use alma_scoped_executor_regression::scoped_executor_fs::ScopedExecutorFileSystem;
use alma_scoped_executor_regression::scoped_files::{Access, ScopedFiles};
use codex_apply_patch::{AppliedPatchDelta, ApplyPatchFailure, apply_patch};
use codex_file_system::{ExecutorFileSystem, FileSystemSandboxContext};
use codex_protocol::models::{ManagedFileSystemPermissions, PermissionProfile};
use codex_protocol::permissions::{FileSystemAccessMode, FileSystemPath, FileSystemSandboxEntry, NetworkSandboxPolicy};
use codex_utils_path_uri::PathUri;
use std::collections::{BTreeMap, BTreeSet};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};

static NEXT: AtomicUsize = AtomicUsize::new(0);
fn uri(path: &str) -> PathUri { PathUri::parse(&format!("file://{path}")).unwrap() }
fn workspace() -> PathBuf {
    let base = PathBuf::from(std::env::var_os("ALMA_APPLY_PATCH_WORKSPACE").expect("use run_apply_patch.py"));
    let root = base.join(format!("case-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir(&root).unwrap();
    root
}
fn fixture() -> (PathBuf, ScopedExecutorFileSystem) {
    let root = workspace();
    for directory in ["input", "output"] { std::fs::create_dir(root.join(directory)).unwrap(); }
    std::fs::write(root.join("input/source.txt"), "原材料\n").unwrap();
    std::fs::write(root.join("output/first.txt"), "original\n").unwrap();
    std::fs::write(root.join("output/move.txt"), "move me\n").unwrap();
    std::fs::write(root.join("output/blocked.txt"), "blocked\n").unwrap();
    let fs = ScopedExecutorFileSystem::new(vec![
        (uri("/input"), ScopedFiles::open(&root.join("input"), Access::ReadOnly).unwrap()),
        (uri("/output"), ScopedFiles::open(&root.join("output"), Access::ReadWrite).unwrap()),
    ], 1024 * 1024).unwrap();
    (root, fs)
}

async fn run_patch(patch: &str, cwd: &PathUri, fs: &dyn ExecutorFileSystem,
    sandbox: Option<&FileSystemSandboxContext>) -> Result<AppliedPatchDelta, ApplyPatchFailure> {
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    let result = apply_patch(patch, cwd, &mut stdout, &mut stderr, fs, sandbox).await;
    if result.is_err() { assert!(stdout.is_empty()); }
    result
}

// Access times are excluded because the snapshot itself reads the fixtures.
#[derive(Debug, PartialEq, Eq)]
struct Entry { directory: bool, inode: u64, mode: u32, modified: (i64, i64), bytes: Vec<u8> }
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Entry> {
    fn visit(root: &Path, path: &Path, entries: &mut BTreeMap<PathBuf, Entry>) {
        let metadata = std::fs::metadata(path).unwrap();
        entries.insert(path.strip_prefix(root).unwrap().to_path_buf(), Entry {
            directory: metadata.is_dir(), inode: metadata.ino(), mode: metadata.mode(),
            modified: (metadata.mtime(), metadata.mtime_nsec()),
            bytes: if metadata.is_file() { std::fs::read(path).unwrap() } else { Vec::new() },
        });
        if metadata.is_dir() {
            for entry in std::fs::read_dir(path).unwrap() { visit(root, &entry.unwrap().path(), entries); }
        }
    }
    let mut entries = BTreeMap::new();
    visit(root, root, &mut entries);
    entries
}

#[tokio::test]
async fn actual_apply_patch_add_update_move_delete_parents_and_utf8() {
    let (root, fs) = fixture();
    let cwd = uri("/output");
    let add = "*** Begin Patch\n*** Add File: 资料/子目录/笔记.txt\n+第一版 🔐\n*** End Patch";
    assert_eq!(run_patch(add, &cwd, &fs, None).await.unwrap().changes().len(), 1);
    assert_eq!(std::fs::read_to_string(root.join("output/资料/子目录/笔记.txt")).unwrap(), "第一版 🔐\n");
    let update = "*** Begin Patch\n*** Update File: 资料/子目录/笔记.txt\n@@\n-第一版 🔐\n+第二版 中文\n*** End Patch";
    run_patch(update, &cwd, &fs, None).await.unwrap();
    let moved = "*** Begin Patch\n*** Update File: 资料/子目录/笔记.txt\n*** Move to: 移动/结果.txt\n@@\n-第二版 中文\n+第三版 😀\n*** End Patch";
    run_patch(moved, &cwd, &fs, None).await.unwrap();
    assert!(!root.join("output/资料/子目录/笔记.txt").exists());
    assert_eq!(std::fs::read_to_string(root.join("output/移动/结果.txt")).unwrap(), "第三版 😀\n");
    run_patch("*** Begin Patch\n*** Delete File: 移动/结果.txt\n*** End Patch", &cwd, &fs, None).await.unwrap();
    assert!(!root.join("output/移动/结果.txt").exists());
    assert_eq!(std::fs::read_to_string(root.join("input/source.txt")).unwrap(), "原材料\n");
}

async fn rejected_without_mutation(later_hunk: &str, sandbox: Option<FileSystemSandboxContext>) {
    let (root, fs) = fixture();
    let before = snapshot(&root);
    let patch = format!("*** Begin Patch\n*** Update File: first.txt\n@@\n-original\n+changed\n{later_hunk}\n*** End Patch");
    let failure = run_patch(&patch, &uri("/output"), &fs, sandbox.as_ref()).await.expect_err("must reject denied target");
    let after = snapshot(&root);
    let changed: BTreeSet<_> = before.keys().chain(after.keys()).filter(|path| before.get(*path) != after.get(*path)).collect();
    println!("committed_delta={} changed_entries={}", failure.delta().changes().len(), changed.len());
    assert_eq!(failure.delta().changes().len(), 0, "authorization rejection must precede every committed hunk");
    assert!(changed.is_empty(), "authorization rejection must preserve all owned fixture entries");
}

#[tokio::test]
async fn mixed_rw_then_ro_update_is_rejected_before_any_mutation() {
    rejected_without_mutation("*** Update File: /input/source.txt\n@@\n-原材料\n+changed", None).await;
}
#[tokio::test]
async fn mixed_rw_then_ro_add_is_rejected_before_any_mutation() {
    rejected_without_mutation("*** Add File: /input/new.txt\n+new", None).await;
}
#[tokio::test]
async fn mixed_rw_then_ro_delete_is_rejected_before_any_mutation() {
    rejected_without_mutation("*** Delete File: /input/source.txt", None).await;
}
#[tokio::test]
async fn mixed_rw_then_move_from_ro_is_rejected_before_any_mutation() {
    rejected_without_mutation("*** Update File: /input/source.txt\n*** Move to: imported/target.txt\n@@\n-原材料\n+imported", None).await;
}
#[tokio::test]
async fn mixed_rw_then_move_into_ro_is_rejected_before_any_mutation() {
    rejected_without_mutation("*** Update File: move.txt\n*** Move to: /input/moved.txt\n@@\n-move me\n+moved", None).await;
}
#[tokio::test]
async fn mixed_rw_then_policy_denied_target_is_rejected_before_any_mutation() {
    let entry = |path, access| FileSystemSandboxEntry::new(FileSystemPath::Path { path: uri(path) }, access);
    let sandbox = FileSystemSandboxContext::from_permission_profile(PermissionProfile::Managed {
        file_system: ManagedFileSystemPermissions::Restricted { entries: vec![
            entry("/output", FileSystemAccessMode::Write),
            entry("/output/blocked.txt", FileSystemAccessMode::Read),
        ], glob_scan_max_depth: None }, network: NetworkSandboxPolicy::Restricted,
    }, uri("/output"));
    rejected_without_mutation("*** Update File: blocked.txt\n@@\n-blocked\n+changed", Some(sandbox)).await;
}
#[tokio::test]
async fn rejected_batch_does_not_create_first_hunks_parents() {
    let (root, fs) = fixture();
    let before = snapshot(&root);
    let patch = "*** Begin Patch\n*** Add File: new/parents/first.txt\n+new\n*** Delete File: /input/source.txt\n*** End Patch";
    let failure = run_patch(patch, &uri("/output"), &fs, None).await.unwrap_err();
    println!("committed_delta={} created_parent={}", failure.delta().changes().len(), root.join("output/new").exists());
    assert!(snapshot(&root) == before, "no parent creation or writes before rejecting the batch");
    assert!(failure.delta().is_empty());
}

#[tokio::test]
async fn actual_native_fs_normal_operations_remain_supported() {
    let root = workspace();
    let cwd = PathUri::from_host_native_path(&root).unwrap();
    let fs = codex_exec_server::LOCAL_FS.as_ref();
    run_patch("*** Begin Patch\n*** Add File: nested/hello.txt\n+hello 中文\n*** End Patch", &cwd, fs, None).await.unwrap();
    run_patch("*** Begin Patch\n*** Update File: nested/hello.txt\n*** Move to: moved.txt\n@@\n-hello 中文\n+updated 🔐\n*** End Patch", &cwd, fs, None).await.unwrap();
    assert_eq!(std::fs::read_to_string(root.join("moved.txt")).unwrap(), "updated 🔐\n");
    run_patch("*** Begin Patch\n*** Delete File: moved.txt\n*** End Patch", &cwd, fs, None).await.unwrap();
    assert!(!root.join("moved.txt").exists());
}

fn narrow_parent_policy() -> FileSystemSandboxContext {
    let entry = |path, access| FileSystemSandboxEntry::new(FileSystemPath::Path { path: uri(path) }, access);
    FileSystemSandboxContext::from_permission_profile(PermissionProfile::Managed {
        file_system: ManagedFileSystemPermissions::Restricted { entries: vec![
            entry("/output", FileSystemAccessMode::Write),
            entry("/output/parent", FileSystemAccessMode::Read),
            entry("/output/parent/file.txt", FileSystemAccessMode::Write),
        ], glob_scan_max_depth: None }, network: NetworkSandboxPolicy::Restricted,
    }, uri("/output"))
}

#[tokio::test]
async fn denied_parent_creation_is_rejected_before_any_mutation() {
    rejected_without_mutation("*** Add File: parent/file.txt\n+new", Some(narrow_parent_policy())).await;
}

#[tokio::test]
async fn writable_file_inside_existing_readonly_parent_remains_supported() {
    let (root, fs) = fixture();
    std::fs::create_dir(root.join("output/parent")).unwrap();
    run_patch("*** Begin Patch\n*** Add File: parent/file.txt\n+allowed\n*** End Patch", &uri("/output"), &fs, Some(&narrow_parent_policy())).await.unwrap();
    assert_eq!(std::fs::read(root.join("output/parent/file.txt")).unwrap(), b"allowed\n");
}

#[tokio::test]
async fn authorization_preflight_is_not_a_content_failure_transaction() {
    let (root, fs) = fixture();
    let patch = "*** Begin Patch\n*** Update File: first.txt\n@@\n-original\n+changed\n*** Update File: move.txt\n@@\n-not the current contents\n+replacement\n*** End Patch";
    let failure = run_patch(patch, &uri("/output"), &fs, None).await.unwrap_err();
    assert_eq!(failure.delta().changes().len(), 1);
    assert_eq!(std::fs::read(root.join("output/first.txt")).unwrap(), b"changed\n");
    assert_eq!(std::fs::read(root.join("output/move.txt")).unwrap(), b"move me\n");
}
