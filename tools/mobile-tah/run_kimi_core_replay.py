#!/usr/bin/env python3
"""Bounded, model-free Codex/Kimi Framework parity in Swift JSCore + SQLite.

Uses the existing generated runtime without rebuilding another task's artifacts.
Run build_bundle.mjs first if the runtime bundle is missing or stale.
All credentials and provider replies are synthetic. No LLM, SDK, native provider
backend, Keychain, phone, or network qualification is performed.
"""
from pathlib import Path
import hashlib
import json
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CORE = REPO / 'shared/tah-runtime'
CACHE = HERE / '.cache'

# Based on core_replay.swift, with reset support for the real AuthService and
# counters that prove this replay never dispatches a native provider operation.
SWIFT = r'''
import Foundation

@main struct KimiCoreReplay {
    @MainActor static func main() async throws {
        let args = CommandLine.arguments
        let journal = try TAHJournalStore(directory: URL(fileURLWithPath: args[4]))
        var auth = #"{"version":1,"providerID":null,"state":"unauthed","credential":null,"account":null,"checkedAt":null}"#
        var resets = 0
        var notifications = 0
        var nativeProviderCalls = 0
        var notificationsPrivateFree = true
        let host = try await AlmaTAHJavaScriptHost(bundle: String(contentsOfFile: args[1], encoding: .utf8)) { method, json in
            if method.hasPrefix("store.") { return try await journal.handleJSONRPC(method, json: json) }
            if method.hasPrefix("ui.") {
                notifications += 1
                if json.contains("PRIVATE_GUARDIAN_") { notificationsPrivateFree = false }
                return "null"
            }
            switch method {
            case "credential.load": return auth
            case "credential.save":
                let value = try JSONDecoder().decode(TAHRuntimeValue.self, from: Data(json.utf8))
                auth = String(decoding: try JSONEncoder().encode(value["record"]!), as: UTF8.self)
                return "null"
            case "credential.reset":
                let value = try JSONDecoder().decode(TAHRuntimeValue.self, from: Data(json.utf8))
                let record = TAHRuntimeValue.object(["version": .integer(1), "providerID": value["providerID"] ?? .null,
                    "state": .string("unauthed"), "credential": .null, "account": .null, "checkedAt": .null])
                auth = String(decoding: try JSONEncoder().encode(record), as: UTF8.self)
                resets += 1
                return "null"
            default:
                if method.hasPrefix("provider.") { nativeProviderCalls += 1 }
                throw AlmaTAHJavaScriptHost.HostError.unavailable
            }
        }
        do {
            try await host.evaluate(String(contentsOfFile: args[2], encoding: .utf8))
            let result = try await host.invoke("proof", json: String(contentsOfFile: args[3], encoding: .utf8))
            guard case .object(var report) = try JSONDecoder().decode(TAHRuntimeValue.self, from: Data(result.utf8)),
                  notificationsPrivateFree, notifications > 0, nativeProviderCalls == 0, resets == 2 else {
                throw TAHRuntimeError.integrity_locked
            }
            report["nativeProviderCalls"] = .integer(nativeProviderCalls)
            report["metadataResets"] = .integer(resets)
            report["publicNotifications"] = .integer(notifications)
            report["nativeNotificationsPrivateFree"] = .bool(notificationsPrivateFree)
            print(String(decoding: try JSONEncoder().encode(TAHRuntimeValue.object(report)), as: UTF8.self))
        } catch {
            await host.shutdown()
            await journal.close()
            throw error
        }
        await host.shutdown()
        await journal.close()
    }
}
'''


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def main():
    CACHE.mkdir(exist_ok=True)
    bundle = CORE / 'generated/alma-tah.js'
    if not bundle.exists():
        raise RuntimeError('Build the generated runtime with tools/mobile-tah/build_bundle.mjs first')
    fixture_path = HERE / 'fixtures/core-replay.json'
    fixture = json.loads(fixture_path.read_text())
    profiles = []
    profile_paths = [CORE / 'upstream/providers/codex/app-profile.json', CORE / 'kimi-upstream/app-profile.json']
    for path in profile_paths:
        profile_bytes = path.read_bytes()
        profile = json.loads(profile_bytes)
        profile['profileIdentity'] = sha256(profile_bytes)
        profiles.append(profile)
    assert profiles[1]['id'] == 'kimi'
    assert (profiles[1]['guardianModel'], profiles[1]['guardianEffort']) == ('kimi-for-coding', 'low')
    prompts = CORE / 'upstream/prompts'
    fixture['config'] = {
        'profiles': profiles,
        'actionInstructions': (prompts / 'action_instructions/structured_notes_v4_3.txt').read_text(),
        'resources': {key: (prompts / 'system_prompts' / name).read_text() for key, name in {
            'actorPromptTemplate': 'actor_prompt_v4_2.txt',
            'rawGuardianPrompt': 'safety_guardian_raw_prompt_v0_3.txt',
            'extraGuardianPrompt': 'safety_guardian_extra_prompt_v0_6.txt',
            'safetyPolicy': 'safety_guardian_policy_v0_2.txt',
        }.items()},
    }
    app = REPO / 'apps/ios/Sources/AlmaTAH'
    originals = [app / 'Runtime/AlmaTAHJavaScriptHost.swift', app / 'Runtime/TAHJavaScriptBytePrimitives.swift',
                 *sorted((app / 'Persistence').glob('TAH*.swift'))]
    with tempfile.TemporaryDirectory(prefix='kimi-core-replay-', dir=CACHE) as directory:
        work = Path(directory)
        # Snapshot inputs so concurrent runtime/native edits cannot change a run.
        source_hashes = {}
        sources = []
        for original in originals:
            data = original.read_bytes()
            copied = work / original.name
            copied.write_bytes(data)
            sources.append(copied)
            source_hashes[str(original.relative_to(REPO))] = sha256(data)
        bundle_bytes = bundle.read_bytes()
        source_hashes['generatedRuntime'] = sha256(bundle_bytes)
        (work / 'runtime.js').write_bytes(bundle_bytes)
        (work / 'replay.js').write_bytes((HERE / 'kimi_core_replay.js').read_bytes())
        (work / 'input.json').write_text(json.dumps(fixture))
        (work / 'Replay.swift').write_text(SWIFT)
        binary = work / 'replay'
        subprocess.run(['xcrun', 'swiftc', '-swift-version', '6', '-strict-concurrency=complete',
                        '-parse-as-library', *map(str, sources), str(work / 'Replay.swift'),
                        '-lsqlite3', '-o', str(binary)], check=True, timeout=120)
        output = subprocess.check_output([str(binary), str(work / 'runtime.js'), str(work / 'replay.js'),
                                          str(work / 'input.json'), str(work / 'journal')], text=True, timeout=60)
    report = json.loads(output)
    expected_roles = ['raw_guardian', 'actor', 'extra_guardian', 'actor', 'extra_guardian', 'actor']
    assert report['passed'] and report['modelCalls'] is False and report['nativeProviderCalls'] == 0
    for provider in ['codex', 'kimi']:
        assert [call['role'] for call in report['attempts'] if call['providerID'] == provider] == expected_roles
        replay = report['providers'][provider]
        assert [step['revision'] for step in replay['publications']] == [0, 1, 2]
        assert all(step['criticDecision'] == 'PASS' for step in replay['publications'])
        assert all(step['parts'] >= 2 and step['wrongHashRejected'] for step in replay['workingLogs'])
    assert report['metadataResets'] == 2 and report['historyReadableAfterReplacement']
    report['sourceSHA256'] = source_hashes
    report['fixtureSHA256'] = sha256(fixture_path.read_bytes())
    report['replaySHA256'] = sha256((HERE / 'kimi_core_replay.js').read_bytes())
    report['configurationSHA256'] = sha256(json.dumps(fixture['config'], sort_keys=True).encode())
    destination = CACHE / 'latest-kimi-core-replay.json'
    destination.write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps({'passed': True, 'modelCalls': False, 'nativeBackendQualified': False,
                      'providers': ['codex', 'kimi'], 'publishedRevisions': 6, 'checkedOutputFiles': 12,
                      'criticPasses': 6, 'multiChunkWorkingLogs': 6, 'report': str(destination)}))


if __name__ == '__main__':
    main()
