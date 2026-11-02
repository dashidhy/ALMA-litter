"""Verify/apply the ALMA patch stack to the pinned submodule without resetting edits.

Works from committed upstream objects; temporary trees contain only patch-touched
files. It neither updates the user's installed CLI nor stages/commits Git changes.
"""
from pathlib import Path
import argparse, hashlib, json, subprocess, tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CODEX = REPO / "shared/third_party/codex"
PIN = "6ff1e1ca3b30fc8b914720681fcf5fe62e95f856"
PATCHES = REPO / "patches/codex-0.166"


def git(args, cwd=CODEX, check=True):
    p = subprocess.run(["git", *args], cwd=cwd, capture_output=True, timeout=45)
    if check and p.returncode:
        raise RuntimeError(p.stderr.decode(errors="replace")[-2000:])
    return p


def selected():
    return [PATCHES / line.strip() for series in ("series", "series.experimental")
            for line in (PATCHES/series).read_text().splitlines()
            if line.strip() and not line.lstrip().startswith("#")] + [
                REPO / "patches/codex-fs-preflight/codex-batch-preflight.patch",
                REPO / "patches/codex-code-mode-embedder/provider-injection.patch",
                REPO / "patches/codex-code-mode-embedder/runtime-optional-sandbox.patch",
                REPO / "patches/codex-0.166/embedded-patch-routing.patch",
                REPO / "patches/codex-provider-backend/provider-backend.patch"
            ]


def state(root, files):
    return {name: hashlib.sha256((root/name).read_bytes()).hexdigest()
            if (root/name).is_file() and not (root/name).is_symlink() else None for name in files}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()
    if git(["rev-parse", "HEAD"]).stdout.decode().strip() != PIN:
        raise RuntimeError("Initialize the submodule at the reviewed 0.166 commit first; no automatic reset")
    patches = selected()
    files = set()
    for patch in patches:
        for line in patch.read_text().splitlines():
            if line.startswith(("--- a/", "+++ b/")):
                name = line[6:]
                if Path(name).is_absolute() or ".." in Path(name).parts:
                    raise ValueError("Invalid patch path")
                files.add(name)
    changed = set(git(["diff", "--name-only", "HEAD"]).stdout.decode().splitlines())
    changed.update(git(["ls-files", "--others", "--exclude-standard"]).stdout.decode().splitlines())
    if changed - files:
        raise RuntimeError("Unrecognized submodule edits; preserving them: " + ", ".join(sorted(changed-files)))
    actual = state(CODEX, files)
    (HERE/".cache").mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="verify-codex-", dir=HERE/".cache") as temp:
        scratch = Path(temp)
        git(["init", "-q"], scratch)
        for name in files:
            content = git(["show", PIN+":"+name], check=False)
            if content.returncode == 0:
                path = scratch/name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content.stdout)
        states = [state(scratch, files)]
        for patch in patches:
            git(["apply", "--check", "--whitespace=error-all", str(patch)], scratch)
            git(["apply", str(patch)], scratch)
            states.append(state(scratch, files))
        matches = [i for i, expected in enumerate(states) if expected == actual]
        if not matches:
            raise RuntimeError("Submodule content is not a recognized patch-stack state; no files changed")
        done = max(matches)
        if args.check_only and done != len(patches):
            raise RuntimeError(f"Only {done}/{len(patches)} patches prepared")
        if not args.check_only:
            for patch in patches[done:]:
                git(["apply", "--check", "--whitespace=error-all", str(patch)])
                git(["apply", str(patch)])
        if state(CODEX, files) != states[-1]:
            raise RuntimeError("Prepared sources failed final content check")
    report = {"commit": PIN, "patches": [{"name":p.name, "sha256":hashlib.sha256(p.read_bytes()).hexdigest()}
                                         for p in patches], "trackedPathsChecked":len(files),
              "appliedNow":0 if args.check_only else len(patches)-done,
              "scope":"patch/source verification only; not compilation or runtime acceptance"}
    (HERE/".cache/codex-prepared.json").write_text(json.dumps(report, indent=2)+"\n")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
