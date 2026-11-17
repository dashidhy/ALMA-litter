"""Exercise App file operations under the real sealed iSH filesystem grants."""
from pathlib import Path
import argparse, hashlib, importlib.util, json, shutil, subprocess, tempfile

parser=argparse.ArgumentParser();parser.add_argument('--protocol',action='store_true');args=parser.parse_args()
REPO=Path(__file__).resolve().parents[2]
ZCODE=REPO.parent/'ALMA-ZCode'
CODEX=REPO.parent/'ALMA-codex'
OUT=REPO/'tools/mobile-tah/.cache/asset-files-ish'
OUT.mkdir(parents=True,exist_ok=True)
TARGET=REPO/'tools/alma-ios-lab/kimi_owned_probe/.cache/target/debug'
RUSTC=REPO.parent/'ALMA/.build/tauri-toolchain/rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc'
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
old=REPO/'tools/alma-ios-lab/kimi_owned_probe/.cache/owned-source'
current=CODEX/'ios/.build/vendor/litter-ish-owned'
for name in ['kernel/workspace_policy.c','kernel/session_job.c','embed/host/src/instance.rs','fs/real.c','kernel/mmap.c']:
 if sha(old/name)!=sha(current/name):raise RuntimeError('Qualified kernel source mismatch: '+name)
source=(ZCODE/'ios/native/tests/runtime-grant-probe.rs').read_text()
a=source.index('    let script=r#"');b=source.index('"#;',a)+3
source=source[:a]+'    let script=std::fs::read_to_string(&args[4])?;'+source[b:]
source=source.replace('"-e", script]', '"-e", script.as_str()]').replace('view/outbox','view/assets')
source=source.replace('output==b"ZCODE_GRANT_PASS\\n"','output.ends_with(b"ZCODE_GRANT_PASS\\n")').replace('std::fs::write(&args[3], b"ZCODE_GRANT_PASS\\n")?;', 'if let Ok(Ok(output))=execution { std::fs::write(&args[3], output)?; }')
file=OUT/'probe.rs';file.write_text(source);binary=OUT/'probe'
command=[str(RUSTC),'--edition=2021',str(file),'-o',str(binary),'-L','dependency='+str(TARGET/'deps')]
for name in ['ish_embed_host','tokio']:
 matches=list((TARGET/'deps').glob('lib'+name+'-*.rlib'))
 if len(matches)!=1:raise RuntimeError('Expected exactly one qualified '+name)
 command+=['--extern',name+'='+str(matches[0])]
for p in (TARGET/'build').glob('*/out'):
 command+=['-L','native='+str(p)]
 if (p/'meson-build').exists():command+=['-L','native='+str(p/'meson-build')]
subprocess.run(command,check=True,timeout=120)
spec=importlib.util.spec_from_file_location('asset_probe_guest',ZCODE/'ios/guest/run.py');guest=importlib.util.module_from_spec(spec);spec.loader.exec_module(guest)
inputs=json.loads((ZCODE/'ios/.cache/guest-m1szedm4/report.json').read_text())['inputs'];rootfs=Path(inputs['rootfs'])
work=Path(tempfile.mkdtemp(prefix='run-',dir=OUT));workspace=work/'workspace';view=workspace/'attempts/probe/view';scratch=workspace/'attempts/probe/scratch'
for p in [view/'assets',scratch,workspace/'.runtime/zcode']:p.mkdir(parents=True,exist_ok=True)
shutil.copyfile(REPO/'shared/session-agent/fixtures/nvidia-transcript.md',view/'transcript.md')
shutil.copyfile(REPO/'shared/session-agent/runtime/asset-files.cjs',workspace/'.runtime/zcode/asset-files.cjs')
script=work/'probe.cjs';script.write_text('''const fs=require('node:fs');
(async()=>{
 let result;
 try {const api=await require('/workspace/.runtime/zcode/asset-files.cjs').createAssetFiles('/workspace/attempts/probe/view','/workspace/attempts/probe/scratch');result={ok:true,value:await api.call('copy_file',{source:'transcript.md',destination:'assets/copied.md'})};}
 catch(error){result={ok:false,code:error.almaCode??error.code??error.name};}
 fs.writeFileSync('/workspace/attempts/probe/scratch/result.json',JSON.stringify(result));
 process.stdout.write('ZCODE_GRANT_PASS\\n');
})().catch(()=>{process.exitCode=1;});
''')
if args.protocol:
 shutil.copyfile(REPO/'shared/session-agent/runtime/protocol-writer.cjs',workspace/'.runtime/zcode/protocol-writer.cjs')
 script.write_text("""const fs=require('node:fs');
(async()=>{
 const originalWrite=process.stdout.write.bind(process.stdout);
 const body='x'.repeat(256*1024), report={};
 let written=0;
 try {
  for(let index=0;index<16;index++){
   const bytes=Buffer.from('SYNC'+JSON.stringify({kind:'http',index,body})+'\\n');
   for(let offset=0;offset<bytes.length;){const n=fs.writeSync(1,bytes,offset);if(n<=0)throw Error('zero_write');offset+=n;written+=n;}
  }
 }catch(error){report.syncError=error.code??error.message;}
 report.syncWritten=written;
 await new Promise(resolve=>originalWrite('\\n',resolve));
 const writer=require('/workspace/.runtime/zcode/protocol-writer.cjs').createProtocolWriter('ASYNC',{frameLimit:()=>2*1024*1024});
 writer.send({kind:'http',index:1,body});writer.send({kind:'terminal'});await writer.flush();
 fs.writeFileSync('/workspace/attempts/probe/scratch/result.json',JSON.stringify(report));
 await new Promise(resolve=>originalWrite('ZCODE_GRANT_PASS\\n',resolve));
})().catch(error=>{fs.writeSync(2,String(error.code??error.name));process.exitCode=1;});
""")
clone=work/'rootfs';guest.host.require_space(work);guest.host.clone_rootfs(rootfs,clone)
try:run=guest.run_bounded([str(binary),str(clone/'data'),str(workspace),str(work/'receipt'),str(script)],work,work/'process',60)
finally:shutil.rmtree(clone)
result=json.loads((scratch/'result.json').read_text()) if (scratch/'result.json').exists() else {'ok':False,'code':'no_result'}
if args.protocol and (work/'receipt').exists():
 lines=(work/'receipt').read_text().splitlines();packets=[]
 for line in lines:
  if line.startswith('ASYNC'):packets.append(json.loads(line[5:]))
 result['asyncFrameCount']=len(packets)
 result['asyncFramesValid']=len(packets)==2 and packets[0].get('body')=='x'*(256*1024) and packets[1].get('kind')=='terminal'
report={'processExit':run['hostReturncode'],'stopReason':run['stopReason'],'result':result,'originalUnchanged':sha(view/'transcript.md')==sha(REPO/'shared/session-agent/fixtures/nvidia-transcript.md'),'toolSHA256':sha(REPO/'shared/session-agent/runtime/asset-files.cjs'),'protocolSHA256':sha(REPO/'shared/session-agent/runtime/protocol-writer.cjs'),'probeSHA256':sha(file),'work':str(work)}
(OUT/'latest.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
