#!/usr/bin/env python3
"""Bounded offline checks: exact waiter/tests + selected source-derived protocol types.

Host execution uses existing cached Tokio only. iOS metadata mode uses actual
upstream protocol crates. Neither builds dependencies nor links/runs iOS code.
"""
from pathlib import Path
import hashlib
import json
import re
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SRC = ROOT / 'shared/rust-bridge/codex-mobile-client/src'
UP = ROOT / 'shared/third_party/codex/codex-rs'
BUILD = HERE / '.build'
BUILD.mkdir(exist_ok=True)
INPUTS = {}


def read(path):
    source = path.read_text()
    INPUTS[str(path.relative_to(ROOT))] = hashlib.sha256(source.encode()).hexdigest()
    return source


def block(source, prefix):
    start = source.index(prefix)
    opening = source.index('{', start)
    depth, i = 1, opening + 1
    while depth:
        if source.startswith('//', i):
            i = source.index('\n', i) + 1
            continue
        if source.startswith('/*', i):
            i = source.index('*/', i) + 2
            continue
        if source[i] == '"':
            i += 1
            while source[i] != '"':
                i += 2 if source[i] == '\\' else 1
        elif source[i] == '{':
            depth += 1
        elif source[i] == '}':
            depth -= 1
        i += 1
    return source[start:i]


def plain(source):
    return re.sub(r'#\[(?:serde|ts|schemars|error|experimental)(?:[^\]"\\]|"(?:\\.|[^"\\])*")*\]\s*', '', source)


def decl(source, name):
    match = re.search(r'pub (?:struct|enum) ' + name + r'\b', source)
    return '#[derive(Debug, Clone, PartialEq)]\n' + plain(block(source, match[0]))


events = read(SRC / 'session/events.rs')
client = read(SRC / 'ffi/client.rs')
models = read(SRC / 'types/models.rs')
turn = read(UP / 'app-server-protocol/src/protocol/v2/turn.rs')
thread = read(UP / 'app-server-protocol/src/protocol/v2/thread_data.rs')
item = read(UP / 'app-server-protocol/src/protocol/v2/item.rs')
shared = read(UP / 'app-server-protocol/src/protocol/v2/shared.rs')
core_models = read(UP / 'protocol/src/models.rs')
core_items = read(UP / 'protocol/src/items.rs')

# Guard unchanged strict schema request, subscription ordering, turn/start identity,
# timeout, and the single documented stale-thread retry.
run = block(client, 'async fn run_structured_turn(')
assert run.index('event_processor.subscribe()') < run.index('.request_typed_for_server(')
assert 'output_schema: Some(output_schema)' in run
assert 'Ok(response) => response.turn' in run
assert 'wait_for_structured_turn(&mut events_rx, server_id, thread_id, &started_turn.id)' in run
assert 'const STRUCTURED_RESPONSE_TIMEOUT_SECS: u64 = 60;' in client
assert 'Duration::from_secs(STRUCTURED_RESPONSE_TIMEOUT_SECS)' in run
perform = block(client, 'async fn perform_structured_response(')
assert perform.count('run_structured_turn(') == 2
assert 'thread became stale again on retry' in perform

ui = '#[derive(Debug, Clone)] pub(crate) enum UiEvent {\n' + ',\n'.join(
    block(events, name + ' {') for name in ['TurnStarted', 'TurnCompleted', 'ItemCompleted']) + '}\n'
common = 'mod types { ' + decl(models, 'ThreadKey') + '}\n'
common += '''mod session { pub mod events {
use crate::types::ThreadKey;
use codex_app_server_protocol::ServerNotification;
use tokio::sync::broadcast;
'''+ui+'''
pub struct EventProcessor { ui_event_tx: broadcast::Sender<UiEvent> }
impl EventProcessor {
 pub fn new() -> Self { Self { ui_event_tx: broadcast::channel(256).0 } }
'''
for prefix in ['pub fn subscribe(', 'pub fn emit_local_turn_interrupted(', 'fn emit(', 'fn make_key(']:
    common += block(events, prefix) + '\n'
common += '''pub fn process_notification(&self, server_id: &str, _runtime: String, notification: &ServerNotification) {
match notification {
'''
for name in ['TurnCompleted', 'ItemCompleted']:
    common += block(events, 'ServerNotification::'+name+'(n) =>') + ',\n'
common += '_ => {} } } }\n#[cfg(test)] mod tests { use super::*; use codex_app_server_protocol as proto;\n'
for prefix in ['fn make_turn(', 'fn process_and_recv(']:
    common += block(events, prefix)+'\n'
for name in ['turn_completed_preserves_upstream_status_and_error', 'local_interrupt_is_interrupted_without_error']:
    common += '#[test]\n'+block(events, 'fn '+name+'(')+'\n'
common += '} } }\nuse codex_app_server_protocol as upstream;\n'
common += block(client, 'async fn wait_for_structured_turn(')+'\n'
common += '#[cfg(test)]\n'+block(client, 'mod structured_turn_tests {')+'\n'

# Host: exact relevant declarations, with metadata attributes removed; omitted
# enum variants are unrelated to these tests. No status/phase or behavior doubles.
host = 'extern crate self as codex_app_server_protocol; extern crate self as codex_protocol;\n'
host += 'pub mod models { '+decl(core_models, 'MessagePhase')+'}\nuse models::MessagePhase;\n'
for source, names in [(turn, ['TurnStatus', 'TurnCompletedNotification']),
                      (thread, ['Turn', 'TurnItemsView', 'TurnError', 'MisalignmentErrorDetails', 'MisalignmentSteer']),
                      (item, ['ThreadItem', 'ItemCompletedNotification', 'MemoryCitation', 'MemoryCitationEntry']),
                      (core_items, ['AgentMessageDelivery', 'AsyncUserInputQuestion']),
                      (shared, ['CodexErrorInfo', 'NonSteerableTurnKind'])]:
    for name in names:
        host += decl(source, name).replace('#[default]', '')+'\n'
host += '#[derive(Debug, Clone, PartialEq)] pub enum ThreadItemPayload {\n'
for name in ['AgentMessage', 'Plan']:
    host += plain(block(item[item.index('pub enum ThreadItemPayload'):], name+' {'))+',\n'
host += '}\nimpl ThreadItem { '+block(item, 'pub fn untimed(')+' }\n'
host += '#[derive(Debug, Clone)] pub enum ServerNotification { TurnCompleted(TurnCompletedNotification), ItemCompleted(ItemCompletedNotification) }\n'

rustc = ROOT.parent / 'ALMA/.build/tauri-toolchain/rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc'
report = {'source_sha256': INPUTS, 'source_guards_passed': True, 'checks': {}}
for mode in ['host', 'ios-real-protocol']:
    source = BUILD / (mode+'.rs')
    source.write_text('#![allow(dead_code, unreachable_patterns)]\n'+(host if mode == 'host' else '')+common)
    command = [str(rustc), '--edition=2024', '--test', '--crate-name=turn_completion_regression', str(source)]
    if mode == 'host':
        deps = HERE.parent / 'backend_regression/.cache/target/debug/deps'
        artifact = max(deps.glob('libtokio-*.rlib'), key=lambda p:p.stat().st_mtime_ns)
        binary = BUILD/'tests'
        command += ['-L', 'dependency='+str(deps), '--extern', 'tokio='+str(artifact), '-o', str(binary)]
    else:
        deps = ROOT / 'shared/rust-bridge/target/aarch64-apple-ios/ios-dev/deps'
        command += ['--target=aarch64-apple-ios', '--emit=metadata', '-L', 'dependency='+str(deps), '-L', 'dependency='+str(ROOT/'shared/rust-bridge/target/ios-dev/deps'), '-o', str(BUILD/'tests.rmeta')]
        for name in ['codex_app_server_protocol', 'codex_protocol', 'tokio']:
            artifact = max(deps.glob('lib'+name+'-*.rmeta'), key=lambda p:p.stat().st_mtime_ns)
            command += ['--extern', name+'='+str(artifact)]
    result = subprocess.run(command, text=True, capture_output=True, timeout=60)
    output = result.stdout+result.stderr
    executed = False
    if result.returncode == 0 and mode == 'host':
        result = subprocess.run([str(binary)], text=True, capture_output=True, timeout=30)
        output += result.stdout+result.stderr
        executed = True
    (HERE/(mode+'-output.txt')).write_text(output or 'Actual iOS protocol metadata check passed; tests compiled, not executed.\n')
    report['checks'][mode] = {'command':command, 'exit_code':result.returncode, 'tests_executed':executed}
    print(mode, output or 'PASS (metadata only)')
(HERE/'evidence.json').write_text(json.dumps(report,indent=2)+'\n')
raise SystemExit(any(c['exit_code'] for c in report['checks'].values()))
