"""Bounded control/collection for the disposable background probe, never a debugger.

No periodic device polling is started: collect after meaningful intervals so
host traffic is not mistaken for an unattended background execution test.
"""
from pathlib import Path
import argparse, json, os, subprocess, time, uuid

HERE = Path(__file__).resolve().parent
LAB = HERE.parent
BUNDLE = "com.alma.litter.background-probe"
CURRENT = LAB / ".cache/current-background-run.json"


def ctl(args):
    r = subprocess.run(["xcrun", "devicectl", *args], capture_output=True, text=True, timeout=35)
    if r.returncode:
        raise RuntimeError((r.stderr + r.stdout)[-1500:])


def main():
    p = argparse.ArgumentParser()
    p.add_argument("action", choices=["start", "sample", "home", "lock", "collect"])
    p.add_argument("--mode", choices=["continuous", "quiet", "quiet-indeterminate"], default="continuous")
    p.add_argument("--cycles", type=int, default=120)
    p.add_argument("--workload", choices=["mixed", "node"], default="mixed")
    p.add_argument("--device", default=os.environ.get("ALMA_IOS_DEVICE"))
    a = p.parse_args()
    if a.action in ["home", "lock"]:
        p.error("Use the device UI to background or lock it; the historical shared-RSD HID route is disabled")
    if not a.device:p.error("Supply --device or ALMA_IOS_DEVICE")
    if a.action == "start":
        run = str(uuid.uuid4())
        out = LAB / "results/background" / run
        out.mkdir(parents=True)
        ctl(["device", "process", "launch", "--device", a.device, "--terminate-existing", BUNDLE,
             "--json-output", str(out / "launch.json"), "--run", "--run-id", run,
             "--cycles", str(a.cycles), "--mode", a.mode,"--workload",a.workload])
        j = json.loads((out / "launch.json").read_text())
        state = dict(runID=run, directory=str(out), pid=j["result"]["process"]["processIdentifier"],
                     mode=a.mode, workload=a.workload, cycles=a.cycles, startedHostUnix=time.time())
        CURRENT.write_text(json.dumps(state, indent=2) + "\n")
        print(json.dumps(state), flush=True)
        return
    state = json.loads(CURRENT.read_text())
    out = Path(state["directory"])
    names = ["background-status.json"]
    if a.action == "collect":
        names += [f"background-{state['runID']}.json", f"background-{state['runID']}.log"]
    for name in names:
        ctl(["device", "copy", "from", "--device", a.device, "--domain-type", "appDataContainer",
             "--domain-identifier", BUNDLE, "--source", "Documents/"+name,
             "--destination", str(out/name), "--timeout", "15"])
    j = json.loads((out/"background-status.json").read_text())
    if j["runID"] != state["runID"]:
        raise RuntimeError("Report belongs to a previous run")
    print(json.dumps({k:v for k,v in j.items() if k!="events"}), flush=True)
    print(json.dumps(j["events"][-5:]), flush=True)


if __name__ == "__main__":
    main()
