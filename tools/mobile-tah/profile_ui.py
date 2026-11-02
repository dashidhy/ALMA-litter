"""Bounded, read-only iPhone UI metrics; never launches/stops the target App."""
from pathlib import Path
import argparse, json, os, statistics, subprocess, time
p=argparse.ArgumentParser();p.add_argument('--label',required=True);p.add_argument('--seconds',type=int,default=30);p.add_argument('--udid',default=os.environ.get('ALMA_IOS_DEVICE'),required=not os.environ.get('ALMA_IOS_DEVICE'));a=p.parse_args()
if not 5<=a.seconds<=60:raise SystemExit('Use 5–60 seconds')
if not a.label.replace('-','').replace('_','').isalnum():raise SystemExit('Use a simple label')
root=Path(__file__).resolve().parents[2];cache=Path(__file__).resolve().parent/'.cache';cache.mkdir(exist_ok=True)
exe=root/'tools/alma-ios-lab/.cache/device-tools/bin/pymobiledevice3';env=dict(os.environ,PYMOBILEDEVICE3_UDID=a.udid,PYTHONUNBUFFERED='1')
raw=cache/(a.label+'-fps.jsonl');errors=cache/(a.label+'-fps.err')
with raw.open('w') as out,errors.open('w') as err:
 proc=subprocess.Popen([str(exe),'developer','dvt','fps','--userspace'],stdout=out,stderr=err,env=env)
 try:proc.wait(timeout=a.seconds+2)
 except subprocess.TimeoutExpired:
  proc.terminate();proc.wait(timeout=8)
values=[]
for line in raw.read_text().splitlines():
 try:values.append(json.loads(line)['fps'])
 except (ValueError,KeyError):pass
report={'label':a.label,'scope':'Core Animation display FPS; interpret only with foreground App and workload/scroll context','sampleCount':len(values),'fps':{'min':min(values),'max':max(values),'median':statistics.median(values),'mean':statistics.mean(values)}if values else None,'appRestarted':False}
(cache/(a.label+'-metrics.json')).write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
