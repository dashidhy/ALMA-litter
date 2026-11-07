"""Adopt only reviewed Kimi sources and regenerate narrow mobile adapter seams."""
from pathlib import Path
import argparse
import difflib
import hashlib
import json
import subprocess

ROOT = Path(__file__).resolve().parents[2] / 'shared/tah-runtime'
DEST = ROOT / 'kimi-upstream'
LOCK = ROOT / 'kimi-source-lock.json'
FILES = [f'adapter/src/{name}.ts' for name in
         ['auth-driver', 'guest-adapter', 'models', 'native-sdk', 'policy', 'tool-details']]
FILES += ['app-profile.json', 'LICENSE.upstream']
PROTOCOL = 'src/auth-prototype/protocol.ts'
BEFORE = 'z.enum(["codex", "qoder"])'
AFTER = 'z.enum(["codex", "qoder", "kimi"])'


def digest(data):
    return hashlib.sha256(data).hexdigest()


def verify():
    lock = json.loads(LOCK.read_text())
    actual = {str(p.relative_to(DEST)) for p in DEST.rglob('*') if p.is_file()}
    if actual != set(lock['files']):
        raise ValueError('Kimi owned inventory drift')
    for name, sha in lock['files'].items():
        if digest((DEST / name).read_bytes()) != sha:
            raise ValueError(f'Kimi source drift: {name}')
    return lock


def outputs():
    result = {}
    patches = []
    for name in ['auth-driver', 'models', 'policy', 'tool-details', 'guest-adapter']:
        original = (DEST / f'adapter/src/{name}.ts').read_text()
        text = original.replace('"../../../../src/', '"../../../upstream/src/')
        target = f'adopted/{name}.ts'
        if name == 'guest-adapter':
            target = 'guest/adapter.ts'
            text = text.replace('from "./', 'from "../adopted/')
            text = text.replace('import { loadKimiSDK, type KimiHarness, type KimiSession, type NativeEvent }',
                                'import type { KimiSDK, KimiHarness, KimiSession, NativeEvent }')
            before = 'const HOME = "/run/alma/provider-child-home/kimi";\nconst WORKSPACE = "/workspace/attempt";'
            if text.count(before) != 1:
                raise ValueError('Kimi path seam drift')
            text = text.replace(before, '''export interface MobileKimiGuestOptions {
  readonly home: string;
  readonly workspaceRoot: string;
  readonly loadSDK: () => Promise<KimiSDK>;
}''')
            text = text.replace('  #used = false; #cancelled = false;',
                                '  constructor(private readonly options: MobileKimiGuestOptions) {}\n  #used = false; #cancelled = false;')
            text = text.replace('    this.#used = true;',
                                '    this.#used = true;\n    const HOME = this.options.home;\n    const WORKSPACE = this.options.workspaceRoot;')
            text = text.replace('const sdk = await loadKimiSDK();', 'const sdk = await this.options.loadSDK();')
            text = text.replace('disposable VM', 'per-attempt owned guest process')
            close_before = '      try { await this.#session?.close(); await harness?.close(); }'
            close_after = '''      try { await this.#session?.close(); }
      catch { caught = failure("cleanup", "close_failed", "Kimi runtime did not close cleanly.", true); }
      try { await harness?.close(); }'''
            if text.count(close_before) != 1:
                raise ValueError('Kimi session/harness closure seam drift')
            text = text.replace(close_before, close_after)
            # Keep reviewed mobile failure classification in its own source module.
            text = text.replace('AttemptTerminalV1, NormalizedFailureV1', 'AttemptTerminalV1')
            start = text.index('class KimiFailure')
            end = text.index('/** A fresh native Harness', start)
            text = text[:start] + text[end:]
            start = text.index('function nativeFailure(')
            end = text.index('function nativeConfiguration(', start)
            text = text[:start] + text[end:]
            text = ('import { performance } from "node:perf_hooks";\n'
                    'import { KimiFailure, failure, nativeFailure, retryDetail } from "./failures.js";\n' + text)
            activity_state_before = '      let text = ""; let textBytes = 0; let eventFailure: unknown; let count = 0;'
            if text.count(activity_state_before) != 1:
                raise ValueError('Kimi thinking activity state seam drift')
            text = text.replace(activity_state_before,
                                activity_state_before + '\n      let lastActivityAt = -Infinity;')
            activity_before = '''            case "turn.step.started": case "thinking.delta":
              context.emit({ kind: "activity" }); break;'''
            activity_after = '''            case "turn.step.started":
              lastActivityAt = performance.now();
              context.emit({ kind: "activity" }); break;
            case "thinking.delta": {
              // Refresh liveness at most once per second between step starts.
              const now = performance.now();
              if (now - lastActivityAt >= 1000) {
                lastActivityAt = now;
                context.emit({ kind: "activity" });
              }
              break;
            }'''
            if text.count(activity_before) != 1:
                raise ValueError('Kimi thinking activity emission seam drift')
            text = text.replace(activity_before, activity_after)
            retry_before = 'detail: "Kimi is retrying a model request"'
            if text.count(retry_before) != 1:
                raise ValueError('Kimi retry diagnostics seam drift')
            text = text.replace(retry_before, 'detail: retryDetail(event)')
            watch_before = '[watch]\nenabled = false'
            if text.count(watch_before) != 1:
                raise ValueError('Kimi database configuration seam drift')
            text = text.replace(watch_before, '[database]\nbase = false\nsearch = false\n' + watch_before)
        if name == 'policy':
            missing_before = 'request.toolName !== "Write" || ancestor === workspace'
            if text.count(missing_before) != 1:
                raise ValueError('Kimi missing-path approval seam drift')
            text = text.replace(missing_before,
                '!(["Read", "Write", "Edit", "Glob", "Grep"].includes(request.toolName)) || ancestor === workspace')
        result[target] = text
        patches.append(''.join(difflib.unified_diff(original.splitlines(True), text.splitlines(True),
                       fromfile=f'kimi-upstream/adapter/src/{name}.ts', tofile=f'platform/kimi/{target}')))
    # SDK surface is type-only. The ESM entry supplies the immutable sibling import.
    native = (DEST / 'adapter/src/native-sdk.ts').read_text()
    result['adopted/native-sdk.ts'] = native[:native.index('export async function loadKimiSDK')]
    patches.append(''.join(difflib.unified_diff(native.splitlines(True), result['adopted/native-sdk.ts'].splitlines(True),
        fromfile='kimi-upstream/adapter/src/native-sdk.ts', tofile='platform/kimi/adopted/native-sdk.ts')))
    result['adaptation.patch'] = ''.join(patches)
    result['adaptation.json'] = json.dumps({
        'sources': json.loads(LOCK.read_text())['files'],
        'outputs': {name: digest(text.encode()) for name, text in result.items()},
        'seams': ['owned core import relocation', 'attempt-private home and workspace roots',
                  'SDK loader supplied by immutable guest ESM entry',
                  'independent sequential session and harness closure attempts',
                  'bounded native error cause classification and safe retry metadata',
                  'monotonic one-second thinking activity interval with immediate step-start heartbeats',
                  'disable optional SDK session-index read model and history search worker',
                  'authorize missing paths only after validating their existing ancestors'],
        'preserved': ['model and effort policy', 'tool grants and approvals', 'normalized event semantics',
                      'frozen model, effort and tool configuration', 'cancellation', 'session/harness closure and private-home removal'],
        'readWebFallback': 'Deny direct URL fetch; allow official Kimi fetch/search service only with frozen web grant',
    }, indent=2) + '\n'
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, help='Explicit Mac providers/kimi directory for initial adoption')
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    if args.check_only and args.source:
        parser.error('--check-only verifies owned files without adopting a source')
    if args.source:
        source = args.source.resolve()
        records = {name: digest((source / name).read_bytes()) for name in FILES}
        if LOCK.exists():
            if records != verify()['files']:
                raise ValueError('Mac Kimi source drift requires explicit review')
        else:
            if DEST.exists() and any(DEST.iterdir()):
                raise ValueError('Kimi destination is not empty')
            for name in FILES:
                path = DEST / name
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes((source / name).read_bytes())
            LOCK.write_text(json.dumps({'source': str(source), 'gitHead': subprocess.check_output(
                ['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip(), 'files': records}, indent=2) + '\n')
        # These are the only Mac core additions needed to admit a second provider.
        source_lock_path = ROOT / 'source-lock.json'
        source_lock = json.loads(source_lock_path.read_text())
        changes = {
            PROTOCOL: [(BEFORE, AFTER),
                ('  Object.freeze({ id: "qoder" as const, displayName: "Qoder" }),',
                 '  Object.freeze({ id: "qoder" as const, displayName: "Qoder" }),\n'
                 '  Object.freeze({ id: "kimi" as const, displayName: "Kimi Code (Prototype)" }),')],
            'src/app-runtime/attempt-port.ts': [
                ('readonly id: "codex" | "qoder";', 'readonly id: "codex" | "qoder" | "kimi";')],
        }
        for relative, replacements in changes.items():
            path = ROOT / 'upstream' / relative
            current = path.read_text()
            expected = current
            for before, after in replacements:
                if after not in expected:
                    expected = expected.replace(before, after)
            mac_path = source.parents[1] / relative
            if mac_path.read_text() != expected:
                raise ValueError(f'Mac source differs beyond reviewed Kimi IDs: {relative}')
            if digest(path.read_bytes()) != source_lock['files'][relative]:
                raise ValueError(f'Core source lock drift: {relative}')
            if current != expected:
                old_hash = source_lock['files'][relative]
                path.write_text(expected)
                source_lock['files'][relative] = digest(expected.encode())
                source_lock.setdefault('reviewedAdoptions', []).append({
                    'path': relative, 'source': str(mac_path),
                    'beforeSHA256': old_hash, 'afterSHA256': digest(expected.encode()),
                    'change': 'Add only existing Mac Kimi provider inventory/ID declarations'})
        source_lock_path.write_text(json.dumps(source_lock, indent=2) + '\n')
    verify()
    for name, text in outputs().items():
        path = ROOT / 'platform/kimi' / name
        if args.check_only:
            if not path.is_file() or path.read_text() != text:
                raise ValueError(f'Kimi adaptation drift: {name}')
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text)
    print(json.dumps({'verified': True, 'kimiSources': len(FILES), 'checkOnly': args.check_only}))


if __name__ == '__main__':
    main()
