#!/usr/bin/env python3
"""Small offline Apple consumers with original features; no Codex/Iroh build."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import tomllib

sys.dont_write_bytecode = True
import prepare as prep

IOS, MAC = "aarch64-apple-ios", "aarch64-apple-darwin"
CANDIDATE_SHA = "096c44b66a9b09b99b4dd36b1c295ff3a492039ccecaf55466bd6ddcdba59968"


def index_path(name):
    if len(name) == 1:
        return "1/" + name
    if len(name) == 2:
        return "2/" + name
    if len(name) == 3:
        return "3/" + name[0] + "/" + name
    return name[:2] + "/" + name[2:4] + "/" + name


def closure(packages):
    pending = [p for p in packages if p["name"] == "netdev" and p["version"] == "0.45.0"]
    prep.require(len(pending) == 1, "Expected netdev 0.45.0 in project lock")
    seen = {}
    while pending:
        item = pending.pop()
        key = (item["name"], item["version"])
        if key in seen:
            continue
        seen[key] = item
        for dep in item.get("dependencies", []):
            parts = dep.split()
            matches = [p for p in packages if p["name"] == parts[0]
                       and (len(parts) == 1 or p["version"] == parts[1])]
            prep.require(len(matches) == 1, f"Ambiguous dependency {dep}")
            pending += matches
    return list(seen.values())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--toolchain", type=Path, default=prep.ROOT.parent /
                        "ALMA/.build/tauri-toolchain/rustup/toolchains/stable-aarch64-apple-darwin")
    parser.add_argument("--archive-cache", type=Path, default=prep.ARCHIVES)
    args = parser.parse_args()
    toolchain = args.toolchain.resolve()
    compiler = subprocess.check_output([str(toolchain / "bin/rustc"), "-Vv"], text=True, timeout=10)
    prep.require("release: 1.99.0\n" in compiler, "Existing Rust 1.99.0 required")
    prep.require((toolchain / f"lib/rustlib/{IOS}/lib").is_dir(), "iOS std must already be installed")
    cache = prep.HERE / ".cache"
    cache.mkdir(exist_ok=True)
    run = Path(tempfile.mkdtemp(prefix="validation-", dir=cache))
    print(f"Evidence: {run}", flush=True)
    reviewed = json.loads((prep.HERE / "patch.json").read_text())
    packages = prep.locked_packages()
    selected = closure(packages)
    registry_id = args.archive_cache.name
    original_index = args.archive_cache.parents[1] / "index" / registry_id
    cargo_home = run / "cargo-home"
    index = cargo_home / "registry/index" / registry_id
    archive_cache = cargo_home / "registry/cache" / registry_id
    index.mkdir(parents=True)
    archive_cache.mkdir(parents=True)
    shutil.copyfile(original_index / "config.json", index / "config.json")
    archive_hashes = {}
    metadata_only = []
    # Copy verified archives and cached index metadata, not shared extracted source.
    # Cargo will extract/compile only dependencies selected for the Apple consumer.
    for pkg in selected + [{"name": "netdev", "version": "0.45.1", "checksum": CANDIDATE_SHA}]:
        name, version = pkg["name"], pkg["version"]
        checksum = (prep.netdev_checksum(packages, version, reviewed) if
                    (name, version) == ("netdev", "0.45.0") else pkg["checksum"])
        filename = f"{name}-{version}.crate"
        archive = args.archive_cache / filename
        if not archive.is_file() and (name, version) == ("netdev", "0.45.1"):
            prep.unpack(name, version, checksum, run / "candidate", args.archive_cache)
            archive = prep.HERE / ".cache/archives" / filename
        metadata = original_index / ".cache" / index_path(name)
        data = metadata.read_bytes()
        entries = [json.loads(piece) for piece in data.split(b"\0") if piece.startswith(b'{"name":')]
        prep.require(any(p["vers"] == version and p["cksum"] == checksum for p in entries),
                     f"Cached registry metadata differs for {filename}")
        dest = index / ".cache" / index_path(name)
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(metadata, dest)
        if archive.is_file():
            prep.require(prep.sha(archive.read_bytes()) == checksum, f"Checksum mismatch: {archive}")
            shutil.copyfile(archive, archive_cache / filename)
            archive_hashes[filename] = checksum
        else:
            # Inactive platform/feature dependencies need metadata for resolution,
            # not archive downloads. Offline Cargo fails if any active input is missing.
            metadata_only.append(filename)
    source = prep.prepare(destination=run / "patched", archives=args.archive_cache)
    prep.require(prep.prepare(destination=run / "patched", archives=args.archive_cache) == source,
                 "Idempotent preparation failed")
    sentinel = source / "local-edit-sentinel"
    sentinel.write_text("preserve local changes\n")
    try:
        prep.prepare(destination=run / "patched", archives=args.archive_cache)
    except RuntimeError as error:
        prep.require("refusing to overwrite" in str(error) and sentinel.read_text() == "preserve local changes\n",
                     "Dirty destination was not protected")
    else:
        raise RuntimeError("Dirty destination accepted")
    finally:
        sentinel.unlink()
    corrupt = run / "corrupt"
    corrupt.mkdir()
    (corrupt / "netdev-0.45.0.crate").write_bytes(b"corrupt")
    try:
        prep.unpack("netdev", "0.45.0", reviewed["archive_sha256"], run / "bad", corrupt)
    except RuntimeError as error:
        prep.require("checksum mismatch" in str(error), "Wrong corruption error")
    else:
        raise RuntimeError("Corrupt archive accepted")
    prep.require(prep.netdev_checksum([{"name": "netdev", "version": "0.45.0"}], "0.45.0", reviewed)
                 == reviewed["archive_sha256"], "Post-patch lock provenance failed")
    # Enumeration, address ordering and scope handling must remain byte-identical.
    original = run / "original"
    original.mkdir()
    baseline = prep.unpack("netdev", "0.45.0", reviewed["archive_sha256"], original, args.archive_cache)
    for rel in ("src/os/unix/interface.rs", "src/os/ios/interface.rs", "Cargo.toml", "Cargo.toml.orig"):
        prep.require((source / rel).read_bytes() == (baseline / rel).read_bytes(), f"Unexpected change: {rel}")
    env = {k: os.environ[k] for k in ("HOME", "TMPDIR", "DEVELOPER_DIR", "SDKROOT") if k in os.environ}
    env.update(PATH=f"{toolchain / 'bin'}:/usr/bin:/bin:/usr/sbin:/sbin", RUSTC=str(toolchain / "bin/rustc"),
               CARGO_HOME=str(cargo_home), CARGO_TARGET_DIR=str(run / "target"),
               CARGO_NET_OFFLINE="true", CARGO_BUILD_JOBS="2")
    results = []
    report = {"compiler": compiler, "archives": archive_hashes, "metadata_only": metadata_only,
              "project_lock_sha256": prep.sha((prep.ROOT / "shared/rust-bridge/Cargo.lock").read_bytes()),
              "prepare_checks": ["archive/patch/file checksums", "idempotent", "dirty destination refused",
                                 "corrupt archive refused", "post-patch lock provenance", "enumeration sources unchanged"],
              "results": results}
    for version, target, fixed, action, expected in [
        ("0.45.0", IOS, False, "build", "in6_ifreq"),
        ("0.45.1", IOS, False, "build", "in6_ifreq"),
        ("0.45.0", MAC, False, "test", None),
        ("0.45.0", IOS, True, "build", None),
        ("0.45.0", IOS, True, "check", None),
        ("0.45.0", MAC, True, "test", None),
    ]:
        case = run / f"{len(results)}-{version}-{target}-{action}"
        case.mkdir()
        manifest = ('[workspace]\n[package]\nname = "netdev-ios-probe"\nversion = "0.0.0"\n'
                    'edition = "2024"\npublish = false\n[lib]\npath = "lib.rs"\n'
                    '[features]\npatched = []\n[dependencies]\nlibc = "=0.2.191"\n'
                    f'netdev = "={version}"\n')
        if fixed:
            manifest += '[patch.crates-io]\nnetdev = { path = ' + json.dumps(str(source)) + ' }\n'
        (case / "Cargo.toml").write_text(manifest)
        shutil.copyfile(prep.HERE / "consumer.rs", case / "lib.rs")
        common = ["--manifest-path", str(case / "Cargo.toml"), "--offline"]
        generated = subprocess.run([str(toolchain / "bin/cargo"), "generate-lockfile", *common],
                                   cwd=case, env=env, capture_output=True, text=True, timeout=30)
        prep.require(generated.returncode == 0, generated.stdout + generated.stderr)
        command = [str(toolchain / "bin/cargo"), action, *common, "--locked",
                   "--tests" if action == "check" else "--lib", "--target", target, "--jobs", "2"]
        if fixed:
            command += ["--features", "patched"]
        if action == "test":
            command += ["--", "--nocapture"]
        started = time.monotonic()
        completed = subprocess.run(command, cwd=case, env=env, text=True,
                                   stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180)
        (case / "build.log").write_text(completed.stdout)
        resolved = tomllib.loads((case / "Cargo.lock").read_text())["package"]
        prep.require(all(p["version"] == "0.2.191" for p in resolved if p["name"] == "libc"), "libc changed")
        result = {"version": version, "target": target, "patched": fixed, "action": action,
                  "exit_code": completed.returncode, "expected_error": expected, "command": command,
                  "log": str(case / "build.log"), "seconds": round(time.monotonic() - started, 2),
                  "packages": [{k: p[k] for k in ("name", "version", "checksum") if k in p} for p in resolved]}
        results.append(result)
        (run / "results.json").write_text(json.dumps(report, indent=2) + "\n")
        prep.require((completed.returncode != 0 and expected in completed.stdout) if expected else completed.returncode == 0,
                     f"Unexpected build result: {case / 'build.log'}")
        print(f"{version} {target} {action} patched={fixed}: "
              f"{'expected failure' if expected else 'PASS'} ({result['seconds']}s)", flush=True)
    print(f"PASS: six bounded cases. {run / 'results.json'}")


if __name__ == "__main__":
    main()
