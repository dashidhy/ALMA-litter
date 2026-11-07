#!/usr/bin/env python3
"""Offline tests of the actual unintegrated module, with a cached libc crate."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tomllib

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCE = ROOT.parent / "ALMA-codex/ios/native/src/scoped_files.rs"
BUILD = HERE / ".build"
TOOLCHAIN = ROOT.parent / "ALMA/.build/tauri-toolchain"


def main():
    for directory in ("harness", "cargo-home", "target", "workspaces", "tmp"):
        (BUILD / directory).mkdir(parents=True, exist_ok=True)
    lock = tomllib.loads((ROOT / "shared/rust-bridge/Cargo.lock").read_text())
    versions = {package["version"] for package in lock["package"] if package["name"] == "libc"}
    if len(versions) != 1:
        raise RuntimeError("expected one existing locked libc version")
    version = versions.pop()
    candidates = list((TOOLCHAIN / "cargo/registry/src").glob(f"*/libc-{version}"))
    if len(candidates) != 1:
        raise RuntimeError(f"locked libc {version} must already be cached; no downloads")
    libc = candidates[0]
    # Separate workspace, source file used directly as the library. No mobile
    # manifest/lib.rs edits, source rewriting, replacement libc, or syscall stubs.
    manifest = BUILD / "harness/Cargo.toml"
    manifest.write_text(f'''[package]
name = "alma-scoped-files-regression"
version = "0.0.0"
edition = "2024"

[workspace]

[lib]
path = {json.dumps(str(SOURCE))}

[[test]]
name = "scoped_files"
path = {json.dumps(str(HERE / "tests.rs"))}

[dependencies]
libc = {{ path = {json.dumps(str(libc))} }}
''')
    env = dict(os.environ,
               RUSTUP_TOOLCHAIN="stable-aarch64-apple-darwin",
               RUSTUP_HOME=str(TOOLCHAIN / "rustup"),
               CARGO_HOME=str(BUILD / "cargo-home"),
               CARGO_TARGET_DIR=str(BUILD / "target"),
               TMPDIR=str(BUILD / "tmp"),
               RUSTFLAGS="-Dwarnings",
               ALMA_SCOPED_TEST_WORKSPACE=str(BUILD / "workspaces"))
    env["PATH"] = str(TOOLCHAIN / "cargo/bin") + os.pathsep + env["PATH"]
    for key in ("RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "CARGO_ENCODED_RUSTFLAGS", "RUSTC"):
        env.pop(key, None)
    cargo = TOOLCHAIN / "cargo/bin/cargo"
    rustc = TOOLCHAIN / "cargo/bin/rustc"
    compiler = subprocess.run([str(rustc), "--version"], env=env, check=True,
                              text=True, capture_output=True).stdout.strip()
    runs = []
    commands = [
        ("host-tests", ["test", "--offline", "-j", "2", "--manifest-path", str(manifest),
                        "--target", "aarch64-apple-darwin", "--", "--test-threads=1"]),
        ("ios-compile", ["build", "--offline", "-j", "2", "--manifest-path", str(manifest),
                         "--target", "aarch64-apple-ios", "--lib"]),
    ]
    for name, arguments in commands:
        result = subprocess.run([str(cargo), *arguments], env=env, cwd=HERE,
                                text=True, capture_output=True)
        (BUILD / f"{name}.stdout.txt").write_text(result.stdout)
        (BUILD / f"{name}.stderr.txt").write_text(result.stderr)
        if result.returncode:
            print(result.stdout)
            print(result.stderr)
            result.check_returncode()
        summaries = [line for line in result.stdout.splitlines() if line.startswith("test result:")]
        print(f"{name}: " + ("; ".join(summaries) if summaries else "passed (library compiled; not linked or run)"))
        runs.append({"name": name, "exit_code": result.returncode, "test_summaries": summaries})
    evidence = {
        "compiler": compiler,
        "toolchain": env["RUSTUP_TOOLCHAIN"],
        "libc_version": version,
        "source_sha256": hashlib.sha256(SOURCE.read_bytes()).hexdigest(),
        "tests_sha256": hashlib.sha256((HERE / "tests.rs").read_bytes()).hexdigest(),
        "runs": runs,
        "scope": "ordinary operations in owned temporary workspaces; no adversarial host-access probes",
        "integration": "unintegrated; no full mobile build or device test",
    }
    (BUILD / "evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")


if __name__ == "__main__":
    main()
