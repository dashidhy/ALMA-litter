"""Verify a signed prototype's resources; this command never installs an App."""
from pathlib import Path
import argparse
import hashlib
import json
import plistlib
import subprocess
from provider_sources import verify_native_provenance

HERE = Path(__file__).resolve().parent


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def runtime(root):
    manifest = json.loads((root / 'runtime-manifest.json').read_text())
    expected = {'runtime-manifest.json'}
    for entry in manifest['files']:
        relative = entry['path']
        if Path(relative).is_absolute() or any(part in ('', '.', '..') for part in relative.split('/')):
            raise ValueError('Invalid runtime asset path')
        file = root / relative
        if relative in expected or file.is_symlink() or not file.is_file():
            raise ValueError('Invalid runtime asset inventory')
        expected.add(relative)
        if file.stat().st_size != entry['bytes'] or sha(file) != entry['sha256']:
            raise ValueError(f'Runtime asset identity mismatch: {relative}')
    entries = list(root.rglob('*'))
    if any(path.is_symlink() for path in entries):
        raise ValueError('Unexpected runtime symlink')
    if {path.relative_to(root).as_posix() for path in entries if path.is_file()} != expected:
        raise ValueError('Unexpected runtime files')
    return {'manifestSHA256': sha(root / 'runtime-manifest.json'), 'files': len(manifest['files'])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--app', type=Path, default=HERE / '.cache/TauriDerivedData/Build/Products/Release-iphoneos/AlmaTAHTauri.app')
    parser.add_argument('--report', type=Path, default=HERE / '.cache/zcode-composition/artifact.json')
    parser.add_argument('--expect-kimi-manifest')
    parser.add_argument('--expect-zcode-manifest')
    parser.add_argument('--expect-app-version')
    parser.add_argument('--expect-app-build')
    parser.add_argument('--verify-native-inputs', action='store_true', help='Require the packaged native provenance to match current source and retained archive')
    parser.add_argument('--phone-candidate', action='store_true', help='Mark resources as finally qualified on Mac; does not claim phone validation')
    args = parser.parse_args()
    app = args.app.resolve(strict=True)
    subprocess.run(['codesign', '--verify', '--deep', '--strict', str(app)], check=True)
    info = plistlib.loads((app / 'Info.plist').read_bytes())
    if args.expect_app_version and info['CFBundleShortVersionString'] != args.expect_app_version:
        raise ValueError('App version differs from the expected candidate')
    if args.expect_app_build and info['CFBundleVersion'] != args.expect_app_build:
        raise ValueError('App build differs from the expected candidate')
    native = json.loads((app / 'native-build-identity.json').read_text())
    if args.verify_native_inputs:
        verify_native_provenance(native)
        if sha(Path(native['artifact']['path'])) != native['artifact']['sha256']:
            raise ValueError('Native archive differs from its signed-package provenance')
    bundle = json.loads((app / 'bundle-manifest.json').read_text())
    config = json.loads((app / 'mobile-config.json').read_text())
    if sha(app / 'alma-tah.js') != bundle['sha256']:
        raise ValueError('Trusted Core bundle differs')
    for name in ['codex', 'kimi', 'zcode']:
        chunk = bundle['chunks'][name]
        if chunk['filename'] != f'alma-provider-{name}.js' or sha(app / chunk['filename']) != chunk['sha256']:
            raise ValueError('Provider chunk differs')
    runtimes = {name: runtime(app / f'{name}-runtime') for name in ['kimi', 'zcode']}
    for name, expected in [('kimi', args.expect_kimi_manifest), ('zcode', args.expect_zcode_manifest)]:
        if expected and runtimes[name]['manifestSHA256'] != expected:
            raise ValueError(f'{name} generation differs from the expected qualified resource')
    cache = json.loads((app / 'kimi-runtime/compile-cache/manifest.json').read_text())
    if cache['identity']['nodeSHA256'] != sha(app / 'fs/data/usr/bin/node'):
        raise ValueError('Kimi cache Node identity differs')
    profiles = [profile['id'] for profile in config['profiles']]
    if profiles != ['codex', 'kimi', 'zcode']:
        raise ValueError('Provider configuration differs')
    report = {'status': 'mac-qualified-phone-candidate' if args.phone_candidate else 'composition-build-awaiting-final-resources',
              'app': str(app), 'appVersion': info['CFBundleShortVersionString'], 'appBuild': info['CFBundleVersion'],
              'bundleID': info['CFBundleIdentifier'], 'executableSHA256': sha(app / info['CFBundleExecutable']),
              'trustedBundleSHA256': bundle['sha256'], 'nativeBuildIdentitySHA256': sha(app / 'native-build-identity.json'),
              'nativeSourcesMatchCurrent': True if args.verify_native_inputs else None,
              'nativeArchiveSHA256': native['artifact']['sha256'],
              'runtimeAssets': runtimes, 'kimiCacheManifestSHA256': sha(app / 'kimi-runtime/compile-cache/manifest.json'),
              'profiles': profiles, 'signed': True, 'codesignDeepStrictPassed': True,
              'phoneTouched': False, 'phoneTestReady': args.phone_candidate}
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
