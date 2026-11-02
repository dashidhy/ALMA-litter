#!/usr/bin/env python3
"""Test actual lexical guest-shell resolution/argv methods with shell type fixtures.

Does not execute a shell, probe host executables or compile the full Codex crates.
"""
from pathlib import Path
import hashlib,json,os,shutil,subprocess
from prepare_source import HERE,prepare_source
from verify import digest,git_apply,require,tree_hashes
base=prepare_source();patch=HERE/'embedded-guest-shell.patch'
report=json.loads((HERE/'reports/guest-shell-verification.json').read_text())
require(report['patch_sha256']==digest(patch),'verify guest-shell patch first')
expected=tree_hashes(base);expected.update(report['checks'][0]['after_sha256'])
source=HERE/'.cache'/('guest-shell-source-'+digest(patch)[:16])
if not source.exists():
 shutil.copytree(base,source,symlinks=True)
 require(git_apply(source,patch,'--check')['ok'],'check failed');require(git_apply(source,patch)['ok'],'apply failed')
require(tree_hashes(source)==expected,'test source mismatch')
root=source/'codex-rs';work=HERE/'.cache/guest-shell-harness';(work/'src').mkdir(parents=True,exist_ok=True);(work/'.cargo').mkdir(exist_ok=True)
(work/'.cargo/config.toml').write_text('[source.crates-io]\nreplace-with="cached"\n[source.cached]\ndirectory='+json.dumps(str(HERE/'.cache/event-log-harness/vendor'))+'\n')
(work/'Cargo.toml').write_text('[package]\nname="guest-shell-check"\nversion="0.0.0"\nedition="2024"\n[dependencies]\nanyhow="1"\n')
def item(source,needle):
 start=source.index(needle);brace=source.index('{',start);depth=1;i=brace+1
 while depth:
  if source[i]=='{':depth+=1
  elif source[i]=='}':depth-=1
  i+=1
 return source[start:i]
shell=(root/'core/src/shell.rs').read_text();detect=(root/'shell-command/src/shell_detect.rs').read_text()
code='#![allow(dead_code)]\nextern crate self as codex_shell_command;\nuse std::path::PathBuf;\n'
code+='#[derive(Debug,PartialEq,Eq,Clone,Copy)]\n'+item(detect,'pub enum ShellType')+'\n'+item(detect,'impl ShellType')+'\n'
code+='pub mod shell_detect { use super::ShellType;\n'+item(detect,'pub fn detect_shell_type')+'\n}\n'
code+='struct ShellInfo { name:String,path:String }\n#[derive(Clone)] struct Shell { shell_type:ShellType,shell_path:PathBuf }\nimpl Shell {\n'
for method in ['pub fn derive_exec_args','pub(crate) fn from_environment_shell_info','pub(crate) fn for_embedded_exec']:
 code+=item(shell,method)+'\n'
code+='}\n'
tests=(root/'core/src/shell_tests.rs').read_text().split('// Embedded shell contract:')[1]
code+='#[cfg(test)] mod tests { use super::*;\n// Embedded shell contract:'+tests+'\n}\n'
(work/'src/lib.rs').write_text(code)
toolchain=Path('/Users/dashidhy/Public/projects/agent/ALMA/.build/tauri-toolchain/rustup/toolchains/stable-aarch64-apple-darwin')
env=dict(os.environ,CARGO_HOME=str(work/'cargo-home'),CARGO_TARGET_DIR=str(work/'target'),RUSTC=str(toolchain/'bin/rustc'),RUSTDOC=str(toolchain/'bin/rustdoc'));env.pop('RUSTC_WRAPPER',None)
r=subprocess.run([str(toolchain/'bin/cargo'),'test','--offline','--lib'],cwd=work,env=env,capture_output=True,text=True,timeout=60)
log=r.stdout+r.stderr;(work/'test.log').write_text(log);print(log)
result={'patch_sha256':digest(patch),'scope':'exact shell methods/lexical detector with type fixtures; not full Codex integration','command':'python3 patches/codex-0.166/tests/run_guest_shell_tests.py','returncode':r.returncode,'output':log,'source_hashes':{p:digest(root/p) for p in ['core/src/shell.rs','core/src/shell_tests.rs','core/src/tools/handlers/unified_exec/preparation.rs']}}
(HERE/'reports/guest-shell-tests.json').write_text(json.dumps(result,indent=2)+'\n')
raise SystemExit(r.returncode)
