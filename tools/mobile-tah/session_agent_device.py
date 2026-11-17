"""Drive the opted-in phone prototype through its real UI command boundary.

No provider calls run on this Mac. Commands and results are transferred through
the test App's Documents directory; never include credentials in this protocol.
"""
from pathlib import Path
import argparse
import json
import subprocess
import time
import uuid

HERE = Path(__file__).resolve().parent
APP = 'com.alma.litter.agent-probe'


class Phone:
    def __init__(self, device, output):
        self.device = device
        self.output = output
        output.mkdir(parents=True, exist_ok=True)

    def command(self, args, check=True):
        result = subprocess.run(['xcrun', 'devicectl', *args], text=True,
                                capture_output=True, timeout=60)
        if check and result.returncode:
            raise RuntimeError(result.stderr.strip() or result.stdout.strip())
        return result

    def copy(self, direction, source, destination, check=True):
        return self.command(['device', 'copy', direction, '--device', self.device,
                             '--domain-type', 'appDataContainer', '--domain-identifier', APP,
                             '--source', str(source), '--destination', str(destination)], check)

    def launch(self):
        previous = self.read_document('session-agent-automation-ready.json')
        self.command(['device', 'process', 'launch', '--device', self.device,
                      '--terminate-existing', APP, '--', '--session-agent-automation'])
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline:
            value = self.read_document('session-agent-automation-ready.json')
            if value and value.get('bootID') != (previous or {}).get('bootID'):
                return value
            time.sleep(.5)
        raise TimeoutError('Phone automation did not become ready; check foreground/unlock state')

    def read_document(self, name):
        local = self.output / name
        result = self.copy('from', 'Documents/' + name, local, check=False)
        if result.returncode:
            return None
        try:
            return json.loads(local.read_text())
        except (OSError, ValueError):
            return None

    def call(self, method, value=None, timeout=120):
        request = {'id': str(uuid.uuid4()), 'method': method, 'value': value or {}}
        local = self.output / 'request.json'
        local.write_text(json.dumps(request, ensure_ascii=False) + '\n')
        self.copy('to', local, 'Documents/session-agent-request.json')
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            response = self.read_document('session-agent-response.json')
            if response and response.get('id') == request['id']:
                (self.output / (request['id'] + '.json')).write_text(
                    json.dumps({'request': request, 'response': response}, ensure_ascii=False, indent=2) + '\n')
                if response.get('error'):
                    raise RuntimeError(response['error'])
                result = response['result']
                if isinstance(result, dict) and result.get('error') and 'sessionId' not in result:
                    raise RuntimeError(result['error'])
                return result
            time.sleep(.4)
        raise TimeoutError(f'No reply for {method}; do not replay the unknown request automatically')

    def wait(self, timeout=1800):
        started = time.monotonic()
        previous = None
        while time.monotonic() - started < timeout:
            result = self.call('agent.snapshot')
            state = (result.get('status'), len(result.get('messages', [])), len(result.get('activities', [])))
            if state != previous:
                print(json.dumps({'elapsedSeconds': round(time.monotonic() - started, 1),
                                  'status': state[0], 'messages': state[1], 'activities': state[2],
                                  'busy': result.get('busy'), 'error': result.get('error')}, ensure_ascii=False), flush=True)
                previous = state
            if not result.get('busy'):
                return result
            time.sleep(3)
        raise TimeoutError('Inference still in progress; not automatically cancelled or retried')

    def export_assets(self):
        listing = self.call('agent.assets')
        folder = self.output / 'assets'
        folder.mkdir(exist_ok=True)
        for file in listing['files']:
            path = file['path']
            if not path.startswith('assets/') or '..' in Path(path).parts:
                raise ValueError('Unexpected asset path')
            result = self.call('agent.read', {'path': path})
            destination = folder / path.removeprefix('assets/')
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(result['text'])
        return listing


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--device', default='00008101-001C25CC22D0001E')
    parser.add_argument('--output', type=Path, default=HERE / '.cache/session-agent-device')
    sub = parser.add_subparsers(dest='operation', required=True)
    sub.add_parser('launch')
    invoke = sub.add_parser('call')
    invoke.add_argument('method')
    invoke.add_argument('--value', default='{}')
    invoke.add_argument('--file', type=Path)
    invoke.add_argument('--timeout', type=float, default=120)
    wait = sub.add_parser('wait')
    wait.add_argument('--timeout', type=float, default=1800)
    sub.add_parser('export-assets')
    args = parser.parse_args()
    phone = Phone(args.device, args.output)
    if args.operation == 'launch':
        result = phone.launch()
    elif args.operation == 'call':
        result = phone.call(args.method, json.loads(args.file.read_text() if args.file else args.value), args.timeout)
    elif args.operation == 'wait':
        result = phone.wait(args.timeout)
    else:
        result = phone.export_assets()
    (args.output / 'latest.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    if isinstance(result, dict) and 'messages' in result:
        result = {key: result.get(key) for key in ['sessionId', 'threadId', 'ready', 'busy', 'status', 'error', 'model', 'effort', 'sequence']}
    print(json.dumps(result, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
