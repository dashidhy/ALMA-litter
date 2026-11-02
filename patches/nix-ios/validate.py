#!/usr/bin/env python3
"""Isolated nix compatibility checks; Rust 1.99.0, at most two jobs per build."""

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import tomllib

sys.dont_write_bytecode = True
import prepare as prep

ACTUAL = {
    "0.28.0": ["fs", "ioctl", "poll", "process", "signal", "term"],
    "0.29.0": ["feature", "fs", "memoffset", "mount", "net", "process", "sched", "signal", "socket", "term", "uio", "user"],
    "0.30.1": ["feature"],
    "0.31.2": ["fs", "mman", "poll", "process", "signal"],
}
OFFICIAL_0313 = "cf20d2fde8ff38632c426f1165ed7436270b44f199fc55284c38276f9db47c3d"
IOS, MAC = "aarch64-apple-ios", "aarch64-apple-darwin"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--toolchain", type=Path, default=prep.ROOT.parent /
                        "ALMA/.build/tauri-toolchain/rustup/toolchains/stable-aarch64-apple-darwin")
    parser.add_argument("--archive-cache", type=Path, default=prep.ARCHIVES)
    args = parser.parse_args()
    toolchain = args.toolchain.resolve()
    rustc, cargo = toolchain / "bin/rustc", toolchain / "bin/cargo"
    compiler = subprocess.check_output([str(rustc), "-Vv"], text=True, timeout=10)
    prep.require("release: 1.99.0\n" in compiler, "Existing Rust 1.99.0 required")
    prep.require((toolchain / f"lib/rustlib/{IOS}/lib").is_dir(), "iOS std must already be installed")
    cache = prep.HERE / ".cache"
    cache.mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix="validation-", dir=cache))
    print(f"Evidence: {run}", flush=True)
    sources = run / "sources"
    sources.mkdir()
    packages = prep.locked_packages()
    reviewed = json.loads((prep.HERE / "patches.json").read_text())
    for version in ACTUAL:
        prep.require(prep.nix_checksum([{"name": "nix", "version": version}], version, reviewed[version])
                     == reviewed[version]["archive_sha256"], "Post-patch lock provenance failed")
        for changed in [[], [{"name": "nix", "version": version, "source": "git+unreviewed"}],
                        [{"name": "nix", "version": version, "source": prep.REGISTRY, "checksum": "0" * 64}]]:
            try:
                prep.nix_checksum(changed, version, reviewed[version])
            except RuntimeError:
                pass
            else:
                raise RuntimeError("Changed nix selection accepted")
    inputs = [("nix", v) for v in ACTUAL] + [
        ("libc", "0.2.191"), ("bitflags", "2.13.2"), ("cfg-if", "1.0.4"),
        ("cfg_aliases", "0.1.1"), ("cfg_aliases", "0.2.2"),
        ("memoffset", "0.9.1"), ("autocfg", "1.5.1"),
    ]
    archive_hashes = {}
    for name, version in inputs + [("nix", "0.31.3")]:
        checksum = (OFFICIAL_0313 if (name, version) == ("nix", "0.31.3") else
                    prep.nix_checksum(packages, version, reviewed[version]) if name == "nix" else
                    prep.locked_checksum(packages, name, version))
        source = prep.unpack(name, version, checksum, sources, args.archive_cache)
        archive_hashes[f"{name}-{version}"] = checksum
        (source / ".cargo-checksum.json").write_text(json.dumps({
            "package": checksum, "files": prep.inventory(source),
        }) + "\n")
    patched = {v: prep.prepare(v, run / "patched", args.archive_cache) for v in ACTUAL}
    # Verify preparation is idempotent and never silently overwrites a changed copy.
    prep.require(prep.prepare("0.29.0", run / "patched", args.archive_cache) == patched["0.29.0"],
                 "Repeat preparation failed")
    sentinel = patched["0.29.0"] / "local-edit-sentinel"
    sentinel.write_text("preserve this local edit\n")
    try:
        prep.prepare("0.29.0", run / "patched", args.archive_cache)
    except RuntimeError as error:
        prep.require("refusing to overwrite" in str(error), "Wrong dirty-copy failure")
        prep.require(sentinel.read_text() == "preserve this local edit\n", "Local edit overwritten")
    else:
        raise RuntimeError("Dirty source was accepted")
    finally:
        sentinel.unlink()
    # Exercise checksum rejection without touching the original archive cache.
    corrupt = run / "corrupt"
    corrupt.mkdir()
    (corrupt / "nix-0.29.0.crate").write_bytes(b"not the reviewed archive")
    try:
        prep.unpack("nix", "0.29.0", archive_hashes["nix-0.29.0"], run / "bad", corrupt)
    except RuntimeError as error:
        prep.require("checksum mismatch" in str(error), "Wrong checksum failure")
    else:
        raise RuntimeError("Corrupt archive was accepted")

    cargo_home = run / "cargo-home"
    cargo_home.mkdir()
    (cargo_home / "config.toml").write_text(
        '[source.crates-io]\nreplace-with = "verified"\n'
        '[source.verified]\ndirectory = ' + json.dumps(str(sources)) + '\n')
    env = {k: os.environ[k] for k in ("HOME", "TMPDIR", "DEVELOPER_DIR", "SDKROOT") if k in os.environ}
    env.update(PATH=f"{toolchain / 'bin'}:/usr/bin:/bin:/usr/sbin:/sbin", RUSTC=str(rustc),
               CARGO_HOME=str(cargo_home), CARGO_TARGET_DIR=str(run / "target"),
               CARGO_NET_OFFLINE="true", CARGO_BUILD_JOBS="2")
    results = []
    report = {"compiler": compiler, "archive_sha256": archive_hashes,
              "project_lock_sha256": prep.sha((prep.ROOT / "shared/rust-bridge/Cargo.lock").read_bytes()),
              "prepare_checks": ["idempotent", "dirty destination refused", "corrupt archive refused",
                                 "post-patch lock provenance", "missing/changed selections refused"],
              "results": results}

    def case(version, target, features, fixed=False, expected=(), unavailable=False, label="net"):
        directory = run / f"{len(results):02d}-{version}-{target}-{label}"
        directory.mkdir()
        markers = ([] if version == "0.28.0" else ["has-utun"]) + (["with-ioctl"] if "ioctl" in features else [])
        manifest = ('[workspace]\n[package]\nname = "nix-ios-probe"\nversion = "0.0.0"\n'
                    'edition = "2021"\npublish = false\n[lib]\npath = "lib.rs"\n'
                    '[features]\nhas-utun = []\nwith-ioctl = []\ndefault = ' + json.dumps(markers) + '\n'
                    '[dependencies]\nlibc = "=0.2.191"\n'
                    f'nix = {{ version = "={version}", features = {json.dumps(features)} }}\n')
        if fixed:
            manifest += '\n[patch.crates-io]\nnix = { path = ' + json.dumps(str(patched[version])) + ' }\n'
        (directory / "Cargo.toml").write_text(manifest)
        source = ((prep.HERE / "consumer.rs").read_text() if "net" in features
                  else "pub const EINTR: nix::errno::Errno = nix::errno::Errno::EINTR;\n")
        if unavailable:
            source = ('pub use nix::sys::socket::SysControlAddr;\n'
                      'pub const CONTROL: nix::sys::socket::SockProtocol = nix::sys::socket::SockProtocol::KextControl;\n')
            if version != "0.28.0":
                source += 'pub use nix::sys::socket::sockopt::UtunIfname;\n'
        (directory / "lib.rs").write_text(source)
        command = [str(cargo), "generate-lockfile", "--offline", "--manifest-path", str(directory / "Cargo.toml")]
        locked = subprocess.run(command, cwd=directory, env=env, text=True, capture_output=True, timeout=30)
        prep.require(locked.returncode == 0, locked.stdout + locked.stderr)
        command = [str(cargo), "test" if target == MAC and "net" in features else "build",
                   "--offline", "--locked", "--manifest-path", str(directory / "Cargo.toml"),
                   "--lib", "--target", target, "--jobs", "2"]
        started = time.monotonic()
        completed = subprocess.run(command, cwd=directory, env=env, text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
        (directory / "build.log").write_text(completed.stdout)
        result = {"version": version, "target": target, "features": features, "patched": fixed,
                  "label": label, "expected_errors": list(expected), "exit_code": completed.returncode,
                  "seconds": round(time.monotonic() - started, 2), "command": command,
                  "log": str(directory / "build.log")}
        results.append(result)
        (run / "results.json").write_text(json.dumps(report, indent=2) + "\n")
        if expected:
            prep.require(completed.returncode != 0 and all(s in completed.stdout for s in expected),
                         f"Unexpected negative control: {result['log']}")
        else:
            prep.require(completed.returncode == 0, f"Build failed: {result['log']}")
        print(f"{version} {target} {label} patched={fixed}: "
              f"{'expected failure' if expected else 'PASS'}", flush=True)

    for version in ["0.28.0", "0.30.1", "0.31.2"]:
        for target in ([MAC] if version == "0.30.1" else [IOS, MAC]):
            case(version, target, ACTUAL[version], label="actual")
    case("0.29.0", IOS, ACTUAL["0.29.0"], expected=["SYSPROTO_CONTROL", "UTUN_OPT_IFNAME"], label="actual")
    case("0.31.3", IOS, ["net", "ioctl"], expected=["SYSPROTO_CONTROL", "UTUN_OPT_IFNAME"], label="official-candidate")
    for version in ACTUAL:
        case(version, IOS, ["net", "ioctl"], expected=["SYSPROTO_CONTROL", "AF_SYS_CONTROL"], label="latent")
        for target in [IOS, MAC]:
            case(version, target, ["net", "ioctl"], fixed=True)
        missing = ["KextControl", "SysControlAddr"] + ([] if version == "0.28.0" else ["UtunIfname"])
        case(version, IOS, ["net", "ioctl"], fixed=True, expected=missing, unavailable=True, label="absent-api")
    for target in [IOS, MAC]:
        case("0.29.0", target, ACTUAL["0.29.0"], fixed=True, label="actual")
    print(f"PASS: {len(results)} bounded cases; {run / 'results.json'}")


if __name__ == "__main__":
    main()
