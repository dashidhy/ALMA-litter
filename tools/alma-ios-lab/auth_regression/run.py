#!/usr/bin/env python3
"""Compile the production refresh method with in-memory, offline test doubles."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCE = ROOT / "apps/ios/Sources/Litter/Models/ChatGPTOAuth.swift"
BUILD = HERE / ".build"


def extract(source, declaration, indent=""):
    match = re.search(
        rf"^{re.escape(indent + declaration)}[^\n]*\n.*?^{indent}\}}",
        source, re.M | re.S,
    )
    if match is None:
        raise RuntimeError(f"production declaration not found: {declaration}")
    return match[0]


def main():
    BUILD.mkdir(exist_ok=True)
    for folder in ("tmp", "module-cache"):
        (BUILD / folder).mkdir(exist_ok=True)
    env = dict(os.environ, TMPDIR=str(BUILD / "tmp"),
               CLANG_MODULE_CACHE_PATH=str(BUILD / "module-cache"))
    source = SOURCE.read_text()
    assert "@MainActor\nenum ChatGPTOAuth {" in source
    methods = [
        extract(source, "static func refreshStoredTokens(", "    "),
        extract(source, "static func tokenBundle(", "    "),
        extract(source, "private static func resolveAccountID(", "    "),
        extract(source, "private static func resolvePlanType(", "    "),
        extract(source, "private static func decodeJWTClaims(", "    "),
    ]
    derived = "\n\n".join([
        "import Foundation\nimport Security",
        extract(source, "struct ChatGPTOAuthTokenBundle:"),
        extract(source, "enum ChatGPTOAuthError:"),
        "@MainActor\nenum ChatGPTOAuth {\n" + "\n\n".join(methods) + "\n}",
    ]) + "\n"
    # The actual network and Keychain implementation are never compiled.
    for forbidden in ("URLSession", "SecItemCopyMatching", "SecItemAdd", "LLog."):
        assert forbidden not in derived
    derived_path = BUILD / "Production.swift"
    derived_path.write_text(derived)
    version = subprocess.run(["/usr/bin/swiftc", "--version"], env=env,
                             text=True, capture_output=True, check=True).stdout.strip()
    evidence = {"compiler": version, "source_sha256": hashlib.sha256(source.encode()).hexdigest(),
                "derived_sha256": hashlib.sha256(derived.encode()).hexdigest(), "runs": []}

    def build_and_run(name, production, mode, extra_args=()):
        binary = BUILD / name
        compile_command = ["/usr/bin/swiftc", "-parse-as-library", "-swift-version", mode,
                           "-strict-concurrency=" + ("targeted" if mode == "5" else "complete"),
                           "-warnings-as-errors", "-module-cache-path", str(BUILD / "module-cache"),
                           str(production), str(HERE / "Harness.swift"), "-o", str(binary)]
        compiled = subprocess.run(compile_command, env=env, text=True, capture_output=True)
        (BUILD / f"{name}.compile.txt").write_text(compiled.stdout + compiled.stderr)
        if compiled.returncode:
            print(compiled.stderr)
            compiled.check_returncode()
        result = subprocess.run([str(binary), *extra_args], env=env, cwd=BUILD,
                                text=True, capture_output=True)
        (BUILD / f"{name}.stdout.txt").write_text(result.stdout)
        (BUILD / f"{name}.stderr.txt").write_text(result.stderr)
        # Never print tokens or account values, even though all are artificial.
        assert not result.stderr, "unexpected test stderr; inspect local evidence"
        for sentinel in ("DUMMY_SECRET_", "dummy-account-", "eyJ"):
            assert sentinel not in result.stdout, "test output included fixture content"
        return result

    for mode in ("5", "6"):
        result = build_and_run(f"swift-{mode}", derived_path, mode)
        if result.returncode:
            print(result.stdout, end="")
        result.check_returncode()
        print(f"Swift {mode}: {result.stdout.splitlines()[-1]}")
        evidence["runs"].append({"swift_mode": mode, "summary": result.stdout.splitlines()[-1],
                                 "output_scan": "passed"})

    # Restore only the audited conjunct in a generated copy. The same regression
    # must fail, demonstrating that the test detects the original acceptance bug.
    fixed = "refreshed.accountID != previousAccountID {"
    original = "refreshed.accountID != previousAccountID,\n           stored.accountID != previousAccountID {"
    assert derived.count(fixed) == 1
    control_path = BUILD / "OriginalGuard.swift"
    control_path.write_text(derived.replace(fixed, original, 1))
    control = build_and_run("original-guard-control", control_path, "5", ("--original-guard-control",))
    assert control.returncode == 1, "original guard unexpectedly passed regression"
    assert control.stdout == "FAIL expected_stored_match_refresh_mismatch: outcome\n"
    print("Original-guard negative control: rejected by regression as expected")
    evidence["original_guard_control"] = "expected failure reproduced"
    (BUILD / "evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")


if __name__ == "__main__":
    main()
