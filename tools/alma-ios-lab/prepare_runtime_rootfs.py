"""Prepare the pinned Bash/Python/Node rootfs once, using the actual ARM64 guest.

Only generates an ignored build artifact. This does not yet switch the shipping
Litter resource or claim that workspace permission enforcement is integrated.
"""
from pathlib import Path
import hashlib, json, shlex, shutil, tarfile, tempfile
from ish_probe import run_case

HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
ROOT_ARCHIVE_SHA = "70e7d8acc9520ca45d53821dd3ffab1035620156dda3e513e66013e848f6ba0a"


def sha(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def tree_sha(root):
    digest = hashlib.sha256()
    for p in sorted(root.rglob("*")):
        relative = p.relative_to(root).as_posix().encode()
        if p.is_symlink():
            raise ValueError("Unexpected native symlink in prepared fakefs")
        if p.is_file():
            digest.update(len(relative).to_bytes(4, "big"))
            digest.update(relative)
            digest.update(bytes.fromhex(sha(p)))
    return digest.hexdigest()


def main():
    lock_path = HERE / "results/2026-10-31-ish-package-lock.json"
    lock = json.loads(lock_path.read_text())
    archive = CACHE / "litter-rootfs-v0.1.2.tar.gz"
    assert sha(archive) == ROOT_ARCHIVE_SHA
    for p in lock["packages"]:
        assert sha(CACHE / "ish-apks" / p["filename"]) == p["sha256"]
    version = hashlib.sha256(("alma-tools-v2:" + ROOT_ARCHIVE_SHA + sha(lock_path)).encode()).hexdigest()[:16]
    output = CACHE / "runtime-rootfs" / version
    if (output / "ready.json").exists():
        record = json.loads((output/"ready.json").read_text())
        if record["treeSHA256"] != tree_sha(output/"fs"):
            raise ValueError("Prepared rootfs integrity mismatch; refusing reuse")
        print(json.dumps({"reused": True, "output": str(output), "version": version}))
        return
    output.parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="rootfs-build-", dir=CACHE) as tmp:
        tmp = Path(tmp)
        with tarfile.open(archive) as tar:
            tar.extractall(tmp, filter="data")
        logs = tmp / "verification"
        # Realfs mount state is process-local. ISH_BIND_MOUNTS persists a native
        # host symlink in fakefs/data, which must never enter a phone bundle.
        install_script = ("mkdir -p /packages && mount -t real "
                          + shlex.quote(str(CACHE/"ish-apks"))
                          + " /packages && apk add --no-network /packages/*.apk")
        installed = run_case("install", install_script, tmp/"fs", logs, timeout=180)
        if installed["returncode"] != 0:
            raise RuntimeError("guest package installation failed")
        checks = run_case("tools", "/bin/bash -c 'a=(BASH READY); printf \"%s_%s\\n\" \"${a[0]}\" \"${a[1]}\"' && python3 --version && node --version",
                          tmp / "fs", logs, timeout=45)
        if checks["returncode"] != 0 or "BASH_READY" not in checks["stdout"]:
            raise RuntimeError("prepared runtime tools failed verification")
        # This namespace contains no user transcription fixture or account data.
        (tmp / "fs/alma-tools.json").write_text(json.dumps({"version": version,
            "rootArchiveSHA256": ROOT_ARCHIVE_SHA, "packageLockSHA256": sha(lock_path),
            "packages": [{k:p[k] for k in ("name", "version", "sha256")} for p in lock["packages"]]}, indent=2)+"\n")
        (tmp/"fs/.litter-rootfs-id").write_text("alma-tools="+version+";arch=aarch64\n")
        record = dict(version=version, rootArchiveSHA256=ROOT_ARCHIVE_SHA,
                      packageLockSHA256=sha(lock_path), toolCheck=checks["stdout"],
                      treeSHA256=tree_sha(tmp/"fs"),
                      bytes=sum(p.stat().st_size for p in (tmp/"fs").rglob("*") if p.is_file()),
                      scope="Prepared pinned guest tools only; shipping resource and permission enforcement not yet wired")
        output.mkdir()
        shutil.move(str(tmp / "fs"), output / "fs")
        shutil.move(str(logs), output / "verification")
        (output/"ready.json").write_text(json.dumps(record, indent=2)+"\n")
        print(json.dumps({"reused": False, "output": str(output), **record}))


if __name__ == "__main__":
    main()
