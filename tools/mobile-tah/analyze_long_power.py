"""Clip device power samples to actual phone qualification/revision intervals."""
import argparse
from datetime import datetime
import json
from pathlib import Path
import xml.etree.ElementTree as ET

from summarize_power_exports import rows


def epoch(value):
    return datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp()


def power_interval(samples, start, end):
    durations, integral, count = 0.0, 0.0, 0
    for sample in samples:
        if sample.get('power-usage') is None:
            continue
        left = max(start, float(sample['start']) / 1e9)
        right = min(end, (float(sample['start']) + float(sample['duration'])) / 1e9)
        seconds = max(0, right - left)
        if seconds:
            durations += seconds
            integral += seconds * float(sample['power-usage'])
            count += 1
    return {'intervalSeconds': end - start, 'observedSeconds': durations, 'samples': count,
            'wholeDevicePercentPerHour': integral / durations if durations else None,
            'estimatedBatteryPercentagePoints': integral / 3600}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', required=True, type=Path)
    args = parser.parse_args()
    report = json.loads((args.run / 'qualification.json').read_text())
    validation = json.loads((args.run / 'validation.json').read_text())
    toc = ET.parse(args.run / 'toc.xml').getroot()
    summary = toc.find('run/info/summary')
    origin = epoch(summary.findtext('start-date'))
    trace_seconds = float(summary.findtext('duration'))
    phone_origin = epoch(report['startedAt'])
    raw_start = next(s['elapsedSeconds'] for s in report['steps'] if s['stage'] == 'raw_check')
    bounds = [('whole_workflow', phone_origin + raw_start, phone_origin + report['elapsedSeconds'])]
    for revision in validation['revisions']:
        bounds.append((f"v{revision['revision']}", epoch(revision['startedAt']), epoch(revision['endedAt'])))
        stages = revision.get('stages', [])
        for index, stage in enumerate(stages):
            if stage['phase'] not in ['actor', 'extra_guardian']:
                continue
            end = stages[index + 1]['at'] if index + 1 < len(stages) else revision['endedAt']
            bounds.append((f"v{revision['revision']}_{stage['phase']}", epoch(stage['at']), epoch(end)))
    if validation['revisions']:
        bounds.append(('raw_and_action_setup', phone_origin + raw_start, epoch(validation['revisions'][0]['startedAt'])))
    power = rows(args.run / 'SystemPowerLevel.xml')
    thermal = rows(args.run / 'device-thermal-state-intervals.xml')
    charging = rows(args.run / 'DeviceChargingState.xml')
    intervals = {}
    for name, left, right in bounds:
        start, end = max(0, left - origin), min(trace_seconds, right - origin)
        if end <= start:
            continue
        result = power_interval(power, start, end)
        result.update(startSecondsInTrace=start, endSecondsInTrace=end,
                      taskIntervalSeconds=right - left,
                      thermalStates=sorted({r['thermal-state'] for r in thermal
                          if float(r['start']) / 1e9 < end and (float(r['start']) + float(r['duration'])) / 1e9 > start}),
                      chargingOverlapSeconds=sum(max(0, min(end, (float(r['start']) + float(r['duration'])) / 1e9) - max(start, float(r['start']) / 1e9)) for r in charging))
        intervals[name] = result
    energy = [x for x in report.get('energySamples', []) if x['elapsedSeconds'] >= raw_start]
    output = {'provider': report['providerID'], 'intervals': intervals,
              'nativeBattery': {'firstPercent': energy[0].get('batteryPercent') if energy else None,
                                'lastPercent': energy[-1].get('batteryPercent') if energy else None,
                                'states': sorted({x['batteryState'] for x in energy}),
                                'lowPowerModes': sorted({x['lowPowerMode'] for x in energy}),
                                'sampleCount': len(energy),
                                'scope': 'Coarse system-reported battery levels; not used to derive hourly power'},
              'scope': 'Instrument-estimated whole-device energy, including display/system. Samples clipped to actual task bounds; not app-only power or a controlled cross-provider A/B test.'}
    (args.run / 'power-analysis.json').write_text(json.dumps(output, indent=2) + '\n')
    print(json.dumps(output, indent=2))


if __name__ == '__main__':
    main()
