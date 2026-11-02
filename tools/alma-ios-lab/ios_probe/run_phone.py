"""Launch only the disposable iSH test app, collect results, confirm its exit."""
from pathlib import Path
import argparse,json,subprocess,time,uuid

HERE=Path(__file__).resolve().parent
CTL='/Library/Developer/PrivateFrameworks/CoreDevice.framework/Versions/A/Resources/bin/devicectl'
BUNDLE='com.alma.frontier.ish-tools'


def ctl(args,timeout=25):
    p=subprocess.run([CTL,*args],capture_output=True,text=True,timeout=timeout)
    if p.returncode:raise RuntimeError(p.stderr[-2000:]+p.stdout[-2000:])


def main():
    p=argparse.ArgumentParser();p.add_argument('--device',required=True);a=p.parse_args()
    run=str(uuid.uuid4());out=HERE.parent/'results/iphone'/run;out.mkdir(parents=True)
    launch=out/'launch.json'
    ctl(['device','process','launch','--device',a.device,'--terminate-existing',BUNDLE,
         '--json-output',str(launch),'--run','--run-id',run])
    response=json.loads(launch.read_text());pid=response['result']['process']['processIdentifier']
    print(json.dumps({'runID':run,'pid':pid,'output':str(out)}),flush=True)
    began=time.monotonic();last_phase=None;result=None
    def copy(remote,local):
        ctl(['device','copy','from','--device',a.device,'--domain-type','appDataContainer',
             '--domain-identifier',BUNDLE,'--source','Documents/'+remote,'--destination',str(local),'--timeout','10'])
    def alive():
        path=out/'process-check.json'
        ctl(['device','info','processes','--device',a.device,'--json-output',str(path),'--timeout','10'])
        data=json.loads(path.read_text());found=any(x.get('processIdentifier')==pid for x in data['result']['runningProcesses'])
        path.unlink()  # Do not retain inventories of unrelated phone processes.
        return found
    try:
        while time.monotonic()-began<630:
            try:
                copy('status.json',out/'status.json')
                s=json.loads((out/'status.json').read_text())
                if s.get('runID')==run:
                    result=s
                    if s.get('phase')!=last_phase:
                        print(json.dumps({'phase':s.get('phase'),'seconds':s.get('elapsedSeconds'),
                              'completedCases':len(s.get('cases',[])),'footprintMiB':round(s.get('footprintBytes',0)/1048576,1)}),flush=True)
                        last_phase=s.get('phase')
                    if s['phase'] in ['completed','failed','stopped']:break
            except (RuntimeError,FileNotFoundError,json.JSONDecodeError):pass
            if not alive():
                print('Test process exited before a terminal report',flush=True);break
            time.sleep(3)
    finally:
        for name in [f'report-{run}.json',f'stderr-{run}.log']:
            try:copy(name,out/name)
            except RuntimeError:pass
        time.sleep(1)
        is_alive=alive()
        if is_alive:
            ctl(['device','process','signal','--device',a.device,'--pid',str(pid),'--signal','SIGKILL','--timeout','10'])
            time.sleep(1)
        ended=not alive()
        receipt={'runID':run,'pid':pid,'processEnded':ended,'hostStoppedProcess':is_alive,
                 'lastPhase':result.get('phase') if result else None,'seconds':time.monotonic()-began}
        (out/'collection.json').write_text(json.dumps(receipt,indent=2)+'\n')
        print(json.dumps(receipt),flush=True)


if __name__=='__main__':main()
