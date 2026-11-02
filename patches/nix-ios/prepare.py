#!/usr/bin/env python3
"""Prepare checksum-verified nix sources. Python 3.12+, patch, and curl only.

Default output: repository .build/vendor/nix-0.29.0. Other versions are opt-in.
Never edits registry sources, project manifests/locks, or an existing dirty copy.
"""

import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tarfile
import tempfile
import tomllib

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
ARCHIVES = ROOT.parent / "ALMA/.build/tauri-toolchain/cargo/registry/cache/index.crates.io-1949cf8c6b5b557f"
REGISTRY = "registry+https://github.com/rust-lang/crates.io-index"


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def locked_packages():
    return tomllib.loads((ROOT / "shared/rust-bridge/Cargo.lock").read_text())["package"]


def locked_checksum(packages, name, version):
    found = [p for p in packages if p["name"] == name and p["version"] == version
             and p.get("source") == REGISTRY and p.get("checksum")]
    require(len(found) == 1, f"Expected one registry {name} {version} in Cargo.lock")
    return found[0]["checksum"]


def nix_checksum(packages, version, reviewed):
    selected = [p for p in packages if p["name"] == "nix" and p["version"] == version]
    require(len(selected) == 1, f"Expected one nix {version} selection in Cargo.lock")
    if "source" not in selected[0] and "checksum" not in selected[0]:
        # Cargo removes registry checksums when [patch] selects a local path.
        # Retain the exact reviewed pre-patch Cargo.lock checksum for fresh prep.
        require(len(reviewed.get("source_lock_sha256", "")) == 64, "Missing lock provenance")
        return reviewed["archive_sha256"]
    checksum = locked_checksum(packages, "nix", version)
    require(checksum == reviewed["archive_sha256"], "Cargo.lock disagrees with reviewed archive")
    return checksum


def unpack(name, version, checksum, destination, archives=ARCHIVES):
    """Verify archive bytes before extracting only safe regular files/directories."""
    filename = f"{name}-{version}.crate"
    archive = archives / filename
    if not archive.is_file():
        downloads = HERE / ".cache/archives"
        downloads.mkdir(parents=True, exist_ok=True)
        archive = downloads / filename
        if not archive.is_file():
            with tempfile.TemporaryDirectory(dir=downloads) as tmp:
                downloaded = Path(tmp) / filename
                subprocess.run([
                    "curl", "--fail", "--location", "--silent", "--show-error",
                    "--connect-timeout", "10", "--max-time", "45", "--output", str(downloaded),
                    f"https://static.crates.io/crates/{name}/{filename}",
                ], check=True, timeout=50)
                require(sha(downloaded.read_bytes()) == checksum, f"Bad download: {filename}")
                downloaded.replace(archive)
    require(sha(archive.read_bytes()) == checksum, f"Archive checksum mismatch: {archive}")
    crate = destination / f"{name}-{version}"
    require(not crate.exists(), f"Refusing to extract over {crate}")
    with tarfile.open(archive, "r:gz") as bundle:
        members = bundle.getmembers()
        for member in members:
            path = Path(member.name)
            require(not path.is_absolute() and ".." not in path.parts
                    and path.parts[0] == crate.name and (member.isfile() or member.isdir()),
                    f"Unsafe archive member: {member.name}")
        bundle.extractall(destination, members=members, filter="data")
    return crate


def inventory(directory):
    files = {}
    for path in sorted(directory.rglob("*")):
        require(not path.is_symlink(), f"Unexpected symlink: {path}")
        if path.is_file():
            files[str(path.relative_to(directory))] = sha(path.read_bytes())
    return files


def prepare(version="0.29.0", destination=ROOT / ".build/vendor", archives=ARCHIVES):
    manifest = json.loads((HERE / "patches.json").read_text())
    require(version in manifest, f"Unsupported version {version}")
    reviewed = manifest[version]
    checksum = nix_checksum(locked_packages(), version, reviewed)
    patch = HERE / f"nix-{version}.patch"
    require(sha(patch.read_bytes()) == reviewed["patch_sha256"], "Patch changed; review its hashes")
    destination = destination.resolve()
    require(destination.is_relative_to((ROOT / ".build/vendor").resolve())
            or destination.is_relative_to((HERE / ".cache").resolve()),
            "Output must be under repository .build/vendor or this patch's .cache")
    destination.mkdir(parents=True, exist_ok=True)
    target = destination / f"nix-{version}"
    require(not target.is_symlink(), f"Refusing symlink destination {target}")
    with tempfile.TemporaryDirectory(prefix=".prepare-nix-", dir=destination) as tmp:
        source = unpack("nix", version, checksum, Path(tmp), archives)
        before = inventory(source)
        for rel, hashes in reviewed["files"].items():
            require(before.get(rel) == hashes["before"], f"Unexpected source: {rel}")
        subprocess.run(["patch", "--batch", "--forward", "--fuzz=0", "-p1", "-i", str(patch)],
                       cwd=source, check=True, capture_output=True, text=True, timeout=10)
        expected = dict(before)
        expected.update({rel: hashes["after"] for rel, hashes in reviewed["files"].items()})
        require(inventory(source) == expected, "Patch changed unexpected files or produced wrong bytes")
        (source / ".alma-nix-ios.json").write_text(json.dumps({
            "version": version, "archive_sha256": checksum,
            "patch_sha256": reviewed["patch_sha256"], "files": expected,
        }, indent=2) + "\n")
        if target.exists():
            require(target.is_dir() and inventory(target) == inventory(source),
                    f"Existing source differs; refusing to overwrite {target}")
        else:
            source.rename(target)
    return target


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", choices=["0.28.0", "0.29.0", "0.30.1", "0.31.2"],
                        default="0.29.0")
    parser.add_argument("--destination", type=Path, default=ROOT / ".build/vendor")
    parser.add_argument("--archive-cache", type=Path, default=ARCHIVES)
    args = parser.parse_args()
    print(prepare(args.version, args.destination, args.archive_cache))


if __name__ == "__main__":
    main()
