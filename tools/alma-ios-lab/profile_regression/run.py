#!/usr/bin/env python3
"""Offline actual ConfigToml/feature consumer tests, reusing the host cache.

No bridge/core/device build, model requests, auth or network actions. Stop the
build at a time or disk-growth bound; never delete another helper's cache.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import time

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
UP = ROOT.parent / "ALMA-codex/codex-rs"
SOURCE = ROOT.parent / "ALMA-codex/ios/native/src/alma_local_profile.rs"
BUILD = HERE / ".build"


def disk_bytes(path):
    if not path.exists():
        return None
    result = subprocess.run(["du", "-sk", str(path)], text=True, capture_output=True)
    if result.returncode or not result.stdout.split():
        return None  # Another lane can remove shared cache files during du.
    return int(result.stdout.split()[0]) * 1024


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--target-dir", type=Path, default=HERE.parent / "scoped_executor_regression/.build/target")
    parser.add_argument("--toolchain", type=Path, default=ROOT.parent / "ALMA/.build/tauri-toolchain")
    parser.add_argument("--mac-profile", type=Path, default=ROOT.parent / "ALMA/app/TAH/providers/codex/adapter/src/native-profile.ts")
    parser.add_argument("--max-seconds", type=int, default=240)
    parser.add_argument("--max-growth-mib", type=int, default=768)
    parser.add_argument("--allow-cold-cache", action="store_true", help="explicitly allow a bounded build without cached Codex config artifacts")
    args = parser.parse_args()
    if not args.allow_cold_cache and not any((args.target_dir / "debug/deps").glob("libcodex_config-*.rlib")):
        parser.error("host config cache is absent; select an existing --target-dir or explicitly use --allow-cold-cache (no build started)")
    args.target_dir.mkdir(parents=True, exist_ok=True)
    BUILD.mkdir(parents=True, exist_ok=True)
    manifest = '''[package]
name="alma-local-profile-regression"
version="0.0.0"
edition="2024"
[workspace]
[lib]
path="lib.rs"
[dependencies]
serde_json="1"
toml={version="0.9",features=["preserve_order"]}
'''
    for name, path in [("codex-config", "config"), ("codex-features", "features"), ("codex-protocol", "protocol")]:
        manifest += f'{name}={{path={json.dumps(str(UP / path))}}}\n'
    manifest += "[profile.dev]\ndebug=0\nincremental=false\n"
    workspace = (ROOT / "shared/rust-bridge/Cargo.toml").read_text()
    patches = workspace[workspace.index("[patch.crates-io]"):]
    patches = re.sub(r'path\s*=\s*"([^\"]+)"', lambda m: 'path = ' + json.dumps(str((ROOT / "shared/rust-bridge" / m[1]).resolve())), patches)
    (BUILD / "Cargo.toml").write_text(manifest + patches)
    (BUILD / "lib.rs").write_text(
        f'#[path={json.dumps(str(SOURCE))}] mod alma_local_profile;\n'
        f'#[cfg(test)] #[path={json.dumps(str(HERE / "tests.rs"))}] mod tests;\n')
    if not (BUILD / "Cargo.lock").exists():
        shutil.copyfile(ROOT / "shared/rust-bridge/Cargo.lock", BUILD / "Cargo.lock")
    env = dict(os.environ, CARGO_HOME=str(args.toolchain / "cargo"),
               RUSTUP_HOME=str(args.toolchain / "rustup"), RUSTUP_TOOLCHAIN="stable-aarch64-apple-darwin",
               CARGO_TARGET_DIR=str(args.target_dir.resolve()), CARGO_BUILD_JOBS="2",
               ALMA_MAC_NATIVE_PROFILE=str(args.mac_profile.resolve()))
    env["PATH"] = str(args.toolchain / "cargo/bin") + os.pathsep + env["PATH"]
    for key in ["RUSTC", "RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS"]:
        env.pop(key, None)
    command = [str(args.toolchain / "cargo/bin/cargo"), "test", "--offline", "--lib", "--manifest-path", str(BUILD / "Cargo.toml"), "-j", "2", "--", "--test-threads=1"]
    start = time.monotonic()
    before = disk_bytes(args.target_dir)
    if before is None:
        parser.error("host cache changed during disk measurement; no build started")
    after = before
    reason = None
    with (BUILD / "output.txt").open("w") as log:
        process = subprocess.Popen(command, cwd=HERE, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        while process.poll() is None:
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                after = disk_bytes(args.target_dir)
                if after is None:
                    reason = "shared cache disappeared or changed during disk measurement"
                elif time.monotonic() - start > args.max_seconds:
                    reason = "time bound exceeded"
                elif after - before > args.max_growth_mib * 1024 * 1024:
                    reason = "disk growth bound exceeded"
                if reason:
                    try:
                        os.killpg(process.pid, signal.SIGTERM)
                    except ProcessLookupError:
                        pass
                    try:
                        process.wait(timeout=5)
                    except subprocess.TimeoutExpired:
                        os.killpg(process.pid, signal.SIGKILL)
                        process.wait()
        code = process.returncode if reason is None else 124
    inputs = [SOURCE, HERE / "tests.rs", HERE / "run.py", args.mac_profile,
              UP / "features/src/lib.rs", UP / "config/src/config_toml.rs", UP / "config/src/merge.rs"]
    after = disk_bytes(args.target_dir)
    report = {
        "exit_code": code, "bounded_stop_reason": reason, "command": command,
        "elapsed_seconds": round(time.monotonic() - start, 2),
        "target_growth_bytes": None if after is None else after - before,
        "upstream_commit": subprocess.check_output(["git", "-C", str(UP), "rev-parse", "HEAD"], text=True).strip(),
        "sha256": {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs},
        "scope": "actual codex-config ConfigToml, strict validation and recursive merge; actual codex-features resolution; unchanged production module",
        "not_verified": ["full core ConfigBuilder materialization/managed requirements", "session wiring", "local RPC rejection", "iOS/device"],
    }
    (HERE / "last-attempt.json").write_text(json.dumps(report, indent=2) + "\n")
    if code == 0:
        (HERE / "results.json").write_text(json.dumps(report, indent=2) + "\n")
        shutil.copyfile(BUILD / "output.txt", BUILD / "last-pass-output.txt")
    output = (BUILD / "output.txt").read_text()
    print(output[-12000:])
    print(json.dumps({k: report[k] for k in ["exit_code", "elapsed_seconds", "target_growth_bytes", "bounded_stop_reason"]}))
    raise SystemExit(code)


if __name__ == "__main__":
    main()
