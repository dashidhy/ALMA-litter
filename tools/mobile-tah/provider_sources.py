"""Compose fork-owned providers with app-owned TAH inputs for the phone build.

ALMA_CODEX_REPO and ALMA_KIMI_REPO default to the migrated sibling forks.
TAH_RUNTIME selects the app source. ALMA_IOS_BUILD_CACHE and KIMI_ICU_LINKER
select explicit shared-host artifacts, defaulting to the Codex fork's cache.
"""

from pathlib import Path
import argparse
import hashlib
import json
import os
import subprocess
import sys
import shutil

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
OUT = HERE / '.cache/app'
APP_VERSION = '0.4.2'
APP_BUILD = '15'


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def record(path):
    return {'path': str(path), 'bytes': path.stat().st_size, 'sha256': digest(path)}


def configured_path(variable, default):
    return Path(os.environ.get(variable, str(default))).expanduser().resolve(strict=True)


def working_tree_identity(repo):
    names = subprocess.check_output(
        ['git', '-C', str(repo), 'ls-files', '--cached', '--others', '--exclude-standard', '-z']).decode().split('\0')
    rows = []
    for name in sorted(set(filter(None, names))):
        path = repo / name
        if path.is_symlink():
            rows.append([name, 'symlink', os.readlink(path)])
        elif path.is_file():
            rows.append([name, path.stat().st_mode & 0o777, digest(path)])
        elif not path.exists():
            rows.append([name, 'deleted'])
        else:
            raise ValueError(f'Unsupported working-tree entry: {path}')
    return {'sha256': hashlib.sha256(json.dumps(rows, separators=(',', ':')).encode()).hexdigest(),
            'files': len(rows), 'scope': 'tracked and non-ignored untracked files, modes and symlink targets'}


def provider_sources():
    core = configured_path('TAH_RUNTIME', REPO / 'shared/tah-runtime')
    codex = configured_path('ALMA_CODEX_REPO', REPO.parent / 'ALMA-codex')
    kimi = configured_path('ALMA_KIMI_REPO', REPO.parent / 'ALMA-kimi-code')
    zcode = configured_path('ALMA_ZCODE_REPO', REPO.parent / 'ALMA-ZCode')
    zcode_lock = json.loads((core / 'zcode-source-lock.json').read_text())
    baseline = json.loads((codex / 'ios/upstream-baseline.json').read_text())
    sdk_lock = json.loads((kimi / 'ios/sdk/source-lock.json').read_text())
    providers = {}
    for name, repo, lock_name, release in [
        ('codex', codex, 'source-lock.json', {
            'repository': baseline['upstream'], 'releaseTag': baseline['releaseTag'],
            'sourceCommit': baseline['commit']}),
        ('kimi', kimi, 'provider-source-lock.json', sdk_lock['upstream']),
        ('zcode', zcode, None, {'repository': 'https://github.com/zai-org/ZCode',
                              'releaseTag': zcode_lock['releaseTag'],
                              'sourceCommit': zcode_lock['sourceCommit']}),
    ]:
        adapter = repo / 'ios/tah-adapter'
        lock_path = adapter / lock_name if lock_name else core / 'zcode-source-lock.json'
        locked = json.loads(lock_path.read_text())['files']
        expected = locked if isinstance(locked, dict) else {row['path']: row['sha256'] for row in locked}
        files = []
        for relative, sha in sorted(expected.items()):
            source = adapter / relative
            if source.is_symlink() or not source.is_file() or digest(source) != sha:
                raise ValueError(f'{name} provider source drift: {source}')
            files.append({'path': relative, 'bytes': source.stat().st_size, 'sha256': sha})
        tag_commit = subprocess.check_output(
            ['git', '-C', str(repo), 'rev-parse', release['releaseTag'] + '^{commit}'], text=True).strip()
        if tag_commit != release['sourceCommit']:
            raise ValueError(f'{name} release tag differs from the pinned commit')
        release['tagObject'] = subprocess.check_output(
            ['git', '-C', str(repo), 'rev-parse', release['releaseTag']], text=True).strip()
        if name == 'codex' and release['tagObject'] != baseline['tagObject']:
            raise ValueError('Codex annotated tag object differs from its baseline')
        providers[name] = {'repository': str(repo), 'adapter': str(adapter), 'release': release,
                           'checkoutHead': subprocess.check_output(
                               ['git', '-C', str(repo), 'rev-parse', 'HEAD'], text=True).strip(),
                           'sourceLockSHA256': digest(lock_path), 'files': files,
                           'workingTreeContent': working_tree_identity(repo)}
    return {'tahRuntime': str(core), 'providers': providers}


def run_json(command):
    result = subprocess.run([str(part) for part in command], cwd=REPO, text=True, capture_output=True)
    if result.returncode:
        raise RuntimeError(f'Provider preparation failed: {command}\n{result.stdout}\n{result.stderr}')
    return json.loads(result.stdout.strip().splitlines()[-1])


def prepare_runtime():
    sources = provider_sources()
    adapter = Path(sources['providers']['kimi']['adapter'])
    default_cache = None
    qualified_manifest = None
    if not os.environ.get('ALMA_KIMI_COMPILE_CACHE'):
        recent = adapter.parent / 'tests/.cache/tah-sdk/latest.json'
        if not recent.exists():
            raise ValueError('Set ALMA_KIMI_COMPILE_CACHE to a prepared cache generation')
        prepared = json.loads(recent.read_text())
        if prepared.get('passed') is not True:
            raise ValueError('Recent Kimi combined qualification has not passed')
        default_cache = prepared['preparedCache']
        qualified_manifest = prepared['manifestSHA256']
    cache = configured_path('ALMA_KIMI_COMPILE_CACHE', default_cache)
    result = run_json([sys.executable, adapter / 'prepare_kimi_runtime.py',
                       '--tah-runtime', sources['tahRuntime'], '--compile-cache', cache,
                       '--require-compile-cache'])
    if result.get('compileCache', {}).get('included') is not True:
        raise ValueError('Kimi runtime did not report its prepared compile cache')
    resource = Path(result['resource'])
    if qualified_manifest and digest(resource / 'runtime-manifest.json') != qualified_manifest:
        raise ValueError('Kimi runtime differs from the latest qualified resource; wait for its updated receipt')
    return resource


def prepare_zcode_runtime():
    """Consume an explicitly prepared provider generation; never silently rebuild SDK."""
    zcode = configured_path('ALMA_ZCODE_REPO', REPO.parent / 'ALMA-ZCode')
    receipt_path = zcode / 'ios/.cache/prephone-runtime.json'
    receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else {}
    default = receipt.get('runtime', receipt.get('resource'))
    if not default and not os.environ.get('ALMA_ZCODE_RUNTIME'):
        raise ValueError('Set ALMA_ZCODE_RUNTIME to an explicitly prepared ZCode runtime generation')
    source = configured_path('ALMA_ZCODE_RUNTIME', default)
    manifest = json.loads((source / 'runtime-manifest.json').read_text())
    if manifest.get('schemaVersion') != 1:
        raise ValueError('Unsupported ZCode runtime manifest')
    names = set()
    for row in manifest['files']:
        relative = row['path']
        if relative in names or Path(relative).is_absolute() or any(x in ('', '.', '..') for x in relative.split('/')):
            raise ValueError('Invalid ZCode resource path')
        names.add(relative)
        file = source / relative
        if file.is_symlink() or file.stat().st_size != row['bytes'] or digest(file) != row['sha256']:
            raise ValueError('ZCode runtime asset identity mismatch')
    if not {'catalog.json', 'guest.cjs', 'sdk/backend.cjs'}.issubset(names):
        raise ValueError('ZCode runtime/catalog incomplete')
    identity = digest(source / 'runtime-manifest.json')
    destination = HERE / '.cache/zcode-resources' / identity / 'zcode-runtime'
    if destination.exists():
        for row in manifest['files']:
            if digest(destination / row['path']) != row['sha256']:
                raise ValueError('Installed App build resource has drifted')
    else:
        destination.parent.mkdir(parents=True, exist_ok=True)
        staging = destination.with_name('staging')
        if staging.exists():
            shutil.rmtree(staging)
        shutil.copytree(source, staging)
        staging.rename(destination)
    return destination


def prepare_provider_resources():
    """Return (rootfs manifest Path, Kimi runtime Path) from migrated builders."""
    sources = provider_sources()
    codex = Path(sources['providers']['codex']['repository'])
    adapter = Path(sources['providers']['kimi']['adapter'])
    cache = configured_path('ALMA_IOS_BUILD_CACHE', REPO / 'tools/alma-ios-lab/.cache')
    linker = configured_path('KIMI_ICU_LINKER', cache / 'phone-build-bin/ld.lld')
    result = run_json([sys.executable, adapter / 'prepare_kimi_rootfs.py',
                       '--host-tools', codex / 'ios/build', '--host-cache', cache,
                       '--rootfs-package-lock', codex / 'ios/inputspins/ish-package-lock.json',
                       '--linker', linker])
    manifest_path = Path(result['manifest'])
    runtime = prepare_runtime()
    cache = json.loads((runtime / 'compile-cache/manifest.json').read_text())
    rootfs = Path(json.loads(manifest_path.read_text())['fs'])
    if digest(rootfs / 'data/usr/bin/node') != cache['identity']['nodeSHA256']:
        raise ValueError('Prepared Kimi cache differs from the bundled Node binary')
    return manifest_path, runtime


def write_build_identity(rootfs_manifest, kimi_runtime):
    sources = provider_sources()
    core = Path(sources['tahRuntime'])
    manifest_path = core / 'generated/bundle-manifest.json'
    bundle = json.loads(manifest_path.read_text())
    if bundle['providerSources'] != sources or digest(core / 'generated/alma-tah.js') != bundle['sha256']:
        raise ValueError('Trusted bundle provider identity is stale; rebuild build_bundle.mjs')
    zcode_runtime = prepare_zcode_runtime()
    value = {'schemaVersion': 1, 'appVersion': APP_VERSION, 'appBuild': APP_BUILD,
             'sources': sources, 'trustedBundle': bundle,
             'artifacts': {'trustedBundle': record(core / 'generated/alma-tah.js'),
                           'trustedBundleManifest': record(manifest_path),
                           'configuration': record(OUT / 'mobile-config.json'),
                           'kimiRuntimeManifest': record(kimi_runtime / 'runtime-manifest.json'),
                           'kimiGuest': record(kimi_runtime / 'guest.mjs'),
                           'zcodeRuntimeManifest': record(zcode_runtime / 'runtime-manifest.json'),
                           'zcodeCatalog': record(zcode_runtime / 'catalog.json'),
                           'providerChunks': {name: record(core / 'generated' / chunk['filename']) for name, chunk in bundle['chunks'].items()},
                           'kimiSDKLock': record(Path(sources['providers']['kimi']['repository']) / 'ios/sdk/source-lock.json')},
             'kimiRuntime': json.loads((kimi_runtime / 'runtime-manifest.json').read_text()),
             'zcodeRuntime': json.loads((zcode_runtime / 'runtime-manifest.json').read_text())}
    if rootfs_manifest is not None:
        value['artifacts']['rootfsManifest'] = record(rootfs_manifest)
        value['rootfs'] = json.loads(rootfs_manifest.read_text())
    path = OUT / 'provider-build-identity.json'
    path.write_text(json.dumps(value, indent=2) + '\n')
    return path


def native_input_records(sources):
    native_files = {}
    for name, provider in sources['providers'].items():
        native = Path(provider['repository']) / 'ios/native'
        paths = [native / 'Cargo.toml', *sorted((native / 'src').rglob('*.rs'))]
        native_files[name] = [record(path) for path in paths]
    facade = REPO / 'shared/rust-bridge'
    tauri = REPO / 'apps/ios/tah-ui/src-tauri'
    native_files['app'] = [record(path) for path in [
        facade / 'Cargo.toml', facade / 'Cargo.lock', facade / 'codex-mobile-client/Cargo.toml',
        *sorted((facade / 'codex-mobile-client/src').rglob('*.rs')),
        tauri / 'Cargo.toml', tauri / 'build.rs', tauri / 'tauri.conf.json',
        *sorted((tauri / 'src').rglob('*.rs')),
        *sorted(path for path in (tauri / 'icons').rglob('*') if path.is_file()),
        *sorted(path for path in (tauri.parent / 'dist').rglob('*') if path.is_file()),
    ]]
    return native_files


def write_native_provenance(artifact, command, expected_sources=None):
    """Record the successful native artifact for main's build_tauri.py caller."""
    sources = provider_sources()
    native_files = native_input_records(sources)
    if expected_sources is not None and expected_sources != native_files:
        raise ValueError('Native source changed during compilation; rebuild before packaging')
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / 'native-build-identity.json'
    path.write_text(json.dumps({'schemaVersion': 1, 'appVersion': APP_VERSION, 'appBuild': APP_BUILD,
                               'providers': sources['providers'], 'nativeSources': native_files,
                               'artifact': record(Path(artifact).resolve(strict=True)),
                               'command': [str(part) for part in command]}, indent=2) + '\n')
    return path


def verify_native_provenance(value):
    """Refuse a stale native archive even if its artifact hash still matches."""
    current = native_input_records(provider_sources())
    if value.get('nativeSources') != current:
        raise ValueError('Native sources differ from the built archive; rerun build_tauri.py')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources', action='store_true', help='Print validated provider input metadata')
    parser.parse_args()
    print(json.dumps(provider_sources()))
