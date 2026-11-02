"""Private, offline host build from verified pinned assets. No shared mutations."""
from pathlib import Path
import hashlib
import json
import os
import shutil
import subprocess
import tarfile
from bounded import clean_env, run

HERE = Path(__file__).resolve().parent
CACHE = HERE / '.cache'
SHARED = HERE.parent / '.cache'
PIN = '4f783cd957b83de3019d6a843408d5bb3ff902c7'
SOURCE = CACHE / ('litter-ish-' + PIN)
BUILD = CACHE / 'host-build'
ASSETS = {
    'ish-4f783cd9.tar.gz': '3df629379e1403821909f5e822b24b631f7e576f4fce6f8357e85423a3a46067',
    'litter-rootfs-v0.1.2.tar.gz': '70e7d8acc9520ca45d53821dd3ffab1035620156dda3e513e66013e848f6ba0a',
}


def sha(path):
    with Path(path).open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    CACHE.mkdir(exist_ok=True)
    for name, digest in ASSETS.items():
        assert sha(SHARED / name) == digest, name
    if not SOURCE.exists():
        with tarfile.open(SHARED / 'ish-4f783cd9.tar.gz') as archive:
            archive.extractall(CACHE, filter='data')
    # Verify private and shared source bytes against the pinned archive, read-only.
    with tarfile.open(SHARED / 'ish-4f783cd9.tar.gz') as archive:
        for member in archive:
            if member.isfile():
                expected = hashlib.file_digest(archive.extractfile(member), 'sha256').hexdigest()
                assert sha(CACHE / member.name) == expected, member.name
                assert sha(SHARED / member.name) == expected, member.name
    if not (CACHE / 'base').exists():
        (CACHE / 'base').mkdir()
        with tarfile.open(SHARED / 'litter-rootfs-v0.1.2.tar.gz') as archive:
            archive.extractall(CACHE / 'base', filter='data')
    manifest = json.loads((SHARED / 'ish-apks/manifest.json').read_text())
    packages = CACHE / 'packages'
    packages.mkdir(exist_ok=True)
    for item in manifest['packages']:
        assert Path(item['filename']).name == item['filename']
        source, dest = SHARED / 'ish-apks' / item['filename'], packages / item['filename']
        assert sha(source) == item['sha256']
        if not dest.exists():
            shutil.copyfile(source, dest)
        assert sha(dest) == item['sha256']
    (packages / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
    env = clean_env()  # IPHONEOS_DEPLOYMENT_TARGET intentionally absent.
    env['SDKROOT'] = subprocess.check_output(
        ['xcrun', '--sdk', 'macosx', '--show-sdk-path'], text=True, timeout=10).strip()
    env['CC'] = '/usr/bin/clang'
    env['PATH'] = str(SHARED / 'host-bin') + os.pathsep + env['PATH']
    steps = []
    args = [SHARED / 'ish-tools/bin/meson', 'setup']
    if (BUILD / 'build.ninja').exists():
        args += ['--reconfigure']
    args += [BUILD, SOURCE, '--buildtype=release', '-Dguest_arch=arm64',
             '-Dkernel=ish', '-Dno_crlf=true']
    result = run(args, CACHE / 'meson.log', cwd=HERE, env=env)
    steps.append(result)
    if result['hostExit'] or result['stopReason']:
        raise RuntimeError(f'meson failed: {result}; see .cache/meson.log')
    # Each incremental build slice has a 45s deadline. A timed-out slice can resume.
    for attempt in range(8):
        result = run(['ninja', '-C', BUILD, '-j', '2', 'ish'],
                     CACHE / f'ninja-{attempt}.log', cwd=HERE, env=env)
        steps.append(result)
        if result['hostExit'] == 0 and result['stopReason'] is None:
            break
        if result['stopReason'] != 'wall_timeout':
            raise RuntimeError(f'ninja failed: {result}')
    else:
        raise RuntimeError('build slice budget exhausted; rerun to resume')
    vdso = BUILD / 'vdso/arm64/libvdso.so.elf'
    assert vdso.stat().st_size > 1024 and vdso.read_bytes()[:4] == b'\x7fELF'
    report = {'ishCommit': PIN, 'sourceUnmodified': True,
              'binarySHA256': sha(BUILD / 'ish'), 'vdsoSHA256': sha(vdso),
              'sdk': env['SDKROOT'], 'iphoneDeploymentTargetUnset': True,
              'assets': ASSETS, 'packageManifestSHA256': sha(packages / 'manifest.json'),
              'steps': steps}
    (CACHE / 'build.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
