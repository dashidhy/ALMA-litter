#!/usr/bin/env python3
"""Package the locked SDK and owned guest as an immutable iOS bundle resource.

Only local build inputs are used. Each generation lives at
.cache/kimi-runtimes/<manifest-sha256>/kimi-runtime. Xcode copies that final
directory as a folder resource, next to fs and mobile-config.json.
"""

import argparse
import fcntl
import hashlib
import json
from pathlib import Path, PurePosixPath
import subprocess
import tarfile
import tempfile


HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CORE = REPO / 'shared/tah-runtime'
PROBE = REPO / 'tools/kimi-mobile-probe'
SDK = PROBE / '.cache/latest-release/artifact/opt/kimi'
SDK_LOCK = PROBE / 'latest-source.lock.json'
GUEST = HERE / '.cache/kimi-guest'
COMPAT = HERE / 'kimi-compat'
NATIVE_TOOLS = HERE / 'kimi-tools'
GENERATIONS = HERE / '.cache/kimi-runtimes'
MANIFEST = 'runtime-manifest.json'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def encoded(value):
    return (json.dumps(value, indent=2, sort_keys=True) + '\n').encode()


def safe_path(value):
    path = PurePosixPath(value)
    if not value or path.is_absolute() or any(part in ('', '.', '..') for part in value.split('/')) or '\\' in value or '\0' in value:
        raise ValueError(f'Invalid resource path: {value!r}')
    return path


def read_file(path):
    info = path.lstat()
    if path.is_symlink() or not path.is_file() or info.st_nlink != 1:
        raise ValueError(f'Expected a single-link regular file: {path}')
    return path.read_bytes()


def inventory(root, exclude=()):
    if root.is_symlink() or not root.is_dir():
        raise ValueError(f'Expected a resource directory: {root}')
    records = []
    for path in sorted(root.rglob('*')):
        relative = path.relative_to(root).as_posix()
        safe_path(relative)
        if path.is_symlink():
            raise ValueError(f'Resource symlink: {path}')
        if path.is_dir():
            continue
        data = read_file(path)
        if relative not in exclude:
            records.append({'path': relative, 'bytes': len(data), 'sha256': digest(data)})
    return records


def verify_records(root, records, exclude=()):
    expected_directories = set()
    for record in records:
        path = safe_path(record['path'])
        expected_directories.update(str(parent) for parent in path.parents if str(parent) != '.')
    if sorted(inventory(root, exclude), key=lambda row: row['path']) != sorted(records, key=lambda row: row['path']):
        raise ValueError(f'Resource inventory or hash mismatch: {root}')
    actual_directories = {path.relative_to(root).as_posix() for path in root.rglob('*') if path.is_dir()}
    if actual_directories != expected_directories:
        raise ValueError(f'Resource directory inventory mismatch: {root}')


def owned_profile():
    """Use the adopted Mac shape and bind consent identity to owned mobile inputs."""
    lock = json.loads(read_file(CORE / 'kimi-source-lock.json'))
    sources = inventory(CORE / 'kimi-upstream')
    if {row['path']: row['sha256'] for row in sources} != lock['files']:
        raise ValueError('Owned Kimi source differs from kimi-source-lock.json')
    profile = json.loads(read_file(CORE / 'kimi-upstream/app-profile.json'))
    if profile['id'] != 'kimi':
        raise ValueError('Expected the owned Kimi app profile')
    profile['displayName'] = 'Kimi Code'
    identity = {'profile': profile, 'sources': sources,
                'platform': inventory(CORE / 'platform/kimi'),
                'sdkLockSHA256': digest(read_file(SDK_LOCK)),
                'compatLockSHA256': digest(read_file(COMPAT / 'source-lock.json')),
                'nativeToolsLockSHA256': digest(read_file(NATIVE_TOOLS / 'source-lock.json')),
                'coreSourceLockSHA256': digest(read_file(CORE / 'source-lock.json')),
                'vendorLockSHA256': digest(read_file(CORE / 'vendor-lock.json')),
                'buildDependencyLockSHA256': digest(read_file(HERE / 'package-lock.json')),
                'guestBuilderSHA256': digest(read_file(HERE / 'build_kimi_guest.mjs'))}
    profile['profileIdentity'] = digest(encoded(identity))
    return profile


def sdk_records():
    if not SDK.exists():
        raise FileNotFoundError('Missing locked SDK. Run tools/kimi-mobile-probe/prepare_latest.py first.')
    lock = json.loads(read_file(SDK_LOCK))
    records = inventory(SDK)
    tree = digest(json.dumps(records, sort_keys=True, separators=(',', ':')).encode())
    if tree != lock['artifact']['treeSHA256'] or len(records) != lock['artifact']['files']:
        raise ValueError('SDK closure differs from latest-source.lock.json')
    if digest(read_file(SDK / 'sdk/index.mjs')) != lock['sdkIndexSHA256']:
        raise ValueError('SDK entry hash mismatch')
    return records


def guest_records():
    if not (GUEST / 'manifest.json').is_file():
        raise FileNotFoundError('Kimi guest is not ready. Run node tools/mobile-tah/build_kimi_guest.mjs.')
    manifest = json.loads(read_file(GUEST / 'manifest.json'))
    records = inventory(GUEST, exclude=('manifest.json',))
    expected = manifest['files'] if 'files' in manifest else [
        {'path': 'guest.mjs', 'bytes': manifest['bytes'], 'sha256': manifest['sha256']}]
    verify_records(GUEST, expected, exclude=('manifest.json',))
    if manifest.get('sdkImport') != './sdk/index.mjs' or not any(row['path'] == 'guest.mjs' for row in records):
        raise ValueError('Guest must use the packaged sibling SDK and guest.mjs entry')
    # The owned builder validates its source locks on every normal packaging run.
    # Retain the complete actual source list in packaged provenance as well.
    inputs = ['platform/kimi/guest/entry.mjs', *[name.lstrip('/') for name in manifest['modules']]]
    upstream_lock = json.loads(read_file(CORE / 'source-lock.json'))['files']
    vendor_lock = json.loads(read_file(CORE / 'vendor-lock.json'))
    source_records = []
    for name in sorted(set(inputs)):
        safe_path(name)
        if not name.startswith(('platform/kimi/', 'upstream/', 'vendor/')):
            raise ValueError(f'Unexpected guest build source: {name}')
        data = read_file(CORE / name)
        if name.startswith('upstream/') and digest(data) != upstream_lock[name.removeprefix('upstream/')]:
            raise ValueError(f'Guest upstream source hash mismatch: {name}')
        if name.startswith('vendor/'):
            _, package, relative = name.split('/', 2)
            if digest(data) != vendor_lock[package]['files'][relative]:
                raise ValueError(f'Guest vendor source hash mismatch: {name}')
        source_records.append({'path': name, 'bytes': len(data), 'sha256': digest(data)})
    return records, source_records, manifest


def compatibility_files(manifest):
    lock = json.loads(read_file(COMPAT / 'source-lock.json'))
    if {package['name']: package['version'] for package in lock['packages']} != manifest['compatibilityPackages']:
        raise ValueError('Guest compatibility dependencies differ from the owned package lock')
    result = {}
    for package in lock['packages']:
        archive = COMPAT / safe_path(package['archive'])
        if digest(read_file(archive)) != package['sha256']:
            raise ValueError(f'Compatibility source archive hash mismatch: {archive}')
        expected = {row['path']: row for row in package['files']}
        seen = set()
        with tarfile.open(archive, 'r:gz') as stream:
            for member in stream:
                safe_path(member.name)
                if not member.isfile() or member.name not in expected or member.name in seen:
                    raise ValueError(f'Unexpected compatibility archive member: {member.name}')
                data = stream.extractfile(member).read()
                row = expected[member.name]
                if len(data) != row['bytes'] or digest(data) != row['sha256']:
                    raise ValueError(f'Compatibility file hash mismatch: {member.name}')
                result[f'node_modules/{package["name"]}/{member.name}'] = data
                seen.add(member.name)
        if seen != set(expected):
            raise ValueError(f'Incomplete compatibility archive: {archive}')
    return result


def prepare_runtime(verify_only=False):
    if not verify_only:
        GENERATIONS.mkdir(parents=True, exist_ok=True)
    with (GENERATIONS / 'prepare.lock').open('r' if verify_only else 'a') as guard:
        fcntl.flock(guard, fcntl.LOCK_SH if verify_only else fcntl.LOCK_EX)
        return prepare_locked_runtime(verify_only)


def prepare_locked_runtime(verify_only):
    profile = owned_profile()
    if not verify_only:
        builder = HERE / 'build_kimi_guest.mjs'
        if not builder.is_file():
            raise FileNotFoundError('Kimi guest builder is not ready: tools/mobile-tah/build_kimi_guest.mjs')
        subprocess.run(['node', str(builder)], cwd=REPO, check=True, stdout=subprocess.DEVNULL)
    sdk = sdk_records()
    guest, sources, guest_manifest = guest_records()
    payload = compatibility_files(guest_manifest)
    for root, records in [(SDK, sdk), (GUEST, guest)]:
        for row in records:
            if row['path'] in payload:
                raise ValueError(f'Overlapping runtime asset: {row["path"]}')
            data = read_file(root / row['path'])
            if len(data) != row['bytes'] or digest(data) != row['sha256']:
                raise ValueError(f'Build input changed during packaging: {row["path"]}')
            payload[row['path']] = data
    metadata = {
        'app-profile.json': encoded(profile),
        'latest-source.lock.json': read_file(SDK_LOCK),
        'compat-source-lock.json': read_file(COMPAT / 'source-lock.json'),
        'native-tools-source-lock.json': read_file(NATIVE_TOOLS / 'source-lock.json'),
        'guest-manifest.json': read_file(GUEST / 'manifest.json'),
        'guest-sources.json': encoded({'schemaVersion': 1, 'files': sources}),
        'LICENSE.kimi-upstream': read_file(CORE / 'kimi-upstream/LICENSE.upstream'),
    }
    if payload.keys() & (metadata.keys() | {MANIFEST}):
        raise ValueError('Guest assets collide with runtime metadata')
    payload.update(metadata)
    if owned_profile() != profile:
        raise ValueError('Owned Kimi build inputs changed during packaging; retry after edits finish')
    records = [{'path': name, 'bytes': len(data), 'sha256': digest(data)} for name, data in sorted(payload.items())]
    manifest = encoded({'schemaVersion': 1, 'files': records})
    generation = GENERATIONS / digest(manifest)
    resource = generation / 'kimi-runtime'
    if verify_only:
        verify_records(resource, records, exclude=(MANIFEST,))
        if read_file(resource / MANIFEST) != manifest:
            raise ValueError('Packaged runtime manifest mismatch')
        return resource
    if generation.exists():
        verify_records(resource, records, exclude=(MANIFEST,))
        if read_file(resource / MANIFEST) != manifest:
            raise ValueError('Existing generation manifest mismatch')
        return resource
    with tempfile.TemporaryDirectory(prefix='.staging-', dir=GENERATIONS) as temporary:
        staged_generation = Path(temporary) / 'generation'
        staged = staged_generation / 'kimi-runtime'
        for name, data in {**payload, MANIFEST: manifest}.items():
            target = staged / safe_path(name)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            target.chmod(0o444)
        verify_records(staged, records, exclude=(MANIFEST,))
        staged_generation.rename(generation)
    return resource


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--verify-only', action='store_true', help='Verify the current generation without rebuilding or writing')
    args = parser.parse_args()
    resource = prepare_runtime(args.verify_only)
    manifest = json.loads(read_file(resource / MANIFEST))
    print(json.dumps({'resource': str(resource), 'entrypoint': '/workspace/.runtime/kimi/guest.mjs',
                      'manifestSHA256': digest(read_file(resource / MANIFEST)),
                      'files': len(manifest['files']), 'verified': True}))


if __name__ == '__main__':
    main()
