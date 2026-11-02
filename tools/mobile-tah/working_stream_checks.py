"""Build and test Working streams, using the unchanged replay build/host helpers.

python3 tools/mobile-tah/working_stream_checks.py [--bundle /absolute/alma-tah.js]
No models, credentials, frontend, phone, or checked-in generated files are used.
"""
from pathlib import Path
import argparse
import json
import shutil
import subprocess
import tempfile
from raw_notification_checks import HERE, REPO, build_bundle, verify_bundle, fixture_input


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--bundle', type=Path)
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix='working_stream_checks-') as directory:
        temp = Path(directory).resolve()
        bundle = args.bundle.resolve() if args.bundle else build_bundle(temp)
        sha = verify_bundle(bundle)
        isolated = json.loads(subprocess.check_output(
            ['node', str(HERE / 'working_stream_checks.mjs'), str(bundle)], text=True, timeout=120))
        frozen = temp / 'alma-tah.js'
        shutil.copyfile(bundle, frozen)
        script = temp / 'working_stream_fixture.js'
        script.write_text((HERE / 'core_replay.js').read_text() + '\n' + (HERE / 'working_stream_checks.js').read_text())
        fixture = temp / 'input.json'
        fixture.write_text(json.dumps(fixture_input()))
        app = REPO / 'apps/ios/Sources/AlmaTAH'
        sources = [app / 'Runtime/AlmaTAHJavaScriptHost.swift', app / 'Runtime/TAHJavaScriptBytePrimitives.swift',
                   *sorted((app / 'Persistence').glob('TAH*.swift')), HERE / 'core_replay.swift']
        binary = temp / 'working_stream_host'
        subprocess.run(['xcrun', 'swiftc', '-swift-version', '6', '-strict-concurrency=complete',
                        '-parse-as-library', *map(str, sources), '-lsqlite3', '-o', str(binary)], check=True, timeout=120)
        integrated = json.loads(subprocess.check_output([str(binary), str(frozen), str(script), str(fixture),
                                                        str(temp / 'journal')], text=True, timeout=90))
        assert integrated['passed'] and not integrated['modelCalls'] and not integrated['nativeProviderCalls']
        print(json.dumps({'passed': True, 'bundleSHA256': sha, 'isolated': isolated, 'integrated': integrated}, indent=2))


if __name__ == '__main__':
    main()
