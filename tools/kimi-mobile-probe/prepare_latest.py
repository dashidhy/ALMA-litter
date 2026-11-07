#!/usr/bin/env python3
"""Build the reviewed Kimi release SDK and verify its complete runtime closure.

Reads latest-source.lock.json. All writes stay in .cache/latest-release.
The existing Node/pnpm executables are read-only inputs. The seed pnpm store is
copied before use. A completed artifact is reusable without network access.
"""

import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile


HERE = Path(__file__).resolve().parent
CACHE = HERE / '.cache/latest-release'
BUILD = CACHE / 'build'
SOURCE = CACHE / 'source'
ARTIFACT = CACHE / 'artifact/opt/kimi'
OLD = HERE.parents[2] / 'ALMA/.build/kimi-native-prototype.83lJDD'
DEFAULT_NODE = OLD / 'downloads/node-v24.15.0-darwin-arm64/bin/node'
DEFAULT_PNPM = Path.home() / 'Library/pnpm/.tools/pnpm/10.33.0/node_modules/pnpm/bin/pnpm.cjs'


def digest(path):
    with path.open('rb') as stream:
        result = hashlib.sha256()
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
        return result.hexdigest()


def require_hash(path, expected):
    actual = digest(path)
    if actual != expected:
        raise ValueError(f'Hash mismatch for {path}: {actual}, expected {expected}')


def write_json(path, value):
    temporary = path.with_suffix(path.suffix + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n')
    temporary.replace(path)


def inventory(root):
    records = []
    for path in sorted(root.rglob('*')):
        if path.is_symlink():
            raise ValueError(f'Unexpected artifact symlink: {path}')
        if path.is_file():
            records.append({'path': str(path.relative_to(root)),
                            'bytes': path.stat().st_size, 'sha256': digest(path)})
    return records


def verify_artifact(root, lock):
    require_hash(root / 'sdk/index.mjs', lock['sdkIndexSHA256'])
    records = inventory(root)
    encoded = json.dumps(records, sort_keys=True, separators=(',', ':')).encode()
    if hashlib.sha256(encoded).hexdigest() != lock['artifact']['treeSHA256']:
        raise ValueError('Artifact file inventory differs from the reviewed lock')
    if len(records) != lock['artifact']['files']:
        raise ValueError('Artifact file count differs from the reviewed lock')
    return records


def run(command, log_name, environment, cwd=SOURCE, timeout=600):
    log = BUILD / 'logs' / log_name
    with log.open('w') as stream:
        stream.write('$ ' + json.dumps([str(x) for x in command]) + '\n')
        stream.flush()
        result = subprocess.run([str(x) for x in command], cwd=cwd, env=environment,
                                stdin=subprocess.DEVNULL, stdout=stream,
                                stderr=subprocess.STDOUT, timeout=timeout)
    if result.returncode:
        raise RuntimeError(f'Command failed ({result.returncode}), see {log}')


def extract_source(archive):
    # Accept the upstream documentation's sibling-file link, while rejecting
    # directory links, hard links and paths that could escape the source tree.
    with tarfile.open(archive, 'r:gz') as bundle:
        members = bundle.getmembers()
        if sum(member.size for member in members) > 256 * 1024**2:
            raise ValueError('Source archive exceeds 256 MiB expanded limit')
        for member in members:
            parts = Path(member.name).parts
            if not parts or member.name.startswith('/') or '..' in parts:
                raise ValueError(f'Unsafe archive path: {member.name}')
            if member.issym():
                link = Path(member.linkname)
                target = str(Path(member.name).parent / link)
                if link.is_absolute() or len(link.parts) != 1 or '..' in link.parts or not bundle.getmember(target).isfile():
                    raise ValueError(f'Unsafe archive link: {member.name}')
            elif not (member.isdir() or member.isfile()):
                raise ValueError(f'Unsupported archive member: {member.name}')
        SOURCE.mkdir(parents=True)
        for member in members:
            relative = Path(*Path(member.name).parts[1:])
            destination = SOURCE / relative
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            elif member.issym():
                destination.parent.mkdir(parents=True, exist_ok=True)
                destination.symlink_to(member.linkname)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                with bundle.extractfile(member) as source, destination.open('wb') as output:
                    shutil.copyfileobj(source, output)
                destination.chmod(member.mode & 0o777)


def package_sdk(destination, lock):
    sdk = SOURCE / 'packages/node-sdk'
    shutil.copytree(sdk / 'dist', destination / 'sdk')
    packages = {}

    def add(name, modules):
        source = (modules / name).resolve(strict=True)
        package = json.loads((source / 'package.json').read_text())
        if name in packages:
            if packages[name] != package['version']:
                raise ValueError(f'External dependency version conflict: {name}')
            return
        packages[name] = package['version']
        shutil.copytree(source, destination / 'node_modules' / name,
                        ignore=shutil.ignore_patterns('node_modules'))
        parent_modules = source.parent.parent if name.startswith('@') else source.parent
        for dependency in package.get('dependencies', {}):
            add(dependency, parent_modules)

    for name in json.loads((sdk / 'package.json').read_text())['dependencies']:
        add(name, sdk / 'node_modules')
    expected = {package['name']: package['version']
                for package in lock['artifact']['externalPackages']}
    if packages != expected:
        raise ValueError('External dependency closure differs from the reviewed lock')
    records = verify_artifact(destination, lock)
    write_json(BUILD / 'artifact-files.json', records)


def build(args, lock, environment):
    archive = CACHE / 'downloads' / (lock['sourceCommit'] + '.tar.gz')
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        if args.offline:
            raise FileNotFoundError(f'Offline build requires {archive}')
        temporary = archive.with_suffix('.part')
        run(['/usr/bin/curl', '--fail', '--location', '--silent', '--show-error',
             '--connect-timeout', '15', '--max-time', '180', '--max-filesize',
             str(100 * 1024**2), '--output', temporary, lock['sourceArchiveURL']],
            'download.log', environment, cwd=BUILD, timeout=200)
        require_hash(temporary, lock['sourceArchiveSHA256'])
        temporary.replace(archive)
    require_hash(archive, lock['sourceArchiveSHA256'])

    # Re-extraction makes partially failed and repeated builds identical.
    if SOURCE.exists():
        shutil.rmtree(SOURCE)
    extract_source(archive)
    require_hash(SOURCE / 'pnpm-lock.yaml', lock['pnpmLockSHA256'])
    sdk = SOURCE / 'packages/node-sdk'
    require_hash(sdk / 'tsdown.config.ts', lock['buildConfigSHA256'])
    if json.loads((sdk / 'package.json').read_text())['version'] != lock['sdkVersion']:
        raise ValueError('SDK package version differs from the lock')

    patches = [
        ('permission-rules', lock['permissionPatch'], lock['permissionPatchSHA256']),
        ('serial-tools', lock['serialToolsPatch'], lock['serialToolsPatchSHA256']),
    ]
    # git apply can silently skip files inside an enclosing repository's
    # ignored subtree. patch plus exact before/after hashes avoids that trap.
    for name, specification, patch_hash in patches:
        patch = BUILD / (name + '.patch')
        patch.write_text(specification['text'])
        require_hash(patch, patch_hash)
        target = SOURCE / specification['target']
        require_hash(target, specification['beforeSHA256'])
        run(['/usr/bin/patch', '--batch', '--fuzz=0', '-p1', '-i', patch],
            name + '-patch.log', environment)
        require_hash(target, specification['afterSHA256'])

    store = BUILD / 'pnpm-store'
    if not store.exists() and args.seed_store.is_dir():
        # macOS clone copy keeps the original store read-only and saves space.
        run(['/bin/cp', '-cR', args.seed_store, store], 'seed-store.log',
            environment, cwd=BUILD)
    store.mkdir(parents=True, exist_ok=True)
    pnpm = [args.node, args.pnpm]
    install = pnpm + ['--filter', '@moonshot-ai/kimi-code-sdk...', 'install',
                      '--frozen-lockfile', '--ignore-scripts', '--store-dir', store,
                      '--reporter', 'append-only',
                      '--offline' if args.offline else '--prefer-offline']
    run(install, 'install.log', environment)
    run(pnpm + ['--filter', '@moonshot-ai/kimi-code-sdk', 'run', 'build'],
        'sdk-build.log', environment)
    require_hash(SOURCE / 'pnpm-lock.yaml', lock['pnpmLockSHA256'])
    require_hash(sdk / 'tsdown.config.ts', lock['buildConfigSHA256'])
    for _, specification, _ in patches:
        require_hash(SOURCE / specification['target'], specification['afterSHA256'])
    staging = CACHE / 'artifact-staging'
    if staging.exists():
        shutil.rmtree(staging)
    package_sdk(staging / 'opt/kimi', lock)
    if ARTIFACT.exists():
        # Keep existing readers on an identical, immutable directory.
        verify_artifact(ARTIFACT, lock)
        shutil.rmtree(staging)
    else:
        staging.replace(CACHE / 'artifact')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', type=Path, default=DEFAULT_NODE)
    parser.add_argument('--pnpm', type=Path, default=DEFAULT_PNPM,
                        help='Pinned pnpm 10.33.0 bin/pnpm.cjs')
    parser.add_argument('--seed-store', type=Path, default=OLD / 'pnpm-store')
    parser.add_argument('--offline', action='store_true')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--rebuild', action='store_true', help='Rebuild and compare every artifact file')
    mode.add_argument('--verify-only', action='store_true', help='Verify cached artifact without building')
    args = parser.parse_args()
    lock = json.loads((HERE / 'latest-source.lock.json').read_text())
    for name in ['logs', 'home', 'tmp', 'bin']:
        (BUILD / name).mkdir(parents=True, exist_ok=True)
    with (BUILD / 'prepare.lock').open('a') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX)
        if args.rebuild or not ARTIFACT.exists():
            if args.verify_only:
                raise FileNotFoundError(ARTIFACT)
            args.node = args.node.resolve(strict=True)
            args.pnpm = args.pnpm.resolve(strict=True)
            require_hash(args.node, lock['toolchain']['nodeSHA256'])
            require_hash(args.pnpm, lock['toolchain']['pnpmEntrySHA256'])
            # Upstream's build script invokes pnpm again. Resolve it locally.
            pnpm_link = BUILD / 'bin/pnpm'
            if pnpm_link.is_symlink():
                pnpm_link.unlink()
            pnpm_link.symlink_to(args.pnpm)
            environment = {'PATH': f'{args.node.parent}:{BUILD / "bin"}:/usr/bin:/bin',
                           'HOME': str(BUILD / 'home'), 'TMPDIR': str(BUILD / 'tmp'),
                           'CI': 'true', 'LC_ALL': 'C', 'TZ': 'UTC', 'HUSKY': '0'}
            for command, expected in [([args.node, '--version'], lock['toolchain']['nodeVersion']),
                                      ([args.node, args.pnpm, '--version'], lock['toolchain']['pnpmVersion'])]:
                actual = subprocess.check_output(command, env=environment, cwd=BUILD,
                                                 text=True, timeout=30).strip()
                if actual != expected:
                    raise ValueError(f'Tool version mismatch: {actual}, expected {expected}')
            build(args, lock, environment)
        records = verify_artifact(ARTIFACT, lock)
        print(json.dumps({'optKimi': str(ARTIFACT), 'releaseTag': lock['releaseTag'],
                          'sourceCommit': lock['sourceCommit'], 'sdkVersion': lock['sdkVersion'],
                          'sdkIndexSHA256': lock['sdkIndexSHA256'],
                          'artifactTreeSHA256': lock['artifact']['treeSHA256'],
                          'files': len(records), 'bytes': sum(item['bytes'] for item in records),
                          'verified': True}, indent=2))


if __name__ == '__main__':
    main()
