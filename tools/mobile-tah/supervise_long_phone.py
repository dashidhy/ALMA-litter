"""Observe a phone-owned NVIDIA qualification and attach power-only recording.

No role/model dispatch occurs on Mac. The explicit App launch flag starts the
existing phone controller fixture. Reports contain only progress/energy metadata.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil
import signal
import subprocess
import time
import xml.etree.ElementTree as ET

from summarize_power_exports import rows


def utc():
    return datetime.now(timezone.utc).isoformat()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--provider', choices=['codex', 'kimi', 'zcode'], required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--device', default='00008101-001C25CC22D0001E')
    parser.add_argument('--no-power', action='store_true', help='Functional qualification without Instruments')
    parser.add_argument('--power-template', default='Power Profiler', help='Verified Instruments template name or path')
    parser.add_argument('--max-minutes', type=int, default=120, help='Bound the recording/observer, not an individual model request')
    args = parser.parse_args()
    if not 1 <= args.max_minutes <= 120:
        parser.error('--max-minutes must be between 1 and 120')
    out = args.output.resolve()
    out.mkdir(parents=True, mode=0o700, exist_ok=True)
    trace = out / 'power.trace'
    if trace.exists():
        raise SystemExit('Use a new output directory; existing evidence is immutable')
    if shutil.disk_usage(out).free < 12 * 1024**3:
        raise SystemExit('Insufficient build-machine headroom')
    started = time.time()
    command = ['xcrun', 'xctrace', 'record', '--template', args.power_template, '--instrument', 'Thermal State',
               '--device', args.device, '--time-limit', f'{args.max_minutes}m', '--output', str(trace),
               '--launch', '--', 'com.alma.litter.agent-probe', '--mobile-tah-long-qualification',
               '--mobile-tah-reuse-auth-only', f'--mobile-tah-expected-provider={args.provider}']
    if args.no_power:
        command = ['xcrun', 'devicectl', 'device', 'process', 'launch', '--device', args.device,
                   '--terminate-existing', 'com.alma.litter.agent-probe', '--', '--mobile-tah-long-qualification',
                   '--mobile-tah-reuse-auth-only', f'--mobile-tah-expected-provider={args.provider}']
    common = ['xcrun', 'devicectl', 'device', 'copy', 'from', '--device', args.device,
              '--domain-type', 'appDataContainer', '--domain-identifier', 'com.alma.litter.agent-probe']
    report_path = out / 'qualification.json'
    evidence = {'provider': args.provider, 'startedAt': utc(), 'scope': 'phone-owned Core; Instruments template contents recorded separately',
                'powerTemplate': None if args.no_power else args.power_template, 'maxMinutes': args.max_minutes,
                'status': 'running', 'observations': []}
    if args.no_power:
        evidence['scope'] = 'phone-owned functional qualification; native battery/thermal samples only, no Instruments power claim'

    def save():
        (out / 'supervisor.json').write_text(json.dumps(evidence, indent=2) + '\n')

    with (out / ('launch.log' if args.no_power else 'xctrace.log')).open('w') as log:
        process = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        (out / 'recorder-pid.txt').write_text(str(process.pid))
        save()
        try:
            while time.time() - started < args.max_minutes * 60:
                try:
                    result = subprocess.run(common + ['--source', 'Documents/mobile-tah-long-qualification.json',
                                            '--destination', str(report_path)], capture_output=True, timeout=25)
                except subprocess.TimeoutExpired:
                    result = None
                    evidence['readTimeouts'] = evidence.get('readTimeouts', 0) + 1
                if result is not None and result.returncode == 0:
                    report_path.chmod(0o600)
                    report = json.loads(report_path.read_text())
                    stamp = datetime.fromisoformat(report['startedAt'].replace('Z', '+00:00')).timestamp()
                    if stamp >= started - 5:
                        state = report.get('steps', [{}])[-1].get('state', {})
                        energy = report.get('energySamples', [{}])[-1]
                        observation = {'at': utc(), 'status': report['status'], 'stage': report['stage'],
                                       'elapsedSeconds': report['elapsedSeconds'], 'provider': report.get('providerID'),
                                       'model': report.get('modelID'), 'phase': state.get('phase'),
                                       'acceptedRevisions': state.get('acceptedRevisions'), 'energy': energy}
                        evidence['observations'].append(observation)
                        print(json.dumps(observation, ensure_ascii=False), flush=True)
                        if report.get('providerID') not in [None, args.provider]:
                            evidence['status'] = 'wrong_provider'; break
                        if report['status'] != 'running':
                            evidence['status'] = report['status']
                            evidence['workflowMayStillBeRunning'] = report.get('workflowMayStillBeRunning', False)
                            break
                if not evidence['observations'] and time.time() - started > 180:
                    evidence['status'] = 'qualification_not_started'; break
                if args.no_power and process.poll() not in [None, 0]:
                    evidence['status'] = 'launch_failed'; break
                if not args.no_power and process.poll() is not None:
                    evidence['status'] = 'recorder_ended_before_qualification'; break
                if shutil.disk_usage(out).free < 8 * 1024**3:
                    evidence['status'] = 'host_storage_guard'; break
                size = subprocess.run(['du', '-sk', str(trace)], capture_output=True, text=True)
                if size.returncode == 0 and int(size.stdout.split()[0]) > 2 * 1024**2:
                    evidence['status'] = 'trace_size_guard'; break
                save()
                time.sleep(45)
            else:
                evidence['status'] = 'observer_time_limit'
        except (Exception, KeyboardInterrupt) as error:
            evidence['status'] = 'observer_error'
            evidence['errorType'] = type(error).__name__
        finally:
            if process.poll() is None:
                process.send_signal(signal.SIGINT)
                # 长 trace 的建模/落盘可能超过一分钟，父进程退出会让执行器
                # 回收尚在保存的子进程。分段等待并持续报告，保留进程所有权。
                finalize_deadline = time.monotonic() + 300
                while process.poll() is None and time.monotonic() < finalize_deadline:
                    try:
                        process.wait(timeout=45)
                    except subprocess.TimeoutExpired:
                        print(json.dumps({'status': evidence['status'], 'phase': 'trace_finalizing'}), flush=True)
                if process.poll() is None:
                    evidence['traceFinalization'] = 'still_running'
            evidence['recorderExitCode'] = process.poll()
            evidence['endedAt'] = utc()
            save()
    if args.no_power:
        print(json.dumps({'status': evidence['status'], 'report': str(out / 'supervisor.json')}), flush=True)
        return 0 if evidence['status'] == 'completed' else 1
    if process.poll() is None:
        print(json.dumps({'status': evidence['status'], 'traceFinalization': 'still_running'}), flush=True)
        return 2
    toc = out / 'toc.xml'
    export = subprocess.run(['xcrun', 'xctrace', 'export', '--input', str(trace), '--toc', '--output', str(toc)], capture_output=True, timeout=60)
    if export.returncode == 0:
        root = ET.parse(toc).getroot()
        schemas = {x.get('schema') for x in root.findall('run/data/table')}
        for schema in ['SystemPowerLevel', 'DeviceChargingState', 'device-thermal-state-intervals']:
            if schema not in schemas:
                continue
            path = out / (schema + '.xml')
            subprocess.run(['xcrun', 'xctrace', 'export', '--input', str(trace), '--xpath',
                            f'/trace-toc/run[@number="1"]/data/table[@schema="{schema}"]', '--output', str(path)],
                           check=True, capture_output=True, timeout=60)
        power = rows(out / 'SystemPowerLevel.xml')
        valid = [r for r in power if r.get('power-usage') is not None and float(r['duration']) > 0]
        duration = sum(float(r['duration']) for r in valid)
        evidence['power'] = {'observedSeconds': duration / 1e9, 'samples': len(valid),
                             'wholeDevicePercentPerHour': sum(float(r['duration']) * float(r['power-usage']) for r in valid) / duration if duration else None,
                             'brightnessPercent': sorted({float(r['display-brightness']) for r in valid if r.get('display-brightness') is not None}),
                             'scope': 'unclipped full trace; includes initial waiting and final observation lag'}
        save()
    print(json.dumps({'status': evidence['status'], 'report': str(out / 'supervisor.json'), 'power': evidence.get('power')}, ensure_ascii=False), flush=True)
    return 0 if evidence['status'] == 'completed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
