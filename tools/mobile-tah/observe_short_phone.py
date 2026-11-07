"""Launch the existing phone-owned short fixture and observe its bounded report."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import time

p = argparse.ArgumentParser()
p.add_argument('--provider', choices=['codex', 'kimi', 'zcode'], required=True)
p.add_argument('--output', type=Path, required=True)
p.add_argument('--resume', action='store_true')
a = p.parse_args()
a.output.mkdir(mode=0o700, parents=True, exist_ok=a.resume)
device = '00008101-001C25CC22D0001E'
bundle = 'com.alma.litter.agent-probe'
start = time.time()
log = {'provider': a.provider, 'startedAt': datetime.now(timezone.utc).isoformat(),
       'scope': 'Existing phone-owned short qualification; no power trace', 'observations': []}
if not a.resume:
    launch = subprocess.run(['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', device,
                         '--terminate-existing', bundle, '--', '--mobile-tah-qualification',
                         '--mobile-tah-reuse-auth-only', f'--mobile-tah-expected-provider={a.provider}'],
                        capture_output=True, text=True, timeout=60)
    (a.output / 'launch.log').write_text(launch.stdout + launch.stderr)
    (a.output / 'launch-time.json').write_text(json.dumps({'unix': start}))
    launch.check_returncode()
else:
    start = json.loads((a.output / 'launch-time.json').read_text())['unix']
last = None
try:
    while time.time() - start < 1800:
        result = subprocess.run(['xcrun', 'devicectl', 'device', 'copy', 'from', '--device', device,
                                 '--domain-type', 'appDataContainer', '--domain-identifier', bundle,
                                 '--source', 'Documents/mobile-tah-qualification.json',
                                 '--destination', str(a.output / 'qualification.json')],
                                capture_output=True, timeout=30)
        if result.returncode == 0:
            r = json.loads((a.output / 'qualification.json').read_text())
            fresh = bool(r.get('startedAt')) and datetime.fromisoformat(r['startedAt'].replace('Z', '+00:00')).timestamp() >= start - 3
            if fresh:
                state = r.get('steps', [{}])[-1].get('state', {})
                item = {'at': datetime.now(timezone.utc).isoformat(), 'status': r['status'],
                        'stage': r['stage'], 'provider': r.get('providerID'),
                        'elapsedSeconds': r['elapsedSeconds'], 'state': state}
                log['observations'].append(item)
                if (item['stage'], item['status'], state) != last:
                    print(json.dumps(item), flush=True)
                    last = (item['stage'], item['status'], state)
                log['status'] = r['status']
                (a.output / 'observer.json').write_text(json.dumps(log, indent=2) + '\n')
                if r.get('providerID') not in (None, a.provider):
                    log['status'] = 'wrong_provider'; break
                if r['status'] != 'running': break
        time.sleep(20)
    else: log['status'] = 'observer_timeout_workflow_may_still_run'
finally:
    log['endedAt'] = datetime.now(timezone.utc).isoformat()
    (a.output / 'observer.json').write_text(json.dumps(log, indent=2) + '\n')
print(json.dumps({'status': log.get('status'), 'output': str(a.output)}), flush=True)

raise SystemExit(0 if log.get("status") == "completed" else 1)
