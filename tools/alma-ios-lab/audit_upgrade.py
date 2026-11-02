"""Offline compatibility audit of Litter against the verified latest stable Codex.

Does not upgrade the installed CLI, build an app, log in, or call a model.
Original patches are tried in temporary trees; failures are evidence, not fixed.
"""
from pathlib import Path
import argparse
import atexit
import hashlib
import json
import re
import shutil
import subprocess
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
LATEST = "0.166.0"
LATEST_COMMIT = "6ff1e1ca3b30fc8b914720681fcf5fe62e95f856"
ARCHIVE_SHA = "718c86dcd7104919f2820aa79db0fa0083b5f240aa16da704f43e4acf7b544e5"
LITTER_COMMIT = "366aefdd616f16b9efb6c888be6cfd916bda47d6"


def command(args, cwd):
    p = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=30)
    return {"ok": p.returncode == 0, "returncode": p.returncode, "detail": p.stderr.strip()}


def digest(path):
    with path.open("rb") as f:
        return hashlib.file_digest(f, "sha256").hexdigest()


def struct_fields(source, name):
    match = re.search(r"pub struct " + name + r"(?:<[^>]+>)?\s*\{(.*?)\n\}", source, re.S)
    if not match:
        return None
    return re.findall(r"^\s*pub\s+(\w+)\s*:", match[1], re.M)


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()
    if a.output.exists():
        raise FileExistsError(a.output)
    cache = HERE / ".cache"
    repository = HERE.parents[1]
    snapshot = tempfile.TemporaryDirectory(prefix="litter-baseline-", dir=cache)
    atexit.register(snapshot.cleanup)
    litter = Path(snapshot.name) / "tree"
    litter.mkdir()
    archived = Path(snapshot.name) / "source.tar"
    subprocess.run(["git", "archive", LITTER_COMMIT, "-o", str(archived)], cwd=repository, check=True)
    with tarfile.open(archived) as baseline:
        baseline.extractall(litter, filter="data")
    old = cache / "codex-be2951ea34f0d295ed0becf97079f92fa5f6950e"
    latest = cache / ("codex-rust-v" + LATEST)
    archive_path = cache / ("codex-" + LATEST + ".tar.gz")
    assert digest(archive_path) == ARCHIVE_SHA
    with tarfile.open(archive_path) as archive:
        for member in archive.getmembers():
            if member.isfile():
                relative = Path(*Path(member.name).parts[1:])
                stream = archive.extractfile(member)
                assert stream is not None
                assert digest(latest / relative) == hashlib.file_digest(stream, "sha256").hexdigest(), relative
    names = re.findall(r'"\$REPO_DIR/patches/codex/([^"]+\.patch)"',
                       (litter / "apps/ios/scripts/sync-codex.sh").read_text())
    report = dict(targetVersion=LATEST, targetCommit=LATEST_COMMIT, targetArchiveSHA256=ARCHIVE_SHA,
                  litterCommit=LITTER_COMMIT, baselineFilesVerified=True,
                  installedCLIUnchanged=True, scope="source and patch applicability only; no full build or account use")
    results = []
    with tempfile.TemporaryDirectory(prefix="upgrade-audit-", dir=cache) as temp:
        scratch = Path(temp)
        sequential = scratch / "sequential"
        shutil.copytree(latest, sequential)
        assert command(["git", "init", "-q"], sequential)["ok"]
        for name in names:
            path = litter / "patches/codex" / name
            files = sorted(set(re.findall(r'^\+\+\+ b/(.+)$', path.read_text(), re.M)))
            independent = scratch / "independent"
            independent.mkdir()
            assert command(["git", "init", "-q"], independent)["ok"]
            for file in files:
                source = latest / file
                if source.is_file():
                    dest = independent / file
                    dest.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(source, dest)
            clean = command(["git", "apply", "--check", str(path)], independent)
            reverse = command(["git", "apply", "--reverse", "--check", str(path)], independent)
            check = command(["git", "apply", "--check", str(path)], sequential)
            if check["ok"]:
                assert command(["git", "apply", str(path)], sequential)["ok"]
            results.append(dict(name=name, sha256=digest(path), files=files,
                                missingPaths=[f for f in files if not (latest / f).exists()],
                                independentCheck=clean, identicalReverseCheck=reverse,
                                sequentialSkippingFailures=check))
            shutil.rmtree(independent)
    report["patches"] = results
    report["counts"] = dict(total=len(results),
        cleanIndependent=sum(r["independentCheck"]["ok"] for r in results),
        cleanSequentialSkippingFailures=sum(r["sequentialSkippingFailures"]["ok"] for r in results),
        identicalReverse=sum(r["identicalReverseCheck"]["ok"] for r in results))
    impacted = sorted(set(f for r in results for f in r["files"]))
    report["patchedPathDrift"] = {"total": len(impacted),
        "missing": [f for f in impacted if not (latest / f).exists()],
        "unchanged": [f for f in impacted if (old / f).is_file() and (latest / f).is_file() and digest(old / f) == digest(latest / f)],
        "changed": [f for f in impacted if (old / f).is_file() and (latest / f).is_file() and digest(old / f) != digest(latest / f)]}
    start_path = "codex-rs/app-server/src/in_process.rs"
    before = struct_fields((old / start_path).read_text(), "InProcessStartArgs")
    after = struct_fields((latest / start_path).read_text(), "InProcessStartArgs")
    report["inProcessStartArgs"] = dict(old=before, latest=after,
        added=sorted(set(after) - set(before)), removed=sorted(set(before) - set(after)))
    auth_path = "codex-rs/app-server/src/external_auth.rs"
    report["externalAuthBridgeUnchanged"] = digest(old / auth_path) == digest(latest / auth_path)
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({"counts": report["counts"], "pathDrift": report["patchedPathDrift"],
                      "newStartupFields": report["inProcessStartArgs"]["added"],
                      "externalAuthBridgeUnchanged": report["externalAuthBridgeUnchanged"]}, indent=2))


if __name__ == "__main__":
    main()
