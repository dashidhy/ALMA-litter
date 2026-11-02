"""Pinned-source audit only. No app integration, account, network, or iPhone use.

Uses an already fetched Litter checkout and the matching official Codex archive.
Applies the original ordered patches to a disposable copy, and compiles small
source-extracted Rust/Swift probes. These are host reproductions, not a claim
that the complete iOS binary has been exercised.
"""
from pathlib import Path
import argparse
import atexit
import hashlib
import json
import os
import re
import shutil
import subprocess
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
LITTER = "366aefdd616f16b9efb6c888be6cfd916bda47d6"
CODEX = "be2951ea34f0d295ed0becf97079f92fa5f6950e"
ARCHIVE_SHA = "cd5a884836b53422052989479c6662f06e2ee8bb768c1a86a5ff7326b887d4d6"


def run(args, cwd=None, timeout=60):
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    return dict(returncode=result.returncode, stdout=result.stdout, stderr=result.stderr)


def text(path):
    return path.read_text()


def sha(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.output.exists():
        raise FileExistsError("Use a new result path; previous evidence is immutable")
    cache = HERE / ".cache"
    repository = HERE.parents[1]
    snapshot = tempfile.TemporaryDirectory(prefix="litter-baseline-", dir=cache)
    atexit.register(snapshot.cleanup)
    litter = Path(snapshot.name) / "tree"
    litter.mkdir()
    archived = Path(snapshot.name) / "source.tar"
    subprocess.run(["git", "archive", LITTER, "-o", str(archived)], cwd=repository, check=True)
    with tarfile.open(archived) as baseline:
        baseline.extractall(litter, filter="data")
    original = cache / ("codex-" + CODEX)
    assert sha(cache / "codex-be2951ea.tar.gz") == ARCHIVE_SHA
    # Verify the extracted baseline as well as the archive. Never compare a
    # previously patched or accidentally edited tree with the wrong baseline.
    with tarfile.open(cache / "codex-be2951ea.tar.gz") as archive:
        for member in archive.getmembers():
            if member.isfile():
                relative = Path(*Path(member.name).parts[1:])
                stream = archive.extractfile(member)
                assert stream is not None
                assert sha(original / relative) == hashlib.file_digest(stream, "sha256").hexdigest(), relative
    result = dict(litter=LITTER, codex=CODEX, codexArchiveSHA256=ARCHIVE_SHA,
                  scope="host source-extracted probes; no iOS app or account invocation")
    with tempfile.TemporaryDirectory(prefix="audit-", dir=cache) as temp:
        scratch = Path(temp)
        patched = scratch / "codex"
        shutil.copytree(original, patched)
        assert run(["git", "init", "-q"], patched)["returncode"] == 0
        names = re.findall(r'"\$REPO_DIR/patches/codex/([^"]+\.patch)"',
                           text(litter / "apps/ios/scripts/sync-codex.sh"))
        patches = []
        for name in names:
            patch = litter / "patches/codex" / name
            check = run(["git", "apply", "--check", str(patch)], patched)
            item = dict(name=name, sha256=sha(patch), clean=check["returncode"] == 0,
                        files=re.findall(r'^\+\+\+ b/(.+)$', text(patch), re.M))
            if not item["clean"]:
                item["error"] = check["stderr"]
                patches.append(item)
                break
            apply = run(["git", "apply", str(patch)], patched)
            assert apply["returncode"] == 0, apply
            patches.append(item)
        result["patches"] = patches
        result["allPatchesApplyStrictly"] = len(patches) == len(names) and all(p["clean"] for p in patches)
        result["changedFiles"] = sorted(set(p for item in patches for p in item["files"]))
        result["baselineFilesVerified"] = True

        exec_path = litter / "shared/rust-bridge/codex-mobile-client/src/ish_exec.rs"
        source = text(exec_path)
        snippet = re.search(r'let preview = String::from_utf8_lossy\(&output\);\s*'
                            r'let preview = if preview\.len\(\) > 200 \{.*?\n    \};',
                            source, re.S).group(0)
        assert source.count(snippet) == 2
        rust = scratch / "utf8_probe.rs"
        rust.write_text('''fn main() {
    std::panic::set_hook(Box::new(|_| {}));
    for (label, output) in [
        ("ascii", "a".repeat(220).into_bytes()),
        ("han", "中".repeat(70).into_bytes()),
        ("mixed_emoji", ("a".to_owned() + &"😀".repeat(50)).into_bytes()),
    ] {
        let result = std::panic::catch_unwind(|| {
''' + snippet + '''
            preview.len()
        });
        println!("{}:{}", label, if result.is_ok() { "ok" } else { "panic" });
    }
}
''')
        toolchain = Path(os.environ.get("ALMA_RUST_TOOLCHAIN_ROOT", str(PROJECT.parent / "ALMA/.build/tauri-toolchain")))
        rustc = toolchain / "cargo/bin/rustc"
        # rustup's toolchain home is specified per subprocess, never a new HOME.
        probe_env = dict(os.environ)
        probe_env["RUSTUP_HOME"] = str(toolchain / "rustup")
        probe_env["RUSTUP_TOOLCHAIN"] = "stable-aarch64-apple-darwin"
        result["rustc"] = subprocess.check_output([str(rustc), "--version"], text=True, env=probe_env).strip()
        result["swiftc"] = run(["xcrun", "swiftc", "--version"])["stdout"].strip()
        build = subprocess.run([str(rustc), "--edition=2024", str(rust), "-o", str(scratch / "utf8-probe")],
                               capture_output=True, text=True, env=probe_env, timeout=60)
        assert build.returncode == 0, build.stderr
        probe = run([str(scratch / "utf8-probe")])
        assert probe["returncode"] == 0, probe
        result["utf8Preview"] = dict(sourceSHA256=sha(exec_path), duplicateSites=2,
                                     outcomes=dict(line.split(":") for line in probe["stdout"].splitlines()),
                                     limitation="Exec-hook postprocessing snippet; no guest process executed")

        oauth = litter / "apps/ios/Sources/Litter/Models/ChatGPTOAuth.swift"
        account_guard = re.search(r'if let previousAccountID, !previousAccountID\.isEmpty,\s*'
                                  r'refreshed\.accountID != previousAccountID,\s*'
                                  r'stored\.accountID != previousAccountID \{\s*'
                                  r'throw ChatGPTOAuthError\.refreshAccountMismatch\s*\}', text(oauth)).group(0)
        swift = scratch / "account_probe.swift"
        swift.write_text('''import Foundation
struct Token { let accountID: String }
enum ChatGPTOAuthError: Error { case refreshAccountMismatch }
func check(_ previousAccountID: String?, _ stored: Token, _ refreshed: Token) throws {
''' + account_guard + '''
}
for (label, expected, old, new) in [
    ("same_account", "A", "A", "A"),
    ("changed_after_matching_stored", "A", "A", "B"),
    ("changed_after_nonmatching_stored", "A", "B", "B")
] {
    do { try check(expected, Token(accountID: old), Token(accountID: new)); print("\\(label):accepted") }
    catch { print("\\(label):rejected") }
}
''')
        compiled = run(["xcrun", "swiftc", str(swift), "-o", str(scratch / "account-probe")])
        assert compiled["returncode"] == 0, compiled
        probe = run([str(scratch / "account-probe")])
        assert probe["returncode"] == 0, probe
        result["refreshAccountGuard"] = dict(sourceSHA256=sha(oauth),
            outcomes=dict(line.split(":") for line in probe["stdout"].splitlines()),
            limitation="Pure guard logic with dummy account IDs; no OAuth or credentials used")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
