#!/usr/bin/env python3
"""Compile/run exact leading guards with the real network_scope in both modes.

Only the post-guard continuation and TransportError container are harness shims.
This does not establish a connection or compile the full mobile crate.
"""
import hashlib
import json
from pathlib import Path
import subprocess
from run import SRC, HERE, BUILD, TOOLCHAIN, block

METHODS = ['connect_remote', 'connect_remote_over_slingshot',
           'connect_remote_over_ssh_bridges', 'connect_remote_over_ssh',
           'finish_connect_remote_over_ssh']


def main():
    out = BUILD / 'remote-cli-guards'
    out.mkdir(parents=True, exist_ok=True)
    mobile = (SRC / 'mobile_client/mod.rs').read_text()
    before_path = BUILD / 'remote-cli-before/mobile_client/mod.rs'
    before = before_path.read_text() if before_path.exists() else None
    ffi = (SRC / 'ffi/client.rs').read_text()
    network = SRC / 'network_scope.rs'
    expected = '''if !crate::network_scope::remote_cli_available() {
        return Err(TransportError::ConnectionFailed(
            crate::network_scope::REMOTE_CLI_UNSUPPORTED.into(),
        ));
    }'''
    probes = []
    for method in METHODS:
        body = block(mobile, mobile.index('async fn '+method+'('))
        body = body[body.index('{')+1:-1].strip()
        assert body.startswith('if !crate::network_scope::remote_cli_available()'), method
        guard = block(body, 0)
        assert ''.join(guard.split()) == ''.join(expected.split()), method
        if before is not None:
            original = block(before, before.index('async fn '+method+'('))
            original_body = original[original.index('{')+1:-1].strip()
            # All existing enrollment/session/SSH behavior stays after the guard.
            assert body[len(guard):].strip() == original_body, method
        probes.append(f'fn {method}() -> Result<(), TransportError> {{\n{guard}\nSIDE_EFFECTS.fetch_add(1, std::sync::atomic::Ordering::SeqCst); Ok(())\n}}')
    accessor = block(ffi, ffi.index('pub fn remote_cli_available(&self)'))
    assert ''.join(accessor.split()) == 'pubfnremote_cli_available(&self)->bool{crate::network_scope::remote_cli_available()}'
    generated = '''#![allow(dead_code)]
#[derive(Debug, PartialEq)] enum TransportError { ConnectionFailed(String) }
static SIDE_EFFECTS: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
'''+f'#[path={json.dumps(str(network))}] mod network_scope;\n'
    generated += '\n'.join(probes)
    generated += '\nstruct Capability; impl Capability { '+accessor+' }\n'
    generated += '''#[test]
fn guards_run_before_side_effects_and_accessors_report_the_same_capability() {
    assert_eq!(Capability.remote_cli_available(), cfg!(feature="remote-cli"));
    for guard in [METHODS] {
        SIDE_EFFECTS.store(0, std::sync::atomic::Ordering::SeqCst);
        let result = guard();
        if cfg!(feature="remote-cli") {
            assert_eq!(result, Ok(()));
            assert_eq!(SIDE_EFFECTS.load(std::sync::atomic::Ordering::SeqCst), 1);
        } else {
            assert_eq!(result, Err(TransportError::ConnectionFailed(network_scope::REMOTE_CLI_UNSUPPORTED.into())));
            assert_eq!(SIDE_EFFECTS.load(std::sync::atomic::Ordering::SeqCst), 0);
        }
    }
}
'''.replace('METHODS', ', '.join(METHODS))
    source = out / 'guards.rs'
    source.write_text(generated)
    rustc = TOOLCHAIN / 'rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc'
    runs, logs = [], []
    for mode in ['disabled', 'enabled']:
        binary = out / mode
        command = [str(rustc), '--edition=2024', '--test', str(source), '-o', str(binary)]
        if mode == 'enabled':
            command += ['--cfg', 'feature="remote-cli"']
        compiled = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        logs.append(mode+' compile:\n'+compiled.stdout)
        assert compiled.returncode == 0, compiled.stdout
        result = subprocess.run([str(binary)], text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        logs.append(mode+' tests:\n'+result.stdout)
        runs.append({'mode': mode, 'compile_command': command, 'test_exit_code': result.returncode})
    assert all(run['test_exit_code'] == 0 for run in runs), '\n'.join(logs)
    current_hash = hashlib.sha256(network.read_bytes()).hexdigest()
    previous_hash_path = BUILD / 'remote-cli-network-scope-before.json'
    previous_hash = json.loads(previous_hash_path.read_text())['sha256'] if previous_hash_path.exists() else None
    if previous_hash is not None:
        assert current_hash == previous_hash, 'network_scope changed during this pass; review before claiming preservation'
    evidence = {
        'scope': 'two runtime files; guards and accessor only',
        'methods': METHODS, 'existing_method_continuations_unchanged': True if before is not None else None,
        'network_scope_unchanged': True if previous_hash is not None else None,
        'runs': runs, 'full_mobile_build_rerun': False,
        'source_sha256': {str(path.relative_to(HERE.parents[2])):hashlib.sha256(path.read_bytes()).hexdigest()
                          for path in [SRC/'mobile_client/mod.rs', SRC/'ffi/client.rs', network]},
    }
    (HERE / 'remote-cli-guard-evidence.json').write_text(json.dumps(evidence, indent=2)+'\n')
    (HERE / 'remote-cli-guard-output.txt').write_text('\n'.join(logs))
    print('PASS: five leading guards and accessor verified in both feature modes. Preservation checks recorded when pre-edit snapshots are present.')


if __name__ == '__main__':
    main()
