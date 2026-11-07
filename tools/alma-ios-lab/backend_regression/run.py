#!/usr/bin/env python3
"""Compile the unchanged adapter in an isolated contract harness, offline.

Core producer/trait code is read from the composed Codex fork. Protocol DTOs,
iSH boundary and policy are test doubles: not real bridge/iOS integration.
"""
from pathlib import Path
import hashlib,json,os,signal,subprocess
HERE=Path(__file__).resolve().parent;REPO=HERE.parents[2];CACHE=HERE/'.cache';CACHE.mkdir(exist_ok=True)
codex=Path(os.environ.get('ALMA_CODEX_REPO',REPO.parent/'ALMA-codex')).resolve(strict=True)
adapter=codex/'ios/native/src/ish_exec_backend.rs'
actual=codex/'codex-rs/exec-server/src/process.rs';core=actual.read_text()
producer=core[core.index('/// Pushed process events'):core.index('#[cfg(test)]')]
# Only metadata fixtures replace transitive protocol types; producer/traits stay exact.
for name in ['core','ish','driver']:(CACHE/name/'src').mkdir(parents=True,exist_ok=True)
(CACHE/'core/src/lib.rs').write_text((HERE/'fixtures/core_types.rs').read_text()+producer)
(CACHE/'ish/src/lib.rs').write_text((HERE/'fixtures/ish_mock.rs').read_text())
(CACHE/'driver/src/lib.rs').write_text('#[path='+json.dumps(str(adapter))+'] pub mod adapter;\n#[cfg(test)] mod tests {\n'+(HERE/'fixtures/tests.rs').read_text()+'\n}\n')
for name,package in [('core','codex-exec-server'),('ish','ish-embed-host')]:
 (CACHE/name/'Cargo.toml').write_text('[package]\nname='+json.dumps(package)+'\nversion="0.0.0"\nedition="2024"\n[dependencies]\ntokio={version="=1.52.3",features=["sync","rt","time","macros"]}\n')
(CACHE/'driver/Cargo.toml').write_text('[package]\nname="ish-backend-contract-check"\nversion="0.0.0"\nedition="2024"\n[dependencies]\ncodex-exec-server={path="../core"}\nish-embed-host={path="../ish"}\ntokio={version="=1.52.3",features=["sync","rt","time","macros"]}\n')
vendor=REPO/'patches/ish-lifecycle/.cache/vendor'
toolchain=Path(os.environ.get('ALMA_RUST_TOOLCHAIN_ROOT',REPO.parent/'ALMA/.build/tauri-toolchain'))/'rustup/toolchains/stable-aarch64-apple-darwin'
env=dict(os.environ,CARGO_HOME=str(CACHE/'cargo-home'),CARGO_TARGET_DIR=str(CACHE/'target'),RUSTC=str(toolchain/'bin/rustc'),RUSTDOC=str(toolchain/'bin/rustdoc'));env.pop('RUSTC_WRAPPER',None)
args=[str(toolchain/'bin/cargo'),'test','--offline','--lib','--config','source.crates-io.replace-with="cached"','--config','source.cached.directory='+json.dumps(str(vendor))]
r=subprocess.Popen(args,cwd=CACHE/'driver',env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
try:
 out,err=r.communicate(timeout=120)
except subprocess.TimeoutExpired:
 os.killpg(r.pid,signal.SIGKILL)
 out,err=r.communicate()
log=out+err;(CACHE/'test.log').write_text(log)
report={'adapter_sha256':hashlib.sha256(adapter.read_bytes()).hexdigest(),'actual_core_process_source_sha256':hashlib.sha256(actual.read_bytes()).hexdigest(),'returncode':r.returncode,'output':log,'scope':'unchanged adapter compiled against actual Core producer/traits plus explicit boundary DTO/iSH test doubles; not full real crate or device compilation','real_ish_adapter_execution_verified':False}
(HERE/'results.json').write_text(json.dumps(report,indent=2)+'\n');print(log);raise SystemExit(r.returncode)
