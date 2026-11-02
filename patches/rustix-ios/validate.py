#!/usr/bin/env python3
"""Bounded official-release comparison; writes only below this directory/.cache.

Requires Python 3.12+ (tomllib and tarfile's data filter), curl, and an existing
Rust 1.99.0 toolchain with aarch64-apple-ios installed. No tool installation.
"""

import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import time
import tomllib


HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"
# Observed in https://index.crates.io/ru/st/rustix on 2026-11-01; not lockfile pins.
RELEASES = {
    "1.1.5": "891efababe418670775f199f0d233d84843c227a0949a883ce15b37c78d6629d",
    "1.1.6": "e5e76742e5294153d4dde1207dbec5bdd81eef6fabdc0d2118babadabfd858aa",
}
LOCKED = {
    "rustix": "1.1.4", "libc": "0.2.191", "bitflags": "2.13.2",
    "errno": "0.3.14", "linux-raw-sys": "0.12.1",
    "windows-sys": "0.61.2", "windows-link": "0.2.1",
}


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def unpack(name, version, checksum, cache, sources, archive_cache):
    filename = f"{name}-{version}.crate"
    original = archive_cache / filename
    archive = original if original.is_file() else cache / filename
    if not archive.is_file():
        subprocess.run([
            "curl", "--fail", "--location", "--silent", "--show-error",
            "--connect-timeout", "10", "--max-time", "45", "--output", str(archive),
            f"https://static.crates.io/crates/{name}/{filename}",
        ], check=True, timeout=50)
    require(digest(archive.read_bytes()) == checksum, f"Checksum mismatch: {archive}")
    crate = sources / f"{name}-{version}"
    # Extract only regular files/directories beneath the expected crate root.
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        for member in members:
            path = Path(member.name)
            require(not path.is_absolute() and ".." not in path.parts
                    and path.parts[0] == crate.name
                    and (member.isfile() or member.isdir()),
                    f"Unexpected archive member: {member.name}")
        bundle.extractall(sources, members=members, filter="data")
    # Cargo directory-source metadata; crate contents themselves stay unmodified.
    hashes = {str(p.relative_to(crate)): digest(p.read_bytes())
              for p in sorted(crate.rglob("*")) if p.is_file()}
    (crate / ".cargo-checksum.json").write_text(json.dumps({
        "package": checksum, "files": hashes,
    }) + "\n")
    return {"name": name, "version": version, "checksum": checksum}


def main():
    sibling_toolchain = ROOT.parent / "ALMA/.build/tauri-toolchain"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--toolchain", type=Path, default=sibling_toolchain /
                        "rustup/toolchains/stable-aarch64-apple-darwin")
    parser.add_argument("--archive-cache", type=Path, default=sibling_toolchain /
                        "cargo/registry/cache/index.crates.io-1949cf8c6b5b557f")
    args = parser.parse_args()
    toolchain = args.toolchain.resolve()
    rustc, cargo = toolchain / "bin/rustc", toolchain / "bin/cargo"
    compiler = subprocess.check_output([str(rustc), "-Vv"], text=True, timeout=10)
    require("release: 1.99.0\n" in compiler, "Validation requires existing Rust 1.99.0")
    require((toolchain / "lib/rustlib/aarch64-apple-ios/lib").is_dir(),
            "Existing toolchain has no iOS std; this script does not install it")

    lockpath = ROOT / "shared/rust-bridge/Cargo.lock"
    lock_bytes = lockpath.read_bytes()
    packages = tomllib.loads(lock_bytes.decode())["package"]
    checksums = {}
    for name, version in LOCKED.items():
        matches = [p for p in packages if p["name"] == name and p["version"] == version
                   and p.get("source") == REGISTRY and p.get("checksum")]
        require(len(matches) == 1, f"Expected one locked {name} {version}; re-review if changed")
        checksums[name] = matches[0]["checksum"]

    cache = HERE / ".cache"
    cache.mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix="validation-", dir=cache))
    print(f"Evidence: {run}", flush=True)
    sources, cargo_home = run / "sources", run / "cargo-home"
    sources.mkdir()
    cargo_home.mkdir()
    archives = [unpack(n, v, checksums[n], run, sources, args.archive_cache)
                for n, v in LOCKED.items()]
    archives += [unpack("rustix", v, sha, run, sources, args.archive_cache)
                 for v, sha in RELEASES.items()]
    (cargo_home / "config.toml").write_text(
        '[source.crates-io]\nreplace-with = "verified-archives"\n'
        '[source.verified-archives]\ndirectory = ' + json.dumps(str(sources)) + '\n')
    # Use a minimal environment: no inherited rustflags, wrappers, target overrides,
    # shared Cargo/Rustup home, or profile overrides. The toolchain is already installed.
    env = {k: os.environ[k] for k in ("HOME", "TMPDIR", "DEVELOPER_DIR", "SDKROOT")
           if k in os.environ}
    env.update(PATH=f"{toolchain / 'bin'}:/usr/bin:/bin:/usr/sbin:/sbin",
               CARGO_HOME=str(cargo_home), CARGO_TARGET_DIR=str(run / "target"),
               RUSTC=str(rustc), CARGO_BUILD_JOBS="2", CARGO_NET_OFFLINE="true")
    results = []
    for version, target, expected in [
        ("1.1.4", "aarch64-apple-ios", ["AF_SYS_CONTROL", "SYSPROTO_EVENT", "SYSPROTO_CONTROL"]),
        ("1.1.5", "aarch64-apple-ios", ["crate::timespec"]),
        ("1.1.6", "aarch64-apple-ios", []),
        ("1.1.6", "aarch64-apple-darwin", []),
    ]:
        case = run / f"rustix-{version}-{target}"
        case.mkdir()
        shutil.copyfile(HERE / "consumer.rs", case / "lib.rs")
        (case / "Cargo.toml").write_text(
            '[workspace]\n\n[package]\nname = "rustix-ios-net-probe"\n'
            'version = "0.0.0"\nedition = "2021"\npublish = false\n'
            '[lib]\npath = "lib.rs"\n[dependencies]\n'
            f'rustix = {{ version = "={version}", features = ["net"] }}\n'
            'libc = "=0.2.191"\n')
        # Only this small standalone crate is built; no parent workspace discovery.
        common = [str(cargo), "--offline", "--manifest-path", str(case / "Cargo.toml")]
        subprocess.run([common[0], "generate-lockfile", *common[1:]],
                       cwd=case, env=env, check=True, timeout=30, capture_output=True)
        command = [common[0], "build", *common[1:], "--locked", "--lib",
                   "--target", target, "--jobs", "2"]
        started = time.monotonic()
        completed = subprocess.run(command, cwd=case, env=env, text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=120)
        (case / "build.log").write_text(completed.stdout)
        resolved = tomllib.loads((case / "Cargo.lock").read_text())["package"]
        require(any(p["name"] == "libc" and p["version"] == "0.2.191" for p in resolved),
                "libc version changed")
        result = {"rustix": version, "target": target, "exit_code": completed.returncode,
                  "seconds": round(time.monotonic() - started, 2), "command": command,
                  "expected_errors": expected, "log": str(case / "build.log"),
                  "packages": [{k: p[k] for k in ("name", "version", "checksum") if k in p}
                               for p in resolved]}
        results.append(result)
        (run / "results.json").write_text(json.dumps({
            "compiler": compiler, "lockfile_sha256": digest(lock_bytes),
            "archives": archives, "results": results,
        }, indent=2) + "\n")
        if expected:
            require(completed.returncode != 0 and all(s in completed.stdout for s in expected),
                    f"Unexpected negative control result; see {case / 'build.log'}")
        else:
            require(completed.returncode == 0, f"Build failed; see {case / 'build.log'}")
        print(f"rustix {version} {target}: "
              f"{'expected failure' if expected else 'PASS'} ({result['seconds']}s)", flush=True)
    print(f"PASS: official rustix 1.1.6 + libc 0.2.191; evidence {run / 'results.json'}")


if __name__ == "__main__":
    main()
