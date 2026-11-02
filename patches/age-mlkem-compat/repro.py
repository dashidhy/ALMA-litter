#!/usr/bin/env python3
"""Bounded, isolated dependency probe. All writes stay beside this script."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import signal
import subprocess
import tarfile
import time

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parent.parent
TOOLCHAIN = REPO.parent / "ALMA/.build/tauri-toolchain"
BIN = TOOLCHAIN / "rustup/toolchains/stable-aarch64-apple-darwin/bin"
WORK = ROOT / ".work"
EVIDENCE = ROOT / "evidence"
AGE_REV = "b5b68c4f4f7ea5c368bc060f6fe0237549c3a13f"
CLATTER_REV = "9a8d15c4f80d5911ca0403aa22e0de99ea59df08"


def run(label, args, *, expected=0, timeout=175, expected_text=None):
    """Kill the entire child process group before three minutes, including rustc."""
    started = time.monotonic()
    with (EVIDENCE / (label + ".log")).open("w") as log:
        log.write("$ " + " ".join(map(str, args)) + "\n")
        log.flush()
        p = subprocess.Popen(args, cwd=WORK, env=ENV, stdout=log,
                             stderr=subprocess.STDOUT, start_new_session=True)
        try:
            code = p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.wait()
            raise SystemExit(f"{label}: exceeded {timeout}s; process group stopped")
        elapsed = round(time.monotonic() - started, 2)
        log.write(f"\nexit={code}; elapsed_seconds={elapsed}\n")
    print(f"{label}: exit={code}, {elapsed}s", flush=True)
    if ((expected == 0 and code != 0) or (expected != 0 and code == 0)
            or (expected_text and expected_text not in (EVIDENCE / (label + ".log")).read_text())):
        print((EVIDENCE / (label + ".log")).read_text()[-6000:])
        raise SystemExit(f"Unexpected result for {label}")


def manifest(name, dependencies, extra="", source=""):
    p = WORK / name
    (p / "src").mkdir(parents=True, exist_ok=True)
    (p / "Cargo.toml").write_text(
        f'[package]\nname = "{name}"\nversion = "0.0.0"\nedition = "2024"\n'
        '[workspace]\nresolver = "3"\n[dependencies]\n' + dependencies + "\n" + extra)
    (p / "src/lib.rs").write_text(source or "// Dependency-resolution probe.\n")
    if not (p / "Cargo.lock").exists():
        # Preserve the actual graph's existing pins, including yanked-but-locked
        # transitive releases; this is an isolated copy, never a workspace update.
        saved = EVIDENCE / (name + ".Cargo.lock")
        shutil.copyfile(saved if saved.exists() else REPO / "shared/rust-bridge/Cargo.lock",
                        p / "Cargo.lock")
    return p / "Cargo.toml"


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["baseline", "pin", "upstream", "ios", "interop", "graph"])
    mode = parser.parse_args().mode
    EVIDENCE.mkdir(exist_ok=True)
    registry = WORK / "cargo-home/registry"
    registry.mkdir(parents=True, exist_ok=True)
    for part in ["index", "cache"]:
        if not (registry / part).exists():
            # APFS copy-on-write, separate inodes: never symlink the shared registry.
            subprocess.run(["cp", "-cR", str(TOOLCHAIN / "cargo/registry" / part),
                            str(registry / part)], check=True)
    ENV = os.environ.copy()
    for key in ["RUSTC_WRAPPER", "RUSTC_WORKSPACE_WRAPPER", "RUSTFLAGS",
                "CARGO_ENCODED_RUSTFLAGS", "CARGO_BUILD_TARGET"]:
        ENV.pop(key, None)
    ENV.update(CARGO_HOME=str(WORK / "cargo-home"), RUSTUP_HOME=str(TOOLCHAIN / "rustup"),
               RUSTUP_TOOLCHAIN="stable-aarch64-apple-darwin", RUSTC=str(BIN / "rustc"),
               RUSTDOC=str(BIN / "rustdoc"), PATH=str(BIN) + ":" + ENV["PATH"],
               CARGO_TARGET_DIR=str(WORK / "target"), CARGO_BUILD_JOBS="2",
               CARGO_INCREMENTAL="0", CARGO_PROFILE_DEV_DEBUG="0",
               CARGO_PROFILE_TEST_DEBUG="0", CARGO_HTTP_TIMEOUT="20", CARGO_NET_RETRY="1")
    cargo = str(BIN / "cargo")
    modern = 'modern = { package = "ml-kem", version = "=0.3.2" }\n'
    if mode in ["baseline", "pin"]:
        version = "0.2.1" if mode == "baseline" else "0.2.3"
        m = manifest("probe-" + mode, 'age = "=0.12.1"\n' + modern +
                     f'legacy = {{ package = "ml-kem", version = "={version}" }}\n')
        run(mode + "-resolve", [cargo, "tree", "--offline", "--manifest-path", str(m)],
            expected=0 if mode == "baseline" else 1, timeout=60,
            expected_text=None if mode == "baseline" else "failed to select a version for `kem`")
        if mode == "baseline":
            run("baseline-compile", [cargo, "check", "--offline", "--locked", "-j2",
                                     "--manifest-path", str(m), "-p", "ml-kem@0.2.1"], expected=1,
                expected_text="type `Error` is not a member of trait `::kem::Decapsulate`")
    else:
        archive = WORK / "rage.tar.gz"
        source = WORK / ("rage-" + AGE_REV)
        if not archive.exists():
            run("upstream-source-download", ["curl", "--fail", "--silent", "--show-error",
                "--max-time", "30", "-L", "https://codeload.github.com/str4d/rage/tar.gz/" + AGE_REV,
                "-o", str(archive)], timeout=35)
        expected_hash = json.loads((EVIDENCE / "rage-source.json").read_text())["sha256"]
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == expected_hash
        if not source.exists():
            with tarfile.open(archive) as tar:
                tar.extractall(WORK, filter="data")
        clatter = next((TOOLCHAIN / "cargo/git/checkouts").glob("clatter-*/9a8d15c"))
        deps = ('age = "=0.12.1"\n' + modern +
                f'clatter = {{ path = "{clatter}", default-features = false, features = '
                '["alloc", "getrandom", "use-25519", "use-aes-gcm", '
                '"use-rust-crypto-ml-kem", "use-sha"] }\n')
        # Exact upstream archive; path source avoids the environment's hanging Git fetch.
        # Integration uses the immutable Git pin documented in REPORT.md.
        patch = f'[patch.crates-io]\nage = {{ path = "{source / "age"}" }}\n'
        m = manifest("probe-upstream", deps, patch, (ROOT / "consumer.rs").read_text())
        # Upstream's public recipient fixture, without implementing any crypto here.
        fixture = re.search(r'pub\(crate\) const TEST_RECIPIENT: &str = "([^"]+)";',
                            (source / "age/src/native/tagpq.rs").read_text()).group(1)
        (m.parent / "src/tagpq-recipient.txt").write_text(fixture)
        if mode == "upstream":
            run("upstream-resolve", [cargo, "tree", "--manifest-path", str(m)], timeout=90)
            run("upstream-tree", [cargo, "tree", "--locked", "--manifest-path", str(m)], timeout=30)
            run("upstream-test", [cargo, "test", "--locked", "-j2", "--manifest-path", str(m),
                                  "--", "--test-threads=1"])
        elif mode == "ios":
            run("upstream-ios-check", [cargo, "check", "--locked", "-j2", "--manifest-path", str(m),
                                       "--target", "aarch64-apple-ios"])
        elif mode == "graph":
            ENV["CARGO_NET_GIT_FETCH_WITH_CLI"] = "true"
            git_patch = ('[patch.crates-io]\nage = { git = "https://github.com/str4d/rage", '
                         f'rev = "{AGE_REV}" }}\n')
            graph = manifest("probe-russh-graph", deps + 'russh = "=0.62.6"\n', git_patch)
            run("russh-graph", [cargo, "tree", "--manifest-path", str(graph)], timeout=90)
        else:
            old = manifest("probe-released", 'age = "=0.12.1"\n'
                           'legacy = { package = "ml-kem", version = "=0.2.3" }\n')
            (old.parent / "src/main.rs").write_text((ROOT / "released-consumer.rs").read_text())
            run("released-resolve", [cargo, "tree", "--offline", "--manifest-path", str(old)], timeout=60)
            run("released-encrypt", [cargo, "run", "--offline", "--locked", "-j2",
                                      "--manifest-path", str(old), "--", "encrypt", str(WORK)])
            ENV["AGE_COMPAT_FIXTURES"] = str(WORK)
            run("upstream-interop-test", [cargo, "test", "--offline", "--locked", "-j2",
                  "--manifest-path", str(m), "--", "--test-threads=1", "--include-ignored"])
            run("released-decrypt", [cargo, "run", "--offline", "--locked", "-j2",
                                      "--manifest-path", str(old), "--", "decrypt", str(WORK)])
