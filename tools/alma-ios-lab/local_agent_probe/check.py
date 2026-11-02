#!/usr/bin/env python3
"""Bounded source validation/type-check only. Never link, install, or launch iOS."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parent


def run(command, path, env):
    result = subprocess.run(command, env=env, text=True, capture_output=True, timeout=180)
    path.write_text(result.stdout + result.stderr)
    if result.returncode:
        print(result.stdout + result.stderr)
        result.check_returncode()
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=["shell", "bound"], default="shell")
    args = parser.parse_args()
    out = HERE / ".build" / args.mode
    manifest_path = out / "compile-manifest.json"
    if not manifest_path.exists(): raise SystemExit("Run prepare.py for this mode first.")
    manifest = json.loads(manifest_path.read_text())
    for directory in (out / "tmp", out / "module-cache"):
        directory.mkdir(exist_ok=True)
    env = dict(os.environ, TMPDIR=str(out / "tmp"), DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer")
    sdk = subprocess.check_output(["xcrun", "--sdk", "iphoneos", "--show-sdk-path"], env=env, text=True).strip()
    swiftc = subprocess.check_output(["xcrun", "--find", "swiftc"], env=env, text=True).strip()
    source = "\n".join(path.read_text() for path in (HERE / "Sources").glob("*.swift"))
    # Probe sources do not parse upstream protocol JSON or create startup tasks.
    for forbidden in ("JSONSerialization", "JSONDecoder", ".onAppear", ".task(", ".task {", "LLog.", "print(", "NSLog("):
        if forbidden in source: raise SystemExit(f"Probe source audit failed: {forbidden}")
    if "cwd: QualificationWorkspace.output" not in source:
        raise SystemExit("Thread start must use the fixed qualification cwd.")
    flags = ["-parse-as-library", "-swift-version", "5", "-strict-concurrency=targeted", "-warnings-as-errors", "-module-cache-path", str(out / "module-cache")]
    command = [swiftc, "-typecheck", *flags, "-target", "arm64-apple-ios18.0", "-sdk", sdk]
    if args.mode == "bound":
        command += ["-D", "PROBE_HAS_BINDINGS", "-I", manifest["headers"]]
    command += manifest["compile_sources"]
    run(command, out / "ios-typecheck.txt", env)
    checks = {"ios_typecheck": "passed", "actual_generated_bindings_typechecked": args.mode == "bound", "no_launch_or_network": True}
    if args.mode == "shell":
        gate_sources = [HERE / "Sources/TrustedBootstrap.swift", HERE / "Sources/ProbeModel.swift", out / "ProbeBuildReadiness.swift", HERE / "Tests/GateTests.swift"]
        binary = out / "gate-tests"
        host_sdk = subprocess.check_output(["xcrun", "--sdk", "macosx", "--show-sdk-path"], env=env, text=True).strip()
        run([swiftc, *flags, "-sdk", host_sdk, "-target", "arm64-apple-macos14.0", *map(str, gate_sources), "-o", str(binary)], out / "gates-compile.txt", env)
        result = run([str(binary)], out / "gates-output.txt", env)
        print(result.stdout.strip())
        checks["disabled_gate_host_test"] = "passed; actual ProbeModel and disabled bootstrap, no generated API stubs"
    checks["compiler"] = subprocess.run([swiftc, "--version"], env=env, text=True, capture_output=True, check=True).stdout.strip()
    checks["command"] = command
    checks["source_sha256"] = {path: hashlib.sha256(Path(path).read_bytes()).hexdigest() for path in manifest["compile_sources"]}
    checks["limits"] = "type-check only; no iOS link, installation, login, account RPC or model task executed"
    (out / "check-evidence.json").write_text(json.dumps(checks, indent=2) + "\n")
    print(f"PASS: {args.mode} iOS SDK type-check; no app link/install/launch")


if __name__ == "__main__":
    main()
