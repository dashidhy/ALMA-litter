#!/usr/bin/env python3
"""Read-only real JSCore RPC bench; no bundle rebuild, device, credentials or models.

python3 tools/mobile-tah/run_jscore_rpc_bench.py
JSC_useJIT=false python3 tools/mobile-tah/run_jscore_rpc_bench.py
--jit both compares fresh processes; default honors JSC_useJIT, otherwise compares both.
--native-bytes off (default) preserves the JS codec baseline; on enables native codecs.
JSC_useJIT=false python3 tools/mobile-tah/run_jscore_rpc_bench.py --native-bytes both --no-instrument
Native A/B uses one binary, frozen config/bundle, and copies of one database snapshot.
Requires the Host's enableNativeBytePrimitives parameter and TAHJavaScriptBytePrimitives.swift.
Detailed per-read statistics are under .cache/jscore-rpc-bench-*/report.json.
Only the two benchmark sources and .cache are written. Database and WAL are copied
as bytes BEFORE SQLite opens anything. No SQLite connection ever opens the source.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import re
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
CORE = ROOT / 'shared/tah-runtime'
CACHE = HERE / '.cache'


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def bounded(value):
    number = int(value)
    if not 1 <= number <= 5:
        raise argparse.ArgumentTypeError('must be 1..5')
    return number


def snapshot(source, destination):
    destination.mkdir()
    # Ignore source SHM (rebuild on the disposable copy); retain committed WAL pages.
    paths = [source] + ([Path(str(source) + '-wal')] if Path(str(source) + '-wal').exists() else [])
    before = {p.name: digest(p) for p in paths}
    for p in paths:
        shutil.copyfile(p, destination / p.name)
    if before != {p.name: digest(p) for p in paths} or before != {p.name: digest(destination / p.name) for p in paths}:
        raise RuntimeError('source_changed_during_copy')
    with sqlite3.connect(destination / 'tah.sqlite3') as db:
        if db.execute('PRAGMA quick_check').fetchone() != ('ok',):
            raise RuntimeError('copied_database_invalid')
        db.execute('PRAGMA wal_checkpoint(TRUNCATE)')
    return before


def inventory(path, maximum):
    # Metadata selection only; no titles, transcript text, account records or credentials.
    with sqlite3.connect(f'{path.as_uri()}?mode=ro', uri=True) as db:
        operations = dict(db.execute('SELECT operation_id,stream_id FROM events'))
        rows = db.execute('''SELECT json_extract(e.payload,'$.id'),
            json_extract(e.payload,'$.transcriptID'),json_extract(e.payload,'$.materialID'),
            coalesce((SELECT sum(length(payload)) FROM events WHERE stream_id='action/'||json_extract(e.payload,'$.id')),0),
            coalesce((SELECT sum(length(payload)) FROM events WHERE stream_id='operation/'||json_extract(e.payload,'$.id')),0),
            s.rowid FROM streams s JOIN events e ON e.stream_id=s.id AND e.version=s.version
            WHERE s.id LIKE 'meta/%' AND s.deleted=0 ORDER BY s.rowid DESC''').fetchall()
        cases = [dict(zip(['actionID', 'transcriptID', 'materialID', 'actionJournalBytes', 'operationJournalBytes', 'position'], row)) for row in rows[:maximum]]
        if not cases or any(not all(c[k] for k in ('actionID', 'transcriptID', 'materialID')) for c in cases):
            raise RuntimeError('no_valid_action_metadata')
        summary = {'actionCount': len(rows), 'selectedNewestActions': len(cases),
                   'events': db.execute('SELECT count(*) FROM events').fetchone()[0],
                   'payloadBytes': db.execute('SELECT coalesce(sum(length(payload)),0) FROM events').fetchone()[0]}
    return cases, operations, summary


def logical_digest(path):
    # Hash all table rows, including pending/chunks, without emitting private data.
    h = hashlib.sha256()
    with sqlite3.connect(f'{path.as_uri()}?mode=ro', uri=True) as db:
        names = [r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")]
        for name in names:
            h.update(name.encode())
            for row in db.execute('SELECT * FROM "' + name.replace('"', '""') + '" ORDER BY rowid'):
                for value in row:
                    data = value if isinstance(value, bytes) else repr(value).encode()
                    h.update(len(data).to_bytes(8, 'big')); h.update(data)
    return h.hexdigest()


def config():
    prompts = CORE / 'upstream/prompts'
    profile = json.loads((CORE / 'upstream/providers/codex/app-profile.json').read_text())
    profile['profileIdentity'] = '1' * 64  # synthetic; never loads actual credential/profile state
    files = {'actorPromptTemplate': 'actor_prompt_v4_2.txt', 'rawGuardianPrompt': 'safety_guardian_raw_prompt_v0_3.txt',
             'extraGuardianPrompt': 'safety_guardian_extra_prompt_v0_6.txt', 'safetyPolicy': 'safety_guardian_policy_v0_2.txt'}
    return {'profiles': [profile], 'resources': {k: (prompts / 'system_prompts' / v).read_text() for k, v in files.items()},
            'actionInstructions': (prompts / 'action_instructions/structured_notes_v4_3.txt').read_text()}


def run(command, env, timeout, code):
    try:
        p = subprocess.run(command, env=env, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise RuntimeError(code + '_timeout') from None
    if p.returncode:
        # Compiler diagnostics contain source paths but no journal data. Runtime errors suppressed.
        if code == 'compile':
            sys.stderr.write(p.stderr[-12000:])
        else:
            # JSC_dumpOptions emits diagnostics before the benchmark's safe error line.
            for line in reversed(p.stderr.splitlines()):
                try:
                    safe = json.loads(line)
                    if (isinstance(safe, dict) and list(safe) == ['error']
                            and isinstance(safe['error'], str)
                            and all(c.isalnum() or c == '_' for c in safe['error'])):
                        sys.stderr.write(json.dumps(safe) + '\n')
                        break
                except (ValueError, TypeError):
                    pass
        raise RuntimeError(code + '_failed')
    return p


def summarize(result):
    rows = []
    for method in sorted({s['method'] for s in result['samples']}):
        samples = [s for s in result['samples'] if s['method'] == method]
        median = lambda key: round(statistics.median(key(s) for s in samples), 3)
        hooks = {}
        for sample in samples:
            for key, val in sample['js'].items():
                row = hooks.setdefault(key, {'selfMs': 0, 'calls': 0, 'bufferBytes': 0})
                for field in row:
                    row[field] += val[field]
        rows.append({'method': method, 'reads': len(samples), 'wallMedianMs': median(lambda s: s['wallMs']),
                     'wallMaxMs': round(max(s['wallMs'] for s in samples), 3), 'cpuMedianMs': median(lambda s: s['cpuMs']),
                     'replyBytesMedian': median(lambda s: s['replyBytes']),
                     'platformCallsMedian': median(lambda s: s['platform']['calls']),
                     'platformRequestBytesMedian': median(lambda s: s['platform']['requestBytes']),
                     'platformResponseBytesMedian': median(lambda s: s['platform']['responseBytes']),
                     'platformWallMedianMs': median(lambda s: s['platform']['wallMs']),
                     'journalBytesMedian': median(lambda s: s['platform']['journalPayloadBytes']),
                     **({'jsSelfMedianMs': {family: median(lambda s: sum(v['selfMs'] for k, v in s['js'].items() if k.startswith(prefix))) for family, prefix in [('Buffer', 'Buffer.'), ('Zod', 'Zod.'), ('structuredClone', 'structuredClone'), ('JSON', 'JSON.'), ('TextCodec', 'Text'), ('nativeSHA256', 'nativeSHA256')]}} if hooks else {})})
    return rows



# Timing and JS instrumentation counters may change; all observable read results and
# store traffic must remain identical. Compare each read, not only aggregate medians.
PLATFORM_TRAFFIC_FIELDS = (
    'calls', 'requestBytes', 'responseBytes', 'byMethod', 'requestBytesByMethod',
    'responseBytesByMethod', 'journalPayloadBytes', 'journalBytesByStream',
    'journalChunkCallsByStream',
)


def verify_equivalence(reports):
    if not reports or any(not run['samples'] for run in reports.values()):
        raise RuntimeError('missing_rpc_samples')
    reference = next(iter(reports.values()))['samples']
    def sequence(samples):
        return [(s['method'], s['caseID'], s['iteration'], s['variant'],
                 s['requestFingerprint'], s['requestBytes']) for s in samples]
    expected_sequence = sequence(reference)
    for result in reports.values():
        samples = result['samples']
        if sequence(samples) != expected_sequence:
            raise RuntimeError('rpc_sequence_drift')
        if any(a['replyFingerprint'] != b['replyFingerprint'] or a['replyBytes'] != b['replyBytes']
               for a, b in zip(reference, samples)):
            raise RuntimeError('native_bytes_instrumentation_or_jit_reply_drift')
        if any(a['platform'][key] != b['platform'][key]
               for a, b in zip(reference, samples) for key in PLATFORM_TRAFFIC_FIELDS):
            raise RuntimeError('platform_traffic_drift')
    return {'rpcSequenceVerified': True, 'replyEquivalenceVerified': True,
            'replyBytesVerified': True, 'platformTrafficVerified': True,
            'rpcSequenceSHA256': hashlib.sha256(json.dumps(expected_sequence, separators=(',', ':')).encode()).hexdigest()}


def compare_native_bytes(reports):
    # Pair only identical requested JIT + instrumentation modes, and require their
    # EFFECTIVE engine options to match before attributing timing to native bytes.
    comparisons = []
    modes = dict.fromkeys(run['executionMode'] for run in reports.values())
    for mode in modes:
        pair = {run['nativeBytes']: run for run in reports.values() if run['executionMode'] == mode}
        if set(pair) != {False, True}:
            continue
        off, on = pair[False], pair[True]
        if off['effectiveJSCOptions'] != on['effectiveJSCOptions']:
            raise RuntimeError('native_ab_jsc_options_drift')
        checks = verify_equivalence({'off': off, 'on': on})
        off_rows = {row['method']: row for row in summarize(off)}
        on_rows = {row['method']: row for row in summarize(on)}
        methods = []
        for method, a in off_rows.items():
            b = on_rows[method]
            methods.append({'method': method, 'readsPerArm': a['reads'],
                'offWallMedianMs': a['wallMedianMs'], 'onWallMedianMs': b['wallMedianMs'],
                'offCPUMedianMs': a['cpuMedianMs'], 'onCPUMedianMs': b['cpuMedianMs'],
                'wallSpeedup': round(a['wallMedianMs'] / b['wallMedianMs'], 3) if b['wallMedianMs'] else None,
                'cpuSpeedup': round(a['cpuMedianMs'] / b['cpuMedianMs'], 3) if b['cpuMedianMs'] else None,
                'replyBytesMedian': a['replyBytesMedian'], 'platformCallsMedian': a['platformCallsMedian'],
                'platformRequestBytesMedian': a['platformRequestBytesMedian'],
                'platformResponseBytesMedian': a['platformResponseBytesMedian'],
                'journalBytesMedian': a['journalBytesMedian']})
        comparisons.append({'executionMode': mode, 'effectiveUseJIT': off['effectiveJSCOptions']['useJIT'],
                            **checks, 'methods': methods})
    return comparisons


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--database', type=Path)
    parser.add_argument('--repetitions', type=bounded, default=3)
    parser.add_argument('--max-actions', type=bounded, default=3)
    parser.add_argument('--max-pages', type=int, choices=range(1, 5), default=2)
    parser.add_argument('--jit', choices=['both', 'on', 'off'], default=None)
    parser.add_argument('--native-bytes', choices=['on', 'off', 'both'], default='off',
                        help='Host native byte primitives; off preserves the JS codec baseline')
    parser.add_argument('--no-instrument', action='store_true', help='skip separate no-JIT instrumented run')
    parser.add_argument('--timeout', type=int, choices=range(30, 301), default=180, metavar='30..300', help='seconds per child, including compile')
    args = parser.parse_args()
    CACHE.mkdir(exist_ok=True)
    out = Path(tempfile.mkdtemp(prefix='jscore-rpc-bench-', dir=CACHE))
    os.chmod(out, 0o700)
    # Whitelist child environment: no inherited API keys, tokens, or credential paths.
    env = {'PATH': '/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(out), 'TMPDIR': str(out),
           'CLANG_MODULE_CACHE_PATH': str(out / 'module-cache')}
    sources = [ROOT / 'apps/ios/Sources/AlmaTAH/Runtime/AlmaTAHJavaScriptHost.swift',
               ROOT / 'apps/ios/Sources/AlmaTAH/Runtime/TAHJavaScriptBytePrimitives.swift',
               *[ROOT / 'apps/ios/Sources/AlmaTAH/Persistence' / name for name in ['TAHJournalStore.swift', 'TAHJournalRPC.swift', 'TAHRuntimeResources.swift', 'TAHRuntimeWire.swift']], HERE / 'jscore_rpc_bench.swift']
    hashes = {str(Path(__file__).resolve().relative_to(ROOT)): digest(Path(__file__))}
    copied = []
    for source in sources:
        data = source.read_bytes()
        hashes[str(source.relative_to(ROOT))] = hashlib.sha256(data).hexdigest()
        target = out / source.name; target.write_bytes(data); copied.append(str(target))
    bundle = CORE / 'generated/alma-tah.js'
    bundle_copy = out / 'alma-tah.js'; bundle_copy.write_bytes(bundle.read_bytes())
    manifest_source = CORE / 'generated/bundle-manifest.json'
    manifest_bytes = manifest_source.read_bytes()
    if json.loads(manifest_bytes)['sha256'] != digest(bundle_copy):
        raise RuntimeError('bundle_manifest_mismatch')
    (out / 'bundle-manifest.json').write_bytes(manifest_bytes)
    hashes[str(manifest_source.relative_to(ROOT))] = hashlib.sha256(manifest_bytes).hexdigest()
    controller = ROOT / 'apps/ios/Sources/AlmaTAH/Runtime/TAHMobileController.swift'
    hashes[str(controller.relative_to(ROOT))] = digest(controller)
    candidates = [CACHE / n / 'tah.sqlite3' for n in ['power-current-journal', 'power-actor-current-journal']]
    source = (args.database or max((p for p in candidates if p.exists()), key=lambda p: max(f.stat().st_mtime_ns for f in [p, Path(str(p) + '-wal')] if f.exists()))).resolve()
    if source.name != 'tah.sqlite3':
        raise RuntimeError('expected_tah_sqlite3')
    try:
        source_hashes = snapshot(source, out / 'snapshot')
        cases, operations, database = inventory(out / 'snapshot/tah.sqlite3', args.max_actions)
        original_digest = logical_digest(out / 'snapshot/tah.sqlite3')
        binary = out / 'bench'
        run(['/usr/bin/xcrun', 'swiftc', '-O', '-swift-version', '6', '-strict-concurrency=complete', '-parse-as-library',
             '-module-cache-path', str(out / 'module-cache'), *copied, '-lsqlite3', '-framework', 'JavaScriptCore', '-o', str(binary)],
            env, args.timeout, 'compile')
        jit = args.jit or ('off' if os.environ.get('JSC_useJIT', '').lower() in ('false', '0', 'no') else 'both')
        modes = [('jit-requested', True, False), ('interpreter', False, False)] if jit == 'both' else [('interpreter' if jit == 'off' else 'jit-requested', jit == 'on', False)]
        if not args.no_instrument:
            modes.append(('interpreter-instrumented', False, True))
        # Freeze all input once; neither arm rereads mutable config or source data.
        shared_plan = {'config': config(), 'cases': cases, 'operationStreams': operations,
                       'repetitions': args.repetitions, 'maxPages': args.max_pages}
        plan_hash = hashlib.sha256(json.dumps(shared_plan, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
        native_values = [False, True] if args.native_bytes == 'both' else [args.native_bytes == 'on']
        variants = [(mode, use_jit, instrument, native) for mode, use_jit, instrument in modes for native in native_values]
        reports = {}
        for mode, use_jit, instrument, native in variants:
            label = mode + ('-native-on' if native else '-native-off')
            journal = out / (label + '-journal'); journal.mkdir()
            shutil.copyfile(out / 'snapshot/tah.sqlite3', journal / 'tah.sqlite3')
            plan = out / 'plan.json'
            plan.write_text(json.dumps({**shared_plan, 'instrument': instrument, 'nativeBytes': native}))
            result_path = out / (label + '.json')
            child = run([str(binary), str(bundle_copy), str(plan), str(journal), str(result_path)],
                dict(env, JSC_useJIT='true' if use_jit else 'false', JSC_dumpOptions='2'), args.timeout, label)
            options = {k: v == 'true' for k, v in re.findall(r'^\s*(useJIT|useLLInt|useBaselineJIT|useDFGJIT|useFTLJIT)=(true|false)\b', child.stderr, re.M)}
            if 'useJIT' not in options or (not use_jit and options['useJIT']):
                raise RuntimeError('jsc_mode_unverified')
            if logical_digest(journal / 'tah.sqlite3') != original_digest:
                raise RuntimeError('copied_journal_mutated')
            reports[label] = json.loads(result_path.read_text())
            if reports[label]['nativeBytes'] is not native or reports[label]['instrumented'] is not instrument:
                raise RuntimeError('benchmark_mode_mismatch')
            reports[label]['executionMode'] = mode
            reports[label]['effectiveJSCOptions'] = options
            reports[label]['jitRequestHonored'] = options['useJIT'] == use_jit
            result_path.write_text(json.dumps(reports[label], separators=(',', ':')) + '\n')
            # Remove all private copied DB payloads promptly (also cleaned on failure below).
            shutil.rmtree(journal)
        if source_hashes != {name: digest(source.parent / name) for name in source_hashes}:
            raise RuntimeError('source_changed_during_run')
        equivalence = verify_equivalence(reports)
        native_comparisons = compare_native_bytes(reports)
        report = {'passed': True, **equivalence, 'nativeBytesSelection': args.native_bytes,
                  'nativeBytesComparison': native_comparisons, 'sharedPlanSHA256': plan_hash,
                  'sourceDirectory': source.parent.name, 'sourceSHA256': source_hashes,
                  'sourceUnchanged': True, 'copiedJournalLogicallyUnchanged': True, 'database': database,
                  'cases': cases, 'sourceSHA256ByPath': hashes, 'bundleSHA256': digest(bundle_copy),
                  'repetitions': args.repetitions, 'runs': reports,
                  'limits': ['Host macOS CPU, not iPhone battery measurement or direct GC attribution.',
                    'Native comparisons use fresh processes, off then on, matching effective JSC options; timing noise is not a semantic difference.',
                    'JIT requested is not JIT effective: inspect effectiveJSCOptions; some host processes cannot enable JIT.',
                    'Unauthenticated credential stub: authenticated raw receipt/consent paths are not covered.',
                    'No model/provider/credential access; only read store RPCs and initialization auth stub allowed.',
                    'History RPC loop follows current controller; no UI projection, Markdown, or Swift decode cost.',
                    'conversationText first chunk only; action.list first page only.',
                    'Instrumented bundle exposes existing Zod parse exports in memory only; baseline bytes unchanged.',
                    'JS hooks use Date.now (1ms), separate run, self time excludes nested hooks; GC may occur inside hooks.',
                    'Repeated reads share one VM per mode; iteration 0 is first touch, not every method a cold VM.']}
        report_path = out / 'report.json'; report_path.write_text(json.dumps(report, separators=(',', ':')) + '\n')
        summary = {'passed': True, 'report': str(report_path), 'sourceDirectory': source.parent.name,
                   'database': database, 'repetitions': args.repetitions, 'providerCalls': 0, 'sourceUnchanged': True,
                   **equivalence, 'nativeBytesComparison': native_comparisons,
                   'runs': {label: {'nativeBytes': result['nativeBytes'], 'effectiveUseJIT': result['effectiveJSCOptions']['useJIT'], 'methods': summarize(result)} for label, result in reports.items()}}
        (out / 'summary.json').write_text(json.dumps(summary, separators=(',', ':')) + '\n')
        print(json.dumps(summary, separators=(',', ':')))
    finally:
        for child in out.iterdir():
            if child.is_dir() and (child.name == 'snapshot' or child.name.endswith('-journal')):
                shutil.rmtree(child)
        (out / 'plan.json').unlink(missing_ok=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        # Do not include arbitrary exception text / source DB payloads in logs.
        code = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(json.dumps({'passed': False, 'error': code}), file=sys.stderr)
        sys.exit(1)
