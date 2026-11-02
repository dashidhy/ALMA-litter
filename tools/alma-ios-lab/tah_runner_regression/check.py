#!/usr/bin/env python3
"""Compile exact runner + focused tests against real cached iOS protocol metadata.
Only the app/session transport shell is stubbed. No requests execute.
"""
from pathlib import Path
import hashlib,json,re,subprocess,sys
sys.dont_write_bytecode=True
HERE=Path(__file__).resolve().parent; ROOT=HERE.parents[2]; SRC=ROOT/'shared/rust-bridge/codex-mobile-client/src'
sys.path.insert(0,str(HERE.parent/'turn_completion_regression'))
# Local balanced block reader (does not import a runner with side effects).
def block(s,prefix):
 start=s.index(prefix); i=s.index('{',start)+1; depth=1
 while depth:
  if s.startswith('//',i): i=s.index('\n',i)+1;continue
  if s[i]=='"':
   i+=1
   while s[i]!='"': i+=2 if s[i]=='\\' else 1
  elif s[i]=='{':depth+=1
  elif s[i]=='}':depth-=1
  i+=1
 return s[start:i]
BUILD=HERE/'.build';BUILD.mkdir(exist_ok=True)
info=block((SRC/'tah_attempt.rs').read_text(),'pub struct TahQualificationInfo')
event=block((SRC/'session/connection.rs').read_text(),'pub enum ServerEvent')
code='''#![allow(dead_code, unused_imports)]
use std::sync::Arc;
fn next_request_id()->i64 { 1 }
mod tah_attempt {
'''+info+'''
pub struct PreparedAttempt { pub info: TahQualificationInfo }
pub fn current()->Option<&'static PreparedAttempt> { None }
}
mod session { pub mod connection {
use codex_app_server_protocol::{ClientRequest,ServerNotification,ServerRequest};
type AgentRuntimeKind=String;type JsonValue=serde_json::Value;
#[derive(Clone,Debug)]
'''+event+'''
pub struct ServerConfig { pub is_local:bool, pub server_id:String }
pub struct ServerSession;
impl ServerSession {
 pub fn config(&self)->&ServerConfig { unimplemented!() }
 pub fn runtime_kinds(&self)->Vec<String> { unimplemented!() }
 pub fn events(&self)->tokio::sync::broadcast::Receiver<ServerEvent> { unimplemented!() }
 pub async fn request_client(&self,_:ClientRequest)->Result<JsonValue,()> { unimplemented!() }
}
} }
pub struct MobileClient;
impl MobileClient {
 pub fn get_session(&self,_:&str)->Result<Arc<session::connection::ServerSession>,()> { unimplemented!() }
}
mod ffi { pub mod shared {
 pub fn shared_mobile_client()->std::sync::Arc<crate::MobileClient> { unimplemented!() }
} }
mod runner {
'''
runner=(SRC/'tah_runner.rs').read_text()
code+='\n'.join(line for line in runner.splitlines() if not line.startswith('//!'))
code+='\n#[cfg(test)] mod tests { use super::*;\n'+(HERE/'tests.rs').read_text()+'\n}\n}\n'
source=BUILD/'check.rs';source.write_text(code)
deps=ROOT/'shared/rust-bridge/target/aarch64-apple-ios/ios-dev/deps';hostdeps=ROOT/'shared/rust-bridge/target/ios-dev/deps'
rustc=ROOT.parent/'ALMA/.build/tauri-toolchain/rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc'
cmd=[str(rustc),'--edition=2024','--test','--target=aarch64-apple-ios','--emit=metadata','--crate-name=tah_runner_check',str(source),'-o',str(BUILD/'check.rmeta'),'-L','dependency='+str(deps),'-L','dependency='+str(hostdeps)]
for name in ['codex_app_server_protocol','codex_protocol','serde','serde_json','tokio']:
 artifact=max(deps.glob('lib'+name+'-*.rmeta'),key=lambda p:p.stat().st_mtime_ns)
 cmd+=['--extern',name+'='+str(artifact)]
r=subprocess.run(cmd,text=True,capture_output=True,timeout=60)
(HERE/'output.txt').write_text(r.stdout+r.stderr or 'PASS: actual iOS protocol metadata; tests compiled, not executed.\n')
(HERE/'evidence.json').write_text(json.dumps({'command':cmd,'exit_code':r.returncode,'tests_executed':False,'runner_sha256':hashlib.sha256(runner.encode()).hexdigest(),'limitations':'App/session shell stubs; actual protocol + Tokio + serde; no requests or device execution'},indent=2)+'\n')
print(r.stdout+r.stderr or 'PASS: actual iOS protocol metadata; tests compiled, not executed.')
raise SystemExit(r.returncode)
