#!/usr/bin/env python3
"""Offline, fail-closed patch checks. Writes only inside this patch directory.

No Git repository/index/config is created; git apply runs outside the enclosing
worktree via GIT_CEILING_DIRECTORIES. No Cargo/network/device operations.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile


HERE = Path(__file__).resolve().parent
REPO = HERE.parent.parent
LAB_CACHE = REPO / "tools/alma-ios-lab/.cache"
TARGET_COMMIT = "6ff1e1ca3b30fc8b914720681fcf5fe62e95f856"
TARGET_ARCHIVE_SHA = "718c86dcd7104919f2820aa79db0fa0083b5f240aa16da704f43e4acf7b544e5"
OLD_COMMIT = "be2951ea34f0d295ed0becf97079f92fa5f6950e"
OLD_ARCHIVE_SHA = "cd5a884836b53422052989479c6662f06e2ee8bb768c1a86a5ff7326b887d4d6"
ALLOWED_TARGETS = {
    "mobile-crypto-compat.patch": ["codex-rs/Cargo.toml"],
    "thread-read-permissions.patch": [
        "codex-rs/app-server-protocol/src/protocol/v2/thread.rs",
        "codex-rs/app-server/src/request_processors/thread_processor.rs",
        "codex-rs/app-server/tests/suite/v2/thread_read.rs",
    ],
    "ios-shell-snapshot-timeout.patch": ["codex-rs/core/src/shell_snapshot.rs"],
    "mxc-desktop-platform.patch": [
        "codex-rs/mxc-sandbox/Cargo.toml",
        "codex-rs/mxc-sandbox/src/lib.rs",
    ],
}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def tree_hashes(root):
    result = {}
    for path in sorted(root.rglob("*")):
        if path.is_symlink():
            result[str(path.relative_to(root))] = "symlink:" + os.readlink(path)
        elif path.is_file():
            result[str(path.relative_to(root))] = digest(path)
    return result


def verify_archive(archive_path, source, expected_sha):
    require(digest(archive_path) == expected_sha, f"archive hash mismatch: {archive_path}")
    entries = {}
    with tarfile.open(archive_path) as archive:
        for member in archive.getmembers():
            relative = Path(*Path(member.name).parts[1:])
            require(not relative.is_absolute() and ".." not in relative.parts, "unsafe archive path")
            if member.isfile():
                stream = archive.extractfile(member)
                require(stream is not None, f"missing archive member: {member.name}")
                entries[str(relative)] = hashlib.sha256(stream.read()).hexdigest()
            elif member.issym():
                entries[str(relative)] = "symlink:" + member.linkname
            else:
                require(member.isdir(), f"unsupported archive member: {member.name}")
    require(entries == tree_hashes(source), f"source differs from pinned archive: {source}")
    return {"archive_sha256": expected_sha, "verified_entries": len(entries)}, entries


def git_apply(root, patch, *options):
    env = dict(os.environ)
    # Do not inherit a caller's alternate repository or index.
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
        env.pop(key, None)
    env["GIT_CEILING_DIRECTORIES"] = str(root.parent.resolve())
    args = ["git", "apply", "--whitespace=error-all", *options, str(patch)]
    completed = subprocess.run(args, cwd=root, env=env, capture_output=True, text=True, timeout=30)
    return {
        "ok": completed.returncode == 0,
        "returncode": completed.returncode,
        "detail": (completed.stdout + completed.stderr).strip(),
    }


def series(name):
    entries = [line.strip() for line in (HERE / name).read_text().splitlines()
               if line.strip() and not line.startswith("#")]
    require(all(entry in ALLOWED_TARGETS for entry in entries), f"unknown patch in {name}")
    return entries


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", default="reports/verification.json",
                        help="report path relative to this patch directory")
    args = parser.parse_args()
    output = (HERE / args.output).resolve()
    require(output.is_relative_to(HERE) and not output.exists(), "report must be new and inside patch directory")
    source = LAB_CACHE / "codex-rust-v0.166.0"
    old_source = LAB_CACHE / ("codex-" + OLD_COMMIT)
    target_info, source_hashes = verify_archive(LAB_CACHE / "codex-0.166.0.tar.gz", source, TARGET_ARCHIVE_SHA)
    old_info, old_hashes = verify_archive(LAB_CACHE / "codex-be2951ea.tar.gz", old_source, OLD_ARCHIVE_SHA)
    original_dir = REPO / "patches/codex"
    originals_before = tree_hashes(original_dir)
    sync_path = REPO / "apps/ios/scripts/sync-codex.sh"
    sync_before = digest(sync_path)
    original_names = re.findall(r'"\$REPO_DIR/patches/codex/([^"/]+\.patch)"', sync_path.read_text())
    required, optional = series("series"), series("series.optional")
    names = required + optional
    require(len(set(names)) == len(names), "duplicate patch")
    require(set(names) == set(ALLOWED_TARGETS), "incomplete series")
    cache = HERE / ".cache"
    cache.mkdir(exist_ok=True)
    report = {
        "scope": "strict patch applicability and source integrity only; not build or runtime acceptance",
        "target_commit": TARGET_COMMIT,
        "old_commit": OLD_COMMIT,
        "target_baseline": target_info,
        "old_baseline": old_info,
        "required_series": required,
        "optional_series": optional,
        "original_patches_sha256": originals_before,
        "sync_script_sha256": sync_before,
    }
    with tempfile.TemporaryDirectory(prefix="verify-", dir=cache) as temp:
        root = Path(temp)
        work = root / "target"
        shutil.copytree(source, work, symlinks=True)
        report["original_independent_checks_on_target"] = {
            name: git_apply(work, original_dir / name, "--check") for name in original_names
        }
        # Only inspect the original hooks/selected patches on the old baseline;
        # the source itself remains read-only and no unrelated patch is installed.
        old_work = root / "old"
        old_work.mkdir()
        old_names = ["mobile-crypto-compat.patch", "ios-exec-hook.patch",
                     "thread-read-permissions.patch", "mobile-shell-snapshot-timeout.patch"]
        for name in old_names:
            paths = re.findall(r"^--- a/(.+)$", (original_dir / name).read_text(), re.M)
            for path in paths:
                target = old_work / path
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(old_source / path, target)
        report["selected_original_independent_checks_on_old"] = {}
        for name in old_names:
            result = git_apply(old_work, original_dir / name, "--check")
            report["selected_original_independent_checks_on_old"][name] = result
            require(result["ok"], f"original does not match old baseline: {name}")
        patch_results = []
        for name in names:
            patch = HERE / name
            paths = re.findall(r"^\+\+\+ b/(.+)$", patch.read_text(), re.M)
            require(sorted(paths) == sorted(ALLOWED_TARGETS[name]), f"unexpected scope: {name}")
            check = git_apply(work, patch, "--check")
            require(check["ok"], f"strict apply check failed: {name}: {check}")
            apply = git_apply(work, patch)
            require(apply["ok"], f"apply failed: {name}")
            reverse = git_apply(work, patch, "--reverse", "--check")
            require(reverse["ok"], f"reverse check failed: {name}")
            duplicate = git_apply(work, patch, "--check")
            require(not duplicate["ok"], f"duplicate application accepted: {name}")
            patch_results.append({
                "name": name, "sha256": digest(patch), "targets": paths,
                "strict_check": check, "apply": apply, "reverse_check": reverse,
                "duplicate_forward_rejected": True,
                "before_sha256": {p: source_hashes[p] for p in paths},
                "after_sha256": {p: digest(work / p) for p in paths},
            })
        work_hashes = tree_hashes(work)
        changed = sorted(p for p in set(work_hashes) | set(source_hashes)
                         if work_hashes.get(p) != source_hashes.get(p))
        expected = sorted(p for name in names for p in ALLOWED_TARGETS[name])
        require(changed == expected, "unexpected change outside patch targets")
        report["patches"] = patch_results
        report["changed_source_paths"] = changed
        report["all_other_upstream_files_identical"] = True
        # Verify full-state reverse detection too, not just immediately after applying.
        for name in names:
            require(git_apply(work, HERE / name, "--reverse", "--check")["ok"],
                    f"full stack reverse detection failed: {name}")
        for name in reversed(names):
            require(git_apply(work, HERE / name, "--reverse", "--check")["ok"], "reverse check failed")
            require(git_apply(work, HERE / name, "--reverse")["ok"], "reverse failed")
        require(tree_hashes(work) == source_hashes, "reverse did not restore pristine tree")
        report["reverse_restores_pristine_tree"] = True
    require(tree_hashes(source) == source_hashes, "target source was modified")
    require(tree_hashes(old_source) == old_hashes, "old source was modified")
    require(tree_hashes(original_dir) == originals_before, "original patches were modified")
    require(digest(sync_path) == sync_before, "sync script was modified")
    report["inputs_unchanged"] = True
    report["not_verified"] = [
        "Rust type checking and integration tests", "Cargo dependency resolution and lockfile regeneration",
        "generated protocol schemas", "iOS compilation/linking", "iSH exec backend and cancellation",
        "filesystem/network enforcement", "phone/background/auth/Web/TAH execution",
    ]
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"report": str(output), "verified_patches": names,
                      "strict_apply_and_reverse": "passed", "runtime_verified": False}, indent=2))


if __name__ == "__main__":
    main()
