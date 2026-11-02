#!/usr/bin/env python3
"""Deterministic reader version/lease regressions against copied production Swift.

Only synthetic snapshots/chunks are supplied: no provider, device, journal, or
network calls. Every changed callback and chunk/snapshot request is recorded.
The fixture prefix is extracted as a literal via AST, never imported/executed.
"""
from pathlib import Path
import argparse
import ast
import hashlib
import json
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[5]
BASE = Path(__file__).with_name("working-log-checks.py")
RESULT = Path(__file__).with_name("working-log-version-checks-result.json")

SWIFT = r'''
// All scheduling barriers are manual continuations. No sleeps/yield polling.
@MainActor final class Signal {
    private var fired = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    func wait() async {
        if fired { return }
        await withCheckedContinuation { waiters.append($0) }
    }
    func fire() {
        fired = true
        let pending = waiters; waiters.removeAll()
        for waiter in pending { waiter.resume() }
    }
}
@MainActor final class Gate {
    let entered = Signal(), released = Signal()
    func stop() async { entered.fire(); await released.wait() }
    func release() { released.fire() }
}
@MainActor struct Version {
    let name: String, data: Data, hash: String
    init(_ name: String, limited: Bool = false, data: Data? = nil) throws {
        self.name = name
        self.data = try data ?? Fixture.bytes(name, limited: limited)
        hash = Fixture.hash(self.data)
    }
    var offsets: [Int] { Array(stride(from: 0, to: data.count, by: 48 * 1024)) }
}
@MainActor final class VersionSource {
    enum Fault { case source, sha, base64, empty, zeroTotal, negativeTotal, tooLargeTotal, changedTotal, oversizedChunk, pastTotal }
    struct Call: Equatable {
        let hash: String, offset: Int, action: String, position: Int?, operation: String?
    }
    var action: TAHMobileController.AppAction
    var blobs: [String: Data] = [:]
    var labels: [String: String] = [:]
    var pinned: Set<String> = []
    var calls: [Call] = []
    var snapshots: [String] = []
    var faults: [String: Fault] = [:]
    var faultOffsets: [String: Int] = [:]
    var gate: Gate?, gateHash: String?, gateOffset = 0
    var snapshotGate: Gate?
    init(_ version: Version, available: [Version]) throws {
        action = try Fixture.action(version.hash)
        for item in available { blobs[item.hash] = item.data; labels[item.hash] = item.name }
    }
    func snapshot(_ id: String) async throws -> TAHMobileController.AppAction {
        snapshots.append(id)
        if let pause = snapshotGate { snapshotGate = nil; await pause.stop() }
        // Models the core's snapshot lease: only the returned version is pinned.
        if let hash = action.presentation?.workingLogSHA256 { pinned.insert(hash) }
        return action
    }
    func part(_ ref: TAHMobileWorkingLogReader.Reference, _ offset: Int) async throws -> TAHMobileController.TextChunk {
        calls.append(.init(hash: ref.hash, offset: offset, action: ref.actionID, position: ref.position, operation: ref.operationID))
        if let pause = gate, offset == gateOffset, gateHash == nil || gateHash == ref.hash {
            gate = nil; await pause.stop()
        }
        guard let data = blobs[ref.hash], ref.position != nil || pinned.contains(ref.hash) else { throw TAHRuntimeError.unavailable }
        guard offset < data.count else { throw TAHRuntimeError.unavailable }
        var body = data.subdata(in: offset..<min(data.count, offset + 48 * 1024)), total = data.count
        if offset >= (faultOffsets[ref.hash] ?? 0), let fault = faults[ref.hash] {
            switch fault {
            case .source: throw TAHRuntimeError.unavailable
            case .sha: body[body.startIndex] ^= 1
            case .base64: return .init(data: "%%%", totalBytes: total)
            case .empty: body = Data()
            case .zeroTotal: total = 0
            case .negativeTotal: total = -1
            case .tooLargeTotal: total = 4 * 1024 * 1024 + 1
            case .changedTotal: if offset > 0 { total += 1 }
            case .oversizedChunk: body = Data(repeating: 65, count: 48 * 1024 + 1)
            case .pastTotal: total = body.count - 1
            }
        }
        return .init(data: body.base64EncodedString(), totalBytes: total)
    }
    func pause(hash: String? = nil, offset: Int = 0) -> Gate {
        let pause = Gate(); gate = pause; gateHash = hash; gateOffset = offset; return pause
    }
}
@MainActor final class Probe {
    let source: VersionSource
    var observed: [TAHUIWorkingLog?] = []
    lazy var reader = TAHMobileWorkingLogReader(
        snapshot: { [source] in try await source.snapshot($0) },
        chunk: { [source] in try await source.part($0, $1) },
        changed: { [weak self] in self?.observed.append($0) })
    init(_ version: Version, available: [Version]) throws { source = try VersionSource(version, available: available) }
    func open(_ hash: String, position: Int? = nil) { reader.open(try! Fixture.reference(hash, position: position)) }
    func update(_ hash: String) { reader.update(reference: try! Fixture.reference(hash), actionID: "a", operationID: "op") }
    func current(_ version: Version, op: String = "op") throws { source.action = try Fixture.action(version.hash, op: op) }
    func settled() async { await reader.waitForUpdates() }
    // Capture the existing worker before close/supersede clears reader.worker.
    func joinCurrentWorker() async -> Task<Void, Never> {
        let entered = Signal()
        let joined = Task { @MainActor in entered.fire(); await reader.waitForUpdates() }
        await entered.wait()
        return joined
    }
    func report() -> [String: Any] {
        ["states": observed.map { state -> Any in
            guard let state else { return NSNull() }
            return ["id": state.id, "actionID": state.actionID, "position": state.position as Any? ?? NSNull(),
                    "revisionIndex": state.revisionIndex, "loading": state.loading, "failed": state.failed,
                    "limited": state.limited, "superseded": state.superseded, "progressing": state.progressing,
                    "error": state.error as Any? ?? NSNull(), "eventIDs": state.events.map(\.id)] as [String: Any]
        }, "snapshots": source.snapshots, "chunks": source.calls.map {
            ["version": source.labels[$0.hash] ?? $0.hash, "hash": $0.hash, "offset": $0.offset,
             "actionID": $0.action, "position": $0.position as Any? ?? NSNull(),
             "operationID": $0.operation as Any? ?? NSNull()] as [String: Any]
        }]
    }
}
@MainActor enum Verify {
    static func require(_ ok: Bool, _ message: String) throws {
        if !ok { throw NSError(domain: "WorkingLogVersions", code: 1, userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    static func stamp(_ state: TAHUIWorkingLog?) -> String {
        guard let state else { return "closed" }
        return "\(state.events.map(\.id).joined(separator: ","))|loading=\(state.loading)|failed=\(state.failed)|limited=\(state.limited)|superseded=\(state.superseded)|progressing=\(state.progressing)|error=\(state.error ?? "nil")"
    }
    static func s(_ marker: String? = nil, loading: Bool = false, failed: Bool = false,
                  limited: Bool = false, superseded: Bool = false, live: Bool = true) -> String {
        "\(marker.map { "\($0),extra-safety-pass" } ?? "")|loading=\(loading)|failed=\(failed)|limited=\(limited)|superseded=\(superseded)|progressing=\(live && !superseded)|error=\(failed ? "Could not read this working log." : "nil")"
    }
    static func opened(_ version: Version, live: Bool = true, limited: Bool = false) -> [String] {
        ["closed", s(loading: true, live: live), s(loading: true, live: live),
         s(version.name, limited: limited, live: live), s(version.name, limited: limited, live: live)]
    }
    static func trace(_ probe: Probe, _ expected: [String]) throws {
        let actual = probe.observed.map(stamp)
        try require(actual == expected, "changed callbacks differ\nexpected: \(expected)\nactual: \(actual)")
        for state in probe.observed.compactMap({ $0 }) {
            try require(!state.events.contains { $0.id == "private" || $0.detail.contains("PRIVATE-GUARDIAN") }, "private event leaked in a callback")
        }
    }
    static func calls(_ probe: Probe, _ versions: [(Version, [Int])], snapshots: Int, position: Int? = nil) throws {
        let expected = versions.flatMap { version, offsets in offsets.map {
            VersionSource.Call(hash: version.hash, offset: $0, action: "a", position: position, operation: position == nil ? "op" : nil)
        } }
        try require(probe.source.calls == expected, "chunk requests differ: \(probe.source.calls) != \(expected)")
        try require(probe.source.snapshots == Array(repeating: "a", count: snapshots), "snapshot count/identity differs: \(probe.source.snapshots), expected \(snapshots)")
    }
    static func identity(_ probe: Probe, position: Int? = nil) throws {
        let states = probe.observed.compactMap { $0 }
        try require(Set(states.map(\.id)).count == 1, "pane identity changed during update")
        try require(states.allSatisfy { $0.actionID == "a" && $0.position == position && $0.revisionIndex == 1 }, "pane action/position/revision changed")
    }
}
@main struct VersionChecks {
    @MainActor static func main() async throws {
        let old = try Version("old", limited: true), b = try Version("B"), c = try Version("C")
        let a = String(repeating: "a", count: 64) // advertised but never available/pinned
        let selected = CommandLine.arguments.dropFirst().first
        var results: [[String: Any]] = []
        func run(_ name: String, _ body: (Probe) async throws -> Void) async throws {
            if let selected, selected != name { return }
            let probe = try Probe(b, available: [old, b, c])
            var result: [String: Any] = ["name": name]
            do { try await body(probe); result["passed"] = true }
            catch { result["passed"] = false; result["error"] = String(describing: error) }
            result.merge(probe.report()) { _, new in new }
            results.append(result)
            probe.reader.close()
            probe.source.gate?.release(); probe.source.snapshotGate?.release()
        }
        func seed(_ probe: Probe) async throws {
            try probe.current(old); probe.open(old.hash); await probe.settled(); try probe.current(b)
        }

        try await run("advertised-A-missing-snapshot-B") { p in
            p.open(a); await p.settled()
            try Verify.trace(p, Verify.opened(b)); try Verify.calls(p, [(b, b.offsets)], snapshots: 2)
            try Verify.identity(p)
            try Verify.require(p.reader.state?.events.first?.detail == String(repeating: "公开 text\n", count: 9000), "multichunk UTF8 content changed")
        }
        try await run("B-notification-during-and-after-read-coalesces") { p in
            try await seed(p)
            let gate = p.source.pause(); p.update(a); await gate.entered.wait()
            p.update(b.hash); p.update(b.hash); gate.release(); await p.settled()
            p.update(b.hash); p.reader.refresh(id: p.reader.state!.id); await p.settled()
            let oldState = Verify.s("old", limited: true), loading = Verify.s("old", loading: true, limited: true)
            try Verify.trace(p, Verify.opened(old, limited: true) + [oldState, loading, loading, loading, Verify.s("B"), Verify.s("B"), Verify.s("B")])
            try Verify.calls(p, [(old, old.offsets), (b, b.offsets)], snapshots: 4); try Verify.identity(p)
        }
        try await run("later-B-notification-uses-effective-loaded-hash") { p in
            p.open(a); await p.settled(); p.update(b.hash); p.reader.refresh(id: p.reader.state!.id); await p.settled()
            try Verify.trace(p, Verify.opened(b) + [Verify.s("B")])
            try Verify.calls(p, [(b, b.offsets)], snapshots: 2)
        }
        try await run("pinned-B-survives-C-and-pending-C-coalesces") { p in
            let gate = p.source.pause(offset: 48 * 1024); p.open(a); await gate.entered.wait()
            try p.current(c); p.update(c.hash); p.update(c.hash)
            gate.release(); await p.settled()
            try Verify.trace(p, ["closed", Verify.s(loading: true), Verify.s(loading: true), Verify.s(loading: true), Verify.s(loading: true),
                                 Verify.s("B"), Verify.s("B", loading: true), Verify.s("C"), Verify.s("C")])
            try Verify.calls(p, [(b, b.offsets), (c, c.offsets)], snapshots: 4); try Verify.identity(p)
        }
        try await run("pinned-B-succeeds-without-C-notification") { p in
            let gate = p.source.pause(offset: 48 * 1024); p.open(a); await gate.entered.wait()
            try p.current(c); gate.release(); await p.settled()
            try Verify.trace(p, Verify.opened(b)); try Verify.calls(p, [(b, b.offsets)], snapshots: 2)
        }
        try await run("eviction-once-recovers-C-without-failed-callback") { p in
            try await seed(p); p.source.faults[b.hash] = .source; p.source.faultOffsets[b.hash] = 48 * 1024
            let gate = p.source.pause(offset: 48 * 1024); p.update(a); await gate.entered.wait()
            try p.current(c); p.update(c.hash); p.update(c.hash); gate.release(); await p.settled()
            p.update(c.hash); await p.settled()
            let stable = Verify.s("old", limited: true), loading = Verify.s("old", loading: true, limited: true)
            try Verify.trace(p, Verify.opened(old, limited: true) + [stable, loading, loading, loading, Verify.s("C"), Verify.s("C"), Verify.s("C")])
            try Verify.calls(p, [(old, old.offsets), (b, [0, 48 * 1024]), (c, c.offsets)], snapshots: 5); try Verify.identity(p)
        }
        try await run("persistent-source-failure-retries-once-preserves-events") { p in
            try await seed(p); let prior = p.reader.state!.events
            p.source.faults[b.hash] = .source; p.source.faults[c.hash] = .source
            let gate = p.source.pause(); p.update(b.hash); await gate.entered.wait()
            try p.current(c); gate.release(); await p.settled()
            p.update(b.hash); await p.settled() // same failed advertisement must not poll/retry
            let failed = Verify.s("old", failed: true, limited: true)
            try Verify.trace(p, Verify.opened(old, limited: true) + [Verify.s("old", limited: true), Verify.s("old", loading: true, limited: true), failed, failed, failed])
            try Verify.calls(p, [(old, old.offsets), (b, [0]), (c, [0])], snapshots: 4)
            try Verify.require(p.reader.state?.events == prior, "failure replaced verified events")
        }
        try await run("unchanged-snapshot-source-failure-does-not-retry") { p in
            p.source.faults[b.hash] = .source; p.open(b.hash); await p.settled()
            p.update(b.hash); await p.settled()
            let failed = Verify.s(failed: true)
            try Verify.trace(p, ["closed", Verify.s(loading: true), Verify.s(loading: true), failed, failed, failed])
            try Verify.calls(p, [(b, [0])], snapshots: 2)
        }
        try await run("explicit-refresh-after-source-failure") { p in
            p.source.faults[b.hash] = .source; p.open(b.hash); await p.settled(); p.source.faults.removeAll()
            p.reader.refresh(id: p.reader.state!.id); await p.settled()
            try Verify.trace(p, ["closed", Verify.s(loading: true), Verify.s(loading: true), Verify.s(failed: true), Verify.s(failed: true),
                                 Verify.s(loading: true, failed: true), Verify.s("B"), Verify.s("B")])
            try Verify.calls(p, [(b, [0]), (b, b.offsets)], snapshots: 4)
        }

        let invalid: [(String, VersionSource.Fault, Int)] = [
            ("SHA-mismatch", .sha, b.offsets.count), ("invalid-base64", .base64, 1), ("empty-chunk", .empty, 1),
            ("zero-total", .zeroTotal, 1), ("negative-total", .negativeTotal, 1), ("4MiB-bound", .tooLargeTotal, 1),
            ("changing-total", .changedTotal, 2), ("48KiB-chunk-bound", .oversizedChunk, 1), ("chunk-exceeds-total", .pastTotal, 1)]
        for (name, fault, chunks) in invalid {
            try await run("integrity-\(name)-never-retries-newer-C") { p in
                try await seed(p); let prior = p.reader.state!.events; p.source.faults[b.hash] = fault
                let gate = p.source.pause(); p.update(b.hash); await gate.entered.wait()
                try p.current(c); gate.release(); await p.settled()
                let failed = Verify.s("old", failed: true, limited: true)
                try Verify.trace(p, Verify.opened(old, limited: true) + [Verify.s("old", limited: true), Verify.s("old", loading: true, limited: true), failed, failed])
                try Verify.calls(p, [(old, old.offsets), (b, Array(b.offsets.prefix(chunks)))], snapshots: 3)
                try Verify.require(p.reader.state?.events == prior, "integrity failure replaced verified content")
            }
        }
        for name in ["invalid-JSON", "schema-version", "event-count"] {
            try await run("integrity-\(name)-never-retries-newer-C") { p in
                let bytes: Data
                if name == "invalid-JSON" { bytes = Data("not JSON".utf8) }
                else {
                    let events: [[String: Any]] = name == "event-count" ? (0..<513).map { ["id": "\($0)", "role": "actor", "kind": "tool", "title": "public", "detail": "x"] } : []
                    bytes = try JSONSerialization.data(withJSONObject: ["schemaVersion": name == "schema-version" ? 2 : 1, "limited": false, "events": events])
                }
                let malformed = try Version(name, data: bytes)
                p.source.blobs[malformed.hash] = bytes; p.source.labels[malformed.hash] = name
                try p.current(malformed)
                let gate = p.source.pause(); p.open(malformed.hash); await gate.entered.wait()
                try p.current(c); gate.release(); await p.settled()
                try Verify.trace(p, ["closed", Verify.s(loading: true), Verify.s(loading: true), Verify.s(failed: true), Verify.s(failed: true)])
                try Verify.calls(p, [(malformed, malformed.offsets)], snapshots: 1)
            }
        }
        try await run("snapshot-operation-change-refuses-before-chunks") { p in
            try p.current(b, op: "new-op"); p.open(a); await p.settled()
            try Verify.trace(p, ["closed", Verify.s(loading: true), Verify.s(loading: true), Verify.s(superseded: true)])
            try Verify.calls(p, [], snapshots: 1)
        }
        try await run("snapshot-action-change-refuses-before-chunks") { p in
            p.source.action = try Fixture.decode([
                "id": "other-action", "transcriptID": "t", "language": "en", "phase": "actor",
                "initialSettingsFrozen": true, "editorMode": "running", "editorToken": "submission/op",
                "canOmitInstructions": false, "operationID": "op", "revisionIndex": 1,
                "latestSubmittedRevisionIndex": 1, "presentation": Fixture.metadata(b.hash),
                "revisions": [], "events": []], TAHMobileController.AppAction.self)
            p.open(a); await p.settled()
            try Verify.trace(p, ["closed", Verify.s(loading: true), Verify.s(loading: true), Verify.s(superseded: true)])
            try Verify.calls(p, [], snapshots: 1)
        }
        try await run("operation-changes-after-pinned-read-refuses-content") { p in
            let gate = p.source.pause(); p.open(b.hash); await gate.entered.wait()
            try p.current(c, op: "new-op"); gate.release(); await p.settled()
            try Verify.trace(p, ["closed", Verify.s(loading: true), Verify.s(loading: true), Verify.s(superseded: true)])
            try Verify.calls(p, [(b, b.offsets)], snapshots: 2)
        }
        try await run("retry-snapshot-new-operation-refuses-content") { p in
            p.source.faults[b.hash] = .source
            let gate = p.source.pause(); p.open(b.hash); await gate.entered.wait()
            try p.current(c, op: "new-op"); gate.release(); await p.settled()
            try Verify.trace(p, ["closed", Verify.s(loading: true), Verify.s(loading: true), Verify.s(superseded: true)])
            try Verify.calls(p, [(b, [0])], snapshots: 2)
        }
        for kind in ["close", "selection", "operation-notification"] {
            try await run("cancel-\(kind)-ignores-late-chunk") { p in
                let gate = p.source.pause(); p.open(b.hash); await gate.entered.wait()
                let joined = await p.joinCurrentWorker()
                if kind == "close" { p.reader.close() }
                else if kind == "selection" { p.reader.update(reference: nil, actionID: "other", operationID: "op") }
                else { p.reader.update(reference: try Fixture.reference(c.hash, op: "new-op"), actionID: "a", operationID: "new-op") }
                gate.release(); await joined.value
                try Verify.trace(p, ["closed", Verify.s(loading: true), Verify.s(loading: true), kind == "operation-notification" ? Verify.s(superseded: true) : "closed"])
                try Verify.calls(p, [(b, [0])], snapshots: 1)
            }
        }
        try await run("cancel-during-snapshot-prevents-chunks") { p in
            let gate = Gate(); p.source.snapshotGate = gate; p.open(a); await gate.entered.wait()
            let joined = await p.joinCurrentWorker(); p.reader.close(); gate.release(); await joined.value
            try Verify.trace(p, ["closed", Verify.s(loading: true), Verify.s(loading: true), "closed"])
            try Verify.calls(p, [], snapshots: 1)
        }
        try await run("historical-position-hash-fixed-across-new-operation") { p in
            let gate = p.source.pause(); p.open(b.hash, position: 7); await gate.entered.wait()
            try p.current(c, op: "new-op")
            p.reader.update(reference: try Fixture.reference(c.hash, op: "new-op"), actionID: "a", operationID: "new-op")
            gate.release(); await p.settled(); p.reader.refresh(id: p.reader.state!.id); await p.settled()
            try Verify.trace(p, Verify.opened(b, live: false)); try Verify.calls(p, [(b, b.offsets)], snapshots: 0, position: 7)
            try Verify.identity(p, position: 7)
        }
        try await run("historical-source-failure-never-follows-live-hash") { p in
            p.source.faults[b.hash] = .source; try p.current(c)
            p.open(b.hash, position: 7); await p.settled()
            try Verify.trace(p, ["closed", Verify.s(loading: true, live: false), Verify.s(loading: true, live: false), Verify.s(failed: true, live: false), Verify.s(failed: true, live: false)])
            try Verify.calls(p, [(b, [0])], snapshots: 0, position: 7)
        }
        try await run("reopening-new-position-rejects-old-inflight-content") { p in
            let gate = p.source.pause(); p.open(b.hash, position: 7); await gate.entered.wait()
            let joined = await p.joinCurrentWorker(); p.open(c.hash, position: 8)
            gate.release(); await joined.value; await p.settled()
            try Verify.trace(p, ["closed", Verify.s(loading: true, live: false), Verify.s(loading: true, live: false)] + Verify.opened(c, live: false))
            try Verify.require(p.reader.state?.position == 8 && p.reader.state?.events.first?.id == "C", "old pane overwrote new position")
            let expected = [VersionSource.Call(hash: b.hash, offset: 0, action: "a", position: 7, operation: nil)] + c.offsets.map {
                VersionSource.Call(hash: c.hash, offset: $0, action: "a", position: 8, operation: nil)
            }
            try Verify.require(p.source.calls == expected && p.source.snapshots.isEmpty, "historical replacement fetched wrong position/hash")
            try Verify.require(Set(p.observed.compactMap { $0?.id }).count == 2, "replacement must publish new pane identity")
        }
        let result: [String: Any] = ["passed": !results.isEmpty && results.allSatisfy { $0["passed"] as? Bool == true },
                                   "checks": results, "providerCalls": 0, "phoneTouched": false, "timedSleeps": 0]
        print(String(data: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), encoding: .utf8)!)
    }
}
'''


def fixture_prefix():
    module = ast.parse(BASE.read_text())
    values = [ast.literal_eval(node.value) for node in module.body
              if isinstance(node, ast.Assign)
              and any(isinstance(target, ast.Name) and target.id == "SWIFT" for target in node.targets)]
    if len(values) != 1 or values[0].count("@MainActor final class Source") != 1:
        raise RuntimeError("working-log-checks.py fixture prefix changed; inspect extraction boundary")
    return values[0].split("@MainActor final class Source", 1)[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", help="Run one named scenario")
    parser.add_argument("--baseline-reader", type=Path, help="Optional real pre-fix controller source for a negative control")
    parser.add_argument("--skip-simulator", action="store_true", help="Host-only negative control")
    args = parser.parse_args()
    out = Path(tempfile.mkdtemp(prefix="alma-working-log-versions-")).resolve()
    result = {"passed": False, "artifacts": str(out), "commands": [], "sourceSHA256": {}}

    def run(command, label, **kwargs):
        result["commands"].append(command)
        proc = subprocess.run(command, capture_output=True, text=True, timeout=120, **kwargs)
        (out / f"{label}.stdout").write_text(proc.stdout)
        (out / f"{label}.stderr").write_text(proc.stderr)
        result[f"{label}Diagnostics"] = proc.stderr
        if proc.returncode:
            raise RuntimeError(f"{label} exited {proc.returncode}: {proc.stderr}{proc.stdout}")
        return proc.stdout

    try:
        fixture = out / "VersionChecks.swift"
        fixture.write_text(fixture_prefix() + SWIFT)
        result["fixtureSHA256"] = hashlib.sha256(fixture.read_bytes()).hexdigest()
        result["fixtureSourceSHA256"] = hashlib.sha256(BASE.read_bytes()).hexdigest()
        sources = []
        for source in sorted((ROOT / "apps/ios/Sources/AlmaTAH").rglob("*.swift")):
            if source.name == "TAHCodexPlatform.swift":
                continue
            original = args.baseline_reader if args.baseline_reader and source.name == "TAHMobileController.swift" else source
            data = original.read_bytes()
            target = out / "sources" / source.relative_to(ROOT / "apps/ios/Sources/AlmaTAH")
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            sources.append(str(target))
            result["sourceSHA256"][str(source.relative_to(ROOT))] = hashlib.sha256(data).hexdigest()
        if args.baseline_reader:
            result["baselineReader"] = str(args.baseline_reader.resolve())
        common = ["-swift-version", "6", "-strict-concurrency=complete", "-parse-as-library", "-module-cache-path", str(out / "cache")]
        run(["xcrun", "swiftc", *common, *sources, str(fixture), "-lsqlite3", "-framework", "JavaScriptCore", "-o", str(out / "checks")], "hostCompile")
        checks = json.loads(run([str(out / "checks"), *([args.case] if args.case else [])], "hostRun"))
        result.update(checks)
        if not args.skip_simulator:
            sdk = run(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-path"], "simulatorSDK").strip()
            # Match the established check lane's platform-source selection, and
            # typecheck this fixture too. No simulator is launched or installed.
            sim_sources = [p for p in sources if Path(p).name not in {"TAHHistoryView.swift", "TAHMobileView.swift"}]
            run(["xcrun", "--sdk", "iphonesimulator", "swiftc", *common, "-sdk", sdk,
                 "-target", "arm64-apple-ios18.0-simulator", "-typecheck", *sim_sources, str(fixture)],
                "simulatorTypecheck", env=dict(os.environ, SDKROOT=sdk))
            result["simulatorTypecheckPassed"] = True
    except Exception as error:
        result["passed"] = False
        result["error"] = str(error)
    # A negative control must not replace the production verification report.
    target = out / RESULT.name if args.baseline_reader else RESULT
    target.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"passed": result["passed"], "checks": len(result.get("checks", [])),
                      "failures": [{"name": c["name"], "error": c.get("error")} for c in result.get("checks", []) if not c["passed"]],
                      "error": result.get("error"), "result": str(target), "artifacts": str(out)}))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
