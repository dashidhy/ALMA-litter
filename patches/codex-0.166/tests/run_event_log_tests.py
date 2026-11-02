#!/usr/bin/env python3
"""Run the actual patched event-log code against cached Tokio, without Codex's graph.

Only event production/replay is covered. Small DTO/error fixtures replace unrelated
protocol dependencies; this does NOT type-check codex-exec-server or codex-core.
Writes/builds only below this patch directory's .cache; no downloads.
"""
import argparse
import json
import os
from pathlib import Path
import subprocess

HERE = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, default=None)
parser.add_argument('--registry', type=Path, default=Path('/Users/dashidhy/Public/projects/agent/ALMA/.build/tauri-toolchain/cargo/registry/src/index.crates.io-1949cf8c6b5b557f'))
parser.add_argument('--toolchain', type=Path, default=Path('/Users/dashidhy/Public/projects/agent/ALMA/.build/tauri-toolchain/rustup/toolchains/stable-aarch64-apple-darwin'))
a = parser.parse_args()
if a.source is None:
    from prepare_source import prepare_source
    a.source = prepare_source()
work = HERE / '.cache/event-log-harness'
work.mkdir(exist_ok=True)
vendor = work / 'vendor'
vendor.mkdir(exist_ok=True)
# Read-only source links. Cargo's directory-source checksums live in our own cache;
# no cached registry source, index, lock, or configuration is changed.
for package in a.registry.iterdir():
    if not (package / 'Cargo.toml').is_file():
        continue
    destination = vendor / package.name
    destination.mkdir(exist_ok=True)
    for child in package.iterdir():
        if child.name == '.cargo-checksum.json':
            continue
        link = destination / child.name
        if not link.exists() and not link.is_symlink():
            link.symlink_to(child.resolve(), target_is_directory=child.is_dir())
    (destination / '.cargo-checksum.json').write_text(json.dumps({'files': {}, 'package': None}))
(work / '.cargo').mkdir(exist_ok=True)
(work / '.cargo/config.toml').write_text('[source.crates-io]\nreplace-with = "cached"\n[source.cached]\ndirectory = ' + json.dumps(str(vendor)) + '\n')
(work / 'Cargo.toml').write_text('''[package]
name = "embedded-event-log-check"
version = "0.0.0"
edition = "2024"
[dependencies]
tokio = { version = "=1.52.3", features = ["sync", "rt", "time", "macros"] }
pretty_assertions = "=1.4.1"
''')
source = (a.source / 'codex-rs/exec-server/src/process.rs').read_text()
code = source[source.index('/// Pushed process events'):source.index('/// Handle for an executor-managed process.')]
tests = source[source.index('#[cfg(test)]'):]
fixtures = '''#![allow(dead_code)]
use std::collections::VecDeque;
use std::sync::{Arc, Mutex as StdMutex};
use tokio::sync::broadcast;
#[derive(Debug)]
pub enum ExecServerError { Protocol(String) }
impl std::fmt::Display for ExecServerError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result { write!(f, "{self:?}") }
}
impl std::error::Error for ExecServerError {}
pub mod protocol {
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub enum ExecOutputStream { Stdout, Stderr, Pty }
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ByteChunk(pub Vec<u8>);
    impl From<Vec<u8>> for ByteChunk { fn from(value: Vec<u8>) -> Self { Self(value) } }
    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct ProcessOutputChunk { pub seq: u64, pub stream: ExecOutputStream, pub chunk: ByteChunk }
}
use protocol::ProcessOutputChunk;
'''
(work / 'src').mkdir(exist_ok=True)
(work / 'src/lib.rs').write_text(fixtures + code + tests)
env = dict(os.environ, CARGO_HOME=str(work/'cargo-home'), CARGO_TARGET_DIR=str(work/'target'),
           RUSTC=str(a.toolchain/'bin/rustc'), RUSTDOC=str(a.toolchain/'bin/rustdoc'))
env.pop('RUSTC_WRAPPER', None)
result = subprocess.run([str(a.toolchain/'bin/cargo'), 'test', '--offline', '--lib'], cwd=work,
                        env=env, capture_output=True, text=True, timeout=120)
(work / 'test.log').write_text(result.stdout + result.stderr)
print(result.stdout + result.stderr)
raise SystemExit(result.returncode)
