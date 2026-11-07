//! Install signed-bundle Kimi assets before creating any guest execution scope.
//! The caller owns the bundle/workspace roots and excludes guest namespace writers.

use crate::scoped_files::{Access, ScopedFiles};
use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::ffi::CString;
use std::fs::{self, OpenOptions};
use std::io;
use std::os::fd::AsRawFd;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

const MANIFEST: &str = "runtime-manifest.json";
const MAX_MANIFEST: usize = 2 * 1024 * 1024;
const MAX_FILE: u64 = 64 * 1024 * 1024;
const MAX_TOTAL: u64 = 256 * 1024 * 1024;
const MAX_FILES: usize = 4096;
static NEXT_STAGE: AtomicU64 = AtomicU64::new(0);

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    schema_version: u32,
    files: Vec<Asset>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Asset {
    path: String,
    sha256: String,
    bytes: u64,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message)
}

fn valid_path(path: &str) -> bool {
    !path.is_empty()
        && !path.contains(['\\', '\0', ':'])
        && path.split('/').all(|part| !matches!(part, "" | "." | ".."))
}

fn regular_file(root: &ScopedFiles, path: &Path) -> io::Result<fs::Metadata> {
    let metadata = root.metadata(path)?;
    if !metadata.is_file() || metadata.nlink() != 1 {
        return Err(invalid("Kimi assets require single-link regular files"));
    }
    Ok(metadata)
}

fn read_manifest(root: &ScopedFiles) -> io::Result<(Vec<u8>, Manifest)> {
    regular_file(root, Path::new(MANIFEST))?;
    let bytes = root.read_file(Path::new(MANIFEST), MAX_MANIFEST)?;
    let manifest: Manifest =
        serde_json::from_slice(&bytes).map_err(|error| invalid(&error.to_string()))?;
    if manifest.schema_version != 1 || manifest.files.is_empty() || manifest.files.len() > MAX_FILES
    {
        return Err(invalid(
            "Invalid Kimi runtime manifest version or file count",
        ));
    }
    let mut names = BTreeSet::new();
    let mut total = 0;
    for asset in &manifest.files {
        if !valid_path(&asset.path)
            || asset.path == MANIFEST
            || !names.insert(asset.path.as_str())
            || asset.bytes > MAX_FILE
            || asset.sha256.len() != 64
            || !asset
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(invalid("Invalid Kimi runtime manifest asset"));
        }
        total += asset.bytes;
    }
    if total > MAX_TOTAL || !names.contains("guest.mjs") || !names.contains("sdk/index.mjs") {
        return Err(invalid("Incomplete or oversized Kimi runtime manifest"));
    }
    Ok((bytes, manifest))
}

fn asset_bytes(root: &ScopedFiles, asset: &Asset) -> io::Result<Vec<u8>> {
    let path = Path::new(&asset.path);
    if regular_file(root, path)?.len() != asset.bytes {
        return Err(invalid("Kimi asset size mismatch"));
    }
    let data = root.read_file(path, asset.bytes as usize)?;
    if data.len() as u64 != asset.bytes || format!("{:x}", Sha256::digest(&data)) != asset.sha256 {
        return Err(invalid("Kimi asset hash mismatch"));
    }
    regular_file(root, path)?;
    Ok(data)
}

fn inventory(root: &Path, relative: &Path, entries: &mut BTreeSet<PathBuf>) -> io::Result<()> {
    for entry in fs::read_dir(root.join(relative))? {
        let entry = entry?;
        let name = relative.join(entry.file_name());
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() || (!metadata.is_dir() && !metadata.is_file()) {
            return Err(invalid("Unsupported Kimi runtime entry"));
        }
        if metadata.is_file() && metadata.nlink() != 1 {
            return Err(invalid("Hard-linked Kimi runtime asset"));
        }
        entries.insert(name.clone());
        if entries.len() > MAX_FILES * 8 {
            return Err(invalid("Oversized Kimi runtime inventory"));
        }
        if metadata.is_dir() {
            inventory(root, &name, entries)?;
        }
    }
    Ok(())
}

fn verify(root_path: &Path, root: &ScopedFiles, manifest: &Manifest) -> io::Result<()> {
    let mut expected = BTreeSet::from([PathBuf::from(MANIFEST)]);
    for asset in &manifest.files {
        let path = Path::new(&asset.path);
        expected.insert(path.to_owned());
        for parent in path
            .ancestors()
            .skip(1)
            .filter(|path| !path.as_os_str().is_empty())
        {
            expected.insert(parent.to_owned());
        }
        asset_bytes(root, asset)?;
    }
    let mut actual = BTreeSet::new();
    inventory(root_path, Path::new(""), &mut actual)?;
    if actual != expected {
        return Err(invalid("Kimi runtime inventory mismatch"));
    }
    Ok(())
}

struct Staging(PathBuf);

impl Drop for Staging {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn create_staging(parent: &Path) -> io::Result<Staging> {
    for _ in 0..128 {
        let sequence = NEXT_STAGE.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(".kimi-stage-{}-{sequence}", std::process::id()));
        match fs::create_dir(&path) {
            Ok(()) => return Ok(Staging(path)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(invalid("Could not allocate Kimi staging directory"))
}

fn publish(staging: &Path, destination: &Path, replacing: bool) -> io::Result<()> {
    if !replacing {
        return fs::rename(staging, destination);
    }
    let source = CString::new(staging.as_os_str().as_bytes())
        .map_err(|_| invalid("Invalid staging path"))?;
    let target = CString::new(destination.as_os_str().as_bytes())
        .map_err(|_| invalid("Invalid runtime path"))?;
    // Atomic exchange keeps an entire old or new tree visible, including on a
    // failed update. Staging now names the old tree and its guard removes it.
    #[cfg(target_vendor = "apple")]
    let result = unsafe {
        libc::renameatx_np(
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_SWAP,
        )
    };
    #[cfg(any(target_os = "linux", target_os = "android"))]
    let result = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            source.as_ptr(),
            libc::AT_FDCWD,
            target.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    };
    #[cfg(not(any(target_vendor = "apple", target_os = "linux", target_os = "android")))]
    return Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "Atomic Kimi runtime replacement unavailable",
    ));
    #[cfg(any(target_vendor = "apple", target_os = "linux", target_os = "android"))]
    if result != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

pub(crate) fn install(bundle_fs: &Path, workspace: &Path) -> io::Result<()> {
    let bundle_parent = bundle_fs
        .parent()
        .ok_or_else(|| invalid("Missing bundle resource parent"))?;
    let source_path = bundle_parent.join("kimi-runtime");
    // Preserve NotFound for older Codex-only app bundles. All other malformed
    // resource failures propagate to the provider availability decision.
    let source = ScopedFiles::open(&source_path, Access::ReadOnly)?;
    let (manifest_bytes, manifest) = read_manifest(&source)?;
    verify(&source_path, &source, &manifest)?;

    let workspace_files = ScopedFiles::open(workspace, Access::ReadWrite)?;
    workspace_files.create_dir_all(Path::new(".runtime"))?;
    let runtime = workspace.join(".runtime");
    let guard = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(&runtime)?;
    // Lock the host-owned directory across threads/processes. Closing releases it.
    if unsafe { libc::flock(guard.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let destination = runtime.join("kimi");
    let replacing = match fs::symlink_metadata(&destination) {
        Ok(metadata) => {
            if !metadata.is_dir() || metadata.file_type().is_symlink() {
                return Err(invalid("Kimi cache must be a regular directory"));
            }
            let cached = ScopedFiles::open(&destination, Access::ReadOnly)?;
            let (cached_bytes, cached_manifest) = read_manifest(&cached)?;
            verify(&destination, &cached, &cached_manifest)?;
            if cached_bytes == manifest_bytes {
                return Ok(());
            }
            true
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => false,
        Err(error) => return Err(error),
    };
    let staging = create_staging(&runtime)?;
    for asset in &manifest.files {
        let target = staging.0.join(&asset.path);
        fs::create_dir_all(
            target
                .parent()
                .ok_or_else(|| invalid("Invalid asset parent"))?,
        )?;
        fs::write(&target, asset_bytes(&source, asset)?)?;
        fs::set_permissions(&target, fs::Permissions::from_mode(0o444))?;
    }
    let staged_manifest = staging.0.join(MANIFEST);
    fs::write(&staged_manifest, &manifest_bytes)?;
    fs::set_permissions(&staged_manifest, fs::Permissions::from_mode(0o444))?;
    let staged = ScopedFiles::open(&staging.0, Access::ReadOnly)?;
    verify(&staging.0, &staged, &manifest)?;
    publish(&staging.0, &destination, replacing)
}
