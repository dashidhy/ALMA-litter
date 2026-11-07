#!/usr/bin/env python3
"""Offline host execution of production dispatcher with source-derived wire DTOs."""
from pathlib import Path
import os,sys,json,subprocess,hashlib
HERE=Path(__file__).resolve().parent; ROOT=HERE.parents[2]; BUILD=HERE/'.build/rust'; BUILD.mkdir(parents=True,exist_ok=True)
sys.path.insert(0,str(HERE.parent/'thread_item_regression'))
from run import declaration
SRC=ROOT.parent/'ALMA-codex/ios/native/src/auth_refresh.rs'
UP=ROOT.parent/'ALMA-codex/codex-rs/app-server-protocol/src'
account=(UP/'protocol/v2/account.rs').read_text();rpc=(UP/'rpc.rs').read_text()
wire='use serde::{Serialize,Deserialize}; use serde_json::Value as JsonValue;\n'
for n in ['ChatgptAuthTokensRefreshParams','ChatgptAuthTokensRefreshReason','ChatgptAuthTokensRefreshResponse']:
 wire+=declaration(account,n)+'\n'
wire=wire.replace('pub struct ChatgptAuthTokensRefreshResponse','#[derive(Debug)]\npub struct ChatgptAuthTokensRefreshResponse')
wire+=declaration(rpc,'JSONRPCErrorError')+'\n'
(BUILD/'lib.rs').write_text('extern crate self as codex_app_server_protocol;\nuniffi::setup_scaffolding!();\n'+wire+'\n#[path='+json.dumps(str(SRC))+'] mod auth_refresh;\n#[cfg(test)] #[path='+json.dumps(str(HERE/'rust_tests.rs'))+'] mod tests;\n')
(BUILD/'Cargo.toml').write_text('''[package]
name="alma-auth-refresh-regression"
version="0.0.0"
edition="2024"
[workspace]
[lib]
path="lib.rs"
[dependencies]
uniffi={version="0.31.0",features=["tokio"]}
tokio={version="1",features=["rt","macros","time","sync","test-util"]}
async-trait="0.1"
thiserror="2"
serde={version="1",features=["derive"]}
serde_json="1"
''')
TC=ROOT.parent/'ALMA/.build/tauri-toolchain'
env=dict(os.environ,CARGO_HOME=str(TC/'cargo'),RUSTUP_HOME=str(TC/'rustup'),RUSTUP_TOOLCHAIN='stable-aarch64-apple-darwin',CARGO_TARGET_DIR=str(BUILD/'target'))
env['PATH']=str(TC/'cargo/bin')+os.pathsep+env['PATH']
for key in ['RUSTC','RUSTC_WRAPPER','RUSTC_WORKSPACE_WRAPPER','RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS']:env.pop(key,None)
cmd=[str(TC/'cargo/bin/cargo'),'test','--offline','--manifest-path',str(BUILD/'Cargo.toml'),'-j','2']
r=subprocess.run(cmd,env=env,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
(HERE/'rust-output.txt').write_text(r.stdout)
(HERE/'rust-evidence.json').write_text(json.dumps({'command':cmd,'exit_code':r.returncode,'production_source_sha256':hashlib.sha256(SRC.read_bytes()).hexdigest(),'transport':'offline dummy reply closure','protocol':'DTOs extracted from actual source; not full upstream crate'},indent=2)+'\n')
print(r.stdout);raise SystemExit(r.returncode)
