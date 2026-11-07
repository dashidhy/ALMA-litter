#!/usr/bin/env python3
"""Extend the pinned phone fakefs with signed, offline Alpine ripgrep packages."""

import argparse
import fcntl
import hashlib
import json
from pathlib import Path
import shlex
import shutil
import sys
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
LAB = REPO / 'tools/alma-ios-lab'
INPUTS = HERE / 'kimi-tools'
OUTPUT = HERE / '.cache/kimi-rootfs'
sys.path.insert(0, str(LAB))
from ish_probe import run_case
from prepare_runtime_rootfs import tree_sha
from prepare_kimi_icu import install_icu, verify_icu


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def installed_packages(fs):
    packages = {}
    for paragraph in (fs / 'data/lib/apk/db/installed').read_text().split('\n\n'):
        fields = dict(line.split(':', 1) for line in paragraph.splitlines() if ':' in line)
        if 'P' in fields:
            packages[fields['P']] = fields['V']
    return packages


def verify_inputs():
    lock_path = INPUTS / 'source-lock.json'
    lock = json.loads(lock_path.read_text())
    base = LAB / '.cache/runtime-rootfs' / lock['rootfsID'] / 'fs'
    base_manifest = json.loads((base.parent / 'ready.json').read_text())
    base_lock_path = REPO / lock['rootfsPackageLockPath']
    if sha(base_lock_path) != lock['rootfsPackageLockSHA256']:
        raise ValueError('Baseline package lock hash mismatch')
    if base_manifest['treeSHA256'] != lock['baseTreeSHA256'] or tree_sha(base) != lock['baseTreeSHA256']:
        raise ValueError('Clean baseline fakefs tree hash mismatch')
    baseline = installed_packages(base)
    for package in json.loads(base_lock_path.read_text())['packages']:
        if baseline.get(package['name']) != package['version']:
            raise ValueError(f'Baseline package version mismatch: {package["name"]}')
    for package in lock['packages']:
        archive = INPUTS / package['archive']
        if archive.parent != INPUTS or archive.is_symlink() or not archive.is_file():
            raise ValueError('Expected a retained regular APK file')
        if archive.stat().st_size != package['bytes'] or sha(archive) != package['sha256']:
            raise ValueError(f'APK hash mismatch: {archive}')
        with tarfile.open(archive, 'r:gz', ignore_zeros=True) as stream:
            metadata = stream.extractfile('.PKGINFO').read()
            if hashlib.sha256(metadata).hexdigest() != package['pkginfoSHA256']:
                raise ValueError(f'APK metadata hash mismatch: {archive}')
            for record in package['files']:
                member = stream.getmember(record['member'])
                if not member.isfile():
                    raise ValueError('Expected a regular APK payload file')
                data = stream.extractfile(member).read()
                if len(data) != record['bytes'] or hashlib.sha256(data).hexdigest() != record['sha256']:
                    raise ValueError(f'APK payload hash mismatch: {record["member"]}')
    return lock, sha(lock_path), base, base_manifest, baseline


def verify_installed(fs, lock, baseline):
    expected = {**baseline, **{package['name']: package['version'] for package in lock['packages']}}
    if installed_packages(fs) != expected:
        raise ValueError('Extended fakefs package inventory differs from baseline plus locked additions')
    for package in lock['packages']:
        for record in package['files']:
            path = fs / 'data' / record['member']
            if path.is_symlink() or path.stat().st_size != record['bytes'] or sha(path) != record['sha256']:
                raise ValueError(f'Installed APK payload mismatch: {record["member"]}')
    for library in lock['rootfsLibraries']:
        if sha(fs / 'data' / library['path'].removeprefix('/')) != library['sha256']:
            raise ValueError(f'Original rootfs library changed: {library["path"]}')
    verify_icu(fs, lock['icuEmbedding'])


def verify_generation(manifest_path, lock, lock_digest, baseline):
    manifest = json.loads(manifest_path.read_text())
    fs = manifest_path.parent / 'fs'
    if manifest['schemaVersion'] != 1 or manifest['lockSHA256'] != lock_digest or manifest['fs'] != str(fs):
        raise ValueError('Prepared fakefs manifest identity mismatch')
    if tree_sha(fs) != manifest['treeSHA256']:
        raise ValueError('Prepared fakefs tree hash mismatch')
    if (fs / '.litter-rootfs-id').read_text() != f'alma-tools=kimi-{lock_digest};arch=aarch64\n':
        raise ValueError('Prepared fakefs rootfs ID mismatch')
    verify_installed(fs, lock, baseline)
    return manifest_path


def prepare_rootfs(verify_only=False):
    lock, lock_digest, base, base_manifest, baseline = verify_inputs()
    generation = OUTPUT / lock_digest
    manifest_path = generation / 'manifest.json'
    if verify_only:
        return verify_generation(manifest_path, lock, lock_digest, baseline)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    with (OUTPUT / 'prepare.lock').open('a') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        if generation.exists():
            return verify_generation(manifest_path, lock, lock_digest, baseline)
        provenance = json.loads((LAB / '.cache/ish-host-build-provenance.json').read_text())
        if sha(LAB / '.cache/ish-host-build/ish') != provenance['binarySHA256']:
            raise ValueError('iSH host binary differs from its reviewed provenance')
        with tempfile.TemporaryDirectory(prefix='.staging-', dir=OUTPUT) as temporary:
            staged = Path(temporary) / 'generation'
            fs = staged / 'fs'
            shutil.copytree(base, fs)
            logs = staged / 'verification'
            apk_paths = ' '.join(shlex.quote('/packages/' + package['archive']) for package in lock['packages'])
            install = ('set -eu; mkdir -p /packages; mount -t real ' + shlex.quote(str(INPUTS))
                       + ' /packages; apk add --no-network ' + apk_paths + '; umount /packages')
            result = run_case('install', install, fs, logs, timeout=180)
            if result['returncode'] != 0 or result['stopReason'] is not None:
                raise RuntimeError(f'Guest APK installation failed: {result["stderr"]}')
            install_icu(fs, lock['icuEmbedding'], LAB / '.cache/phone-build-bin/ld.lld')
            verify_installed(fs, lock, baseline)
            script = '''set -eu
unset LD_LIBRARY_PATH
export PATH=/usr/bin:/bin
test "$(command -v rg)" = /usr/bin/rg
test "$(stat -c %a /usr/bin/rg)" = 755
rg --version
mkdir -p /tmp/alma-rg-check
trap 'rm -rf /tmp/alma-rg-check' EXIT
printf 'alpha\\nKIMI_ROOTFS_NEEDLE_31415\\nomega\\n' > /tmp/alma-rg-check/notes.md
cd /tmp/alma-rg-check
rg --json --line-number KIMI_ROOTFS_NEEDLE_31415 .
rg --files --glob '*.md' .
rg --pcre2 '(?<=KIMI_ROOTFS_)NEEDLE_[0-9]+' notes.md
if rg MISSING_MARKER_2718 .; then exit 91; else test "$?" -eq 1; fi
/bin/bash -c 'a=(BASH READY); printf "%s_%s\\n" "${a[0]}" "${a[1]}"'
python3 --version
node --version
node -e "if ('a'.localeCompare('b') >= 0) throw Error('ICU collation failed'); console.log('ICU_COLLATION_READY')"
printf 'KIMI_ROOTFS_OK\\n'
'''
            check = run_case('tools', script, fs, logs, timeout=45)
            if check['returncode'] != 0 or check['stopReason'] is not None or 'KIMI_ROOTFS_OK' not in check['stdout']:
                raise RuntimeError(f'Extended fakefs tools failed: {check["stdout"]}\n{check["stderr"]}')
            verify_installed(fs, lock, baseline)
            (fs / '.litter-rootfs-id').write_text(f'alma-tools=kimi-{lock_digest};arch=aarch64\n')
            (fs / 'alma-kimi-tools.json').write_bytes((INPUTS / 'source-lock.json').read_bytes())
            manifest = {
                'schemaVersion': 1, 'lockSHA256': lock_digest,
                'rootfsID': f'kimi-{lock_digest}', 'fs': str(generation / 'fs'),
                'baseRootfsID': lock['rootfsID'], 'baseTreeSHA256': base_manifest['treeSHA256'],
                'treeSHA256': tree_sha(fs), 'bytes': sum(path.stat().st_size for path in fs.rglob('*') if path.is_file()),
                'baselinePackages': baseline, 'addedPackages': {package['name']: package['version'] for package in lock['packages']},
                'originalLockedPackageCount': len(json.loads((REPO / lock['rootfsPackageLockPath']).read_text())['packages']),
                'guestToolCheck': check['stdout'], 'ishBinarySHA256': provenance['binarySHA256'],
            }
            (staged / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
            if tree_sha(base) != base_manifest['treeSHA256'] or sha(INPUTS / 'source-lock.json') != lock_digest:
                raise ValueError('Rootfs build inputs changed during preparation')
            staged.rename(generation)
        return verify_generation(manifest_path, lock, lock_digest, baseline)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-only', action='store_true')
    args = parser.parse_args()
    manifest_path = prepare_rootfs(args.verify_only)
    print(json.dumps({'manifest': str(manifest_path), **json.loads(manifest_path.read_text())}))


if __name__ == '__main__':
    main()
