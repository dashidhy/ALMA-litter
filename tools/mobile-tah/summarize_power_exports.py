#!/usr/bin/env python3
"""Summarize saved xctrace power XML exports; no device or model operations.

Export each selected run's SystemPowerLevel, SystemThermalState and
DeviceChargingState to power-run<N>-<Schema>.xml in --data-dir first.
The output is whole-device, duration-weighted power for observed intervals,
not an app-only battery-drain measurement. Preserve collection conditions.
"""
import argparse
import json
from pathlib import Path
import xml.etree.ElementTree as ET


def rows(path):
    root = ET.parse(path).getroot()
    schema = root.find('.//schema')
    if schema is None:
        raise ValueError(f'Missing exported schema: {path.name}')
    names = [column.findtext('mnemonic') for column in schema.findall('col')]
    references = {e.attrib['id']: e for e in root.iter() if 'id' in e.attrib}
    result = []
    for row in root.findall('.//row'):
        if len(row) != len(names):
            raise ValueError(f'Unexpected row shape: {path.name}')
        fields = {}
        for name, value in zip(names, row):
            if 'ref' in value.attrib:
                value = references[value.attrib['ref']]
            fields[name] = None if value.tag == 'sentinel' else value.text
        result.append(fields)
    return result


def summarize(toc, directory, run):
    summary = toc.find(f'run[@number="{run}"]/info/summary')
    if summary is None:
        raise ValueError(f'Missing run {run}')
    power = rows(directory / f'power-run{run}-SystemPowerLevel.xml')
    valid = [r for r in power if r['power-usage'] is not None and float(r['duration']) > 0]
    if not valid:
        raise ValueError(f'No power samples for run {run}')
    observed_ns = sum(float(r['duration']) for r in valid)
    mean = sum(float(r['duration']) * float(r['power-usage']) for r in valid) / observed_ns
    thermal = rows(directory / f'power-run{run}-SystemThermalState.xml')
    charging = rows(directory / f'power-run{run}-DeviceChargingState.xml')
    return {
        'run': run, 'start': summary.findtext('start-date'), 'end': summary.findtext('end-date'),
        'traceDurationSeconds': float(summary.findtext('duration')),
        'observedPowerSeconds': observed_ns / 1e9, 'powerSamples': len(valid),
        'systemPowerPercentPerHour': mean,
        'displayBrightnessPercent': sorted({float(r['display-brightness']) for r in valid if r.get('display-brightness') is not None}),
        'thermalStates': sorted({r['thermal-state'] for r in thermal}),
        'chargerConnectedIntervalCount': len(charging),
        'scope': 'whole-device short-window duration-weighted power; not app-only energy',
        'chargingEvidence': 'No connected intervals must be corroborated with device/UI and unplug confirmation; absence alone is not proof.',
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--toc', type=Path, required=True)
    parser.add_argument('--data-dir', type=Path, required=True)
    parser.add_argument('--runs', type=int, nargs='+', required=True)
    args = parser.parse_args()
    toc = ET.parse(args.toc).getroot()
    print(json.dumps([summarize(toc, args.data_dir, run) for run in args.runs], indent=2))


if __name__ == '__main__':
    main()
