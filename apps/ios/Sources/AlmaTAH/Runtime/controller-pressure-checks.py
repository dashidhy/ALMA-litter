#!/usr/bin/env python3
"""Isolated controller checks with deterministic Core/store response fixtures.

Compile the production methods with deterministic read/command seams, never the
JS host, journal, provider, shared smoke scripts, app, or device. Read-only wire
and presentation DTOs are copied alongside the controller into a fresh temporary
directory. This is not a Core integration, power, or FPS benchmark.
"""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import tempfile


SOURCE = Path(__file__).with_name("TAHMobileController.swift")


def block(source, marker):
    start = source.index(marker)
    opening = source.index("{", start)
    depth = 1
    end = opening + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[start:end]


SEAMS = r'''
import Foundation
@MainActor final class Host {
    var shutdowns = 0
    func invoke(_ method: String, json: String) async throws -> String { "null" }
    func shutdown() async { shutdowns += 1 }
}
@MainActor final class Journal {
    var pause = false, fail = false
    var gate: CheckedContinuation<Void, Never>?
    var mutation: (() -> Void)?
    var received: [(String, String)] = []
    func handleJSONRPC(_ method: String, json: String) async throws -> String {
        received.append((method, json))
        if pause { pause = false; await withCheckedContinuation { gate = $0 } }
        let effect = mutation; mutation = nil; effect?()
        if fail { fail = false; throw TAHRuntimeError.unavailable }
        return "{}"
    }
    func release() { gate?.resume(); gate = nil }
    func close() async {}
}
@MainActor final class LogReader { func close() {} }
@MainActor final class Probe {
    typealias Value = TAHRuntimeValue
    var ready = true, commandBusy = false, refreshPending = false, fullRefreshPending = false
    var writeEpoch = 0, writesInFlight = 0, identityEpoch = 0
    var historyBaseline: HistoryBaseline?
    var historyReload: HistoryReload?
    var progressVersions: [String: Int] = [:]
    var refreshTask: Task<Void, Never>?, expiryTask: Task<Void, Never>?
    var expiryKey: String?, latestProgress: AppProgress?
    var lastError: String?
    var host: Host? = Host(), journal = Journal(), logReader: LogReader?, memoryLogReader: LogReader?
    var prompts: [String: String] = [:]
    var auth: AppAuth?, raw: AppRaw?, selectedMaterial: Transcript? = Transcript(id: "t", materialID: "m", title: "T")
    var selectedTranscript: String? { selectedMaterial?.id }
    var actions: [AppActionRow] = [], action: AppAction?
    var history: [AppMessage] = [], formattedHistory: [String: AttributedString] = [:], historyCursor: String?
    var draft = TAHUIDraft()
    var sourceRevision = 0, wireRevision = 0, reads = 0, activeReads = 0, maximumReads = 0
    var published: [(busy: Bool, revision: Int)] = []
    var presentation = TAHUIPresentation()
    var pauseRead = false, failRead = false
    var readGate: CheckedContinuation<Void, Never>?
    var commandGate: CheckedContinuation<Void, Never>?
    var pauseCheckpoint = false
    var pauseMethod: String?, failureMethod: String?
    var methodGate: CheckedContinuation<Void, Never>?
    var counts: [String: Int] = [:]
    var coreAuth: [String: Any] = ["providerID": "p", "state": "valid", "phase": "idle", "inspecting": false,
        "sourceID": "auth-runtime", "inspection": ["state": "succeeded", "finishedAt": "checked", "failures": []],
        "actorCatalog": ["models": [["handle": "model", "displayName": "Model", "efforts": []]], "defaultModelHandle": "model"]]
    var coreRaw: [String: Any] = ["materialID": "m", "providerID": "p", "state": "allowed", "busy": false,
        "consentGranted": true, "expiresAt": "2030-02-01T00:00:00Z"]
    var coreAction: [String: Any] = ["id": "a", "transcriptID": "t", "language": "en", "phase": "actor",
        "initialSettingsFrozen": true, "editorMode": "running", "editorToken": "submission/cycle",
        "canOmitInstructions": true, "operationID": "execution", "revisionIndex": 0,
        "latestSubmittedRevisionIndex": 0, "revisions": [], "events": []]
    var coreRows: [[String: Any]] = [["id": "a", "createdAt": "today"]]
    // Independent read fixture: immutable committed records and explicit visibility.
    // It does not implement a cache, generations, or refresh policy.
    var records: [[String: Any]] = []
    var hiddenCycles: Set<String> = []
    var missingActions: Set<String> = []
    var pageSize = 2
    func rebuild() {
        published.append((commandBusy || !ready, Int(auth?.account ?? "") ?? -1))
        presentation = Self.project(auth: auth, raw: raw, action: action, draft: draft,
            language: .english, commandBusy: commandBusy || !ready, now: Date())
        presentation.actions = actions.map { .init(id: $0.id, title: $0.customTitle ?? "Structured Notes · " + $0.createdAt) }
        presentation.timeline = Self.timeline(history, action: action, formatted: formattedHistory)
        presentation.hasMoreHistory = historyCursor != nil
        presentation.currentActivity = Self.currentSummary(action, history: history)
    }
    func chooseDefaultModel() { draft.settings.modelID = "model" }
    func restoreDraft() { draft.settings = TAHUIRevisionSettings(providerID: auth?.providerID, modelID: "model") }
    func dismissMaterial() { presentation.material = nil }
    func providerPlatform(_ method: String, _ json: String) async throws -> String { throw TAHRuntimeError.unavailable }
    func checkpoint() async throws {
        if pauseCheckpoint { pauseCheckpoint = false; await waitForCommand() }
    }
    func waitForCommand() async { await withCheckedContinuation { commandGate = $0 } }
    func releaseCommand() { commandGate?.resume(); commandGate = nil }
    func releaseRead() { readGate?.resume(); readGate = nil }
    func releaseMethod() { methodGate?.resume(); methodGate = nil }
    func json(_ value: Any) throws -> String { String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self) }
    func call<T: Decodable>(_ method: String, _ fields: [String: Value] = [:]) async throws -> T {
        counts[method, default: 0] += 1
        let response: String
        if method == "auth.snapshot" || method == "auth.inspect" {
            reads += 1; activeReads += 1; maximumReads = max(maximumReads, activeReads)
            defer { activeReads -= 1 }
            wireRevision += 1
            var value = coreAuth
            value["account"] = value["account"] ?? String(sourceRevision)
            value["sourceRevision"] = wireRevision
            response = try json(value) // capture before suspension to model an older reply
            if pauseRead { pauseRead = false; await withCheckedContinuation { readGate = $0 } }
            if failRead { failRead = false; throw TAHRuntimeError.unavailable }
        } else if method == "raw.status" {
            response = try json(coreRaw)
        } else if method == "action.snapshot" {
            if let id = try fields["actionID"]?.string(), missingActions.contains(id) { throw TAHRuntimeError.invalid_request }
            response = try json(coreAction)
        } else if method == "action.list" {
            let start = Int((try? fields["cursor"]?.string()) ?? "0") ?? 0
            let rows = Array(coreRows.dropFirst(start).prefix(pageSize))
            let end = start + rows.count
            response = try json(["actions": rows, "nextCursor": end < coreRows.count ? String(end) as Any : NSNull()])
        } else if method == "action.conversation" {
            let before = Int((try? fields["cursor"]?.string()) ?? "") ?? Int.max
            let visible = records.filter { ($0["position"] as! Int) < before && !hiddenCycles.contains($0["cycleID"] as! String) }
                .sorted { ($0["position"] as! Int) > ($1["position"] as! Int) }
            let page = Array(visible.prefix(pageSize))
            response = try json(["items": page, "nextCursor": visible.count > page.count ? String(page.last!["position"] as! Int) as Any : NSNull()])
        } else { throw TAHRuntimeError.invalid_request }
        if pauseMethod == method { pauseMethod = nil; await withCheckedContinuation { methodGate = $0 } }
        if failureMethod == method { failureMethod = nil; throw TAHRuntimeError.unavailable }
        return try JSONDecoder().decode(T.self, from: Data(response.utf8))
    }
'''



CHECKS = r'''
@main struct Checks {
    @MainActor static func main() async throws {
        var passed: [String] = []
        func expect(_ condition: Bool, _ name: String) throws {
            guard condition else { throw NSError(domain: "ControllerPressure", code: 1,
                userInfo: [NSLocalizedDescriptionKey: name]) }
            passed.append(name)
        }
        func until(_ predicate: () -> Bool) async throws {
            for _ in 0..<1000 {
                if predicate() { return }
                try await Task.sleep(for: .milliseconds(1))
            }
            throw TAHRuntimeError.busy
        }
        func idle(_ probe: Probe) async throws {
            try await until { !probe.commandBusy && probe.refreshTask == nil && !probe.refreshPending }
        }
        func raw(_ expiry: String?, state: String = "allowed", provider: String = "p") throws -> Probe.AppRaw {
            let value: [String: Any] = ["materialID": "m", "providerID": provider, "state": state,
                "busy": false, "consentGranted": true, "expiresAt": expiry as Any? ?? NSNull()]
            return try JSONDecoder().decode(Probe.AppRaw.self, from: JSONSerialization.data(withJSONObject: value))
        }
        let oldFraction = ISO8601DateFormatter()
        oldFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let oldWhole = ISO8601DateFormatter()
        for text in ["2030-02-01T00:00:00Z", "2030-02-01T00:00:00.123Z",
                     "2030-02-01T08:00:00.123+08:00", "2030-01-31T19:00:00-05:00"] {
            let legacyExpiry = (oldFraction.date(from: text) ?? oldWhole.date(from: text))!
            // Build the intended instant from whole seconds + the literal fraction.
            // The old ICU parser loses ~0.12 microseconds through epoch conversion.
            let expiry = oldWhole.date(from: text.replacingOccurrences(of: ".123", with: ""))!
                .addingTimeInterval(text.contains(".123") ? 0.123 : 0)
            let value = try raw(text)
            try expect(value.allows(providerID: "p", now: legacyExpiry.addingTimeInterval(-0.001)), "before expiry: " + text)
            try expect(!value.allows(providerID: "p", now: expiry), "exact expiry denies: " + text)
            try expect(!value.allows(providerID: "p", now: legacyExpiry.addingTimeInterval(1)), "cached date ages out: " + text)
            try expect(!value.allows(providerID: "other", now: .distantPast), "provider remains scoped: " + text)
        }
        for text: String? in [nil, "", "not-a-date", "2030-02-01", "2030-13-99T25:00:00Z"] {
            try expect(!raw(text).allows(providerID: "p", now: .distantPast), "invalid/missing expiry denied: " + (text ?? "nil"))
        }
        try expect(!raw("2030-02-01T00:00:00Z", state: "blocked").allows(providerID: "p", now: .distantPast), "blocked state remains blocked")

        let burst = Probe()
        for _ in 0..<500 { burst.requestRefresh() }
        try expect(burst.reads == 0 && burst.refreshTask != nil, "callback burst ACKs before reads")
        try await idle(burst)
        try expect(burst.reads == 1 && burst.maximumReads == 1, "500 queued requests produce one serialized snapshot")

        let busy = Probe()
        busy.command { await busy.waitForCommand() }
        try expect(busy.commandBusy && busy.published.last?.busy == true && busy.reads == 0, "command admission publishes synchronously")
        try await until { busy.commandGate != nil }
        for _ in 0..<500 { busy.requestRefresh() }
        busy.sourceRevision = 7; busy.releaseCommand()
        try await idle(busy)
        try expect(busy.reads == 1 && busy.auth?.account == "7", "command's final snapshot consumes earlier requests")
        try expect(busy.published.last?.busy == false, "completion publishes immediately after snapshot")

        let during = Probe()
        during.pauseRead = true; during.refresh()
        try expect(during.commandBusy && during.published.last?.busy == true, "explicit refresh admits immediately")
        try await until { during.readGate != nil }
        during.sourceRevision = 9
        for _ in 0..<500 { during.requestRefresh() }
        during.refresh() // a user refresh while busy must also be retained
        during.releaseRead(); try await idle(during)
        try expect(during.reads == 2 && during.auth?.account == "9" && during.maximumReads == 1, "events during a stale snapshot get exactly one latest-state follow-up")

        let race = Probe()
        race.requestRefresh()
        race.command { await race.waitForCommand() }
        try await until { race.commandGate != nil }
        race.releaseCommand(); try await idle(race)
        try expect(race.reads == 1, "queued refresh cannot race command admission into a second reader")

        let checkpoint = Probe()
        checkpoint.pauseCheckpoint = true
        let checkpointTask = Task { try await checkpoint.checkpointDraft() }
        try await until { checkpoint.commandGate != nil }
        checkpoint.requestRefresh(); checkpoint.releaseCommand()
        try await checkpointTask.value; try await idle(checkpoint)
        try expect(checkpoint.reads == 1, "checkpoint without its own snapshot drains pending refresh")

        let failure = Probe()
        failure.pauseRead = true; failure.failRead = true; failure.refresh()
        try await until { failure.readGate != nil }
        failure.sourceRevision = 11; failure.requestRefresh(); failure.releaseRead()
        try await idle(failure)
        try expect(failure.reads == 2 && failure.auth?.account == "11" && failure.lastError == nil, "request during failed read survives and recovers")

        let stopping = Probe()
        let host = stopping.host!
        stopping.requestRefresh(); await stopping.shutdown()
        for _ in 0..<10 { await Task.yield() }
        try expect(stopping.reads == 0 && host.shutdowns == 1 && stopping.refreshTask == nil && !stopping.refreshPending, "shutdown cancels queued refresh and awaits host")
        stopping.requestRefresh(); stopping.refresh()
        try expect(stopping.refreshTask == nil && stopping.reads == 0, "stopped controller rejects new refresh requests")

        // Exercise the actual call -> async helper -> sync decoder implementation.
        // The fixture host returns immutable JSON; it never runs JS or a provider.
        let rows = (0..<20_000).map { "\($0): Unicode 中文 / literal transcript" }
        let response = String(data: try JSONSerialization.data(withJSONObject: ["rows": rows]), encoding: .utf8)!
        let responseProbe = ResponseProbe(json: response)
        MainActor.preconditionIsolated()
        let decoded: ExecutorCheckedPayload = try await responseProbe.call("fixture", ["input": .string("literal")])
        try expect(!decoded.decodedOnMainThread && decoded.rows == rows, "actual call decodes large Sendable response off main with exact content")
        MainActor.preconditionIsolated()
        passed.append("call returns to MainActor for presentation")
        let syncOnly = try ResponseProbe.decode(SyncOnlyPayload.self, #"{"value":"sync remains available"}"#)
        try expect(syncOnly.value == "sync remains available", "synchronous helper still supports non-Sendable Decodable")
        do {
            let _: ExecutorCheckedPayload = try await ResponseProbe(json: "{invalid").call("fixture")
            try expect(false, "malformed response must throw")
        } catch is DecodingError { try expect(true, "decoding errors propagate through call") }
        do {
            let _: ExecutorCheckedPayload = try await responseProbe.call("fail")
            try expect(false, "host failure must throw")
        } catch TAHRuntimeError.unavailable { try expect(true, "host errors propagate without decoding") }
        let cancelled = Task { @MainActor in
            let value: ExecutorCheckedPayload = try await responseProbe.call("fixture")
            return value
        }
        cancelled.cancel()
        do {
            _ = try await cancelled.value
            try expect(false, "cancelled response must not publish")
        } catch is CancellationError { try expect(true, "cancelled call rejects response before decoding") }
        guard passed.count == 40 else { throw TAHRuntimeError.integrity_locked }
        passed += try await cacheChecks()
        passed += try await eventChecks()
        print(String(data: try JSONSerialization.data(withJSONObject: ["passed": true, "checks": passed], options: .sortedKeys), encoding: .utf8)!)
    }
}
'''


RESPONSE_SEAMS = r'''
enum ResponseValue: Encodable, Sendable {
    case object([String: Self]), string(String)
    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .object(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        }
    }
}
actor ResponseHost {
    let json: String
    init(json: String) { self.json = json }
    func invoke(_ method: String, json: String) async throws -> String {
        guard method == "fixture" else { throw TAHRuntimeError.unavailable }
        return self.json
    }
}
struct ExecutorCheckedPayload: Decodable, Sendable {
    let rows: [String]
    let decodedOnMainThread: Bool
    private enum CodingKeys: String, CodingKey { case rows }
    init(from decoder: Decoder) throws {
        decodedOnMainThread = Thread.isMainThread
        rows = try decoder.container(keyedBy: CodingKeys.self).decode([String].self, forKey: .rows)
    }
}
final class SyncOnlyPayload: Decodable { var value: String }
@MainActor final class ResponseProbe {
    typealias Value = ResponseValue
    let host: ResponseHost?
    init(json: String) { host = ResponseHost(json: json) }
'''


FULL_STUBS = r'''
import Foundation
// Compile-only boundaries. The full production controller is typechecked
// unchanged, including its Observable state, init and the actual polling method.
actor AlmaTAHJavaScriptHost {
    typealias PlatformCall = @MainActor @Sendable (String, String) async throws -> String
    init(bundle: String, platform: @escaping PlatformCall) async throws {}
    func invoke(_ method: String, json: String) async throws -> String { throw TAHRuntimeError.unavailable }
    func shutdown() {}
}
actor TAHJournalStore {
    init(directory: URL) throws {}
    func handleJSONRPC(_ method: String, json: String) throws -> String { throw TAHRuntimeError.unavailable }
    func close() {}
}
'''


def main():
    data = SOURCE.read_bytes()
    source = data.decode()
    out = Path(tempfile.mkdtemp(prefix="alma-controller-pressure-"))
    (out / SOURCE.name).write_bytes(data)
    markers = ["struct AppAuth:", "struct Catalog:", "struct AppRaw:", "struct AppAction:",
               "struct AppActionRow:", "struct ActionPage:", "struct AppProgress:", "struct AppInvalidation:", "struct AppMessage:",
               "struct CriticRound:", "struct AppPresentation:", "struct ConversationPage:", "struct Transcript:",
               "private struct HistoryBaseline", "private struct HistoryReload", "private func canReuseHistory(",
               "private func command(", "func refresh()", "private func runRefresh(",
               "private func requestRefresh(", "private func scheduleRefresh()",
               "private func receiveProgress(", "private func canApplyLive(", "private func applyingLive(",
               "private func currentSnapshot(", "private func scheduleExpiry()", "private func expiryReached(",
               "private func refreshState(", "private func loadHistory(",
               "private func platform(", "private func forwardStore(", "@discardableResult private func acceptAuth(",
               "private func accept(", "func inspectAuthorization()", "func selectAction(id:", "func checkpointDraft()", "func shutdown()",
               "static func project(", "static func timeline(", "static func isGuardianPhase(",
               "static func messageRole(", "static func canShowWorking(", "static func validLogHash(",
               "static func summary(", "static func currentSummary(", "private static func currentCritic(",
               "nonisolated private static func format(", "nonisolated static func decode<", "nonisolated static func encode<"]
    # Only expose private methods in this isolated fixture; bodies are verbatim.
    production = "\n".join(block(source, marker).replace("private ", "", 1) for marker in markers)
    response_markers = ["private func call<", "nonisolated static func decode<",
                        "#if compiler(>=6.2)", "nonisolated static func encode<"]
    response_methods = "\n".join(block(source, marker).replace("private ", "", 1)
                                 for marker in response_markers)
    harness = out / "Checks.swift"
    wire = SOURCE.parent.parent / "Persistence/TAHRuntimeWire.swift"
    contract = SOURCE.parent.parent / "Presentation/TAHPresentationContract.swift"
    (out / wire.name).write_bytes(wire.read_bytes())
    (out / contract.name).write_bytes(contract.read_bytes())
    support = [str(out / wire.name), str(out / contract.name)]
    cache_checks = SOURCE.with_name("controller-history-checks.py")
    cache_source = cache_checks.read_text()
    # The companion contains only a Swift fixture string, not an independent cache implementation.
    namespace = {}
    exec(compile(cache_source, str(cache_checks), "exec"), namespace)
    (out / cache_checks.name).write_text(cache_source)
    event_checks = SOURCE.with_name("controller-event-checks.py")
    event_source = event_checks.read_text()
    event_namespace = {}
    exec(compile(event_source, str(event_checks), "exec"), event_namespace)
    (out / event_checks.name).write_text(event_source)
    assert "schedulePolling" not in source and "milliseconds(750)" not in source
    harness.write_text(SEAMS + production + "\n}\n" + RESPONSE_SEAMS + response_methods + "\n}\n" + CHECKS + namespace["CHECKS"] + event_namespace["CHECKS"])
    stubs = out / "CompileOnlyBoundaries.swift"
    stubs.write_text(FULL_STUBS)
    memory_reader = out / "TAHMemoryWorkingLogReader.swift"
    memory_reader.write_bytes(SOURCE.with_name(memory_reader.name).read_bytes())
    common = ["-parse-as-library", "-strict-concurrency=complete", "-warnings-as-errors",
              "-module-cache-path", str(out / "module-cache")]
    modes = [("5", []), ("6", [])]
    compiler = subprocess.check_output(["xcrun", "swiftc", "--version"], text=True)
    version_match = re.search(r"Swift version (\d+)\.(\d+)", compiler)
    if version_match and tuple(map(int, version_match.groups())) >= (6, 2):
        modes.append(("6", ["-enable-upcoming-feature", "NonisolatedNonsendingByDefault"]))
    for index, (version, flags) in enumerate(modes):
        binary = out / ("checks-" + str(index) + "-swift-" + version)
        subprocess.run(["xcrun", "swiftc", *common, "-swift-version", version,
                        *flags, *support, str(harness), "-o", str(binary)], check=True, timeout=90)
        result = subprocess.check_output([str(binary)], text=True, timeout=15)
        report = json.loads(result)
        assert report["passed"] and len(report["checks"]) >= 40
        (out / (binary.name + ".json")).write_text(result)
        subprocess.run(["xcrun", "swiftc", *common, "-swift-version", version, *flags,
                        "-typecheck", *support, str(stubs), str(memory_reader), str(out / SOURCE.name)], check=True, timeout=90)
        print(json.dumps({"swiftMode": version, "flags": flags, "checksPassed": len(report["checks"]),
                          "originalChecksPassed": 40, "fullControllerTypecheck": True}), flush=True)
    sdk = subprocess.check_output(["xcrun", "--sdk", "iphoneos", "--show-sdk-path"], text=True).strip()
    subprocess.run(["xcrun", "swiftc", *common, "-swift-version", "5", "-typecheck",
                    "-target", "arm64-apple-ios18.0", "-sdk", sdk, *support, str(harness)], check=True, timeout=90)
    subprocess.run(["xcrun", "swiftc", *common, "-swift-version", "5", "-typecheck",
                    "-target", "arm64-apple-ios18.0", "-sdk", sdk, *support, str(stubs),
                    str(memory_reader), str(out / SOURCE.name)], check=True, timeout=90)
    print(json.dumps({"sourceSHA256": hashlib.sha256(data).hexdigest(), "artifacts": str(out),
                      "iOS18Typecheck": True, "providerCalls": 0, "deviceOperations": 0}))


if __name__ == "__main__":
    main()
