"""Run only the disposable fixed-script V8 probe; never touch accounts/models."""
from pathlib import Path
import argparse, json, os, subprocess, time, uuid

HERE=Path(__file__).resolve().parent
TOOL=HERE.parent/'.cache/device-tools/bin/pymobiledevice3'
BUNDLE='com.alma.litter.v8-probe'

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--udid',required=True);args=parser.parse_args()
    run=str(uuid.uuid4());out=HERE/'results'/run;out.mkdir(parents=True)
    env=dict(os.environ,PYMOBILEDEVICE3_UDID=args.udid,NO_COLOR='1',TERM='dumb')
    for key in ['PYMOBILEDEVICE3_NATIVE','PYMOBILEDEVICE3_TUNNEL','PYMOBILEDEVICE3_RSD']:
        env.pop(key,None)
    def call(arguments,timeout=20):
        result=subprocess.run([str(TOOL),*arguments],env=env,capture_output=True,text=True,timeout=timeout)
        if result.returncode:raise RuntimeError(result.stderr[-1200:])
        return result.stdout
    launch=call(['developer','core-device','launch-application','--userspace','--kill-existing',BUNDLE,'--','--run','--run-id',run],45)
    launch=json.loads(launch);pid=launch['processToken']['processIdentifier']
    (out/'launch.json').write_text(json.dumps({'pid':pid,'bundle':BUNDLE,'runID':run},indent=2)+'\n')
    print(json.dumps({'runID':run,'pid':pid,'output':str(out)}),flush=True)
    started=time.monotonic();phase=None;report=None
    while time.monotonic()-started<95:
        try:
            call(['apps','pull','--udid',args.udid,BUNDLE,'Documents/status.json',str(out/'status.json')])
            value=json.loads((out/'status.json').read_text())
            if value.get('runID')==run:
                report=value
                if value['phase']!=phase:
                    print(json.dumps({'phase':value['phase'],'seconds':value['elapsedSeconds'],'cases':len(value['cases'])}),flush=True)
                    phase=value['phase']
                if phase in ['completed','failed','stopped']:break
        except (RuntimeError,FileNotFoundError,json.JSONDecodeError):pass
        time.sleep(1)
    for name in [f'report-{run}.json',f'stderr-{run}.log']:
        try:call(['apps','pull','--udid',args.udid,BUNDLE,'Documents/'+name,str(out/name)])
        except RuntimeError:pass
    time.sleep(1)
    inventory=json.loads(call(['developer','core-device','list-processes','--userspace'],30))
    def contains_pid(value):
        if isinstance(value,dict):
            return any((key in ('processIdentifier','pid') and item==pid) or contains_pid(item) for key,item in value.items())
        return isinstance(value,list) and any(contains_pid(item) for item in value)
    alive=contains_pid(inventory)
    # Do not save inventories of unrelated processes. An unexpectedly live probe
    # is reported, not silently relabelled as a clean shutdown.
    receipt={'runID':run,'pid':pid,'processEnded':not alive,'lastPhase':phase,
             'passed':bool(report and report.get('summary',{}).get('allExpectationsMatched'))}
    (out/'collection.json').write_text(json.dumps(receipt,indent=2)+'\n');print(json.dumps(receipt),flush=True)
    return 0 if receipt['passed'] and not alive else 1

if __name__=='__main__':raise SystemExit(main())
