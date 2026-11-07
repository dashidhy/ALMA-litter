"""Prepare provider resources and build the single Tauri iOS library."""
from pathlib import Path
import argparse,json,os,subprocess,time,shutil,signal,sys
from contextlib import nullcontext
from provider_sources import prepare_provider_resources, provider_sources, write_native_provenance, native_input_records
from native_v8_inputs import verified_environment
HERE=Path(__file__).resolve().parent;REPO=HERE.parents[1];LAB=REPO/'tools/alma-ios-lab'
p=argparse.ArgumentParser();p.add_argument('--check',action='store_true');p.add_argument('--resources-only',action='store_true',help='Generate and verify bundle resources without invoking Cargo');p.add_argument('--timeout-minutes',type=int,default=40);p.add_argument('--artifact-report',type=Path,help='Save Cargo artifact JSON for identifying current build outputs');args=p.parse_args()
if not 1<=args.timeout_minutes<=120:p.error('--timeout-minutes must be between 1 and 120')
rootfs_manifest,kimi_runtime=prepare_provider_resources()
subprocess.run([sys.executable,str(HERE/'prepare_app.py'),'--config-only'],check=True,cwd=REPO)
if args.resources_only:
 print(json.dumps({'kimiRuntime':str(kimi_runtime),'rootfsManifest':str(rootfs_manifest),'rootfs':json.loads(rootfs_manifest.read_text())['fs'],'configuration':str(HERE/'.cache/app/mobile-config.json')}));sys.exit(0)
env=dict(os.environ)
env['CARGO_INCREMENTAL']='0' # This shared target previously accumulated multi-GiB stale incremental generations.
env.update(verified_environment(Path(provider_sources()['providers']['codex']['repository'])))
for k in ['V8_FROM_SOURCE','RUSTY_V8_MIRROR','RUSTY_V8_SRC_BINDING_URL','DOCS_RS']:env.pop(k,None)
command=['bash',str(LAB/'cargo_ios.sh'),'check'if args.check else 'rustc','--lib','--offline','-p','alma-tah-ui','--target','aarch64-apple-ios','--profile','ios-dev','-j','2']
if not args.check:command+=['--crate-type','staticlib']
if args.artifact_report:
 args.artifact_report=args.artifact_report.resolve()
 args.artifact_report.parent.mkdir(parents=True,exist_ok=True)
 command+=['--message-format=json-render-diagnostics']
cache=HERE/'.cache';cache.mkdir(exist_ok=True);log=cache/'tauri-native-build.log';started=time.monotonic()
native_inputs=native_input_records(provider_sources())
target=REPO/'shared/rust-bridge/target';peak_target=0;last_target_check=0.0
if shutil.disk_usage(REPO).free<12*1024**3:raise RuntimeError('Build requires 12 GiB immediate headroom')
with log.open('w')as out, (args.artifact_report.open('w') if args.artifact_report else nullcontext(out)) as cargo_output:
 proc=subprocess.Popen(command,env=env,stdout=cargo_output,stderr=out,start_new_session=True)
 try:
  while proc.poll()is None:
   if shutil.disk_usage(REPO).free<8*1024**3:raise RuntimeError('Native build space floor reached')
   if time.monotonic()-last_target_check>10:
    last_target_check=time.monotonic()
    usage=subprocess.run(['du','-sk',str(target)],capture_output=True,text=True,timeout=10,env={**os.environ,'LC_ALL':'C'})
    # Cargo 会同时清理/替换临时文件；du 仍给出有效汇总但可能因 ENOENT
    # 返回 1。只接受这一种正常竞争，权限/其他统计错误仍停止构建。
    if usage.returncode and (usage.returncode!=1 or not usage.stdout.strip()
      or any('No such file or directory' not in line for line in usage.stderr.splitlines())):
     raise RuntimeError('Unable to measure native target storage: '+usage.stderr.strip())
    peak_target=max(peak_target,int(usage.stdout.split()[0])*1024)
    if peak_target>32*1024**3:raise RuntimeError('Native target exceeded 32 GiB; inspect and prune owned obsolete outputs before retrying')
   if time.monotonic()-started>args.timeout_minutes*60:raise RuntimeError('Native build deadline reached')
   time.sleep(2)
 except BaseException as error:
  os.killpg(proc.pid,signal.SIGTERM)
  try:proc.wait(timeout=10)
  except subprocess.TimeoutExpired:os.killpg(proc.pid,signal.SIGKILL);proc.wait()
  (cache/'tauri-native-build.json').write_text(json.dumps({'exitCode':proc.returncode,'seconds':time.monotonic()-started,'peakTargetBytes':peak_target,'stopReason':str(error)})+'\n')
  raise
if proc.returncode==0 and not args.check:
 write_native_provenance(REPO/'shared/rust-bridge/target/aarch64-apple-ios/ios-dev/libalma_tah_ui_lib.a',command,native_inputs)
report={'exitCode':proc.returncode,'seconds':time.monotonic()-started,'peakTargetBytes':peak_target,'command':command,'kind':'typecheck' if args.check else 'native_build','scope':'iOS types checked against release-pinned provider forks; no archive produced' if args.check else 'Tauri native archive compiled from the release-pinned provider forks; device acceptance is recorded separately'}
(cache/'tauri-native-build.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report));print('\n'.join(log.read_text().splitlines()[-14:]));raise SystemExit(proc.returncode)
