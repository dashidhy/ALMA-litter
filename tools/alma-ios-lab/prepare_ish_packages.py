"""Fetch a small Alpine ARM64 tool cohort; never installs into macOS.

The guest apk solver/signature verifier remains authoritative. This helper only
collects the transitive named/soname candidates from one official index. It
does not bypass signatures or execute packages on the host.
"""
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import hashlib, json, re, subprocess, tarfile

HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
BASE = "https://dl-cdn.alpinelinux.org/alpine/v3.21/main/aarch64"


def paragraphs(data):
    result = []
    for chunk in data.strip().split("\n\n"):
        d = {}
        for line in chunk.splitlines():
            if len(line) > 2 and line[1] == ":":
                d[line[0]] = line[2:]
        if "P" in d:
            result.append(d)
    return result


def name(dep):
    return re.split(r"[<>=~]", dep, maxsplit=1)[0]


def main():
    lock_path = HERE / "results/2026-10-31-ish-package-lock.json"
    if lock_path.exists():
        return restore_locked(json.loads(lock_path.read_text()))
    with tarfile.open(CACHE / "alpine-3.21-main-index.tar.gz") as a:
        packages = paragraphs(a.extractfile("APKINDEX").read().decode())
    by_name = {p["P"]: p for p in packages}
    providers = {}
    for p in packages:
        for item in p.get("p", "").split():
            providers.setdefault(name(item), []).append(p)
    selected = {}

    def add(dep):
        if dep.startswith("!") or dep == "/bin/sh":
            return
        key = name(dep)
        p = by_name.get(key)
        if p is None:
            candidates = providers.get(key, [])
            if not candidates:
                raise ValueError("Missing dependency: " + dep)
            p = min(candidates, key=lambda p: int(p["S"]))
        if p["P"] in selected:
            return
        selected[p["P"]] = p
        for child in p.get("D", "").split():
            add(child)

    for requested in ["python3", "nodejs", "bash"]:
        add(requested)
    total = sum(int(p["S"]) for p in selected.values())
    if total > 150 * 1024 * 1024:
        raise ValueError("Package cohort exceeds the 150 MiB download cap")
    dest = CACHE / "ish-apks"
    dest.mkdir(exist_ok=True)
    print(json.dumps({"packages": len(selected), "downloadBytes": total,
                      "requested": {n: selected[n]["V"] for n in ["python3", "nodejs", "bash"]}}), flush=True)

    def fetch(p):
        filename = p["P"] + "-" + p["V"] + ".apk"
        if not re.fullmatch(r"[a-zA-Z0-9_.+~-]+\.apk", filename):
            raise ValueError(filename)
        path = dest / filename
        if not path.exists():
            part = path.with_suffix(".apk.partial")
            subprocess.run(["curl", "-fLsS", "--connect-timeout", "10", "--max-time", "600",
                            "--continue-at", "-", BASE + "/" + filename, "-o", str(part)], check=True)
            if part.stat().st_size != int(p["S"]):
                raise ValueError("Package size mismatch: " + filename)
            part.rename(path)
        if path.stat().st_size != int(p["S"]):
            raise ValueError("Cached package size mismatch: " + filename)
        with path.open("rb") as f:
            digest = hashlib.file_digest(f, "sha256").hexdigest()
        return dict(name=p["P"], version=p["V"], filename=filename, bytes=path.stat().st_size,
                    sha256=digest, url=BASE + "/" + filename, dependencies=p.get("D", ""))

    with ThreadPoolExecutor(max_workers=4) as pool:
        records = list(pool.map(fetch, selected.values()))
    manifest = dict(repository=BASE, packages=records, bytes=total,
                    scope="Downloaded signed APKs; guest apk must still validate and install them")
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Package downloads complete", flush=True)


def restore_locked(lock):
    dest = CACHE / "ish-apks"
    dest.mkdir(exist_ok=True)
    def restore(item):
        path = dest / item['filename']
        if path.name != item['filename'] or not item['url'].startswith(BASE + '/'):
            raise ValueError('Unexpected locked package path/origin')
        if not path.exists():
            part = path.with_suffix('.apk.partial')
            subprocess.run(['curl','-fLsS','--connect-timeout','10','--max-time','600',
                            '--continue-at','-',item['url'],'-o',str(part)],check=True)
            with part.open('rb') as stream:
                if hashlib.file_digest(stream,'sha256').hexdigest()!=item['sha256']:
                    raise ValueError('Downloaded locked package checksum mismatch')
            part.rename(path)
        with path.open('rb') as stream:
            if path.stat().st_size!=item['bytes'] or hashlib.file_digest(stream,'sha256').hexdigest()!=item['sha256']:
                raise ValueError('Cached locked package checksum mismatch')
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(restore,lock['packages']))
    (dest/'manifest.json').write_text(json.dumps(lock,indent=2)+'\n')
    print('Locked package cohort verified')


if __name__ == "__main__":
    main()
