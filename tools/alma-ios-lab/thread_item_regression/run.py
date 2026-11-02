#!/usr/bin/env python3
"""Compile source-derived hydration tests without the mobile dependency graph.

Protocol declarations are extracted from the checkout, keeping serde attributes
and every payload variant/field. Schema/TS/UniFFI derives are removed. See README
for the intentionally narrow support shims and the limits of this evidence.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
from extend import augment

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2]
SRC = ROOT / 'shared/rust-bridge/codex-mobile-client/src'
UP = ROOT / 'shared/third_party/codex/codex-rs'
BUILD = HERE / '.build'
TOOLCHAIN = ROOT.parent / 'ALMA/.build/tauri-toolchain'
INPUTS = {}


def read(path):
    text = path.read_text()
    INPUTS[str(path.relative_to(ROOT))] = hashlib.sha256(text.encode()).hexdigest()
    return text


def block(text, start):
    """Read balanced Rust delimiters, ignoring quoted strings and comments."""
    opening = text.index('{', start)
    depth, i = 1, opening + 1
    while depth:
        if text.startswith('//', i):
            i = text.index('\n', i) + 1
            continue
        if text.startswith('/*', i):
            i = text.index('*/', i) + 2
            continue
        if text[i] == '"':
            i += 1
            while text[i] != '"':
                i += 2 if text[i] == '\\' else 1
        elif text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
        i += 1
    return text[start:i]


def sanitize(text):
    text = re.sub(r'#\[(?:ts|schemars|error|uniffi)[^\]]*\]\s*', '', text)
    def derive(m):
        names = [x.strip() for x in m[1].split(',')]
        names = [x for x in names if x not in ('TS', 'JsonSchema', 'Error') and not x.startswith('uniffi::')]
        return '#[derive(' + ', '.join(names) + ')]' if names else ''
    return re.sub(r'#\[derive\((.*?)\)\]', derive, text, flags=re.S)


def declaration(text, name):
    match = re.search(r'pub(?:\([^)]*\))? (?:struct|enum) ' + name + r'\b', text)
    if not match:
        raise ValueError(name)
    start = text.rfind('\n\n', 0, match.start()) + 2
    return sanitize(text[start:match.start()] + block(text, match.start()))


def main():
    BUILD.mkdir(exist_ok=True)
    read(HERE / "run.py")
    read(HERE / "extend.py")
    for file in ['conversation.rs', 'session/events.rs', 'mobile_client/event_loop.rs', 'store/reconcile.rs', 'mobile_client/store_listener.rs', 'ffi/app_store.rs', 'store/reducer.rs', 'ffi/client.rs', 'perf_profile.rs', 'mobile_client/thread_projection.rs', 'types/server_requests.rs', 'types/models.rs', 'mobile_client/dynamic_tools.rs', 'mobile_client/mod.rs']:
        read(SRC / file)
    common = 'use serde::{Serialize, Deserialize}; use serde_json::Value as JsonValue; use std::{collections::HashMap, path::PathBuf};\n'
    item = read(UP / 'app-server-protocol/src/protocol/v2/item.rs')
    paths = list((UP / 'app-server-protocol/src/protocol/v2').glob('*.rs'))
    paths += list((UP / 'ext/items/src').glob('*.rs'))
    paths += [UP / 'protocol/src/items.rs', UP / 'protocol/src/models.rs']
    sources = [read(p) for p in paths]
    # Names whose behavior is outside this bounded migration; all payload
    # declarations themselves remain exact. Path is a tiny transparent wrapper.
    done = {'AbsolutePathBuf', 'LegacyAppPathString', 'CodexErrorInfo', 'ReasoningEffort',
            'MessagePhase', 'FunctionCallOutputBody', 'ImageDetail'}
    needed = ['ThreadItem', 'ThreadItemPayload', 'Turn', 'McpToolCallResult']
    parts = []
    while needed:
        name = needed.pop()
        if name in done:
            continue
        source = next((s for s in sources if re.search(r'pub (?:struct|enum) '+name+r'\b', s)), None)
        if source is None:
            raise RuntimeError('missing declaration: '+name)
        code = declaration(source, name)
        if name in ('MisalignmentErrorDetails', 'MisalignmentSteer'):
            code = '#[derive(Debug)]\n' + code
        if name == 'CommandExecutionSource':
            code = code.replace('v2_enum_from_core! {', '').replace(' from CoreExecCommandSource', '')
            code = '#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]\n#[serde(rename_all="camelCase")]\n'+code
        done.add(name)
        parts.append(code)
        # Types in declarations, excluding comments and attributes/strings.
        clean = re.sub(r'//[^\n]*|#\[[\s\S]*?\]|"(?:\\.|[^"\\])*"', '', code)
        for candidate in re.findall(r'\b[A-Z][A-Za-z0-9_]+\b', clean):
            if candidate not in done and any(re.search(r'pub (?:struct|enum) '+candidate+r'\b', s) for s in sources):
                needed.append(candidate)
    # Exact wrapper and ID implementation, without unrelated conversions.
    parts += [block(item, item.index('impl ThreadItem {')),
              block(item, item.index('impl ThreadItemPayload {'))]
    models = read(UP / 'protocol/src/models.rs')
    core = common + '\n'.join(declaration(models, n) for n in [
        'MessagePhase', 'ImageDetail', 'ImageReference',
        'FunctionCallOutputContentItem', 'FunctionCallOutputBody'])
    support = read(HERE / 'support.rs')
    protocol = common + '\nuse crate::codex_protocol::models::{MessagePhase, ImageDetail, FunctionCallOutputBody};\n'
    protocol += '\n'.join(parts)
    (BUILD / 'protocol.rs').write_text(protocol)
    (BUILD / 'core_models.rs').write_text(core)
    types = common + '\n'.join(declaration(read(SRC / f), n) for f, n in [
        ('types/enums.rs', 'AppOperationStatus'), ('types/enums.rs', 'AppSubagentStatus'),
        ('types/models.rs', 'AppMessagePhase')])
    (BUILD / 'types.rs').write_text(types)
    for name in ['conversation_uniffi', 'parser', 'conversation']:
        code = sanitize(read(SRC / (name+'.rs')))
        if name == 'conversation':
            code = code.replace('use codex_shell_command::', 'use crate::codex_shell_command::')
            code = code.replace('use std::path::Path;', 'use crate::{codex_protocol, codex_utils_absolute_path};\nuse std::path::Path;')
        (BUILD / (name+'.rs')).write_text(code)
    reducer = read(SRC / 'store/reducer.rs')
    focused = 'use crate::conversation_uniffi::*;\n'
    focused += block(reducer, reducer.index('fn merge_item_with_existing('))
    focused += '\n#[test]\n' + block(reducer, reducer.index('fn untimed_item_updates_preserve_recorded_timestamp()'))
    ffi = read(SRC / 'ffi/app_store.rs')
    focused += '\nuse crate as upstream; use serde_json::json; use std::collections::HashMap;\n'
    for name in ['thread_item_parses_mcp_arguments_json', 'thread_item_parses_collab_agent_states_json']:
        focused += '\n#[test]\n' + block(ffi, ffi.index('fn '+name+'()'))
    (BUILD / 'focused.rs').write_text(focused)
    (BUILD / 'source_audit.rs').write_text(read(HERE / 'source_audit.rs'))
    extension = augment(read, block, declaration, SRC, UP, BUILD)
    (BUILD / 'lib.rs').write_text('#![allow(dead_code, unused_imports)]\nextern crate self as codex_app_server_protocol;\n'+support+'''
include!("protocol.rs");
mod types;
mod conversation_uniffi;
mod parser;
mod conversation;
#[cfg(test)] mod source_audit;
#[cfg(test)] mod focused;
''' + extension)
    # Only five small cached dependencies, in a separate disposable workspace.
    (BUILD / 'Cargo.toml').write_text('''[package]
name = "thread-item-source-regression"
version = "0.0.0"
edition = "2024"
[workspace]
[lib]
path = "lib.rs"
[dependencies]
serde = { version = "1", features = ["derive"] }
serde_json = "1"
regex = "1"
base64 = "0.22"
shlex = "1"
[dev-dependencies]
syn = { version = "3", features = ["full", "visit"] }
''')
    env = dict(os.environ, CARGO_HOME=str(TOOLCHAIN / 'cargo'),
               RUSTUP_HOME=str(TOOLCHAIN / 'rustup'), RUSTUP_TOOLCHAIN='stable-aarch64-apple-darwin',
               CARGO_TARGET_DIR=str(BUILD / 'target'), THREAD_ITEM_MOBILE_SRC=str(SRC),
               THREAD_ITEM_UPSTREAM_ITEM=str(UP / 'app-server-protocol/src/protocol/v2/item.rs'))
    env['PATH'] = str(TOOLCHAIN / 'cargo/bin') + os.pathsep + env['PATH']
    for key in ['RUSTC', 'RUSTC_WRAPPER', 'RUSTC_WORKSPACE_WRAPPER', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS']:
        env.pop(key, None)
    command = [str(TOOLCHAIN / 'cargo/bin/cargo'), 'test', '--offline', '--manifest-path', str(BUILD / 'Cargo.toml'),
               '--', '--skip', 'parser::tests::', '--skip', 'test_display_command_strips_known_shell_wrappers', '--skip', 'test_command_execution_strips_shell_wrapper_for_display']
    run = subprocess.run(command, env=env, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    (HERE / 'test-output.txt').write_text(run.stdout)
    (HERE / 'evidence.json').write_text(json.dumps({'command': command, 'exit_code': run.returncode,
        'scope': 'source-derived harness; not full protocol/mobile/iOS build',
        'upstream_commit': subprocess.check_output(['git', '-C', str(UP.parent), 'rev-parse', 'HEAD'], text=True).strip(),
        'compiler': subprocess.check_output([str(TOOLCHAIN / 'cargo/bin/rustc'), '--version'], env=env, text=True).strip(),
        'source_sha256': INPUTS}, indent=2)+'\n')
    print(run.stdout)
    raise SystemExit(run.returncode)


if __name__ == '__main__':
    main()
