#!/usr/bin/env python3
"""Run unchanged direct-capture implementation/tests with isolated boundary fixtures.

Requires run_event_log_tests.py first. Reuses its private offline source mirror.
This checks capture logic, not real Codex environment registration, type compatibility,
policy enforcement, iSH, or device behavior. No production substitute is emitted.
"""
from pathlib import Path
import json, os, subprocess
HERE = Path(__file__).resolve().parents[1]
from prepare_source import prepare_source
root = prepare_source() / 'codex-rs'
work = HERE / '.cache/capture-harness'
work.mkdir(exist_ok=True)
(work/'src').mkdir(exist_ok=True)
(work/'.cargo').mkdir(exist_ok=True)
vendor = HERE / '.cache/event-log-harness/vendor'
(work/'.cargo/config.toml').write_text('[source.crates-io]\nreplace-with="cached"\n[source.cached]\ndirectory='+json.dumps(str(vendor))+'\n')
(work/'Cargo.toml').write_text('''[package]
name="embedded-capture-check"
version="0.0.0"
edition="2024"
[dependencies]
tokio={version="=1.52.3",features=["sync","rt","time","macros"]}
tokio-util={version="=0.7.18",features=["rt"]}
async-channel="=2.5.0"
tracing="=0.1.44"
embedded-event-log-check={path="../event-log-harness"}
''')
fixtures = r'''
#![allow(dead_code,unused_imports)]
extern crate self as codex_exec_server;
extern crate self as codex_http_client;
use std::{sync::Arc, collections::HashMap, path::PathBuf, pin::Pin, future::Future};
pub use embedded_event_log_check::{ExecProcessEventLog, ExecProcessEventReceiver, ExecServerError};
pub use embedded_event_log_check::protocol::{ExecOutputStream, ProcessOutputChunk};
use tokio::sync::watch;
pub type ProcessId = String;
pub trait NetworkPolicyDecider: Send + Sync {}
#[derive(Clone,Copy,Debug,PartialEq)] pub enum SandboxType { None }
#[derive(Clone,Copy)] pub enum ProcessSignal { Interrupt }
pub struct ReadResponse { pub chunks: Vec<ProcessOutputChunk>, pub next_seq:u64, pub exited:bool, pub exit_code:Option<i32>, pub closed:bool, pub failure:Option<String>, pub sandbox_denied:bool }
pub enum WriteStatus { Accepted, UnknownProcess, StdinClosed, Starting }
pub struct WriteResponse { pub status: WriteStatus }
pub struct ExecParams {
    pub process_id: ProcessId, pub metadata:Option<()>, pub argv:Vec<String>, pub cwd:PathBuf,
    pub env_policy:Option<()>, pub shell_snapshot:Option<()>, pub env:HashMap<String,String>,
    pub tty:bool, pub pipe_stdin:bool, pub arg0:Option<String>, pub sandbox:Option<()>,
    pub enforce_managed_network:bool, pub managed_network:Option<()>, pub network_proxy:Option<()>,
}
pub struct StartedExecProcess { pub process:Arc<dyn ExecProcess>, pub sandbox_type:Option<SandboxType> }
#[derive(Default)] pub struct EnvironmentCapabilities;
pub struct EnvironmentInfo { pub cwd:Option<PathBuf>, pub capabilities:EnvironmentCapabilities }
impl EnvironmentInfo { pub fn local()->Self { Self { cwd:Some(PathBuf::from("/fixture")), capabilities:Default::default() } } }
pub struct HttpClientFactory;
pub enum OutboundProxyPolicy { ReqwestDefault }
impl HttpClientFactory { pub fn new(_:OutboundProxyPolicy)->Self { Self } }
// Registration is deliberately a fixture: the constructor's actual upstream
// ownership/API integration is covered only by the unrun upstream unit tests.
pub struct Environment { backend:Option<Arc<dyn ExecBackend>>, embedded:bool }
impl Environment {
    pub fn default_for_tests()->Self { Self { backend:None, embedded:false } }
    pub fn get_filesystem(&self) {}
    pub fn embedded(backend:Arc<dyn ExecBackend>, _:(), _:EnvironmentInfo, _:HttpClientFactory)->Result<Self,ExecServerError> { Ok(Self { backend:Some(backend),embedded:true }) }
    pub fn is_embedded(&self)->bool { self.embedded }
    pub fn get_exec_backend(&self)->Arc<dyn ExecBackend> { self.backend.clone().unwrap() }
}
'''
process = (root/'exec-server/src/process.rs').read_text()
traits = process[process.index('/// Handle for an executor-managed process.'):process.index('#[cfg(test)]')]
exec_source=(root/'core/src/exec.rs').read_text()
policy = exec_source[exec_source.index('#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]'):exec_source.index('fn select_process_exec_tool_sandbox_type')]
expiration = exec_source[exec_source.index('/// Mechanism to terminate an exec invocation'):exec_source.index('#[allow(clippy::too_many_arguments)]\npub async fn process_exec_tool_call')]
finalizer = exec_source[exec_source.index('fn finalize_exec_result('):exec_source.index('/// This is a general-purpose function for executing a command specified by')]
exec_fixtures=r'''
use super::*;
use std::{io, time::{Duration,Instant}, process::ExitStatus};
use std::os::unix::process::ExitStatusExt;
use async_channel::Sender;
use tokio_util::sync::CancellationToken;
const DEFAULT_EXEC_COMMAND_TIMEOUT_MS:u64=10000;
const IO_DRAIN_TIMEOUT_MS:u64=2000;
const READ_CHUNK_SIZE:usize=8192;
const EXEC_OUTPUT_MAX_BYTES:usize=1024*1024;
const MAX_EXEC_OUTPUT_DELTAS_PER_CALL:usize=10000;
const TIMEOUT_CODE:i32=64;
const EXEC_TIMEOUT_EXIT_CODE:i32=124;
type Result<T> = std::result::Result<T,CodexErr>;
#[derive(Debug)] enum CodexErr { Io(io::Error), InvalidRequest(String), Sandbox(SandboxErr) }
impl std::fmt::Display for CodexErr { fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result { write!(f,"{self:?}") } }
impl From<io::Error> for CodexErr { fn from(e:io::Error)->Self { Self::Io(e) } }
#[derive(Debug)] enum SandboxErr { Signal(i32), Timeout { output:Box<ExecToolCallOutput> }, Denied { output:Box<ExecToolCallOutput>, network_policy_decision:Option<()> } }
#[derive(Debug)] struct StreamOutput<T> { text:T, truncated_after_lines:Option<u32> }
impl StreamOutput<Vec<u8>> { fn from_utf8_lossy(&self)->StreamOutput<String> { StreamOutput { text:String::from_utf8_lossy(&self.text).into_owned(), truncated_after_lines:self.truncated_after_lines } } }
#[derive(Debug)] struct ExecToolCallOutput { exit_code:i32, stdout:StreamOutput<String>, stderr:StreamOutput<String>, aggregated_output:StreamOutput<String>, duration:Duration, timed_out:bool }
pub struct Event { id:String, msg:EventMsg }
enum EventMsg { ExecCommandOutputDelta(ExecCommandOutputDeltaEvent) }
struct ExecCommandOutputDeltaEvent { call_id:String, stream:ExecOutputStream, chunk:Vec<u8> }
// Sandbox classification and legacy character-set conversion are not under test.
fn is_likely_sandbox_denied(_:SandboxType,_:&ExecToolCallOutput)->bool { false }
fn record_filesystem_sandbox_violation(_:SandboxType,_:&ExecToolCallOutput) {}
fn synthetic_exit_status_for_code(code:i32)->ExitStatus { ExitStatus::from_raw(code<<8) }
'''
code=fixtures+traits+'\nmod exec {\n'+exec_fixtures+policy+expiration+finalizer+'\n#[path='+json.dumps(str(root/'core/src/exec/embedded.rs'))+'] mod embedded;\n}\n'
(work/'src/lib.rs').write_text(code)
toolchain=Path('/Users/dashidhy/Public/projects/agent/ALMA/.build/tauri-toolchain/rustup/toolchains/stable-aarch64-apple-darwin')
env=dict(os.environ,CARGO_HOME=str(work/'cargo-home'),CARGO_TARGET_DIR=str(work/'target'),RUSTC=str(toolchain/'bin/rustc'),RUSTDOC=str(toolchain/'bin/rustdoc'))
env.pop('RUSTC_WRAPPER',None)
r=subprocess.run([str(toolchain/'bin/cargo'),'test','--offline','--lib'],cwd=work,env=env,capture_output=True,text=True,timeout=120)
(work/'test.log').write_text(r.stdout+r.stderr)
print(r.stdout+r.stderr)
raise SystemExit(r.returncode)
