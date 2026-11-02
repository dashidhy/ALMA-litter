//! Codex 0.166 ExecutorFileSystem over host-selected ScopedFiles.
//!
//! Mounts are immutable virtual POSIX file-URI roots, disjoint by default. The
//! explicit attempt-view constructor also permits readonly ancestors with
//! separately granted children. No host source
//! path is retained here or returned to Codex. The controller supplies already
//! opened descriptors and their authority; tool arguments cannot create mounts.
//! ScopedFiles' trusted-topology and same-process assumptions still apply.
//!
//! P0 uses bounded whole-file buffers (including streams) and synchronous native
//! I/O when futures are polled. The controller must schedule this on an I/O
//! worker, not a UI thread. Dropping a pending input stream does not commit it;
//! once synchronous commit starts it is not cancellable. There is no multi-file
//! patch transaction, guest enforcement, or runtime registration in this module.

use bytes::Bytes;
use codex_file_system::*;
use codex_protocol::permissions::{FileSystemPath, FileSystemSpecialPath};
use codex_utils_path_uri::{PathConvention, PathUri};
use futures::{StreamExt, stream, stream::BoxStream};
use std::io;
use std::path::Path;
use std::os::unix::fs::MetadataExt;
use std::time::{SystemTime, UNIX_EPOCH};
use std::sync::Arc;
use crate::execution_fence::{ExecutionFence,ExecutionPermit};

use crate::scoped_files::{Access, ScopedFiles};

pub const MAX_BUFFERED_FILE_BYTES: usize = 64 * 1024 * 1024;
const MAX_VIRTUAL_PATH_BYTES: usize = 16 * 1024;
const MAX_VIRTUAL_DEPTH: usize = 128;

struct Mount {
    root: PathUri,
    components: Vec<String>,
    files: ScopedFiles,
}

/// Actual upstream trait implementation; only host construction grants authority.
pub struct ScopedExecutorFileSystem {
    mounts: Vec<Mount>,
    max_file_bytes: usize,
    fence: Option<Arc<ExecutionFence>>,
}

struct Resolved<'a> {
    mount: &'a Mount,
    relative: String,
    _permit: Option<ExecutionPermit>,
}

impl ScopedExecutorFileSystem {
    /// Consume trusted directory capabilities. Overlapping mounts are rejected
    /// so a parent mount cannot bypass a child's authority through another route.
    pub fn new(roots: Vec<(PathUri, ScopedFiles)>, max_file_bytes: usize) -> io::Result<Self> {
        Self::build(roots, max_file_bytes, false)
    }

    /// An immutable attempt view: readonly snapshot root with explicitly
    /// writable candidate subdirectories. Every overlapping ancestor must be
    /// readonly. A writable ancestor could otherwise bypass a child's authority
    /// through guest tools, so it remains forbidden even in this mode.
    pub fn with_readonly_ancestors(
        roots: Vec<(PathUri, ScopedFiles)>, max_file_bytes: usize,
    ) -> io::Result<Self> {
        Self::build(roots, max_file_bytes, true)
    }

    fn build(roots: Vec<(PathUri, ScopedFiles)>, max_file_bytes: usize, nested_readonly: bool) -> io::Result<Self> {
        if roots.is_empty() || max_file_bytes == 0 || max_file_bytes > MAX_BUFFERED_FILE_BYTES {
            return Err(invalid("invalid scoped filesystem configuration"));
        }
        let mut mounts: Vec<Mount> = Vec::new();
        for (root, files) in roots {
            let components = virtual_components(&root)?;
            for mount in &mounts {
                if components == mount.components {
                    return Err(invalid("duplicate virtual root"));
                }
                if components.starts_with(&mount.components)
                    && (!nested_readonly || mount.files.access() != Access::ReadOnly) {
                    return Err(invalid("overlapping ancestor must be explicitly read-only"));
                }
                if mount.components.starts_with(&components)
                    && (!nested_readonly || files.access() != Access::ReadOnly) {
                    return Err(invalid("overlapping ancestor must be explicitly read-only"));
                }
                if nested_readonly && components.starts_with(&mount.components) {
                    verify_nested_identity(&mount.files, &files, &components[mount.components.len()..])?;
                }
                if nested_readonly && mount.components.starts_with(&components) {
                    verify_nested_identity(&files, &mount.files, &mount.components[components.len()..])?;
                }
            }
            mounts.push(Mount { root, components, files });
        }
        // Resolve to the most specific capability, regardless of registration
        // order. The readonly parent is never used to access a shadowed child.
        mounts.sort_by_key(|mount| std::cmp::Reverse(mount.components.len()));
        Ok(Self { mounts, max_file_bytes, fence:None })
    }

    pub fn with_fence(mut self,fence:Arc<ExecutionFence>) -> Self {self.fence=Some(fence);self}

    fn resolve<'a>(
        &'a self,
        path: &PathUri,
        sandbox: Option<&FileSystemSandboxContext>,
        write: bool,
    ) -> io::Result<Resolved<'a>> {
        // All context and URI validation precedes descriptor I/O.
        let permit=self.fence.as_ref().map(|f|f.acquire()).transpose()?;
        authorize_policy(path, sandbox, write)?;
        let components = virtual_components(path)?;
        let mount = self.mounts.iter().find(|mount| components.starts_with(&mount.components))
            .ok_or_else(|| denied("virtual path is not mapped"))?;
        if write && mount.files.access() != Access::ReadWrite {
            return Err(denied("virtual root is read-only"));
        }
        Ok(Resolved { mount, relative: components[mount.components.len()..].join("/"), _permit:permit })
    }

    fn check_size(&self, size: usize) -> io::Result<()> {
        if size > self.max_file_bytes {
            return Err(io::Error::new(io::ErrorKind::InvalidData, "file exceeds configured limit"));
        }
        Ok(())
    }

    fn write_resolved(&self, resolved: &Resolved<'_>, contents: &[u8]) -> io::Result<()> {
        self.check_size(contents.len())?;
        require_leaf(resolved)?;
        match resolved.mount.files.metadata(Path::new(&resolved.relative)) {
            Ok(metadata) if metadata.is_file() => {}
            Ok(_) => return Err(invalid("write requires a regular file")),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
        resolved.mount.files.atomic_replace(Path::new(&resolved.relative), contents).map_err(io_error)
    }
}

fn verify_nested_identity(parent: &ScopedFiles, child: &ScopedFiles, suffix: &[String]) -> io::Result<()> {
    let expected = parent.metadata(Path::new(&suffix.join("/"))).map_err(io_error)?;
    let actual = child.root_metadata().map_err(io_error)?;
    if !expected.is_dir() || expected.dev() != actual.dev() || expected.ino() != actual.ino() {
        return Err(invalid("nested capability does not match the readonly snapshot directory"));
    }
    Ok(())
}

impl FileSystemMutationPreflight for ScopedExecutorFileSystem {
    fn preflight_mutations(
        &self,
        mutations: &[FileSystemMutation],
        sandbox: Option<&FileSystemSandboxContext>,
    ) -> io::Result<()> {
        // First authorize every source and destination without descriptor I/O.
        // Keep all existing per-operation checks; this is not a transaction.
        let mut parent_checks = Vec::new();
        for mutation in mutations {
            let (path, create_parents) = match mutation {
                FileSystemMutation::WriteFile { path, create_parents } => (path, *create_parents),
                FileSystemMutation::RemoveFile { path } => (path, false),
            };
            let resolved = self.resolve(path, sandbox, true)?;
            require_leaf(&resolved)?;
            if create_parents {
                parent_checks.push(resolved);
            }
        }
        for resolved in parent_checks {
            // Match the recursive retry's parent policy. If creation is denied,
            // an already-existing, read-authorized directory still permits a
            // normal file write. Do not reject that previously supported case.
            let creation_allowed = (|| -> io::Result<()> {
                let mut parent = resolved.mount.root.clone();
                let components: Vec<_> = resolved.relative.split('/').collect();
                for component in &components[..components.len() - 1] {
                    parent = parent.join_descendant(component)
                        .map_err(|_| invalid("invalid virtual parent"))?;
                    authorize_policy(&parent, sandbox, true)?;
                }
                Ok(())
            })();
            if let Err(denied_creation) = creation_allowed {
                let (parent, _) = resolved.relative.rsplit_once('/')
                    .ok_or_else(|| invalid("invalid virtual parent"))?;
                let parent_uri = resolved.mount.root.join_descendant(parent)
                    .map_err(|_| invalid("invalid virtual parent"))?;
                let parent = self.resolve(&parent_uri, sandbox, false)?;
                if !metadata(&parent).is_ok_and(|value| value.is_dir()) {
                    return Err(denied_creation);
                }
            }
        }
        Ok(())
    }
}

impl ExecutorFileSystem for ScopedExecutorFileSystem {
    fn mutation_preflight(&self) -> Option<&dyn FileSystemMutationPreflight> {
        Some(self)
    }

    fn watch_missing(&self, _: Vec<PathUri>, _: Option<PathUri>)
        -> ExecutorFileSystemFuture<'_, Option<tokio::sync::oneshot::Receiver<()>>> {
        Box::pin(async { Err(unsupported("filesystem watches are unsupported")) })
    }

    fn canonicalize<'a>(&'a self, path: &'a PathUri, sandbox: Option<&'a FileSystemSandboxContext>)
        -> ExecutorFileSystemFuture<'a, PathUri> {
        Box::pin(async move {
            let resolved = self.resolve(path, sandbox, false)?;
            metadata(&resolved)?;
            // No native canonicalization: the validated, no-link virtual name
            // remains the identity exposed to the caller.
            Ok(path.clone())
        })
    }

    fn read_file<'a>(&'a self, path: &'a PathUri, _options: ReadFileOptions,
        sandbox: Option<&'a FileSystemSandboxContext>) -> ExecutorFileSystemFuture<'a, Vec<u8>> {
        Box::pin(async move {
            let resolved = self.resolve(path, sandbox, false)?;
            require_leaf(&resolved)?;
            resolved.mount.files.read_file(Path::new(&resolved.relative), self.max_file_bytes).map_err(io_error)
        })
    }

    fn read_file_stream<'a>(&'a self, path: &'a PathUri, sandbox: Option<&'a FileSystemSandboxContext>)
        -> ExecutorFileSystemFuture<'a, FileSystemReadStream> {
        Box::pin(async move {
            let bytes = Bytes::from(self.read_file(path, ReadFileOptions { follow_symlinks: false }, sandbox).await?);
            let chunks: Vec<io::Result<Bytes>> = (0..bytes.len()).step_by(FILE_READ_CHUNK_SIZE)
                .map(|start| Ok(bytes.slice(start..(start + FILE_READ_CHUNK_SIZE).min(bytes.len())))).collect();
            Ok(FileSystemReadStream::new(stream::iter(chunks)))
        })
    }

    fn write_file_stream<'a>(&'a self, path: &'a PathUri, mut contents: BoxStream<'a, io::Result<Bytes>>,
        sandbox: Option<&'a FileSystemSandboxContext>) -> ExecutorFileSystemFuture<'a, u64> {
        Box::pin(async move {
            let resolved = self.resolve(path, sandbox, true)?;
            require_leaf(&resolved)?;
            let mut bytes = Vec::new();
            while let Some(chunk) = contents.next().await {
                let chunk = chunk.map_err(io_error)?;
                if chunk.is_empty() || chunk.len() > FILE_WRITE_CHUNK_SIZE {
                    return Err(invalid("invalid write stream chunk size"));
                }
                self.check_size(bytes.len().checked_add(chunk.len()).ok_or_else(|| invalid("write size overflow"))?)?;
                bytes.extend_from_slice(&chunk);
            }
            self.write_resolved(&resolved, &bytes)?;
            Ok(bytes.len() as u64)
        })
    }

    fn read_file_text<'a>(&'a self, path: &'a PathUri, options: ReadFileOptions,
        sandbox: Option<&'a FileSystemSandboxContext>) -> ExecutorFileSystemFuture<'a, String> {
        Box::pin(async move {
            let bytes = self.read_file(path, options, sandbox).await?;
            // FromUtf8Error owns the input bytes; do not embed it in an error
            // whose Debug representation could disclose the file contents.
            String::from_utf8(bytes).map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "file is not UTF-8"))
        })
    }

    fn write_file<'a>(&'a self, path: &'a PathUri, contents: Vec<u8>, _options: WriteFileOptions,
        sandbox: Option<&'a FileSystemSandboxContext>) -> ExecutorFileSystemFuture<'a, ()> {
        Box::pin(async move {
            let resolved = self.resolve(path, sandbox, true)?;
            self.write_resolved(&resolved, &contents)
        })
    }

    fn create_directory<'a>(&'a self, path: &'a PathUri, options: CreateDirectoryOptions,
        sandbox: Option<&'a FileSystemSandboxContext>) -> ExecutorFileSystemFuture<'a, ()> {
        Box::pin(async move {
            let resolved = self.resolve(path, sandbox, true)?;
            if resolved.relative.is_empty() {
                return if options.recursive { metadata(&resolved).map(|_| ()) }
                    else { Err(io::Error::new(io::ErrorKind::AlreadyExists, "virtual root already exists")) };
            }
            if options.recursive {
                // Preauthorize every possibly-created parent before creating any.
                // Conservatively requires write permission even if it exists.
                let mut parent = resolved.mount.root.clone();
                for component in resolved.relative.split('/') {
                    parent = parent.join_descendant(component).map_err(|_| invalid("invalid virtual parent"))?;
                    authorize_policy(&parent, sandbox, true)?;
                }
                resolved.mount.files.create_dir_all(Path::new(&resolved.relative)).map_err(io_error)
            } else {
                resolved.mount.files.create_dir(Path::new(&resolved.relative)).map_err(io_error)
            }
        })
    }

    fn get_metadata<'a>(&'a self, path: &'a PathUri, _options: GetMetadataOptions,
        sandbox: Option<&'a FileSystemSandboxContext>) -> ExecutorFileSystemFuture<'a, FileMetadata> {
        Box::pin(async move {
            let resolved = self.resolve(path, sandbox, false)?;
            let value = metadata(&resolved)?;
            Ok(FileMetadata {
                is_directory: value.is_dir(), is_file: value.is_file(), is_symlink: false,
                size: value.len(),
                created_at_ms: time_ms(value.created().map_err(io_error)?)?,
                modified_at_ms: time_ms(value.modified().map_err(io_error)?)?,
            })
        })
    }

    fn remove<'a>(&'a self, path: &'a PathUri, options: RemoveOptions,
        sandbox: Option<&'a FileSystemSandboxContext>) -> ExecutorFileSystemFuture<'a, ()> {
        Box::pin(async move {
            if options.recursive { return Err(unsupported("recursive removal is unsupported")); }
            let resolved = self.resolve(path, sandbox, true)?;
            require_leaf(&resolved)?;
            match metadata(&resolved) {
                Ok(value) if value.is_file() => {}
                Ok(_) => return Err(unsupported("directory removal is unsupported")),
                Err(error) if options.force && error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error),
            }
            let result = resolved.mount.files.remove_file(Path::new(&resolved.relative)).map_err(io_error);
            match result {
                Err(error) if options.force && error.kind() == io::ErrorKind::NotFound => Ok(()),
                other => other,
            }
        })
    }

    fn read_directory<'a>(&'a self, _: &'a PathUri, _: Option<&'a FileSystemSandboxContext>)
        -> ExecutorFileSystemFuture<'a, Vec<ReadDirectoryEntry>> {
        Box::pin(async { Err(unsupported("directory listing is unsupported")) })
    }

    fn walk<'a>(&'a self, _: &'a PathUri, _: WalkOptions, _: Option<&'a FileSystemSandboxContext>)
        -> ExecutorFileSystemFuture<'a, WalkOutcome> {
        Box::pin(async { Err(unsupported("directory walking is unsupported")) })
    }

    fn copy<'a>(&'a self, _: &'a PathUri, _: &'a PathUri, _: CopyOptions,
        _: Option<&'a FileSystemSandboxContext>) -> ExecutorFileSystemFuture<'a, ()> {
        Box::pin(async { Err(unsupported("copy is unsupported; use authorized read/write")) })
    }
}

fn authorize_policy(path: &PathUri, sandbox: Option<&FileSystemSandboxContext>, write: bool) -> io::Result<()> {
    virtual_components(path)?;
    let Some(context) = sandbox else { return Ok(()); };
    if !context.sandbox_override.is_no_override() || context.windows_sandbox_is_requested()
        || context.windows_sandbox_proxy_settings_mode.is_some() || context.use_legacy_landlock {
        return Err(unsupported("sandbox execution settings are unsupported"));
    }
    virtual_components(&context.cwd)?;
    let policy = context.permissions.file_system_sandbox_policy();
    if policy.glob_scan_max_depth.is_some() {
        return Err(unsupported("glob policy is unsupported"));
    }
    for entry in &policy.entries {
        if entry.missing_path_behavior.is_some() {
            return Err(unsupported("conditional missing-path policy is unsupported"));
        }
        match &entry.path {
            FileSystemPath::Path { path } => { virtual_components(path)?; }
            FileSystemPath::Special { value: FileSystemSpecialPath::Root } => {}
            _ => return Err(unsupported("only literal and root filesystem policy entries are supported")),
        }
    }
    // These selected-executor APIs use PathUri/context, not native path
    // canonicalization. Glob/special/conditional forms were rejected above.
    let allowed = if write { policy.can_write_path(path, &context.policy_context()) }
        else { policy.resolve_access(path, &context.policy_context()).can_read() };
    if !allowed { return Err(denied("filesystem policy denies the virtual path")); }
    Ok(())
}

fn virtual_components(path: &PathUri) -> io::Result<Vec<String>> {
    if path.infer_path_convention() != Some(PathConvention::Posix) || path.is_opaque()
        || path.lexical_depth().is_none() {
        return Err(invalid("expected an unambiguous POSIX virtual file URI"));
    }
    let bytes = path.decoded_path_bytes();
    let decoded = std::str::from_utf8(&bytes).map_err(|_| invalid("virtual path must be UTF-8"))?;
    if decoded.len() > MAX_VIRTUAL_PATH_BYTES || !decoded.starts_with('/') || decoded.contains('\0') {
        return Err(invalid("invalid virtual path"));
    }
    if decoded == "/" { return Ok(Vec::new()); }
    let components: Vec<String> = decoded[1..].split('/').map(str::to_owned).collect();
    if components.len() > MAX_VIRTUAL_DEPTH || components.iter().any(|part| part.is_empty() || part == "." || part == "..") {
        return Err(invalid("invalid virtual path components"));
    }
    Ok(components)
}

fn require_leaf(resolved: &Resolved<'_>) -> io::Result<()> {
    if resolved.relative.is_empty() { return Err(invalid("operation requires a file below the virtual root")); }
    Ok(())
}

fn metadata(resolved: &Resolved<'_>) -> io::Result<std::fs::Metadata> {
    if resolved.relative.is_empty() { resolved.mount.files.root_metadata().map_err(io_error) }
    else { resolved.mount.files.metadata(Path::new(&resolved.relative)).map_err(io_error) }
}

fn time_ms(time: SystemTime) -> io::Result<i64> {
    let milliseconds = match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => i128::try_from(duration.as_millis()),
        Err(error) => i128::try_from(error.duration().as_millis()).map(|value| -value),
    }.map_err(|_| invalid("metadata timestamp out of range"))?;
    i64::try_from(milliseconds).map_err(|_| invalid("metadata timestamp out of range"))
}

fn invalid(message: &'static str) -> io::Error { io::Error::new(io::ErrorKind::InvalidInput, message) }
fn denied(message: &'static str) -> io::Error { io::Error::new(io::ErrorKind::PermissionDenied, message) }
fn unsupported(message: &'static str) -> io::Error { io::Error::new(io::ErrorKind::Unsupported, message) }
fn io_error(error: io::Error) -> io::Error {
    // Preserve kind for apply_patch missing-parent retry, but never propagate a
    // native pathname (or stream-supplied body) through error Display/Debug.
    io::Error::new(error.kind(), "scoped filesystem operation failed")
}
