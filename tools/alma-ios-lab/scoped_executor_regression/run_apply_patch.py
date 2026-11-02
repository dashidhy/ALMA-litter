#!/usr/bin/env python3
"""Test the full actual apply-patch consumer; baseline failures are evidence."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SRC = ROOT / "shared/rust-bridge/codex-mobile-client/src"
UP = ROOT / "shared/third_party/codex/codex-rs"
BUILD = HERE / ".build"
TOOLCHAIN = ROOT.parent / "ALMA/.build/tauri-toolchain"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--upstream", type=Path, default=UP)
    parser.add_argument("--adapter", type=Path, default=SRC / "scoped_executor_fs.rs")
    parser.add_argument("--label", default="apply-patch-baseline")
    args = parser.parse_args()
    up = args.upstream.resolve()
    adapter = args.adapter.resolve()
    out = BUILD / args.label
    for folder in (out, out / "workspaces", out / "tmp"):
        folder.mkdir(parents=True, exist_ok=True)
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
    for name, path in [("codex-apply-patch", "apply-patch"), ("codex-exec-server", "exec-server"), ("codex-file-system", "file-system"), ("codex-protocol", "protocol"), ("codex-utils-path-uri", "utils/path-uri")]:
        manifest += f'{name}={{path={json.dumps(str(up/path))}}}\n'
    manifest += f'[[test]]\nname="actual_apply_patch"\npath={json.dumps(str(HERE/"apply_patch_tests.rs"))}\n[profile.dev]\ndebug=0\n'
    main_manifest = (ROOT / "shared/rust-bridge/Cargo.toml").read_text()
    patch_sections = main_manifest[main_manifest.index("[patch.crates-io]"):]
    patch_sections = re.sub(r'path\s*=\s*"([^\"]+)"', lambda m: 'path = ' + json.dumps(str((ROOT / "shared/rust-bridge" / m[1]).resolve())), patch_sections)
    manifest += patch_sections
    (out / "Cargo.toml").write_text(manifest)
    (out / "lib.rs").write_text(f'#[path={json.dumps(str(SRC/"scoped_files.rs"))}] pub mod scoped_files;\n#[path={json.dumps(str(adapter))}] pub mod scoped_executor_fs;\n')
    if not (out / "Cargo.lock").exists():
        shutil.copyfile(ROOT / "shared/rust-bridge/Cargo.lock", out / "Cargo.lock")
    env = dict(os.environ, RUSTUP_TOOLCHAIN="stable-aarch64-apple-darwin",
        RUSTUP_HOME=str(TOOLCHAIN/"rustup"), CARGO_HOME=str(TOOLCHAIN/"cargo"),
        CARGO_TARGET_DIR=str(BUILD/"target"), CARGO_BUILD_JOBS="2", TMPDIR=str(out/"tmp"),
        ALMA_APPLY_PATCH_WORKSPACE=str(out/"workspaces"))
    env["PATH"] = str(TOOLCHAIN/"cargo/bin") + os.pathsep + env["PATH"]
    for key in ("RUSTC", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS"):
        env.pop(key, None)
    command = [str(TOOLCHAIN/"cargo/bin/cargo"), "test", "--offline", "-j", "2", "--manifest-path", str(out/"Cargo.toml"), "--test", "actual_apply_patch", "--", "--test-threads=1", "--nocapture"]
    start = time.monotonic()
    with (out/"test-output.txt").open("w") as log:
        process = subprocess.Popen(command, env=env, cwd=HERE, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = process.wait(timeout=900)
        except subprocess.TimeoutExpired:
            import signal
            os.killpg(process.pid, signal.SIGTERM)
            process.wait()
            code = 124
    inputs = [adapter, SRC/"scoped_files.rs", up/"apply-patch/src/lib.rs", up/"apply-patch/src/parser.rs", up/"file-system/src/lib.rs", HERE/"apply_patch_tests.rs"]
    evidence = {"command": command, "exit_code": code, "elapsed_seconds": round(time.monotonic()-start, 2),
        "compiler": subprocess.check_output([str(TOOLCHAIN/"cargo/bin/rustc"), "--version"], env=env, text=True).strip(),
        "upstream_base_commit": subprocess.check_output(["git", "-C", str(UP), "rev-parse", "HEAD"], text=True).strip(),
        "upstream_source": str(up), "adapter_source": str(adapter), "build_jobs": 2,
        "scope": "actual full codex_apply_patch::apply_patch and exec-server consumer; no source-derived substitutes",
        "input_sha256": {str(path): hashlib.sha256(path.read_bytes()).hexdigest() for path in inputs}}
    (out/"evidence.json").write_text(json.dumps(evidence, indent=2)+"\n")
    output = (out/"test-output.txt").read_text()
    summaries = [line for line in output.splitlines() if line.startswith(("test ", "running ", "    Finished"))]
    print("\n".join(summaries) if summaries else output[-5000:])
    raise SystemExit(code)


if __name__ == "__main__":
    main()
