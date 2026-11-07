#!/usr/bin/env python3
"""Real Codex filesystem trait consumer, offline and capped at two build jobs."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SRC = ROOT.parent / "ALMA-codex/ios/native/src"
UP = ROOT.parent / "ALMA-codex/codex-rs"
BUILD = HERE / ".build"
TOOLCHAIN = ROOT.parent / "ALMA/.build/tauri-toolchain"


def main():
    for folder in ("workspaces", "tmp"):
        (BUILD / folder).mkdir(parents=True, exist_ok=True)
    manifest = '''[package]
name="alma-scoped-executor-regression"
version="0.0.0"
edition="2024"
[workspace]
[lib]
path="lib.rs"
[dependencies]
libc="0.2"
bytes="1"
futures="0.3"
tokio={version="1",features=["rt","macros","sync"]}
'''
    for name, path in [("codex-file-system", "file-system"), ("codex-protocol", "protocol"), ("codex-utils-path-uri", "utils/path-uri")]:
        manifest += f'{name}={{path={json.dumps(str(UP/path))}}}\n'
    manifest += f'''[[test]]
name="adapter"
path={json.dumps(str(HERE / "tests.rs"))}
[[test]]
name="primitive"
path={json.dumps(str(HERE.parent / "scoped_files_regression/tests.rs"))}
[profile.dev]
debug=0
'''
    # The existing primitive tests import their original harness crate name.
    # A dependency alias to this library is supplied in a generated test wrapper
    # instead of copying or rewriting either production module.
    manifest = manifest.replace(json.dumps(str(HERE.parent / "scoped_files_regression/tests.rs")), '"primitive.rs"')
    (BUILD / "primitive.rs").write_text('extern crate alma_scoped_executor_regression as alma_scoped_files_regression;\n'
        + f'#[path={json.dumps(str(HERE.parent / "scoped_files_regression/tests.rs"))}] mod tests;\n')
    (BUILD / "Cargo.toml").write_text(manifest)
    (BUILD / "lib.rs").write_text(''.join(f'#[path={json.dumps(str(SRC/(name+".rs")))}]\npub mod {name};\n'
        for name in ["execution_fence", "scoped_files", "scoped_executor_fs"]) + 'pub use scoped_files::{Access, ScopedFiles};\n')
    # Preserve locked/yanked transitive versions (notably spin 0.9.8). Cargo
    # prunes this local copy; the real workspace lockfile remains untouched.
    if not (BUILD / "Cargo.lock").exists():
        shutil.copyfile(ROOT / "shared/rust-bridge/Cargo.lock", BUILD / "Cargo.lock")
    env = dict(os.environ, RUSTUP_TOOLCHAIN="stable-aarch64-apple-darwin",
        RUSTUP_HOME=str(TOOLCHAIN / "rustup"), CARGO_HOME=str(TOOLCHAIN / "cargo"),
        CARGO_TARGET_DIR=str(BUILD / "target"), CARGO_BUILD_JOBS="2", TMPDIR=str(BUILD / "tmp"),
        ALMA_EXECUTOR_TEST_WORKSPACE=str(BUILD / "workspaces"), ALMA_SCOPED_TEST_WORKSPACE=str(BUILD / "workspaces"))
    env["PATH"] = str(TOOLCHAIN / "cargo/bin") + os.pathsep + env["PATH"]
    for key in ("RUSTC", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS"):
        env.pop(key, None)
    command = [str(TOOLCHAIN / "cargo/bin/cargo"), "test", "--offline", "-j", "2", "--manifest-path", str(BUILD / "Cargo.toml"), "--", "--test-threads=1"]
    started = time.monotonic()
    # The caller can poll this log while compilation proceeds. No whole mobile
    # build, source copies of the trait, or upstream filesystem stubs are used.
    with (BUILD / "test-output.txt").open("w") as log:
        process = subprocess.Popen(command, env=env, cwd=HERE, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=600)
        except subprocess.TimeoutExpired:
            import signal
            os.killpg(process.pid, signal.SIGTERM)
            process.wait()
            code = 124
    inputs = [SRC / "scoped_files.rs", SRC / "scoped_executor_fs.rs", UP / "file-system/src/lib.rs", UP / "protocol/src/permissions.rs", UP / "utils/path-uri/src/lib.rs", HERE / "tests.rs"]
    evidence = {
        "command": command, "exit_code": code, "elapsed_seconds": round(time.monotonic() - started, 2),
        "compiler": subprocess.check_output([str(TOOLCHAIN / "cargo/bin/rustc"), "--version"], env=env, text=True).strip(),
        "upstream_commit": subprocess.check_output(["git", "-C", str(UP), "rev-parse", "HEAD"], text=True).strip(),
        "source_sha256": {str(path.relative_to(ROOT)): hashlib.sha256(path.read_bytes()).hexdigest() for path in inputs},
        "scope": "host tests against actual codex-file-system/protocol/path-uri crates; no full mobile or actual apply-patch consumer build",
        "policy": "actual resolve_access/can_write_path for literal/root policies; unsupported contexts rejected before IO",
    }
    (BUILD / "evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")
    output = (BUILD / "test-output.txt").read_text()
    print("\n".join(line for line in output.splitlines() if line.startswith(("test result:", "error", "   Compiling alma-", "    Finished"))))
    if code: print(output[-5000:])
    raise SystemExit(code)


if __name__ == "__main__":
    main()
