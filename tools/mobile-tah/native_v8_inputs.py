"""Verify fork V8 sources plus the exact binding emitted by Cargo's build script.

The generated binding is accepted only when it matches the pinned input artifact.
All other source additions and modifications retain the fork verifier's rejection.
"""
import importlib.util
import hashlib
from pathlib import Path

from provider_sources import REPO, configured_path


def verified_environment(codex):
    spec = importlib.util.spec_from_file_location('fork_v8_inputs', codex / 'ios/build/prepare_native_v8.py')
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    cache = configured_path('ALMA_IOS_BUILD_CACHE', REPO / 'tools/alma-ios-lab/.cache') / 'v8-ios'
    helper.CACHE = cache
    inputs, assets = helper.configuration()
    helper.ordinary_directory(cache)
    helper.ordinary_directory(helper.DEST.parent)
    for name, (_, digest) in assets.items():
        helper.verify_asset(cache / name, digest, inputs['asset_max_bytes'][name])
    expected = helper.source_catalog(cache / 'source.tar.gz', inputs)
    relative = 'gen/src_binding_release_aarch64-apple-ios.rs'
    generated = helper.DEST / relative
    if generated.exists() or generated.is_symlink():
        helper.verify_asset(generated, inputs['artifact_sha256']['bindings-ios.rs'],
                            inputs['asset_max_bytes']['bindings-ios.rs'])
        expected[relative] = {'kind': 'file', 'bytes': generated.stat().st_size,
                              'sha256': inputs['artifact_sha256']['bindings-ios.rs'], 'executable': False}
    checksum_relative = 'gen/src_binding_release_aarch64-apple-ios.sum'
    checksum = helper.DEST / checksum_relative
    if checksum.exists() or checksum.is_symlink():
        digest = inputs['artifact_sha256']['bindings-ios.rs']
        content = f"url {assets['bindings-ios.rs'][0]}\narchive-sha256 {digest}\nsha256 {digest}\n".encode()
        expected[checksum_relative] = {'kind': 'file', 'bytes': len(content),
                                      'sha256': hashlib.sha256(content).hexdigest(), 'executable': False}
    helper.verify_source(helper.DEST, expected)
    return {'RUSTY_V8_ARCHIVE': str(cache / 'v8-ios.a.gz'),
            'RUSTY_V8_ARCHIVE_SHA256': inputs['artifact_sha256']['v8-ios.a.gz'],
            'RUSTY_V8_SRC_BINDING_PATH': str(cache / 'bindings-ios.rs')}
