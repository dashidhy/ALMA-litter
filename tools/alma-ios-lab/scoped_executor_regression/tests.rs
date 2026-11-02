use alma_scoped_executor_regression::scoped_executor_fs::*;
use alma_scoped_executor_regression::scoped_files::{Access, ScopedFiles};
use bytes::Bytes;
use codex_file_system::*;
use codex_protocol::models::{ManagedFileSystemPermissions, PermissionProfile};
use codex_protocol::permissions::{FileSystemAccessMode, FileSystemPath, FileSystemSandboxEntry, FileSystemSpecialPath, NetworkSandboxPolicy};
use codex_protocol::sandbox::SandboxOverride;
use codex_utils_path_uri::PathUri;
use futures::{FutureExt, StreamExt, stream};
use std::io;
use std::path::PathBuf;
use std::sync::{Arc, atomic::{AtomicUsize, Ordering}};

static NEXT: AtomicUsize = AtomicUsize::new(0);

#[tokio::test]
async fn closed_attempt_waits_for_existing_stream_then_refuses_new_io() {
    let (root,adapter)=fixture(4096);
    let fence=Arc::new(alma_scoped_executor_regression::execution_fence::ExecutionFence::default());
    let adapter=adapter.with_fence(fence.clone());
    let path=uri("/candidate/pending.md");
    let mut pending=adapter.write_file_stream(&path,Box::pin(stream::pending()),None);
    assert!(pending.as_mut().now_or_never().is_none());
    fence.close();
    assert!(!fence.drained());
    drop(pending);
    assert!(fence.drained());
    assert!(!root.join("candidate/pending.md").exists());
    expect_error(adapter.write_file(&path,b"late".to_vec(),write_options(),None).await,io::ErrorKind::PermissionDenied);
    expect_error(adapter.read_file(&uri("/input/source.txt"),read_options(),None).await,io::ErrorKind::PermissionDenied);
}

#[tokio::test]
async fn attempt_snapshot_is_readonly_except_explicit_candidate_for_both_mount_orders() {
    let (root, _) = fixture(4096);
    for reverse in [false, true] {
        let mut roots = vec![
            (uri("/attempt"), ScopedFiles::open(&root, Access::ReadOnly).unwrap()),
            (uri("/attempt/candidate"), ScopedFiles::open(&root.join("candidate"), Access::ReadWrite).unwrap()),
        ];
        if reverse { roots.reverse(); }
        let fs = ScopedExecutorFileSystem::with_readonly_ancestors(roots, 4096).unwrap();
        // Exercise capability enforcement even without an outer Core context.
        fs.write_file(&uri("/attempt/candidate/note.md"), b"candidate\n".to_vec(), write_options(), None).await.unwrap();
        assert_eq!(fs.read_file_text(&uri("/attempt/candidate/note.md"), read_options(), None).await.unwrap(), "candidate\n");
        expect_error(fs.write_file(&uri("/attempt/input/source.txt"), b"changed".to_vec(), write_options(), None).await,
            io::ErrorKind::PermissionDenied);
        expect_error(fs.write_file(&uri("/attempt/new.txt"), b"changed".to_vec(), write_options(), None).await,
            io::ErrorKind::PermissionDenied);
        assert_eq!(std::fs::read_to_string(root.join("input/source.txt")).unwrap(), "原材料\n");
    }
    // A Guardian receives only the readonly snapshot capability.
    let guardian = ScopedExecutorFileSystem::with_readonly_ancestors(vec![
        (uri("/attempt"), ScopedFiles::open(&root, Access::ReadOnly).unwrap()),
    ], 4096).unwrap();
    expect_error(guardian.write_file(&uri("/attempt/candidate/note.md"), b"changed".to_vec(), write_options(), None).await,
        io::ErrorKind::PermissionDenied);
}

#[test]
fn attempt_view_rejects_writable_ancestors_and_default_constructor_stays_disjoint() {
    let (root, _) = fixture(4096);
    for reverse in [false, true] {
        let mut roots = vec![
            (uri("/attempt"), ScopedFiles::open(&root, Access::ReadWrite).unwrap()),
            (uri("/attempt/candidate"), ScopedFiles::open(&root.join("candidate"), Access::ReadOnly).unwrap()),
        ];
        if reverse { roots.reverse(); }
        expect_error(ScopedExecutorFileSystem::with_readonly_ancestors(roots, 4096), io::ErrorKind::InvalidInput);
    }
    expect_error(ScopedExecutorFileSystem::new(vec![
        (uri("/attempt"), ScopedFiles::open(&root, Access::ReadOnly).unwrap()),
        (uri("/attempt/candidate"), ScopedFiles::open(&root.join("candidate"), Access::ReadWrite).unwrap()),
    ], 4096), io::ErrorKind::InvalidInput);
    // A virtual candidate must refer to the actual candidate directory, not
    // accidentally grant writes to a different owned snapshot directory.
    expect_error(ScopedExecutorFileSystem::with_readonly_ancestors(vec![
        (uri("/attempt"), ScopedFiles::open(&root, Access::ReadOnly).unwrap()),
        (uri("/attempt/candidate"), ScopedFiles::open(&root.join("input"), Access::ReadWrite).unwrap()),
    ], 4096), io::ErrorKind::InvalidInput);
}
fn uri(path: &str) -> PathUri { PathUri::parse(&format!("file://{path}")).unwrap() }
fn read_options() -> ReadFileOptions { ReadFileOptions::default() }
fn write_options() -> WriteFileOptions { WriteFileOptions::default() }
fn mkdir_options() -> CreateDirectoryOptions { CreateDirectoryOptions { recursive: true, follow_symlinks: true } }
fn remove_options() -> RemoveOptions { RemoveOptions { recursive: false, force: false, follow_symlinks: true } }
fn expect_error<T>(result: io::Result<T>, kind: io::ErrorKind) {
    match result { Err(error) => assert_eq!(error.kind(), kind), Ok(_) => panic!("expected operation rejection") }
}

fn fixture(limit: usize) -> (PathBuf, ScopedExecutorFileSystem) {
    let base = PathBuf::from(std::env::var_os("ALMA_EXECUTOR_TEST_WORKSPACE").expect("use run.py"));
    let root = base.join(format!("case-{}-{}", std::process::id(), NEXT.fetch_add(1, Ordering::Relaxed)));
    std::fs::create_dir(&root).unwrap();
    std::fs::create_dir(root.join("input")).unwrap();
    std::fs::create_dir(root.join("candidate")).unwrap();
    std::fs::write(root.join("input/source.txt"), "原材料\n").unwrap();
    let adapter = ScopedExecutorFileSystem::new(vec![
        (uri("/input"), ScopedFiles::open(&root.join("input"), Access::ReadOnly).unwrap()),
        (uri("/candidate"), ScopedFiles::open(&root.join("candidate"), Access::ReadWrite).unwrap()),
    ], limit).unwrap();
    (root, adapter)
}

fn literal(path: &str, access: FileSystemAccessMode) -> FileSystemSandboxEntry {
    FileSystemSandboxEntry::new(FileSystemPath::Path { path: uri(path) }, access)
}
fn policy(entries: Vec<FileSystemSandboxEntry>) -> FileSystemSandboxContext {
    FileSystemSandboxContext::from_permission_profile(PermissionProfile::Managed {
        file_system: ManagedFileSystemPermissions::Restricted { entries, glob_scan_max_depth: None },
        network: NetworkSandboxPolicy::Restricted,
    }, uri("/candidate"))
}
fn writable_policy() -> FileSystemSandboxContext {
    policy(vec![literal("/candidate", FileSystemAccessMode::Write), literal("/input", FileSystemAccessMode::Read)])
}

#[tokio::test]
async fn actual_trait_object_supports_normal_patch_file_sequence() {
    let (root, adapter) = fixture(4096);
    let fs: &dyn ExecutorFileSystem = &adapter; // actual upstream trait identity
    let sandbox = writable_policy();
    let path = uri("/candidate/资料/out.md");
    expect_error(fs.write_file(&path, b"first\n".to_vec(), write_options(), Some(&sandbox)).await, io::ErrorKind::NotFound);
    fs.create_directory(&path.parent().unwrap(), mkdir_options(), Some(&sandbox)).await.unwrap();
    fs.write_file(&path, "第一版\n".as_bytes().to_vec(), write_options(), Some(&sandbox)).await.unwrap();
    assert_eq!(fs.read_file_text(&path, read_options(), Some(&sandbox)).await.unwrap(), "第一版\n");
    let metadata = fs.get_metadata(&path, GetMetadataOptions::default(), Some(&sandbox)).await.unwrap();
    assert!(metadata.is_file && !metadata.is_directory && !metadata.is_symlink);
    assert_eq!(metadata.size, "第一版\n".len() as u64);
    assert!(metadata.created_at_ms > 0 && metadata.modified_at_ms > 0);
    assert_eq!(fs.canonicalize(&path, Some(&sandbox)).await.unwrap(), path);
    fs.write_file(&path, "第二版 🔐\n".as_bytes().to_vec(), write_options(), Some(&sandbox)).await.unwrap();
    // Move uses the same read/write/remove operations as apply_patch's move hunk.
    let moved = uri("/candidate/moved.md");
    let content = fs.read_file(&path, read_options(), Some(&sandbox)).await.unwrap();
    fs.write_file(&moved, content, write_options(), Some(&sandbox)).await.unwrap();
    fs.remove(&path, remove_options(), Some(&sandbox)).await.unwrap();
    assert_eq!(fs.read_file_text(&moved, read_options(), Some(&sandbox)).await.unwrap(), "第二版 🔐\n");
    fs.remove(&moved, remove_options(), Some(&sandbox)).await.unwrap();
    expect_error(fs.get_metadata(&moved, GetMetadataOptions::default(), Some(&sandbox)).await, io::ErrorKind::NotFound);
    assert_eq!(fs.read_file_text(&uri("/input/source.txt"), read_options(), Some(&sandbox)).await.unwrap(), "原材料\n");
    let directory = fs.get_metadata(&uri("/candidate"), GetMetadataOptions::default(), None).await.unwrap();
    assert!(directory.is_directory && !directory.is_file);
    let error = fs.read_file(&uri("/candidate/missing"), read_options(), None).await.unwrap_err();
    assert!(!error.to_string().contains(root.to_str().unwrap()));
}

#[tokio::test]
async fn policy_is_intersected_with_host_authority() {
    let (root, fs) = fixture(4096);
    let target = uri("/candidate/locked");
    fs.write_file(&target, b"original".to_vec(), write_options(), None).await.unwrap();
    let restricted = policy(vec![
        literal("/candidate", FileSystemAccessMode::Write),
        literal("/candidate/locked", FileSystemAccessMode::Read),
        literal("/candidate/hidden", FileSystemAccessMode::Deny),
        literal("/input", FileSystemAccessMode::Write),
    ]);
    expect_error(fs.write_file(&target, b"changed".to_vec(), write_options(), Some(&restricted)).await, io::ErrorKind::PermissionDenied);
    expect_error(fs.remove(&target, remove_options(), Some(&restricted)).await, io::ErrorKind::PermissionDenied);
    assert_eq!(fs.read_file(&target, read_options(), Some(&restricted)).await.unwrap(), b"original");
    expect_error(fs.read_file(&uri("/candidate/hidden"), read_options(), Some(&restricted)).await, io::ErrorKind::PermissionDenied);
    expect_error(fs.write_file(&uri("/input/source.txt"), b"changed".to_vec(), write_options(), Some(&restricted)).await, io::ErrorKind::PermissionDenied);
    expect_error(fs.create_directory(&uri("/input/new"), mkdir_options(), None).await, io::ErrorKind::PermissionDenied);
    expect_error(fs.read_file(&uri("/candidate-other/file"), read_options(), None).await, io::ErrorKind::PermissionDenied);
    // Actual can_write_path also enforces Codex protected metadata restrictions.
    expect_error(fs.write_file(&uri("/candidate/.git/config"), b"data".to_vec(), write_options(), Some(&restricted)).await, io::ErrorKind::PermissionDenied);
    let disabled = FileSystemSandboxContext::from_permission_profile(PermissionProfile::Disabled, uri("/candidate"));
    expect_error(fs.remove(&uri("/input/source.txt"), remove_options(), Some(&disabled)).await, io::ErrorKind::PermissionDenied);
    assert_eq!(std::fs::read(root.join("input/source.txt")).unwrap(), "原材料\n".as_bytes());
}

#[tokio::test]
async fn root_read_policy_and_preflight_of_recursive_parents() {
    let (root, fs) = fixture(4096);
    let readonly = policy(vec![FileSystemSandboxEntry::new(
        FileSystemPath::Special { value: FileSystemSpecialPath::Root }, FileSystemAccessMode::Read)]);
    assert!(!fs.read_file(&uri("/input/source.txt"), read_options(), Some(&readonly)).await.unwrap().is_empty());
    expect_error(fs.create_directory(&uri("/candidate/new"), mkdir_options(), Some(&readonly)).await, io::ErrorKind::PermissionDenied);
    let narrowed = policy(vec![literal("/candidate", FileSystemAccessMode::Read), literal("/candidate/new/child", FileSystemAccessMode::Write)]);
    expect_error(fs.create_directory(&uri("/candidate/new/child"), mkdir_options(), Some(&narrowed)).await, io::ErrorKind::PermissionDenied);
    assert!(!root.join("candidate/new").exists());
}

#[tokio::test]
async fn unsupported_contexts_reject_before_io_or_stream_consumption() {
    let (root, fs) = fixture(4096);
    let mut contexts = Vec::new();
    contexts.push(policy(vec![literal("/candidate", FileSystemAccessMode::Write), FileSystemSandboxEntry::new(
        FileSystemPath::GlobPattern { pattern: "/candidate/*.private".into() }, FileSystemAccessMode::Deny)]));
    contexts.push(policy(vec![FileSystemSandboxEntry::new(FileSystemPath::Special {
        value: FileSystemSpecialPath::ProjectRoots { subpath: None } }, FileSystemAccessMode::Write)]));
    contexts.push(policy(vec![FileSystemSandboxEntry::skip_missing_path(FileSystemPath::Path { path: uri("/candidate") }, FileSystemAccessMode::Write)]));
    let mut override_context = writable_policy();
    override_context.sandbox_override = SandboxOverride::BypassSandboxFirstAttempt;
    contexts.push(override_context);
    let mut windows = writable_policy();
    windows.windows_sandbox_selection = WindowsSandboxSelection::Elevated;
    contexts.push(windows);
    let mut landlock = writable_policy();
    landlock.use_legacy_landlock = true;
    contexts.push(landlock);
    let target = uri("/candidate/new");
    for context in contexts {
        expect_error(fs.read_file(&target, read_options(), Some(&context)).await, io::ErrorKind::Unsupported);
        expect_error(fs.canonicalize(&target, Some(&context)).await, io::ErrorKind::Unsupported);
        expect_error(fs.get_metadata(&target, GetMetadataOptions::default(), Some(&context)).await, io::ErrorKind::Unsupported);
        expect_error(fs.write_file(&target, b"data".to_vec(), write_options(), Some(&context)).await, io::ErrorKind::Unsupported);
        expect_error(fs.create_directory(&target, mkdir_options(), Some(&context)).await, io::ErrorKind::Unsupported);
        expect_error(fs.remove(&target, remove_options(), Some(&context)).await, io::ErrorKind::Unsupported);
        let polls = Arc::new(AtomicUsize::new(0));
        let observed = polls.clone();
        let input = stream::poll_fn(move |_| { observed.fetch_add(1, Ordering::SeqCst); std::task::Poll::Ready(Some(Ok(Bytes::from_static(b"data")))) }).boxed();
        expect_error(fs.write_file_stream(&target, input, Some(&context)).await, io::ErrorKind::Unsupported);
        assert_eq!(polls.load(Ordering::SeqCst), 0);
    }
    assert_eq!(std::fs::read_dir(root.join("candidate")).unwrap().count(), 0);
}

#[tokio::test]
async fn bounded_streams_text_and_cancelled_input_preserve_output() {
    let (_, fs) = fixture(2 * FILE_READ_CHUNK_SIZE);
    let path = uri("/candidate/output");
    let data = vec![42; FILE_READ_CHUNK_SIZE + 17];
    fs.write_file(&path, data.clone(), write_options(), None).await.unwrap();
    let mut output = fs.read_file_stream(&path, None).await.unwrap();
    let mut roundtrip = Vec::new();
    while let Some(chunk) = output.next().await {
        let chunk = chunk.unwrap();
        assert!(!chunk.is_empty() && chunk.len() <= FILE_READ_CHUNK_SIZE);
        roundtrip.extend_from_slice(&chunk);
    }
    assert_eq!(roundtrip, data);
    let input = stream::iter(vec![Ok(Bytes::from_static("中文 ".as_bytes())), Ok(Bytes::from_static("🔐".as_bytes()))]).boxed();
    assert_eq!(fs.write_file_stream(&path, input, None).await.unwrap(), "中文 🔐".len() as u64);
    assert_eq!(fs.read_file_text(&path, read_options(), None).await.unwrap(), "中文 🔐");
    let invalid_chunk = stream::iter(vec![Ok(Bytes::new())]).boxed();
    expect_error(fs.write_file_stream(&path, invalid_chunk, None).await, io::ErrorKind::InvalidInput);
    let too_large_chunk = stream::iter(vec![Ok(Bytes::from(vec![0; FILE_WRITE_CHUNK_SIZE + 1]))]).boxed();
    expect_error(fs.write_file_stream(&path, too_large_chunk, None).await, io::ErrorKind::InvalidInput);
    let too_much = stream::iter((0..3).map(|_| Ok(Bytes::from(vec![0; FILE_WRITE_CHUNK_SIZE])))).boxed();
    expect_error(fs.write_file_stream(&path, too_much, None).await, io::ErrorKind::InvalidData);
    let failing = stream::iter(vec![Ok(Bytes::from_static(b"partial")), Err(io::Error::other("dummy-body-that-must-not-escape"))]).boxed();
    let error = fs.write_file_stream(&path, failing, None).await.unwrap_err();
    assert!(!error.to_string().contains("dummy-body"));
    let pending = stream::once(async { Ok(Bytes::from_static(b"partial")) }).chain(stream::pending()).boxed();
    assert!(fs.write_file_stream(&path, pending, None).now_or_never().is_none());
    assert_eq!(fs.read_file_text(&path, read_options(), None).await.unwrap(), "中文 🔐");
    fs.write_file_stream(&path, stream::empty().boxed(), None).await.unwrap();
    assert!(fs.read_file(&path, read_options(), None).await.unwrap().is_empty());
    fs.write_file(&path, b"dummy-private-body\xff".to_vec(), write_options(), None).await.unwrap();
    let error = fs.read_file_text(&path, read_options(), None).await.unwrap_err();
    assert_eq!(error.kind(), io::ErrorKind::InvalidData);
    assert!(!format!("{error:?}").contains("dummy-private-body"));
}

#[tokio::test]
async fn configured_file_limit_rejects_read_and_write_without_truncation() {
    let (root, fs) = fixture(4);
    let path = uri("/candidate/small");
    fs.write_file(&path, b"keep".to_vec(), write_options(), None).await.unwrap();
    expect_error(fs.write_file(&path, b"larger".to_vec(), write_options(), None).await, io::ErrorKind::InvalidData);
    assert_eq!(fs.read_file(&path, read_options(), None).await.unwrap(), b"keep");
    std::fs::write(root.join("candidate/large"), b"too large").unwrap();
    expect_error(fs.read_file(&uri("/candidate/large"), read_options(), None).await, io::ErrorKind::InvalidData);
    expect_error(fs.read_file_stream(&uri("/candidate/large"), None).await, io::ErrorKind::InvalidData);
}

#[tokio::test]
async fn malformed_virtual_names_and_root_mutations_are_rejected() {
    let (root, fs) = fixture(4096);
    for raw in ["file:///candidate/a%2Fb", "file:///candidate/a%00b", "file:///candidate/%FF", "file:///candidate//file", "file:///candidate/file/", "file:///C:/candidate/file", "file://server/candidate/file"] {
        if let Ok(path) = PathUri::parse(raw) {
            expect_error(fs.read_file(&path, read_options(), None).await, io::ErrorKind::InvalidInput);
            expect_error(fs.write_file(&path, b"data".to_vec(), write_options(), None).await, io::ErrorKind::InvalidInput);
        }
    }
    // PathUri itself normalizes dot segments. The adapter receives that URI;
    // the resulting unmapped path is denied without probing a native path.
    let normalized = PathUri::parse("file:///candidate/../unmapped/file").unwrap();
    expect_error(fs.read_file(&normalized, read_options(), None).await, io::ErrorKind::PermissionDenied);
    expect_error(fs.write_file(&uri("/candidate"), b"data".to_vec(), write_options(), None).await, io::ErrorKind::InvalidInput);
    expect_error(fs.remove(&uri("/candidate"), remove_options(), None).await, io::ErrorKind::InvalidInput);
    assert_eq!(std::fs::read_dir(root.join("candidate")).unwrap().count(), 0);
}

#[tokio::test]
async fn unsupported_operations_do_not_report_fake_success() {
    let (_, fs) = fixture(4096);
    let path = uri("/candidate");
    expect_error(fs.watch_missing(vec![path.clone()], None).await, io::ErrorKind::Unsupported);
    expect_error(fs.read_directory(&path, None).await, io::ErrorKind::Unsupported);
    expect_error(fs.walk(&path, WalkOptions { max_depth: 1, max_directories: 1, max_entries: 10, follow_directory_symlinks: false, prune_hidden_directories: false }, None).await, io::ErrorKind::Unsupported);
    expect_error(fs.copy(&path, &uri("/candidate/copy"), CopyOptions { recursive: false }, None).await, io::ErrorKind::Unsupported);
    expect_error(fs.remove(&path, RemoveOptions { recursive: true, ..remove_options() }, None).await, io::ErrorKind::Unsupported);
    let directory = uri("/candidate/directory");
    fs.create_directory(&directory, mkdir_options(), None).await.unwrap();
    expect_error(fs.remove(&directory, remove_options(), None).await, io::ErrorKind::Unsupported);
    fs.remove(&uri("/candidate/missing"), RemoveOptions { force: true, ..remove_options() }, None).await.unwrap();
}

#[test]
fn overlapping_virtual_roots_and_invalid_limits_are_rejected() {
    let (root, _) = fixture(4096);
    let open = || ScopedFiles::open(&root.join("candidate"), Access::ReadWrite).unwrap();
    expect_error(ScopedExecutorFileSystem::new(vec![(uri("/work"), open()), (uri("/work/sub"), open())], 4096), io::ErrorKind::InvalidInput);
    expect_error(ScopedExecutorFileSystem::new(vec![(uri("/work"), open()), (uri("/w%6Frk"), open())], 4096), io::ErrorKind::InvalidInput);
    expect_error(ScopedExecutorFileSystem::new(vec![(uri("/work"), open())], 0), io::ErrorKind::InvalidInput);
    expect_error(ScopedExecutorFileSystem::new(vec![(uri("/work"), open())], MAX_BUFFERED_FILE_BYTES + 1), io::ErrorKind::InvalidInput);
}
