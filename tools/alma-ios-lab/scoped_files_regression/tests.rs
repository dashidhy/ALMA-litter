use alma_scoped_files_regression::{Access, ScopedFiles};
use std::fs;
use std::io::{self, Read};
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_WORKSPACE: AtomicU64 = AtomicU64::new(0);

fn workspace() -> PathBuf {
    let base = PathBuf::from(std::env::var_os("ALMA_SCOPED_TEST_WORKSPACE")
        .expect("run through run.py to keep all tests inside the dedicated folder"));
    let sequence = NEXT_WORKSPACE.fetch_add(1, Ordering::Relaxed);
    let directory = base.join(format!("case-{}-{sequence}", std::process::id()));
    fs::create_dir(&directory).unwrap();
    directory
}

fn scope(access: Access) -> (PathBuf, ScopedFiles) {
    let root = workspace();
    let files = ScopedFiles::open(&root, access).unwrap();
    (root, files)
}

fn names(directory: &Path) -> Vec<std::ffi::OsString> {
    let mut names = fs::read_dir(directory).unwrap()
        .map(|entry| entry.unwrap().file_name()).collect::<Vec<_>>();
    names.sort();
    names
}

#[test]
fn existing_root_and_fixed_authority() {
    let (root, read_only) = scope(Access::ReadOnly);
    assert_eq!(read_only.access(), Access::ReadOnly);
    let read_write = ScopedFiles::open(&root, Access::ReadWrite).unwrap();
    assert_eq!(read_write.access(), Access::ReadWrite);
    assert_eq!(ScopedFiles::open(&root.join("missing"), Access::ReadOnly).unwrap_err().kind(), io::ErrorKind::NotFound);
    fs::write(root.join("ordinary-file"), b"data").unwrap();
    assert!(ScopedFiles::open(&root.join("ordinary-file"), Access::ReadOnly).is_err());
}

#[test]
fn nested_unicode_names_and_exact_bytes() {
    let (_, files) = scope(Access::ReadWrite);
    files.create_dir(Path::new("资料")).unwrap();
    files.create_dir(Path::new("资料/子目录 🔐")).unwrap();
    let name = Path::new("资料/子目录 🔐/记录 with spaces.txt");
    let content = "第一行\nemoji 🔐; quotes ' \"\n".as_bytes();
    files.atomic_replace(name, content).unwrap();
    assert_eq!(files.read_file(name, content.len()).unwrap(), content);
}

#[test]
fn binary_and_empty_output_are_preserved() {
    let (_, files) = scope(Access::ReadWrite);
    let bytes = [0, 255, 128, 1, 10, 0, 42];
    files.atomic_replace(Path::new("bytes"), &bytes).unwrap();
    assert_eq!(files.read_file(Path::new("bytes"), bytes.len()).unwrap(), bytes);
    files.atomic_replace(Path::new("empty"), b"").unwrap();
    assert_eq!(files.read_file(Path::new("empty"), 0).unwrap(), b"");
}

#[test]
fn read_limit_is_a_failure_not_truncation() {
    let (_, files) = scope(Access::ReadWrite);
    files.atomic_replace(Path::new("data"), b"12345").unwrap();
    for limit in [0, 1, 4] {
        assert_eq!(files.read_file(Path::new("data"), limit).unwrap_err().kind(), io::ErrorKind::InvalidData);
    }
    assert_eq!(files.read_file(Path::new("data"), 5).unwrap(), b"12345");
    assert_eq!(files.read_file(Path::new("data"), 6).unwrap(), b"12345");
    assert_eq!(files.read_file(Path::new("data"), usize::MAX).unwrap_err().kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn read_only_rejects_all_mutations_and_keeps_original() {
    let (root, writer) = scope(Access::ReadWrite);
    writer.atomic_replace(Path::new("original"), b"unchanged").unwrap();
    let reader = ScopedFiles::open(&root, Access::ReadOnly).unwrap();
    assert_eq!(reader.read_file(Path::new("original"), 9).unwrap(), b"unchanged");
    for result in [
        reader.atomic_replace(Path::new("original"), b"replacement"),
        reader.atomic_replace(Path::new("new"), b"new"),
        reader.remove_file(Path::new("original")),
        reader.create_dir(Path::new("directory")),
    ] {
        assert_eq!(result.unwrap_err().kind(), io::ErrorKind::PermissionDenied);
    }
    assert_eq!(names(&root), vec![std::ffi::OsString::from("original")]);
    assert_eq!(reader.read_file(Path::new("original"), 9).unwrap(), b"unchanged");
}

#[test]
fn malformed_relative_paths_fail_validation_before_any_io() {
    let (root, files) = scope(Access::ReadWrite);
    // Absolute names are parser fixtures only; no host file is opened.
    for raw in ["", "/", "/absolute", ".", "..", "../file", "a/../b", "a/./b", "a//b", "a/", "a\0b", "a/b\0c"] {
        let path = Path::new(raw);
        assert_eq!(files.read_file(path, 10).unwrap_err().kind(), io::ErrorKind::InvalidInput);
        for result in [files.atomic_replace(path, b"data"), files.remove_file(path), files.create_dir(path)] {
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::InvalidInput);
        }
    }
    assert!(names(&root).is_empty());
}

#[test]
fn directories_are_not_returned_as_regular_file_data() {
    let (_, files) = scope(Access::ReadWrite);
    files.create_dir(Path::new("dir")).unwrap();
    assert_eq!(files.read_file(Path::new("dir"), 100).unwrap_err().kind(), io::ErrorKind::InvalidInput);
}

#[test]
fn replacement_preserves_the_old_open_inode() {
    let (root, files) = scope(Access::ReadWrite);
    files.atomic_replace(Path::new("output"), b"old bytes").unwrap();
    let mut old_handle = fs::File::open(root.join("output")).unwrap();
    let old_inode = old_handle.metadata().unwrap().ino();
    files.atomic_replace(Path::new("output"), b"new complete output").unwrap();
    let mut old_bytes = Vec::new();
    old_handle.read_to_end(&mut old_bytes).unwrap();
    assert_eq!(old_bytes, b"old bytes");
    assert_eq!(files.read_file(Path::new("output"), 100).unwrap(), b"new complete output");
    assert_ne!(old_inode, fs::metadata(root.join("output")).unwrap().ino());
    assert_eq!(names(&root), vec![std::ffi::OsString::from("output")]);
}

#[test]
fn failed_directory_replacement_cleans_up_its_temporary() {
    let (root, files) = scope(Access::ReadWrite);
    files.create_dir(Path::new("destination")).unwrap();
    files.atomic_replace(Path::new("destination/keep"), b"kept").unwrap();
    let before = names(&root);
    assert!(files.atomic_replace(Path::new("destination"), b"replacement").is_err());
    assert_eq!(names(&root), before);
    assert_eq!(files.read_file(Path::new("destination/keep"), 4).unwrap(), b"kept");
}

#[test]
fn missing_parents_are_not_created_implicitly() {
    let (root, files) = scope(Access::ReadWrite);
    assert_eq!(files.atomic_replace(Path::new("absent/file"), b"data").unwrap_err().kind(), io::ErrorKind::NotFound);
    assert_eq!(files.create_dir(Path::new("absent/child")).unwrap_err().kind(), io::ErrorKind::NotFound);
    assert!(names(&root).is_empty());
}

#[test]
fn remove_is_single_file_and_non_recursive() {
    let (root, files) = scope(Access::ReadWrite);
    files.create_dir(Path::new("dir")).unwrap();
    files.atomic_replace(Path::new("dir/file"), b"data").unwrap();
    files.remove_file(Path::new("dir/file")).unwrap();
    assert_eq!(files.read_file(Path::new("dir/file"), 4).unwrap_err().kind(), io::ErrorKind::NotFound);
    assert_eq!(files.remove_file(Path::new("dir/file")).unwrap_err().kind(), io::ErrorKind::NotFound);
    assert!(files.remove_file(Path::new("dir")).is_err());
    assert!(root.join("dir").is_dir());
}

#[test]
fn creating_an_existing_directory_is_an_error() {
    let (_, files) = scope(Access::ReadWrite);
    files.create_dir(Path::new("dir")).unwrap();
    assert_eq!(files.create_dir(Path::new("dir")).unwrap_err().kind(), io::ErrorKind::AlreadyExists);
}

#[test]
fn retained_root_survives_an_ordinary_workspace_rename() {
    let workspace = workspace();
    let root = workspace.join("root");
    let moved = workspace.join("renamed-root");
    fs::create_dir(&root).unwrap();
    let files = ScopedFiles::open(&root, Access::ReadWrite).unwrap();
    files.atomic_replace(Path::new("before"), b"retained").unwrap();
    fs::rename(&root, &moved).unwrap();
    assert_eq!(files.read_file(Path::new("before"), 8).unwrap(), b"retained");
    files.atomic_replace(Path::new("after"), b"same directory").unwrap();
    assert_eq!(fs::read(moved.join("after")).unwrap(), b"same directory");
    assert!(!root.exists());
}

#[test]
fn repeated_replacements_have_complete_output_and_no_temp_entries() {
    let (root, files) = scope(Access::ReadWrite);
    for byte in 0..8 {
        let data = vec![byte; 64 * 1024];
        files.atomic_replace(Path::new("output"), &data).unwrap();
        assert_eq!(files.read_file(Path::new("output"), data.len()).unwrap(), data);
    }
    assert_eq!(names(&root), vec![std::ffi::OsString::from("output")]);
}

#[test]
fn non_utf8_names_are_never_lossily_rewritten() {
    let (root, files) = scope(Access::ReadWrite);
    let name = Path::new(std::ffi::OsStr::from_bytes(b"name-\xff"));
    match files.atomic_replace(name, b"bytes") {
        Ok(()) => {
            assert_eq!(files.read_file(name, 5).unwrap(), b"bytes");
            files.remove_file(name).unwrap();
        }
        Err(error) => {
            // The host Apple filesystem rejects invalid UTF-8 filenames.
            // Preserve that OS error rather than creating a lossy name.
            assert_eq!(error.raw_os_error(), Some(libc::EILSEQ));
        }
    }
    assert!(names(&root).is_empty());
}
