#!/usr/bin/env python3
"""Prepare verified plain iOS V8 inputs, without building or changing Cargo.

  python3 tools/alma-ios-lab/prepare_native_v8.py
  python3 tools/alma-ios-lab/prepare_native_v8.py --check-only
  python3 tools/alma-ios-lab/prepare_native_v8.py --check-only --print-env-json
  python3 tools/alma-ios-lab/prepare_native_v8.py --self-test

Default: prepare missing .build/vendor/codex-v8 from the pinned source archive.
Existing sources/assets are checked and never repaired, deleted, or overwritten.
Only missing pinned assets may be downloaded. --check-only never writes/downloads.
--print-env-json emits ONLY the three verified environment entries to stdout;
the qualification label goes to stderr. No environment is installed globally.

Plain V8 lacks the desktop V8 memory sandbox. Opt-in qualification only.
The helper checks immutability; it does not set filesystem immutable flags.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CACHE = HERE / '.cache/v8-ios'
DEST = REPO / '.build/vendor/codex-v8'
INPUTS = HERE / 'native_v8_inputs.json'


class InputError(RuntimeError):
    pass


def sha(path: Path) -> str:
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def ordinary_directory(path: Path) -> None:
    # Refuse redirected output/cache paths rather than writing through symlinks.
    for parent in [path, *path.parents]:
        if parent.is_symlink():
            raise InputError(f'Symlink directory is unsupported: {parent}')
        if parent.exists() and not parent.is_dir():
            raise InputError(f'Expected directory: {parent}')


def verify_asset(path: Path, expected: str, maximum: int) -> None:
    try:
        metadata = path.lstat()
    except FileNotFoundError as error:
        raise InputError(f'Missing pinned asset: {path}') from error
    if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
        raise InputError(f'Expected ordinary non-linked asset; preserving it: {path}')
    if metadata.st_size > maximum or sha(path) != expected:
        raise InputError(f'Pinned asset size/hash mismatch; preserving it: {path}')


def configuration():
    inputs = json.loads(INPUTS.read_text())
    lock = json.loads((HERE / inputs['source_lock']).read_text())
    if (inputs['schema_version'] != 1
            or lock['commit'] != inputs['commit']
            or lock['sourceSHA256'] != inputs['source_sha256']
            or lock['sourceBytes'] != inputs['source_expanded_bytes']
            or lock['artifacts'] != inputs['artifact_sha256']):
        raise InputError('native_v8_inputs.json and verified probe source-lock.json disagree')
    assets = {
        'source.tar.gz': (lock['sourceURL'], lock['sourceSHA256']),
        'v8-ios.a.gz': (lock['archiveURL'], lock['artifacts']['v8-ios.a.gz']),
        'bindings-ios.rs': (lock['bindingsURL'], lock['artifacts']['bindings-ios.rs']),
    }
    expected_urls = {
        'source.tar.gz': 'https://codeload.github.com/seanh-oai/rusty_v8/tar.gz/' + inputs['commit'],
        'v8-ios.a.gz': 'https://github.com/denoland/rusty_v8/releases/download/v152.2.0/librusty_v8_release_aarch64-apple-ios.a.gz',
        'bindings-ios.rs': 'https://github.com/denoland/rusty_v8/releases/download/v152.2.0/src_binding_release_aarch64-apple-ios.rs',
    }
    if any(url != expected_urls[name] for name, (url, _) in assets.items()):
        raise InputError('Pinned URL differs from the qualified source/artifact pair')
    # Download temp is moved into place, never copied; extraction and self-test
    # copies are bounded by the exact small source size. Leave 8 MiB for metadata.
    reserve = sum(inputs['asset_max_bytes'].values()) + 4 * lock['sourceBytes'] + 8 * 1024**2
    if reserve > inputs['max_new_disk_bytes']:
        raise InputError('Configured write bounds exceed 100 MiB')
    return inputs, assets


def download_missing(path: Path, url: str, digest: str, maximum: int, timeout: int) -> bool:
    if path.exists() or path.is_symlink():
        verify_asset(path, digest, maximum)
        return False
    ordinary_directory(path.parent)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.native-v8-download-', dir=path.parent) as directory:
        staged = Path(directory) / 'asset'
        subprocess.run([
            'curl', '-q', '--fail', '--location', '--proto', '=https', '--proto-redir', '=https',
            '--connect-timeout', '10', '--max-time', str(timeout), '--max-filesize', str(maximum),
            '--silent', '--show-error', url, '-o', str(staged),
        ], check=True, timeout=timeout + 5)
        verify_asset(staged, digest, maximum)
        try:
            # Exclusive installation: never clobber an asset another preparer made.
            os.link(staged, path)
        except FileExistsError:
            verify_asset(path, digest, maximum)
            return False
        staged.unlink()  # Remove our temporary name, not an existing archive.
    verify_asset(path, digest, maximum)
    return True


def source_catalog(archive: Path, inputs: dict) -> dict:
    expected_root = 'rusty_v8-' + inputs['commit']
    result = {}
    total = 0
    with tarfile.open(archive, 'r:gz') as tar:
        for index, member in enumerate(tar):
            if index >= 10000:
                raise InputError('Source archive member bound exceeded')
            path = PurePosixPath(member.name)
            if (path.is_absolute() or '..' in path.parts or not path.parts
                    or path.parts[0] != expected_root
                    or str(path) != member.name.rstrip('/')):
                raise InputError('Unexpected source archive path')
            if not (member.isfile() or member.isdir()):
                raise InputError('Source archive links/special files are unsupported')
            relative = str(PurePosixPath(*path.parts[1:]))
            if relative in result:
                raise InputError('Duplicate source archive entry')
            total += member.size
            if total > inputs['source_expanded_bytes']:
                raise InputError('Source archive expanded-size bound exceeded')
            entry = {'kind': 'directory' if member.isdir() else 'file'}
            if member.isfile():
                stream = tar.extractfile(member)
                if stream is None:
                    raise InputError('Missing file payload in source archive')
                with stream:
                    entry.update(bytes=member.size, sha256=hashlib.file_digest(stream, 'sha256').hexdigest(),
                                 executable=bool(member.mode & 0o111))
            result[relative] = entry
    if (total != inputs['source_expanded_bytes']
            or sum(x['kind'] == 'file' for x in result.values()) != inputs['source_files']
            or result.get('.') != {'kind': 'directory'}):
        raise InputError('Source archive does not match the qualified file/size inventory')
    return result


def verify_source(root: Path, expected: dict) -> None:
    if not root.exists() or root.is_symlink() or not root.is_dir():
        raise InputError(f'Missing or redirected source directory: {root}')
    seen = {'.'}

    def walk(directory: Path):
        with os.scandir(directory) as entries:
            for item in entries:
                path = Path(item.path)
                name = str(path.relative_to(root))
                metadata = item.stat(follow_symlinks=False)
                entry = expected.get(name)
                if entry is None:
                    raise InputError(f'Unknown source entry; preserving it: {path}')
                seen.add(name)
                if entry['kind'] == 'directory' and stat.S_ISDIR(metadata.st_mode):
                    walk(path)
                elif (entry['kind'] == 'file' and stat.S_ISREG(metadata.st_mode)
                      and metadata.st_nlink == 1):
                    if (metadata.st_size != entry['bytes']
                            or bool(metadata.st_mode & 0o111) != entry['executable']
                            or sha(path) != entry['sha256']):
                        raise InputError(f'Modified source file; preserving it: {path}')
                else:
                    raise InputError(f'Source type/link differs; preserving it: {path}')
    walk(root)
    missing = set(expected) - seen
    if missing:
        raise InputError(f'Source entries missing; preserving source: {sorted(missing)[:3]}')


def materialize(archive: Path, destination: Path, inputs: dict, expected: dict) -> bool:
    ordinary_directory(destination.parent)
    if destination.exists() or destination.is_symlink():
        verify_source(destination, expected)
        return False
    if sys.platform != 'darwin':
        raise InputError('Atomic source preparation requires the macOS iOS build host')
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='.native-v8-source-', dir=destination.parent) as directory:
        stage = Path(directory) / 'source'
        stage.mkdir()
        # Explicit regular-file extraction; no tar links, owners or absolute paths.
        with tarfile.open(archive, 'r:gz') as tar:
            for member in tar:
                relative = str(PurePosixPath(*PurePosixPath(member.name).parts[1:]))
                entry = expected[relative]
                target = stage / relative
                if entry['kind'] == 'directory':
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    stream = tar.extractfile(member)
                    with stream, target.open('xb') as output:
                        shutil.copyfileobj(stream, output, length=65536)
                    target.chmod(0o755 if entry['executable'] else 0o644)
        verify_source(stage, expected)
        if destination.exists() or destination.is_symlink():
            verify_source(destination, expected)
            return False
        # On this macOS/iOS build host, renamex_np(RENAME_EXCL) installs the
        # staged tree atomically without overwriting even an empty competing dir.
        import ctypes
        libc = ctypes.CDLL(None, use_errno=True)
        rename = libc.renamex_np
        rename.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint]
        rename.restype = ctypes.c_int
        if rename(os.fsencode(stage), os.fsencode(destination), 0x4) != 0:
            error = ctypes.get_errno()
            if error == 17:  # EEXIST: verify the concurrently installed tree.
                verify_source(destination, expected)
                return False
            raise OSError(error, os.strerror(error))
    verify_source(destination, expected)
    return True


def prepare(check_only: bool = False) -> dict:
    inputs, assets = configuration()
    ordinary_directory(CACHE)
    ordinary_directory(DEST.parent)
    # Check ALL pre-existing artifacts first, before any download or source write.
    for name, (_, digest) in assets.items():
        path = CACHE / name
        if check_only or path.exists() or path.is_symlink():
            verify_asset(path, digest, inputs['asset_max_bytes'][name])
    # Fail on modified source before downloading any other missing assets.
    expected = None
    if (CACHE/'source.tar.gz').exists():
        expected = source_catalog(CACHE/'source.tar.gz', inputs)
        if DEST.exists() or DEST.is_symlink():
            verify_source(DEST, expected)
    downloaded = []
    if not check_only:
        ancestor = DEST.parent
        while not ancestor.exists(): ancestor = ancestor.parent
        if shutil.disk_usage(ancestor).free < inputs['max_new_disk_bytes']:
            raise InputError('Less than 100 MiB available for bounded preparation')
        for name, (url, digest) in assets.items():
            if download_missing(CACHE/name, url, digest, inputs['asset_max_bytes'][name], inputs['download_timeout_seconds']):
                downloaded.append(name)
            if name == 'source.tar.gz' and expected is None:
                expected = source_catalog(CACHE/name, inputs)
                if DEST.exists() or DEST.is_symlink():
                    verify_source(DEST, expected)
    expected = expected or source_catalog(CACHE/'source.tar.gz', inputs)
    created = False
    if check_only:
        verify_source(DEST, expected)
    else:
        created = materialize(CACHE/'source.tar.gz', DEST, inputs, expected)
    # Validate returned inputs again after preparation; never print unchecked paths.
    for name, (_, digest) in assets.items():
        verify_asset(CACHE/name, digest, inputs['asset_max_bytes'][name])
    return {
        'verified': True, 'qualification': inputs['qualification'], 'memory_sandbox': False,
        'commit': inputs['commit'], 'source': str(DEST), 'source_created': created,
        'source_files_checked': inputs['source_files'], 'source_expanded_bytes': inputs['source_expanded_bytes'],
        'source_inventory_sha256': hashlib.sha256(json.dumps(expected, sort_keys=True).encode()).hexdigest(),
        'downloaded': downloaded, 'check_only': check_only,
        'env': {'RUSTY_V8_ARCHIVE': str(CACHE/'v8-ios.a.gz'),
                'RUSTY_V8_ARCHIVE_SHA256': inputs['artifact_sha256']['v8-ios.a.gz'],
                'RUSTY_V8_SRC_BINDING_PATH': str(CACHE/'bindings-ios.rs')},
    }


def self_test() -> dict:
    inputs, _ = configuration()
    first = prepare()
    def stamps():
        return {str(p.relative_to(DEST)): (p.stat().st_size, p.stat().st_mtime_ns, p.stat().st_mode)
                for p in [DEST, *DEST.rglob('*')]}
    before = stamps()
    second = prepare()
    checked = prepare(check_only=True)
    assert not second['source_created'] and not second['downloaded']
    assert first['env'] == second['env'] == checked['env']
    assert before == stamps(), 'idempotent prepare changed the source'
    expected = source_catalog(CACHE/'source.tar.gz', inputs)
    passed = ['pinned_asset_hashes', 'exact_source_inventory', 'prepare_idempotence', 'check_only_preserves_source']
    with tempfile.TemporaryDirectory(prefix='.native-v8-selftest-', dir=DEST.parent) as directory:
        root = Path(directory)/'source'
        materialize(CACHE/'source.tar.gz', root, inputs, expected)
        def rejects(fn):
            try: fn()
            except InputError: return
            raise AssertionError('invalid input was accepted')
        file = root/'Cargo.toml'
        original = file.read_bytes()
        file.write_bytes(original+b'\n# synthetic unknown edit\n')
        modified = file.read_bytes()
        rejects(lambda: materialize(CACHE/'source.tar.gz', root, inputs, expected))
        assert file.read_bytes() == modified
        file.write_bytes(original)
        passed.append('modified_source_rejected_without_repair')
        extra = root/'synthetic-extra'
        extra.write_text('owned test fixture')
        rejects(lambda: verify_source(root, expected))
        assert extra.exists()
        extra.unlink()
        passed.append('unknown_source_entry_rejected_without_deletion')
        bad = Path(directory)/'bad-archive'
        bad.write_bytes(b'owned synthetic hash mismatch')
        rejects(lambda: verify_asset(bad, inputs['source_sha256'], 1024))
        assert bad.read_bytes() == b'owned synthetic hash mismatch'
        passed.append('bad_asset_hash_rejected_without_deletion')
        linked = Path(directory)/'linked-asset'
        linked.symlink_to(bad)
        rejects(lambda: verify_asset(linked, inputs['source_sha256'], 1024))
        passed.append('symlink_asset_rejected')
    verify_source(DEST, expected)
    return {'passed': passed, 'count': len(passed), 'network_used': bool(first['downloaded']),
            'qualification': inputs['qualification'], 'source': str(DEST)}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--check-only', action='store_true', help='Read-only verification; no downloads or directory creation')
    parser.add_argument('--print-env-json', action='store_true', help='Print only the three verified build environment entries')
    parser.add_argument('--self-test', action='store_true', help='Prepare, verify idempotence, test rejection in disposable private fixtures')
    args = parser.parse_args()
    if args.self_test and (args.check_only or args.print_env_json):
        parser.error('--self-test cannot be combined with other modes')
    try:
        result = self_test() if args.self_test else prepare(args.check_only)
        if args.print_env_json:
            print(result['qualification'], file=sys.stderr)
            result = result['env']
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except (InputError, OSError, ValueError, KeyError, tarfile.TarError, subprocess.SubprocessError) as error:
        print(json.dumps({'verified': False, 'error': str(error), 'existing_inputs_preserved': True}), file=sys.stderr)
        return 2


if __name__ == '__main__':
    raise SystemExit(main())
