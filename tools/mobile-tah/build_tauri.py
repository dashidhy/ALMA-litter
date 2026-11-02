"""Build one Tauri+Codex iOS library using existing pinned native dependencies."""
from pathlib import Path
import argparse,json,os,subprocess,time,shutil,signal
HERE=Path(__file__).resolve().parent;REPO=HERE.parents[1];LAB=REPO/'tools/alma-ios-lab'
p=argparse.ArgumentParser();p.add_argument('--check',action='store_true');args=p.parse_args()
env=dict(os.environ)
env.update(json.loads(subprocess.check_output(['python3',str(LAB/'prepare_native_v8.py'),'--check-only','--print-env-json'],text=True)))
for k in ['V8_FROM_SOURCE','RUSTY_V8_MIRROR','RUSTY_V8_SRC_BINDING_URL','DOCS_RS']:env.pop(k,None)
command=['bash',str(LAB/'cargo_ios.sh'),'check'if args.check else 'rustc','--lib','--offline','-p','alma-tah-ui','--target','aarch64-apple-ios','--profile','ios-dev','-j','2']
if not args.check:command+=['--crate-type','staticlib']
cache=HERE/'.cache';cache.mkdir(exist_ok=True);log=cache/'tauri-native-build.log';started=time.monotonic()
if shutil.disk_usage(REPO).free<12*1024**3:raise RuntimeError('Build requires 12 GiB immediate headroom')
with log.open('w')as out:
 proc=subprocess.Popen(command,env=env,stdout=out,stderr=subprocess.STDOUT,start_new_session=True)
 try:
  while proc.poll()is None:
   if shutil.disk_usage(REPO).free<8*1024**3:raise RuntimeError('Native build space floor reached')
   if time.monotonic()-started>2400:raise RuntimeError('Native build deadline reached')
   time.sleep(2)
 except BaseException:
  os.killpg(proc.pid,signal.SIGTERM);proc.wait(timeout=10);raise
report={'exitCode':proc.returncode,'seconds':time.monotonic()-started,'command':command,'scope':'Native Tauri+existing Codex build only, no phone/model work'}
(cache/'tauri-native-build.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report));print('\n'.join(log.read_text().splitlines()[-14:]));raise SystemExit(proc.returncode)
