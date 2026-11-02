#!/usr/bin/env python3
"""Type-check extracted mobile conversions/tests against actual cached iOS crates.

No substitute protocol declarations, cargo manifest, linking, or dependency build.
Tests are compiled to metadata, not executed on a host or device.
"""
from pathlib import Path
import json
import os
import re
import subprocess
from run import ROOT, SRC, BUILD, TOOLCHAIN, read, block, declaration, sanitize, INPUTS


def extract(source, prefix):
    return block(source, source.index(prefix))


def main():
    out = BUILD / 'real-protocol'
    out.mkdir(parents=True, exist_ok=True)
    models = read(SRC / 'types/models.rs')
    requests = read(SRC / 'types/server_requests.rs')
    enums = read(SRC / 'types/enums.rs')
    imports = 'use serde::{Serialize, Deserialize}; use codex_app_server_protocol as upstream; use crate::RpcClientError;\n'
    m = imports
    for name in ['PlanType', 'Account', 'AppRealtimeVoice', 'AppRealtimeOutputModality', 'AppRealtimeStartTransport', 'AppDynamicToolSpec']:
        m += declaration(models, name) + '\n'
    for prefix in [
        'impl From<codex_protocol::account::PlanType> for PlanType',
        'impl From<upstream::Account> for Account',
        'impl From<AppRealtimeVoice> for codex_protocol::protocol::RealtimeVoice',
        'impl From<codex_protocol::protocol::RealtimeVoice> for AppRealtimeVoice',
        'impl From<AppRealtimeOutputModality> for codex_protocol::protocol::RealtimeOutputModality',
        'impl From<AppRealtimeStartTransport> for upstream::ThreadRealtimeStartTransport',
        'mod protocol_alignment_tests',
    ]:
        m += extract(models, prefix) + '\n'
    e = imports
    for mobile, core in [('AppThreadGoalStatus', 'ThreadGoalStatus'), ('AppThreadSourceKind', 'ThreadSourceKind'), ('AppSortDirection', 'SortDirection'), ('AppThreadSortKey', 'ThreadSortKey')]:
        e += declaration(enums, mobile) + '\n'
        e += extract(enums, f'impl From<{mobile}> for upstream::{core}') + '\n'
    e += re.search(r'pub type AgentRuntimeKind = [^;]+;', enums)[0]
    r = imports + 'use crate::types::*;\n'
    for mobile, core, conversion in [
        ('AppStartRealtimeSessionRequest', 'ThreadRealtimeStartParams', 'TryFrom'),
        ('AppThreadGoalSetRequest', 'ThreadGoalSetParams', 'From'),
        ('AppThreadGoalClearRequest', 'ThreadGoalClearParams', 'From'),
        ('AppListThreadsRequest', 'ThreadListParams', 'From'),
    ]:
        r += declaration(requests, mobile) + '\n'
        r += extract(requests, f'impl {conversion}<{mobile}> for upstream::{core}') + '\n'
    for prefix in ['fn normalize_cwd(', 'fn review_delivery_into_upstream(', 'mod protocol_alignment_tests']:
        r += extract(requests, prefix) + '\n'
    lib = read(SRC / 'lib.rs')
    error_start = lib.index('pub enum RpcClientError')
    error = lib[lib.rfind('#[derive(', 0, error_start):error_start] + block(lib, error_start)
    code = '#![allow(dead_code, unused_imports)]\n'+error+'''
mod types {
  pub mod models { MODELS }
  mod enums { ENUMS }
  pub use models::*;
  pub use enums::*;
}
mod requests { REQUESTS }
'''.replace('MODELS', m).replace('ENUMS', e).replace('REQUESTS', r)
    code += '\n#[path = '+json.dumps(str(SRC / 'remote_path.rs'))+'] mod remote_path;\n'
    source = out / 'alignment.rs'
    source.write_text(code)
    deps = ROOT / 'shared/rust-bridge/target/aarch64-apple-ios/ios-dev/deps'
    host_deps = ROOT / 'shared/rust-bridge/target/ios-dev/deps'
    command = [str(TOOLCHAIN / 'rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc'), '--edition=2024', '--target=aarch64-apple-ios', '--test', '--emit=metadata', '--crate-name=alignment_protocol_check', str(source), '-o', str(out / 'alignment.rmeta'), '-L', 'dependency='+str(deps), '-L', 'dependency='+str(host_deps)]
    artifacts = {}
    for name in ['codex_app_server_protocol', 'codex_protocol', 'serde', 'serde_json', 'thiserror']:
        artifact = max(deps.glob(f'lib{name}-*.rmeta'), key=lambda p:p.stat().st_mtime_ns)
        artifacts[name] = str(artifact)
        command += ['--extern', name+'='+str(artifact)]
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (Path(__file__).parent / 'real-protocol-output.txt').write_text(result.stdout or 'Actual iOS protocol metadata check passed (tests compiled, not executed).\n')
    (Path(__file__).parent / 'real-protocol-evidence.json').write_text(json.dumps({
        'command': command, 'exit_code': result.returncode, 'tests_executed': False,
        'actual_protocol_artifacts': artifacts, 'source_sha256': INPUTS,
    }, indent=2)+'\n')
    print(result.stdout or 'Actual iOS protocol metadata check passed (tests compiled, not executed).')
    raise SystemExit(result.returncode)


if __name__ == '__main__':
    main()
