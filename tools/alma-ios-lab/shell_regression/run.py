#!/usr/bin/env python3
"""Offline source-derived Rust checks; all generated files stay in .build/."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tarfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SOURCE = ROOT / "shared/rust-bridge/codex-mobile-client/src"
BUILD = HERE / ".build"
TOOLCHAIN = ROOT.parent / "ALMA/.build/tauri-toolchain"
ENV = dict(os.environ, RUSTUP_TOOLCHAIN="stable-aarch64-apple-darwin",
           RUSTUP_HOME=str(TOOLCHAIN / "rustup"), CARGO_HOME=str(TOOLCHAIN / "cargo"))
RUSTC = TOOLCHAIN / "cargo/bin/rustc"
ARCHIVES = {
    "0.166.0": ("codex-0.166.0.tar.gz", "codex-rust-v0.166.0"),
    "0.155.1": ("codex-be2951ea.tar.gz", "codex-be2951ea34f0d295ed0becf97079f92fa5f6950e"),
}


def run(args, **kwargs):
    kwargs.setdefault("check", True)
    return subprocess.run([str(arg) for arg in args], env=ENV, **kwargs)


def item(source, declaration, indent=""):
    """Copy a complete Rust item through its equally-indented closing brace."""
    pattern = rf"^{re.escape(indent + declaration)}[^\n]*\n.*?^{indent}\}}"
    found = re.search(pattern, source, re.M | re.S)
    if not found:
        raise ValueError(f"upstream item not found: {declaration}")
    return found[0]


def main():
    BUILD.mkdir(exist_ok=True)
    compiler = run([RUSTC, "--version"], capture_output=True, text=True).stdout.strip()
    print(compiler, flush=True)
    # Both source archives pin shlex 1.3.0. Compile the already cached library,
    # without Cargo resolution, workspace builds, downloads, or cache writes.
    candidates = list((TOOLCHAIN / "cargo/registry/src").glob("*/shlex-1.3.0/src/lib.rs"))
    if len(candidates) != 1:
        raise RuntimeError("expected one cached shlex-1.3.0 source")
    shlex_rlib = BUILD / "libshlex.rlib"
    run([RUSTC, "--crate-name", "shlex", "--crate-type", "rlib", "--edition=2015",
         "-A", "mismatched_lifetime_syntaxes", "--cfg", 'feature="std"', candidates[0], "-o", shlex_rlib])
    evidence = {"compiler": compiler, "toolchain": ENV["RUSTUP_TOOLCHAIN"], "runs": []}
    for version, (archive, prefix) in ARCHIVES.items():
        archive_path = HERE.parent / ".cache" / archive
        with tarfile.open(archive_path) as tar:
            def read(relative):
                return tar.extractfile(f"{prefix}/codex-rs/{relative}").read().decode()

            parse = read("shell-command/src/parse_command.rs")
            bash = read("shell-command/src/bash.rs")
            powershell = read("shell-command/src/powershell.rs")
            detect = read("shell-command/src/shell_detect.rs")
            shell = read("core/src/shell.rs")
            cargo_lock = read("Cargo.lock")
            assert 'name = "shlex"\nversion = "1.3.0"' in cargo_lock
        parser = "\n".join([
            "use std::path::PathBuf; use shlex::try_join as shlex_try_join;",
            item(detect, "pub enum ShellType"),
            item(detect, "pub fn detect_shell_type("),
            re.search(r"^const POWERSHELL_FLAGS:.*;$", powershell, re.M)[0],
            item(powershell, "pub fn extract_powershell_command("),
            item(bash, "pub fn extract_bash_command("),
            item(parse, "pub fn extract_shell_command("),
            item(parse, "pub fn shlex_join("),
            "pub struct Shell { pub shell_type: ShellType, pub shell_path: PathBuf }",
            "impl Shell {\n" + item(shell, "pub fn derive_exec_args(", "    ") + "\n}",
        ])
        for platform in ("ios", "android"):
            out = BUILD / f"{version}-{platform}"
            out.mkdir(exist_ok=True)
            (out / "parser.rs").write_text(parser)
            # Exercise platform policy on the macOS host without lying to std
            # about its OS. Only the Android cfg selector is changed; bodies,
            # tests, and the iOS command/streaming functions are copied verbatim.
            for name in ("shell_preflight", "mobile_exec_command"):
                source = (SOURCE / f"{name}.rs").read_text()
                source = source.replace('target_os = "android"', "alma_android")
                if name == "shell_preflight":
                    source += '\n#[cfg(not(alma_android))]\npub fn install() {}\n'
                (out / f"{name}.rs").write_text(source)
            headers = "\n".join([
                '#![allow(dead_code)]',
                '#[path="parser.rs"] pub mod parse_command;',
                '#[path="shell_preflight.rs"] mod shell_preflight;',
                '#[path="mobile_exec_command.rs"] mod mobile_exec_command;',
                f'#[path={json.dumps(str(SOURCE / "shell_quoting.rs"))}] mod shell_quoting;',
                f'#[path={json.dumps(str(HERE / "legacy_ish_exec.rs"))}] mod ish_exec;',
            ])
            (out / "harness.rs").write_text(headers + "\n" + (HERE / "harness.rs").read_text())
            binary = out / "regression"
            args = [RUSTC, "--test", "--edition=2024", out / "harness.rs",
                    "--extern", f"shlex={shlex_rlib}", "-o", binary]
            if platform == "android":
                args.extend(["--cfg", "alma_android"])
            run(args)
            result = run([binary, "--test-threads=1", "--nocapture"], capture_output=True,
                         text=True, cwd=out, check=False)
            (out / "stdout.txt").write_text(result.stdout)
            (out / "stderr.txt").write_text(result.stderr)
            if result.returncode:
                print(result.stdout)
                print(result.stderr)
                result.check_returncode()
            # Check actual eprintln output, including apply_patch errors. Test
            # sentinels live in commands, cwd, output, and stub error bodies.
            forbidden = ["PRIVATE_", "秘密", "🔐", "preview=", "cat <<", "BASH_VERSION"]
            assert not any(token in result.stderr for token in forbidden), result.stderr
            if platform == "ios":
                for token in ("run argc=", "run(streaming) argc=", "elapsed_ms=",
                              "output_len=", "exit=23", "exit(streaming)=23",
                              "error_kind=apply_failed", "error_kind=invalid_cwd",
                              "error_kind=runtime_setup"):
                    assert token in result.stderr, token
            summary = next(line for line in result.stdout.splitlines() if line.startswith("test result:"))
            print(f"Codex {version}, {platform} policy: {summary}; log scan passed", flush=True)
            evidence["runs"].append({"version": version, "policy": platform, "result": summary,
                                     "log_scan": "passed", "archive_sha256": hashlib.sha256(archive_path.read_bytes()).hexdigest(),
                                     "parser_sha256": hashlib.sha256(parser.encode()).hexdigest()})
    evidence["module_sha256"] = {name: hashlib.sha256((SOURCE / name).read_bytes()).hexdigest()
                                 for name in ("shell_preflight.rs", "mobile_exec_command.rs")}
    evidence["legacy_hook_sha256"] = hashlib.sha256((HERE / "legacy_ish_exec.rs").read_bytes()).hexdigest()
    (BUILD / "evidence.json").write_text(json.dumps(evidence, indent=2) + "\n")


if __name__ == "__main__":
    main()
