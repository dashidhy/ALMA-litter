#!/usr/bin/env python3
"""Review checks only: syntax/early-error contracts and Cargo trees; no client build."""
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import tomllib

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BASE = 'shared/rust-bridge/codex-mobile-client/'
TOOL = ROOT.parent/'ALMA/.build/tauri-toolchain'
BIN = TOOL/'rustup/toolchains/stable-aarch64-apple-darwin/bin'


def function(text, name, indent=4, last=False):
    found=list(re.finditer(r'^'+' '*indent+r'(?:pub(?:\(crate\))? )?(?:async )?fn '+name+r'\(',text,re.M))
    m=found[-1] if last else found[0]
    opening=text.index('{',m.start())
    end=re.search(r'^'+' '*indent+r'}$',text[opening:],re.M)
    return text[m.start():opening+end.end()]


def run():
    (HERE/'.cache').mkdir(exist_ok=True)
    work=Path(tempfile.mkdtemp(prefix='validate-',dir=HERE/'.cache'))
    report={'scope':'No full client build/link/device test', 'checks':[], 'evidence':str(work)}
    for p in (HERE/'after').rglob('*.sh'):
        subprocess.run(['/bin/bash','-n',str(p)],check=True)
    subprocess.run(['git','apply','--check',str(HERE/'proposal.patch')],cwd=ROOT,check=True)
    subprocess.run(['git','apply','--check',str(HERE/'optional-remove-netdev-override.patch')],cwd=ROOT,check=True)
    report['checks']+=['proposal and optional cleanup apply-check','three shell scripts parse']
    # Verify macOS Bash handles all supported feature argument combinations.
    for local,trace in [(0,0),(1,0),(0,1),(1,1)]:
        script='set -eu; CARGO_FEATURES=(); '
        if trace: script+='CARGO_FEATURES+=(--features rpc-trace); '
        if local: script+='CARGO_FEATURES+=(--no-default-features); '
        script+='printf "<%s>\\n" ${CARGO_FEATURES[@]+"${CARGO_FEATURES[@]}"}'
        result=subprocess.check_output(['/bin/bash','-c',script],text=True)
        assert ('--no-default-features' in result)==bool(local)
        assert ('rpc-trace' in result)==bool(trace)
    report['checks']+=['Bash 3.2 empty/default/local/rpc-trace feature arrays']
    changed=json.loads((HERE/'source-hashes.json').read_text())
    forbidden=['perf_profile.rs','thread_projection.rs','types/server_requests.rs','scoped_files.rs']
    assert not any(any(name in path for name in forbidden) for path in changed)
    for rel,hashes in changed.items():
        assert hashlib.sha256((HERE/'after'/rel).read_bytes()).hexdigest()==hashes['after']
    report['checks']+=['no other-agent ownership files changed; all proposal hashes match']

    # Small consumer: real pure types, disabled parser and actual early-return bodies.
    # Inert signature types replace the huge MobileClient dependencies in THIS TEST ONLY.
    crate=work/'contracts'; (crate/'src').mkdir(parents=True)
    for filename in ['alleycat_types.rs','alleycat_disabled.rs','network_scope.rs']:
        shutil.copyfile(HERE/'after'/BASE/'src'/filename,crate/'src'/filename)
    mobile=(HERE/'after'/BASE/'src/mobile_client/mod.rs').read_text()
    stubs='\n'.join(function(mobile,name,last=True) for name in
                    ['list_alleycat_agents','connect_remote_over_alleycat','alleycat_secret_key','shutdown_alleycat_endpoint'])
    pair=(HERE/'after'/BASE/'src/pair/mod.rs').read_text()
    pair_stubs='\n'.join(function(pair,name,indent=0,last=True) for name in ['start_pair_host','pair_from_iphone'])
    harness='''pub mod types { pub type AgentRuntimeKind = String; }
mod alleycat_types;
pub mod network_scope;
#[path="alleycat_disabled.rs"] pub mod alleycat;
#[cfg(not(feature="remote-alleycat"))]
mod local {
use super::alleycat::{AgentInfo as AlleycatAgentInfo, AgentWire as AlleycatAgentWire, ParsedPairPayload as ParsedAlleycatPairPayload};
#[derive(Debug)] pub enum TransportError { ConnectionFailed(String) }
#[derive(Debug)] pub struct AlleycatConnectOutcome;
pub struct MobileClient;
impl MobileClient {
'''+stubs+'''
}
}
#[cfg(not(feature="remote-pairing"))]
mod pairing {
use std::sync::Arc;
#[derive(Debug)] pub struct PairHostHandle;
#[derive(Debug)] pub struct PairClientHandle;
#[derive(Debug)] pub struct PairServiceInfo;
#[derive(Debug)] pub enum PairError { Transport(String) }
'''+pair_stubs+'''
}
#[cfg(test)] mod tests {
use super::*;
use std::future::Future;
use std::sync::Arc;
use std::task::{Context,Poll,Wake,Waker};
struct WakeOnce; impl Wake for WakeOnce { fn wake(self: Arc<Self>) {} }
fn ready<F: Future>(f: F) -> F::Output {
 let w=Waker::from(Arc::new(WakeOnce)); let mut cx=Context::from_waker(&w);
 match std::pin::pin!(f).as_mut().poll(&mut cx) { Poll::Ready(x)=>x, Poll::Pending=>panic!("disabled operation must not wait for network") }
}
#[test] fn capabilities_are_build_flags() {
 assert_eq!(network_scope::remote_alleycat_available(),cfg!(feature="remote-alleycat"));
 assert_eq!(network_scope::pairing_available(),cfg!(feature="remote-pairing"));
 assert_eq!(alleycat::agent_runtime_kind("codex","Codex"),Some("codex".into()));
}
#[cfg(not(feature="remote-alleycat"))]
#[test] fn remote_calls_fail_without_success_or_waiting() {
 let c=local::MobileClient;
 let params=alleycat::ParsedPairPayload{version:1,node_id:"deferred".into(),token:"deferred".into(),relay:None,host_name:None};
 assert!(alleycat::parse_pair_payload("{}").unwrap_err().to_string().contains("unsupported"));
 let local::TransportError::ConnectionFailed(e)=ready(c.list_alleycat_agents(params.clone(),true)).unwrap_err(); assert!(e.contains("unsupported"));
 let local::TransportError::ConnectionFailed(e)=ready(c.connect_remote_over_alleycat("id".into(),"name".into(),params,"codex".into(),vec![],alleycat::AgentWire::Jsonl)).unwrap_err(); assert!(e.contains("unsupported"));
 assert!(c.alleycat_secret_key().is_none()); ready(c.shutdown_alleycat_endpoint());
}
#[cfg(not(feature="remote-pairing"))]
#[test] fn pairing_returns_error_without_binding_or_connecting() {
 let pairing::PairError::Transport(e)=ready(pairing::start_pair_host("x".into(),"x".into(),0)).unwrap_err(); assert!(e.contains("unsupported"));
 let pairing::PairError::Transport(e)=ready(pairing::pair_from_iphone("invalid".into(),0,"x".into(),"".into())).unwrap_err(); assert!(e.contains("unsupported"));
}
#[test] fn changed_rust_files_parse() {
 for p in include_str!("../../../rust-files.txt").lines() {
  syn::parse_file(&std::fs::read_to_string(p).unwrap()).unwrap_or_else(|e|panic!("{p}: {e}"));
 }
}
}
'''
    # rust-files.txt is at the run directory; from src/lib.rs it is two parents up.
    harness=harness.replace('../../../rust-files.txt','../../rust-files.txt')
    (crate/'src/lib.rs').write_text(harness)
    (work/'rust-files.txt').write_text('\n'.join(str(p) for p in (HERE/'after').rglob('*.rs'))+'\n')
    (crate/'Cargo.toml').write_text('''[workspace]
[package]
name="alma-network-contracts"
version="0.0.0"
edition="2024"
[features]
default=["remote-alleycat","remote-pairing"]
remote-alleycat=[]
remote-pairing=[]
[dependencies]
thiserror="=2.0.18"
[dev-dependencies]
syn={version="=2.0.117",features=["full"]}
''')
    # Isolate compiler output; shared source archives/index are read only.
    home=work/'cargo-home'; cache=home/'registry/cache/index.crates.io-1949cf8c6b5b557f'; cache.mkdir(parents=True)
    index=home/'registry/index/index.crates.io-1949cf8c6b5b557f'; index.mkdir(parents=True)
    srcindex=TOOL/'cargo/registry/index/index.crates.io-1949cf8c6b5b557f'
    shutil.copyfile(srcindex/'config.json',index/'config.json')
    pkgs=tomllib.loads((ROOT/'shared/rust-bridge/Cargo.lock').read_text())['package']
    for name,version in [('thiserror','2.0.18'),('thiserror-impl','2.0.18'),('syn','2.0.117'),('quote','1.0.45'),('proc-macro2','1.0.106'),('unicode-ident','1.0.24')]:
        pkg=next(p for p in pkgs if p['name']==name and p['version']==version)
        archive=TOOL/'cargo/registry/cache/index.crates.io-1949cf8c6b5b557f'/f'{name}-{version}.crate'
        assert hashlib.sha256(archive.read_bytes()).hexdigest()==pkg['checksum']
        shutil.copyfile(archive,cache/archive.name)
        entry=Path('3')/name[0]/name if len(name)==3 else Path(name[:2])/name[2:4]/name
        dest=index/'.cache'/entry; dest.parent.mkdir(parents=True,exist_ok=True); shutil.copyfile(srcindex/'.cache'/entry,dest)
    env={k:os.environ[k] for k in ['HOME','TMPDIR','DEVELOPER_DIR'] if k in os.environ}
    env.update(PATH=str(BIN)+':/usr/bin:/bin:/usr/sbin:/sbin',RUSTC=str(BIN/'rustc'),CARGO_HOME=str(home),CARGO_TARGET_DIR=str(work/'target'),CARGO_BUILD_JOBS='2')
    for action,extra,label in [('test',['--no-default-features'],'local'),('test',[],'default'),('build',['--target','aarch64-apple-ios','--no-default-features','--lib'],'ios')]:
        cmd=[str(BIN/'cargo'),action,'--manifest-path',str(crate/'Cargo.toml'),'--offline','--jobs','2',*extra]
        result=subprocess.run(cmd,env=env,cwd=crate,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=120)
        (work/f'{label}.log').write_text(result.stdout)
        assert result.returncode==0,(label,result.stdout[-3500:])
        report['checks'].append(f'isolated contracts {label}: PASS')
    (HERE/'validation-summary.json').write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))

if __name__=='__main__': run()
