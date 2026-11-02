#!/usr/bin/env python3
"""Create review patches and an isolated full-source checkout; never edit upstream."""
import difflib
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
UPROOT = ROOT / "shared/third_party/codex"
PROPOSAL = ROOT / "patches/codex-fs-preflight"
STAGE = HERE / ".build/preflight-proposal"


def replace_once(source, old, new):
    if source.count(old) != 1:
        raise RuntimeError("proposal source anchor is missing or ambiguous")
    return source.replace(old, new, 1)


def main():
    PROPOSAL.mkdir(parents=True, exist_ok=True)
    snapshot = STAGE / "source"
    snapshot.mkdir(parents=True, exist_ok=True)
    # Copy complete actual source files, including existing mobile changes.
    # No extracted declarations, stub crates, or symlinks back to mutable source.
    files = subprocess.check_output(["git", "-C", str(UPROOT), "ls-files", "-z", "--cached", "--others", "--exclude-standard"]).split(b"\0")
    count = 0
    for raw in files:
        if not raw:
            continue
        relative = Path(raw.decode())
        source = UPROOT / relative
        if not source.exists():
            continue
        destination = snapshot / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source.is_symlink() and destination.is_symlink():
            if source.readlink() != destination.readlink():
                raise RuntimeError("snapshot symlink changed; use a fresh proposal directory")
        else:
            shutil.copy2(source, destination, follow_symlinks=False)
        count += 1

    base = {}
    changes = {}
    fs_path = "codex-rs/file-system/src/lib.rs"
    base[fs_path] = (UPROOT / fs_path).read_text()
    declarations = '''/// A potential file mutation, described before any operation is performed.
/// Paths belong to the selected executor, not necessarily the host filesystem.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FileSystemMutation {
    WriteFile { path: PathUri, create_parents: bool },
    RemoveFile { path: PathUri },
}

/// Optional whole-batch authorization supplied by a filesystem implementation.
/// This check must not mutate files. It does not reserve paths or replace the
/// per-operation sandbox checks, and does not promise rollback for I/O/content
/// failures after authorization. Implementations must inspect the entire batch
/// against their own authority and the supplied sandbox context.
pub trait FileSystemMutationPreflight: Send + Sync {
    fn preflight_mutations(
        &self,
        mutations: &[FileSystemMutation],
        sandbox: Option<&FileSystemSandboxContext>,
    ) -> FileSystemResult<()>;
}

'''
    text = replace_once(base[fs_path], "/// Abstract filesystem access used by components", declarations + "/// Abstract filesystem access used by components")
    hook = '''pub trait ExecutorFileSystem: Send + Sync {
    /// Optional batch authorization. None explicitly means that no additional
    /// batch check is available; existing per-operation behavior is unchanged.
    /// Callers must not interpret None as successful batch authorization.
    fn mutation_preflight(&self) -> Option<&dyn FileSystemMutationPreflight> {
        None
    }

'''
    changes[fs_path] = replace_once(text, "pub trait ExecutorFileSystem: Send + Sync {\n", hook)

    exec_path = "codex-rs/exec-server/src/lib.rs"
    base[exec_path] = (UPROOT / exec_path).read_text()
    changes[exec_path] = replace_once(base[exec_path], "pub use codex_file_system::FileMetadata;", "pub use codex_file_system::FileMetadata;\npub use codex_file_system::FileSystemMutation;\npub use codex_file_system::FileSystemMutationPreflight;")

    apply_path = "codex-rs/apply-patch/src/lib.rs"
    base[apply_path] = (UPROOT / apply_path).read_text()
    text = replace_once(base[apply_path], "use codex_exec_server::ExecutorFileSystem;", "use codex_exec_server::ExecutorFileSystem;\nuse codex_exec_server::FileSystemMutation;")
    preflight = '''    // Hunks come from the official parser (or the typed apply_hunks API).
    // Resolve the entire plan before metadata reads, writes, parent creation,
    // or deletions. In particular, Hunk::path() names a move destination, so
    // use resolve_path() to retain the source authorization check as well.
    if let Some(preflight) = fs.mutation_preflight() {
        let mut mutations = Vec::new();
        for hunk in hunks {
            let path = hunk.resolve_path(cwd)?;
            match hunk {
                Hunk::AddFile { .. } => mutations.push(FileSystemMutation::WriteFile {
                    path,
                    create_parents: true,
                }),
                Hunk::DeleteFile { .. } => mutations.push(FileSystemMutation::RemoveFile { path }),
                Hunk::UpdateFile { move_path: Some(destination), .. } => {
                    mutations.push(FileSystemMutation::RemoveFile { path });
                    mutations.push(FileSystemMutation::WriteFile {
                        path: cwd.join(&destination.to_string_lossy())?,
                        create_parents: true,
                    });
                }
                Hunk::UpdateFile { move_path: None, .. } => mutations.push(FileSystemMutation::WriteFile {
                    path,
                    create_parents: false,
                }),
            }
        }
        preflight.preflight_mutations(&mutations, sandbox)?;
    }

'''
    changes[apply_path] = replace_once(text, "    let mut added: Vec<PathBuf> = Vec::new();", preflight + "    let mut added: Vec<PathBuf> = Vec::new();")

    adapter_relative = "shared/rust-bridge/codex-mobile-client/src/scoped_executor_fs.rs"
    adapter_base = (ROOT / adapter_relative).read_text()
    adapter_impl = '''impl FileSystemMutationPreflight for ScopedExecutorFileSystem {
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

'''
    adapter = replace_once(adapter_base, "impl ExecutorFileSystem for ScopedExecutorFileSystem {", adapter_impl + '''impl ExecutorFileSystem for ScopedExecutorFileSystem {
    fn mutation_preflight(&self) -> Option<&dyn FileSystemMutationPreflight> {
        Some(self)
    }
''')
    core_patch = ""
    for path, contents in changes.items():
        (snapshot / path).write_text(contents)
        core_patch += ''.join(difflib.unified_diff(base[path].splitlines(True), contents.splitlines(True), fromfile="a/"+path, tofile="b/"+path))
    (PROPOSAL / "codex-batch-preflight.patch").write_text(core_patch)
    adapter_patch = ''.join(difflib.unified_diff(adapter_base.splitlines(True), adapter.splitlines(True), fromfile="a/"+adapter_relative, tofile="b/"+adapter_relative))
    (PROPOSAL / "scoped-adapter-preflight.patch").write_text(adapter_patch)
    adapter_path = STAGE / adapter_relative
    adapter_path.parent.mkdir(parents=True, exist_ok=True)
    adapter_path.write_text(adapter)
    metadata = {
        "upstream_commit": subprocess.check_output(["git", "-C", str(UPROOT), "rev-parse", "HEAD"], text=True).strip(),
        "copied_files": count,
        "base_sha256": {path: hashlib.sha256(text.encode()).hexdigest() for path, text in base.items()},
        "adapter_base_sha256": hashlib.sha256(adapter_base.encode()).hexdigest(),
        "core_patch_sha256": hashlib.sha256(core_patch.encode()).hexdigest(),
        "adapter_patch_sha256": hashlib.sha256(adapter_patch.encode()).hexdigest(),
        "status": "proposal only; applied solely to isolated source snapshot, never the actual submodule or production adapter",
    }
    (PROPOSAL / "base.json").write_text(json.dumps(metadata, indent=2)+"\n")
    print(f"Prepared proposal using {count} complete source files; actual source unchanged.")
    print("Proposed upstream:", snapshot / "codex-rs")
    print("Proposed adapter:", adapter_path)


if __name__ == "__main__":
    main()
