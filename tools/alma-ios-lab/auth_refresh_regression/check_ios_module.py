#!/usr/bin/env python3
"""Check real auth-refresh/UniFFI source against cached actual iOS dependencies."""
from pathlib import Path
import sys,subprocess,os,json,hashlib
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[2]
sys.path.insert(0,str(HERE.parent/'thread_item_regression'));from run import TOOLCHAIN, block
out=HERE/'.build/ios';out.mkdir(parents=True,exist_ok=True)
source=ROOT.parent/'ALMA-codex/ios/native/src/auth_refresh.rs'
client=(ROOT/'shared/rust-bridge/codex-mobile-client/src/ffi/client.rs').read_text()
methods='\n'.join(block(client,client.index('pub fn '+name+'(')) for name in ['set_chatgpt_auth_refresh_provider','clear_chatgpt_auth_refresh_provider'])
(out/'lib.rs').write_text('uniffi::setup_scaffolding!();\nuse std::sync::Arc;\n#[path='+json.dumps(str(source))+'] pub mod auth_refresh;\n#[derive(uniffi::Object)] pub struct RegistrationProbe;\n#[uniffi::export] impl RegistrationProbe {\n'+methods+'\n}\n')
(out/'Cargo.toml').write_text('[package]\nname="auth-refresh-ios-typecheck"\nversion="0.0.0"\nedition="2024"\n[workspace]\n')
deps=ROOT/'shared/rust-bridge/target/aarch64-apple-ios/ios-dev/deps';host=ROOT/'shared/rust-bridge/target/ios-dev/deps'
command=[str(TOOLCHAIN/'rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc'),'--crate-name','auth_refresh_ios_typecheck','--crate-type','lib','--edition=2024','--target=aarch64-apple-ios','--emit=metadata',str(out/'lib.rs'),'-o',str(out/'auth_refresh.rmeta'),'-L','dependency='+str(deps),'-L','dependency='+str(host)]
for name in ['uniffi','codex_app_server_protocol','tokio','thiserror']:
 p=max(deps.glob(f'lib{name}-*.rmeta'),key=lambda p:p.stat().st_mtime_ns);command+=['--extern',name+'='+str(p)]
p=max(host.glob('libasync_trait-*.dylib'),key=lambda p:p.stat().st_mtime_ns);command+=['--extern','async_trait='+str(p)]
env=dict(os.environ,CARGO_MANIFEST_DIR=str(out),CARGO_CRATE_NAME='auth_refresh_ios_typecheck',CARGO_PKG_NAME='auth-refresh-ios-typecheck',CARGO_PKG_VERSION='0.0.0',OUT_DIR=str(out))
r=subprocess.run(command,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
(HERE/'ios-module-typecheck.txt').write_text(r.stdout or 'PASS: production auth_refresh and UniFFI async callback compile against actual iOS dependencies.\n')
(HERE/'ios-module-evidence.json').write_text(json.dumps({'command':command,'exit_code':r.returncode,'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'scope':'production module, real iOS metadata, standalone root; not whole-mobile wiring'},indent=2)+'\n')
print(r.stdout or 'PASS actual production module iOS typecheck');raise SystemExit(r.returncode)
