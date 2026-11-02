//! Unintegrated native file operations relative to a trusted directory handle.
//!
//! The trusted host controller selects the root and authority. Operations keep
//! that root descriptor alive, validate relative path components, and open each
//! parent with `openat(O_DIRECTORY | O_NOFOLLOW)`. No canonicalized string or
//! prefix comparison is used as an authorization decision.
//!
//! This is a same-process API, not a sandbox or VM boundary. The controller must
//! control root selection (including its ancestors), directory topology, mounts,
//! and who can rename directories or create links/special files in the scope.
//! An opened directory remains usable if moved; descriptors do not prove that
//! it is still below the root in a concurrently modified namespace. Guest mount,
//! hard-link, directory-rename, and concurrent-writer policy belongs elsewhere.
//! Reads are bounded, but are not snapshots of files modified in place by others.
//!
//! Replacement creates a fresh private inode in the destination parent, writes
//! and syncs it, then renames it over the destination. It never truncates the old
//! inode. Other open handles/hard links retain the old file. File permissions
//! become 0600 (subject to umask); existing ownership/ACLs/xattrs are not copied.
//! The parent directory is not fsynced: atomic visibility is not a promise of
//! power-loss durability. Ordinary pre-rename failures clean up best-effort;
//! process termination can leave a temporary file for the controller to reclaim.
//!
//! Not wired into `lib.rs`, ExecutorFileSystem, or iSH. Requires the existing
//! `libc` crate as a direct dependency when the host integration enables it.

use std::ffi::{CStr, CString};
use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

const DIRECTORY_FLAGS: libc::c_int =
    libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
const TEMP_PREFIX: &str = ".alma-scoped-write-";
const TEMP_ATTEMPTS: usize = 128;
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

/// Authority supplied by the trusted controller, never by a tool argument.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Access {
    ReadOnly,
    ReadWrite,
}

/// A retained directory capability with fixed authority and no public raw fd.
#[derive(Debug)]
pub struct ScopedFiles {
    root: File,
    access: Access,
}

impl ScopedFiles {
    /// Open an existing host-selected directory and retain it for this scope.
    ///
    /// `trusted_root` is the only host path accepted by this API. The controller
    /// must control its resolution; the final lookup uses `O_NOFOLLOW`.
    /// Subsequent operations never reopen this pathname or depend on cwd.
    pub fn open(trusted_root: &Path, access: Access) -> io::Result<Self> {
        let root = OpenOptions::new()
            .read(true)
            .custom_flags(DIRECTORY_FLAGS)
            .open(trusted_root)?;
        Ok(Self { root, access })
    }

    pub fn access(&self) -> Access {
        self.access
    }

    /// Metadata from the retained root itself, without reopening its host path.
    pub fn root_metadata(&self) -> io::Result<std::fs::Metadata> {
        self.root.metadata()
    }

    /// Descriptor metadata for a regular file or directory; never follows a
    /// final link. Special-file and symlink metadata are deliberately unsupported.
    pub fn metadata(&self, relative: &Path) -> io::Result<std::fs::Metadata> {
        let parent = self.parent(relative)?;
        let file = open_at(
            &parent.directory,
            &parent.name,
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC | libc::O_NONBLOCK | libc::O_NOCTTY,
            0,
        )?;
        let metadata = file.metadata()?;
        if !metadata.is_file() && !metadata.is_dir() {
            return Err(io::Error::new(io::ErrorKind::Unsupported, "unsupported entry type"));
        }
        Ok(metadata)
    }

    /// Create missing parents one component at a time, reopening every created
    /// or existing directory with O_NOFOLLOW. Failure may leave created parents.
    /// Callers with per-path policy must authorize all components before calling.
    pub fn create_dir_all(&self, relative: &Path) -> io::Result<()> {
        self.require_write()?;
        let components = parse_relative(relative)?;
        let mut directory = self.root.try_clone()?;
        for component in components {
            // SAFETY: a live directory fd and validated NUL-terminated component.
            if unsafe { libc::mkdirat(directory.as_raw_fd(), component.as_ptr(), 0o700) } != 0 {
                let error = io::Error::last_os_error();
                if error.kind() != io::ErrorKind::AlreadyExists {
                    return Err(error);
                }
            }
            directory = open_at(&directory, &component, DIRECTORY_FLAGS, 0)?;
        }
        Ok(())
    }

    /// Read only a regular file, failing rather than returning a truncated body
    /// when its contents exceed `max_bytes`. No descriptor is exposed to callers.
    pub fn read_file(&self, relative: &Path, max_bytes: usize) -> io::Result<Vec<u8>> {
        let limit = u64::try_from(max_bytes)
            .ok()
            .and_then(|n| n.checked_add(1))
            .ok_or_else(|| invalid_path("read limit is too large"))?;
        let parent = self.parent(relative)?;
        // NONBLOCK avoids waiting on a FIFO before its descriptor type is
        // checked. NOCTTY avoids acquiring a controlling terminal on open.
        let file = open_at(
            &parent.directory,
            &parent.name,
            libc::O_RDONLY
                | libc::O_NOFOLLOW
                | libc::O_CLOEXEC
                | libc::O_NONBLOCK
                | libc::O_NOCTTY,
            0,
        )?;
        let metadata = file.metadata()?;
        if !metadata.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "read requires a regular file",
            ));
        }
        if metadata.len() >= limit {
            return Err(read_limit_exceeded());
        }
        let mut bytes = Vec::new();
        file.take(limit).read_to_end(&mut bytes)?;
        // Recheck the actual bytes too: the file may grow after metadata().
        if bytes.len() > max_bytes {
            return Err(read_limit_exceeded());
        }
        Ok(bytes)
    }

    /// Create or atomically replace a non-directory entry with `contents`.
    ///
    /// Parents must already exist. A destination symlink is replaced as an
    /// entry, never followed. No existing target inode is opened for writing.
    /// Success means the rename completed; parent-directory crash durability
    /// and synchronization with guest writers remain the controller's concern.
    pub fn atomic_replace(&self, relative: &Path, contents: &[u8]) -> io::Result<()> {
        self.require_write()?;
        let parent = self.parent(relative)?;
        let (mut file, mut temporary) = TemporaryEntry::create(&parent)?;
        file.write_all(contents)?;
        file.sync_all()?;
        // SAFETY: both directory fds are live for this call; both C strings
        // are validated, NUL-terminated single components in the same parent.
        let result = unsafe {
            libc::renameat(
                parent.directory.as_raw_fd(),
                temporary.name.as_ptr(),
                parent.directory.as_raw_fd(),
                parent.name.as_ptr(),
            )
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        temporary.pending = false;
        Ok(())
    }

    /// Unlink one non-directory entry. A final symlink is removed, not followed.
    /// Does not recurse, remove directories, or ignore missing entries.
    pub fn remove_file(&self, relative: &Path) -> io::Result<()> {
        self.require_write()?;
        let parent = self.parent(relative)?;
        unlink_at(&parent.directory, &parent.name)
    }

    /// Create exactly one directory, mode 0700 subject to umask.
    /// Parents must exist; an existing destination is an error.
    pub fn create_dir(&self, relative: &Path) -> io::Result<()> {
        self.require_write()?;
        let parent = self.parent(relative)?;
        // SAFETY: the parent descriptor is live and name is a NUL-terminated
        // single relative component. The mode argument has libc's mode_t type.
        let result = unsafe {
            libc::mkdirat(parent.directory.as_raw_fd(), parent.name.as_ptr(), 0o700)
        };
        if result != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }

    fn require_write(&self) -> io::Result<()> {
        if self.access == Access::ReadOnly {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "scope is read-only",
            ));
        }
        Ok(())
    }

    fn parent(&self, relative: &Path) -> io::Result<Parent> {
        // Validate the entire path before the first filesystem operation.
        let mut components = parse_relative(relative)?;
        let name = components
            .pop()
            .expect("parser requires at least one component");
        let mut directory = self.root.try_clone()?;
        for component in components {
            directory = open_at(&directory, &component, DIRECTORY_FLAGS, 0)?;
        }
        Ok(Parent { directory, name })
    }
}

struct Parent {
    directory: File,
    name: CString,
}

/// Parse POSIX path bytes rather than `Path::components`, which normalizes away
/// some dots and repeated separators. Reject ambiguous empty/dot components as
/// well as absolute paths, parents, and NUL. Name bytes are never normalized;
/// the filesystem may reject unsupported encodings.
fn parse_relative(relative: &Path) -> io::Result<Vec<CString>> {
    let bytes = relative.as_os_str().as_bytes();
    if bytes.is_empty() || bytes.starts_with(b"/") {
        return Err(invalid_path("expected a nonempty relative path"));
    }
    bytes
        .split(|byte| *byte == b'/')
        .map(|component| {
            if component.is_empty() || component == b"." || component == b".." {
                return Err(invalid_path("empty, dot, and parent components are forbidden"));
            }
            CString::new(component).map_err(|_| invalid_path("NUL in path component"))
        })
        .collect()
}

fn invalid_path(message: &'static str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

fn read_limit_exceeded() -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, "file exceeds the read limit")
}

fn open_at(directory: &File, name: &CStr, flags: libc::c_int, mode: libc::mode_t) -> io::Result<File> {
    // SAFETY: directory stays live and name points to a valid C string. Callers
    // supply one validated component and flags from libc, including CLOEXEC.
    // Promote Darwin's u16 mode_t for the C variadic argument.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            flags,
            mode as libc::c_uint,
        )
    };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: openat returned a new owned descriptor; File now owns its close.
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn unlink_at(directory: &File, name: &CStr) -> io::Result<()> {
    // SAFETY: live parent descriptor and NUL-terminated single component.
    // Zero flags requests non-directory unlink and never follows a final link.
    if unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Keeps the parent alive through cleanup; not a path resolved from cwd.
struct TemporaryEntry<'a> {
    parent: &'a File,
    name: CString,
    pending: bool,
}

impl<'a> TemporaryEntry<'a> {
    fn create(parent: &'a Parent) -> io::Result<(File, Self)> {
        for _ in 0..TEMP_ATTEMPTS {
            let sequence = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let name = CString::new(format!("{TEMP_PREFIX}{}-{sequence}", std::process::id()))
                .expect("temporary name contains no NUL");
            if name == parent.name {
                continue;
            }
            match open_at(
                &parent.directory,
                &name,
                libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o600,
            ) {
                Ok(file) => {
                    return Ok((
                        file,
                        Self {
                            parent: &parent.directory,
                            name,
                            pending: true,
                        },
                    ));
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not reserve a temporary file name",
        ))
    }
}

impl Drop for TemporaryEntry<'_> {
    fn drop(&mut self) {
        if self.pending {
            let _ = unlink_at(self.parent, &self.name);
        }
    }
}
