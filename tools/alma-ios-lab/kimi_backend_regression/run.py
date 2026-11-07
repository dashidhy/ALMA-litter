#!/usr/bin/env python3
"""Small offline host contract harness and real-dependency iOS metadata check.

Production module is compiled unchanged. Host ExecProcess producer/traits are
extracted from pinned source, with explicit protocol DTO and scope test doubles.
The iOS check uses the cached actual ExecProcess and dependency metadata.
"""
from pathlib import Path
import hashlib, json, os, subprocess, sys

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
CACHE = HERE / '.cache'
TOOLCHAIN = REPO.parent / 'ALMA/.build/tauri-toolchain'
RUST = TOOLCHAIN / 'rustup/toolchains/stable-aarch64-apple-darwin/bin'
SOURCE = REPO / 'shared/rust-bridge/codex-mobile-client/src/kimi_backend.rs'


def main():
    fixtures = json.loads((HERE / 'web-codec-fixtures.json').read_text())
    lock = json.loads((REPO / 'tools/kimi-mobile-probe/latest-source.lock.json').read_text())
    for key in ['releaseVersion', 'sdkVersion', 'sourceCommit']:
        assert fixtures[key] == lock[key], 'Pinned web codec version drift'
    for fixture in fixtures['fixtures']:
        source = REPO / 'tools/kimi-mobile-probe/.cache/latest-release/source' / fixture['sourcePath']
        if source.exists():
            assert hashlib.sha256(source.read_bytes()).hexdigest() == fixture['sourceSHA256'], 'Pinned web codec source drift'
    for name in ['core/src', 'ish/src', 'driver/src']:
        (CACHE / name).mkdir(parents=True, exist_ok=True)
    core = (REPO / 'shared/third_party/codex/codex-rs/exec-server/src/process.rs').read_text()
    producer = core[core.index('/// Pushed process events'):core.index('#[cfg(test)]')]
    fixture = (HERE.parent / 'backend_regression/fixtures/core_types.rs').read_text()
    (CACHE / 'core/src/lib.rs').write_text(fixture + producer)
    (CACHE / 'core/Cargo.toml').write_text('''[package]
name="codex-exec-server"
version="0.0.0"
edition="2024"
[dependencies]
tokio={version="=1.52.3",features=["sync","rt","time","macros"]}
''')
    (CACHE / 'ish/src/lib.rs').write_text((HERE.parent / 'backend_regression/fixtures/ish_mock.rs').read_text())
    (CACHE / 'ish/Cargo.toml').write_text('''[package]
name="ish-embed-host"
version="0.0.0"
edition="2024"
[dependencies]
tokio={version="=1.52.3",features=["sync","rt","time","macros"]}
''')
    root = f'#[path={json.dumps(str(HERE / "scope.rs"))}] mod provider_scope;\n'
    root += f'#[path={json.dumps(str(SOURCE))}] mod kimi_backend;\n'
    root += f'#[cfg(test)] #[path={json.dumps(str(HERE / "tests.rs"))}] mod tests;\n'
    adapter = REPO / 'shared/rust-bridge/codex-mobile-client/src/ish_exec_backend.rs'
    root += f'#[cfg(test)] #[path={json.dumps(str(adapter))}] mod ish_exec_backend;\n'
    root += f'#[cfg(test)] #[path={json.dumps(str(HERE / "owned_process_tests.rs"))}] mod owned_process_tests;\n'
    (CACHE / 'driver/src/lib.rs').write_text(root)
    (CACHE / 'driver/Cargo.toml').write_text('''[package]
name="kimi-backend-contract-check"
version="0.0.0"
edition="2024"
[workspace]
[dependencies]
codex-exec-server={path="../core"}
ish-embed-host={path="../ish"}
tokio={version="=1.52.3",features=["sync","rt-multi-thread","time","macros","net","io-util","test-util"]}
reqwest={version="=0.12.28",default-features=false,features=["http2","json","rustls-tls","stream"]}
futures="=0.3.32"
serde_json="=1.0.149"
base64="=0.22.1"
[profile.dev]
debug=0
incremental=false
[profile.test]
debug=0
incremental=false
''')
    env = dict(os.environ, CARGO_HOME=str(TOOLCHAIN / 'cargo'), RUSTC=str(RUST / 'rustc'),
               RUSTDOC=str(RUST / 'rustdoc'), CARGO_TARGET_DIR=str(CACHE / 'target'))
    for key in ['RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS']:
        env.pop(key, None)
    if '--ios' in sys.argv:
        deps = REPO / 'shared/rust-bridge/target/aarch64-apple-ios/ios-dev/deps'
        host = REPO / 'shared/rust-bridge/target/ios-dev/deps'
        fingerprints = deps.parent / '.fingerprint'
        mobile = max(fingerprints.glob('codex-mobile-client-*/lib-codex_mobile_client.json'),
                     key=lambda path: path.stat().st_mtime_ns)
        dependencies = {item[1]: item[3] for item in json.loads(mobile.read_text())['deps']}
        command = [str(RUST / 'rustc'), '--crate-name', 'kimi_backend_ios_check', '--crate-type', 'lib',
                   '--edition=2024', '--target=aarch64-apple-ios', '--emit=metadata',
                   str(CACHE / 'driver/src/lib.rs'), '-o', str(CACHE / 'ios.rmeta'),
                   '-L', 'dependency=' + str(deps), '-L', 'dependency=' + str(host)]
        for name in ['reqwest', 'tokio', 'codex_exec_server', 'futures', 'serde_json', 'base64']:
            # Cargo may have several feature-unified builds of the same version.
            # Select the actual successful mobile build graph, never mixed mtimes.
            expected = dependencies[name].to_bytes(8, 'little').hex()
            fingerprint = next(path for path in fingerprints.glob(f'*/lib-{name}')
                               if path.read_text().strip() == expected)
            artifact_hash = fingerprint.parent.name.rsplit('-', 1)[1]
            dep = deps / f'lib{name}-{artifact_hash}.rmeta'
            command += ['--extern', name + '=' + str(dep)]
    else:
        command = [str(RUST / 'cargo'), 'test', '--offline', '-j', '2', '--manifest-path',
                   str(CACHE / 'driver/Cargo.toml'), '--', '--test-threads=1']
    result = subprocess.run(command, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, timeout=180)
    (CACHE / ('ios.log' if '--ios' in sys.argv else 'host.log')).write_text(result.stdout)
    print(result.stdout)
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
