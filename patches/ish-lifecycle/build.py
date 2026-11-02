#!/usr/bin/env python3
"""Build private C host + real AArch64 supervisor offline; no shared build writes."""
from pathlib import Path
import json,os,shlex,shutil,subprocess
from verify import HERE,REPO,CACHE,BASE,sha,tree,check_base,apply

def run(args,log,env,cwd=None):
 r=subprocess.run([str(x) for x in args],cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=120)
 if r.returncode:raise RuntimeError('build command failed; inspect '+log.name)

def main():
 expected=check_base();report=json.loads((HERE/'reports/verification.json').read_text());assert report['patch_sha256']==sha(HERE/'owned-session-jobs.patch')
 expected.update(report['after_sha256']);source=CACHE/'source'
 if not source.exists():
  shutil.copytree(BASE,source,symlinks=True);assert apply(source,'--check')['returncode']==0;assert apply(source)['returncode']==0
 assert tree(source)==expected,'private source differs from verified patch'
 toolchain=REPO.parent/'ALMA/.build/tauri-toolchain/rustup/toolchains/stable-aarch64-apple-darwin';lib=toolchain/'lib'
 bindir=CACHE/'bin';bindir.mkdir(exist_ok=True);shim=bindir/'ld.lld';shim.write_text('#!/bin/sh\nexport DYLD_LIBRARY_PATH='+shlex.quote(str(lib))+'\nexec '+shlex.quote(str(lib/'rustlib/aarch64-apple-darwin/bin/rust-lld'))+' -flavor gnu "$@"\n');shim.chmod(0o755)
 env=dict(os.environ,PATH=str(bindir)+os.pathsep+os.environ['PATH']);env.pop('IPHONEOS_DEPLOYMENT_TARGET',None);env.pop('RUSTC_WRAPPER',None)
 meson=REPO/'tools/alma-ios-lab/.cache/ish-tools/bin/meson';build=CACHE/'build'
 with (CACHE/'build.log').open('w') as log:
  run([meson,'setup',*(['--reconfigure'] if (build/'build.ninja').exists() else []),build,source,'--buildtype=release','-Dguest_arch=arm64','-Dkernel=ish','-Dno_crlf=true'],log,env)
  run(['ninja','-C',build,'-j','3','ish'],log,env)
  run(['clang','-std=gnu11','-DGUEST_ARM64=1','-I',source,'-c',source/'embed/ffi.c','-o',build/'ffi-check.o'],log,env)
 vdso=build/'vdso/arm64/libvdso.so.elf';assert vdso.stat().st_size>=1024 and vdso.read_bytes()[:4]==b'\x7fELF'
 # Own directory-source metadata; cached package source links are read-only inputs.
 registry=REPO.parent/'ALMA/.build/tauri-toolchain/cargo/registry/src/index.crates.io-1949cf8c6b5b557f';vendor=CACHE/'vendor';vendor.mkdir(exist_ok=True)
 for package in registry.iterdir():
  if not (package/'Cargo.toml').exists():continue
  dest=vendor/package.name;dest.mkdir(exist_ok=True)
  for child in package.iterdir():
   if child.name=='.cargo-checksum.json':continue
   link=dest/child.name
   if not link.exists() and not link.is_symlink():link.symlink_to(child,target_is_directory=child.is_dir())
  (dest/'.cargo-checksum.json').write_text(json.dumps({'files':{},'package':None}))
 # Real supervisor and protocol sources, isolated from unrelated host dependencies.
 ws=CACHE/'supervisor-workspace';ws.mkdir(exist_ok=True)
 for name in ['protocol','supervisor']:shutil.copytree(source/'embed'/name,ws/name,dirs_exist_ok=True)
 (ws/'Cargo.toml').write_text((source/'embed/Cargo.toml').read_text().replace('    "host",\n',''))
 rustenv=dict(env,CARGO_HOME=str(CACHE/'cargo-home'),CARGO_TARGET_DIR=str(CACHE/'cargo-target'),RUSTC=str(toolchain/'bin/rustc'),RUSTDOC=str(toolchain/'bin/rustdoc'),CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=str(shim),RUSTFLAGS='-Clink-self-contained=yes -Crelocation-model=static')
 with (CACHE/'supervisor-build.log').open('w') as log:
  run([toolchain/'bin/cargo','build','--offline','-p','ish-supervisor','--target','aarch64-unknown-linux-musl','--release','--config','source.crates-io.replace-with="offline-cache"','--config','source.offline-cache.directory='+json.dumps(str(vendor))],log,rustenv,ws)
 supervisor=CACHE/'cargo-target/aarch64-unknown-linux-musl/release/ish-supervisor';assert supervisor.read_bytes()[:4]==b'\x7fELF'
 buildreport={'patch_sha256':report['patch_sha256'],'c_host_build':True,'c_ffi_compile':True,'supervisor_musl_cross_build':True,'host_rust_wrapper_compile':False,'pinned_workspace_lock_used':False,'isolated_supervisor_lock_sha256':sha(ws/'Cargo.lock'),'host_binary_sha256':sha(build/'ish'),'supervisor_sha256':sha(supervisor),'vdso_sha256':sha(vdso),'source_matches_verified_patch':tree(source)==expected,'scope':'private macOS C host + Linux ARM64 Rust supervisor; not iOS or Rust host-wrapper validation'}
 (HERE/'reports/build.json').write_text(json.dumps(buildreport,indent=2)+'\n');print(json.dumps(buildreport,indent=2))
if __name__=='__main__':main()
