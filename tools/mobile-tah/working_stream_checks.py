"""Repeat Working stream checks with publication and UI-delivery barriers.

python3 tools/mobile-tah/working_stream_checks.py [--bundle /absolute/alma-tah.js] [--repeat 5]
The default runs three fresh journals at each of 0 and 20 ms UI ACK delay.
No models, credentials, frontend, phone, or checked-in generated files are used.
"""
from pathlib import Path
import argparse
import json
import os
import shutil
import subprocess
import tempfile
from raw_notification_checks import HERE, REPO, verify_bundle, fixture_input
from provider_sources import provider_sources


def build_bundle(temp):
    inputs = provider_sources()
    source = Path(inputs['tahRuntime'])
    build = temp / 'build'
    core = temp / 'tah-runtime'
    build.mkdir()
    core.mkdir()
    for name in ['build_bundle.mjs', 'runtime_notifications.mjs', 'provider_sources.py', 'package-lock.json']:
        shutil.copyfile(HERE / name, build / name)
    (build / 'node_modules').symlink_to(HERE / 'node_modules', target_is_directory=True)
    for name in ['platform', 'upstream', 'vendor', 'source-lock.json', 'vendor-lock.json', 'zcode-source-lock.json']:
        (core / name).symlink_to(source / name, target_is_directory=(source / name).is_dir())
    environment = dict(os.environ, TAH_RUNTIME=str(core),
                       ALMA_CODEX_REPO=inputs['providers']['codex']['repository'],
                       ALMA_KIMI_REPO=inputs['providers']['kimi']['repository'],
                       ALMA_ZCODE_REPO=inputs['providers']['zcode']['repository'])
    subprocess.run(['node', str(build / 'build_bundle.mjs')], env=environment,
                   check=True, capture_output=True, text=True, timeout=60)
    return core / 'generated/alma-tah.js'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path)
    parser.add_argument('--repeat', type=int, default=3, help='Runs per ACK delay, from 1 to 20')
    parser.add_argument('--ack-delay-ms', type=int, choices=[0, 20], action='append',
                        help='ACK delay to test; defaults to both 0 and 20 ms')
    args = parser.parse_args()
    if not 1 <= args.repeat <= 20:
        parser.error('--repeat must be between 1 and 20')
    with tempfile.TemporaryDirectory(prefix='working_stream_checks-') as directory:
        temp = Path(directory).resolve()
        bundle = args.bundle.resolve() if args.bundle else build_bundle(temp)
        sha = verify_bundle(bundle)
        isolated = json.loads(subprocess.check_output(
            ['node', str(HERE / 'working_stream_checks.mjs'), str(bundle)], text=True, timeout=120))
        frozen = temp / 'alma-tah.js'
        source = bundle.read_text()
        marker = 'globalThis.AlmaTAH=__require'
        if source.count(marker) != 1:
            raise RuntimeError('Test loader exposure must have one bundle entry seam')
        # Expose the queue in this temporary test copy. Every module body is retained.
        frozen.write_text(source.replace(marker, 'globalThis.__almaWorkingTestRequire=__require;' + marker))
        script = temp / 'working_stream_fixture.js'
        script.write_text((HERE / 'core_replay.js').read_text() + '\n' + (HERE / 'working_stream_checks.js').read_text())
        fixture = temp / 'input.json'
        value = fixture_input()
        app = REPO / 'apps/ios/Sources/AlmaTAH'
        sources = [app / 'Runtime/AlmaTAHJavaScriptHost.swift', app / 'Runtime/TAHJavaScriptBytePrimitives.swift',
                   *sorted((app / 'Persistence').glob('TAH*.swift')), HERE / 'core_replay.swift']
        binary = temp / 'working_stream_host'
        subprocess.run(['xcrun', 'swiftc', '-swift-version', '6', '-strict-concurrency=complete',
                        '-parse-as-library', *map(str, sources), '-lsqlite3', '-o', str(binary)], check=True, timeout=120)
        runs = []
        for delay in args.ack_delay_ms or [0, 20]:
            for iteration in range(args.repeat):
                fixture.write_text(json.dumps({**value, 'workingStreamACKDelayMS': delay}))
                journal = temp / f'journal-{len(runs)}'
                integrated = json.loads(subprocess.check_output(
                    [str(binary), str(frozen), str(script), str(fixture), str(journal)], text=True, timeout=90))
                assert integrated['passed'] and not integrated['modelCalls'] and not integrated['nativeProviderCalls']
                assert integrated['ackDelayMS'] == delay and integrated['inactiveRevision'] > integrated['activeRevision']
                runs.append({'iteration': iteration + 1, **integrated})
        print(json.dumps({'passed': True, 'bundleSHA256': sha, 'isolated': isolated,
                          'integrated': runs[-1], 'integratedRuns': runs}, indent=2))


if __name__ == '__main__':
    main()
