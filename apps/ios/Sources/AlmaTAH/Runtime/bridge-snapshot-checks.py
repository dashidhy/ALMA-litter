#!/usr/bin/env python3
"""Host-only bridge cache checks with real projections/JSON; no device, provider or model.

The temporary bridge copy adds only an encoder entry gate/counter and a successful
encoding counter. Cache and dispatch code are compiled verbatim. Faults and completion
order are injected at that gate; the original bridge is separately typechecked for iOS.
"""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
BRIDGE = HERE / "TAHWebPresentationBridge.swift"
CONTRACT = HERE.parent / "Presentation/TAHPresentationContract.swift"

SWIFT = r'''
import Foundation

enum InjectedFailure: Error { case encoding }

actor EncodeProbe {
    static let shared = EncodeProbe()
    var attempts = 0
    var encodes = 0
    var held = false
    var pending: [Int: CheckedContinuation<Void, Error>] = [:]
    var arrivals: [(Int, CheckedContinuation<Void, Never>)] = []

    func reset(held: Bool = false) {
        precondition(pending.isEmpty && arrivals.isEmpty)
        attempts = 0; encodes = 0; self.held = held
    }
    func enter() async throws {
        attempts += 1
        let id = attempts
        if held {
            try await withCheckedThrowingContinuation { continuation in
                pending[id] = continuation
                notifyArrivals()
            }
        } else { notifyArrivals() }
    }
    func notifyArrivals() {
        let ready = arrivals.filter { $0.0 <= attempts }
        arrivals.removeAll { $0.0 <= attempts }
        for (_, waiter) in ready { waiter.resume() }
    }
    func waitForAttempt(_ count: Int) async {
        if attempts < count {
            await withCheckedContinuation { arrivals.append((count, $0)) }
        }
    }
    func release(_ id: Int, fail: Bool = false) {
        guard let waiter = pending.removeValue(forKey: id) else { preconditionFailure("missing encoding") }
        if fail { waiter.resume(throwing: InjectedFailure.encoding) } else { waiter.resume() }
    }
    func encoded() { encodes += 1 }
    func counts() -> [Int] { [attempts, encodes] }
}

// The real contract is used; this replaces only the controller/runtime boundary.
@MainActor final class TAHMobileController: TAHPresentationController {
    var presentation = TAHUIPresentation()
    private var draftValue = TAHUIDraft()
    private(set) var draftReads = 0
    private var readers: [(Int, CheckedContinuation<Void, Never>)] = []
    var draft: TAHUIDraft {
        get {
            draftReads += 1
            let ready = readers.filter { $0.0 <= draftReads }
            readers.removeAll { $0.0 <= draftReads }
            for (_, waiter) in ready { waiter.resume() }
            return draftValue
        }
        set { draftValue = newValue }
    }
    func waitForDraftReads(_ count: Int) async {
        if draftReads < count { await withCheckedContinuation { readers.append((count, $0)) } }
    }
    var sends = 0
    var inspections = 0
    func refresh() {}
    func selectTranscript(id: String) {}
    func importTranscript(title: String, text: String) {}
    func selectAction(id: String) {}
    func updateDraft(_ draft: TAHUIDraft, context: TAHUIEditorContext?) { self.draft = draft }
    func selectInteractionLanguage(_ language: TAHUILanguage) {}
    func checkRawSafety(transcriptID: String, consent: Bool, interactionLanguage: TAHUILanguage) {}
    func createStructuredNotesAction(transcriptID: String, language: TAHUILanguage, settings: TAHUIRevisionSettings) {}
    func sendAction(_ submission: TAHUISubmission) { sends += 1 }
    func loadMoreConversation(actionID: String) {}
    func expandConversation(actionID: String, itemID: String) {}
    func readMaterial(_ request: TAHUIMaterialRequest) {}
    func dismissMaterial() {}
    func inspectAuthorization() { inspections += 1 }
    func checkpointDraft() async throws {}
    func openWorkingLog(actionID: String, position: Int?) {}
    func refreshWorkingLog(id: String) {}
    func closeWorkingLog(id: String) {}
}

@main struct Checks {
    @MainActor static func main() async throws {
        let probe = EncodeProbe.shared
        var checks: [String] = []
        func expect(_ value: Bool, _ name: String) throws {
            guard value else { throw NSError(domain: "BridgeSnapshot", code: 1, userInfo: [NSLocalizedDescriptionKey: name]) }
            checks.append(name)
        }
        func object(_ json: String) throws -> [String: Any] {
            try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
        }
        func snapshot(_ bridge: TAHWebPresentationBridge) -> Task<String, Error> {
            Task { try await bridge.snapshot() }
        }
        func expectFailure(_ task: Task<String, Error>) async throws {
            do { _ = try await task.value; try expect(false, "injected error must propagate") }
            catch InjectedFailure.encoding {}
        }

        // Real JSON is built/encoded once, and nullable/escaped fields retain their wire shape.
        await probe.reset()
        let controller = TAHMobileController()
        controller.draft.instructions = "引用 \"quote\"\n<script> 🐈"
        let bridge = TAHWebPresentationBridge(controller: controller)
        let first = try await bridge.snapshot()
        var identical = true
        for _ in 0..<100 { if try await bridge.snapshot() != first { identical = false } }
        try expect(identical, "same value returns identical JSON")
        try expect(await probe.counts() == [1, 1], "101 sequential reads: one build/encode")
        let payload = try object(first)
        try expect((payload["draft"] as! [String: Any])["instructions"] as? String == controller.draft.instructions,
                   "literal Unicode and escaped text round-trip")
        try expect((payload["presentation"] as! [String: Any])["transcriptID"] is NSNull, "nullable fields remain explicit null")

        // Every value change, including nested presentation/draft fields, must miss the cache.
        let changes: [@MainActor () -> Void] = [
            { controller.draft.instructions += " changed" },
            { controller.draft.settings.modelID = "model-b" },
            { controller.draft.consent.toggle() },
            { controller.presentation.status = "running" },
            { controller.presentation.permissions.send.toggle() },
            { controller.presentation.timeline = [.init(id: "t", title: "T", content: AttributedString("before"))] },
            { controller.presentation.timeline[0].rawText = "after" }
        ]
        for (index, change) in changes.enumerated() {
            change()
            let json = try await bridge.snapshot()
            let cached = try await bridge.snapshot()
            try expect(json != first && cached == json, "changed values replace the cached JSON")
            try expect(await probe.counts() == [index + 2, index + 2], "each presentation/draft change encodes exactly once")
        }
        // Cache hits must not bypass intent dispatch or authorization inspection.
        let beforeDispatch = await probe.counts()
        _ = try await bridge.dispatch(method: "inspectAuthorization", valueJSON: "{}")
        let send = #"{"context":{"actionID":"a","editorToken":"t"},"instructions":"i","settings":{"webEnabled":false},"interactionLanguage":"en","consent":true}"#
        _ = try await bridge.dispatch(method: "sendAction", valueJSON: send)
        _ = try await bridge.dispatch(method: "sendAction", valueJSON: send)
        try expect(controller.inspections == 1 && controller.sends == 2, "cache never deduplicates commands/authorization")
        try expect(await probe.counts() == beforeDispatch, "unchanged post-dispatch display reuses encoding")

        await probe.reset(held: true)
        let concurrentController = TAHMobileController()
        let concurrentBridge = TAHWebPresentationBridge(controller: concurrentController)
        let burst = (0..<32).map { _ in snapshot(concurrentBridge) }
        await concurrentController.waitForDraftReads(32)
        await probe.waitForAttempt(1)
        try expect(await probe.counts() == [1, 0], "32 simultaneous reads share one in-flight encoder")
        burst[0].cancel() // One waiter does not own the shared work's cancellation.
        await probe.release(1)
        var outputs: [String] = []
        for task in burst { outputs.append(try await task.value) }
        let burstCounts = await probe.counts()
        try expect(Set(outputs).count == 1 && burstCounts == [1, 1], "all waiters get the captured JSON with one encode")
        try expect(try await concurrentBridge.snapshot() == outputs[0], "coalesced success is cached")

        // B completes before A. A returns its captured values without replacing B's cache.
        await probe.reset(held: true)
        let ordered = TAHMobileController(), orderedBridge: TAHWebPresentationBridge
        orderedBridge = TAHWebPresentationBridge(controller: ordered)
        ordered.draft.instructions = "A"
        let a = snapshot(orderedBridge)
        await probe.waitForAttempt(1)
        ordered.draft.instructions = "B"; ordered.presentation.status = "B"
        let b = snapshot(orderedBridge)
        await probe.waitForAttempt(2)
        await probe.release(2)
        let bJSON = try await b.value
        await probe.release(1)
        let aJSON = try await a.value
        try expect((try object(aJSON)["draft"] as! [String: Any])["instructions"] as? String == "A", "late caller gets its original draft")
        try expect((try object(aJSON)["presentation"] as! [String: Any])["status"] as? String == "", "late caller gets its original presentation")
        try expect(try await orderedBridge.snapshot() == bJSON, "late A cannot replace cached B")
        try expect(await probe.counts() == [2, 2], "late A does not force B to re-encode")
        ordered.draft.instructions = "A"; ordered.presentation.status = ""
        let revisit = snapshot(orderedBridge)
        await probe.waitForAttempt(3)
        await probe.release(3)
        try expect(try await revisit.value == aJSON, "stale A was not cached for a later revisit")

        // Controller advances without requesting another snapshot: don't retain stale success.
        for changeDraft in [false, true] {
            await probe.reset(held: true)
            let moved = TAHMobileController(), movedBridge: TAHWebPresentationBridge
            movedBridge = TAHWebPresentationBridge(controller: moved)
            let stale = snapshot(movedBridge)
            await probe.waitForAttempt(1)
            if changeDraft { moved.draft.instructions = "changed without read" }
            else { moved.presentation.status = "changed without read" }
            await probe.release(1)
            let staleJSON = try await stale.value
            moved.draft = TAHUIDraft(); moved.presentation = TAHUIPresentation()
            let retryStale = snapshot(movedBridge)
            await probe.waitForAttempt(2)
            await probe.release(2)
            try expect(try await retryStale.value == staleJSON, "stale response still returns captured values")
            try expect(await probe.counts() == [2, 2], "unobserved presentation/draft change rejects stale cache insertion")
        }

        // ABA must compare request identity, not just equal values. Also cover a late failure.
        for failOld in [false, true] {
            await probe.reset(held: true)
            let aba = TAHMobileController(), abaBridge: TAHWebPresentationBridge
            abaBridge = TAHWebPresentationBridge(controller: aba)
            let oldA = snapshot(abaBridge)
            await probe.waitForAttempt(1)
            aba.presentation.status = "B"
            let middleB = snapshot(abaBridge)
            await probe.waitForAttempt(2)
            aba.presentation.status = ""
            let newA = snapshot(abaBridge)
            await probe.waitForAttempt(3)
            await probe.release(1, fail: failOld)
            if failOld { try await expectFailure(oldA) } else { _ = try await oldA.value }
            let reads = aba.draftReads
            var joinedFinished = false
            let joinedA = Task {
                let json = try await abaBridge.snapshot()
                joinedFinished = true
                return json
            }
            await aba.waitForDraftReads(reads + 1)
            try expect(!joinedFinished, "old A cannot supply a cached result while new A is pending")
            await probe.release(2)
            _ = try await middleB.value
            let nextReads = aba.draftReads
            let joinedAfterB = snapshot(abaBridge)
            await aba.waitForDraftReads(nextReads + 1)
            await probe.release(3)
            let current = try await newA.value
            try expect(try await joinedA.value == current, "ABA waiter receives the current task result")
            try expect(try await joinedAfterB.value == current, "late B cannot retire the new A task")
            try expect(await probe.counts() == [3, failOld ? 2 : 3], "ABA old success/failure cannot retire the new A task")
            try expect(try await abaBridge.snapshot() == current, "ABA newest successful request stays cached")
        }

        // Every coalesced waiter sees failure; the very next read retries and may cache success.
        await probe.reset(held: true)
        let failed = TAHMobileController(), failedBridge: TAHWebPresentationBridge
        failedBridge = TAHWebPresentationBridge(controller: failed)
        let failures = (0..<8).map { _ in snapshot(failedBridge) }
        await failed.waitForDraftReads(8)
        await probe.waitForAttempt(1)
        await probe.release(1, fail: true)
        for task in failures { try await expectFailure(task) }
        try expect(await probe.counts() == [1, 0], "one failed attempt shared by eight callers")
        let recovery = snapshot(failedBridge)
        await probe.waitForAttempt(2)
        await probe.release(2)
        let recovered = try await recovery.value
        try expect(try await failedBridge.snapshot() == recovered, "successful retry is cached")
        try expect(await probe.counts() == [2, 1], "failure is never cached; next read encodes successfully")

        print(String(decoding: try JSONSerialization.data(withJSONObject: ["passed": true, "checks": checks.count,
            "sequentialReads": 101, "sequentialEncodes": 1, "concurrentReads": 32, "concurrentEncodes": 1,
            "providerCalls": 0, "deviceOperations": 0], options: .sortedKeys), as: UTF8.self))
    }
}
'''


def run(command, timeout=90):
    result = subprocess.run(command, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(result.stdout + result.stderr)
    if result.stderr:
        raise RuntimeError("Unexpected compiler/runtime diagnostics: " + result.stderr)
    return result.stdout


def main():
    source = BRIDGE.read_text()
    entry = "        dispatchPrecondition(condition: .notOnQueue(.main))"
    encode = "        return String(decoding: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), as: UTF8.self)"
    assert source.count(entry) == source.count(encode) == 1
    instrumented = source.replace(entry, "        try await EncodeProbe.shared.enter()\n" + entry)
    instrumented = instrumented.replace(encode, encode.replace("return String", "let json = String")
                                        + "\n        await EncodeProbe.shared.encoded()\n        return json")
    compiler = subprocess.check_output(["xcrun", "swiftc", "--version"], text=True, stderr=subprocess.STDOUT).strip()
    version = tuple(map(int, re.search(r"Swift version (\d+)\.(\d+)", compiler).groups()))
    modes = [("5", []), ("6", [])] if version >= (6, 0) else [("5", [])]
    if version >= (6, 2):
        modes.append(("6", ["-enable-upcoming-feature", "NonisolatedNonsendingByDefault"]))
    with tempfile.TemporaryDirectory(prefix="alma-bridge-snapshot-") as directory:
        out = Path(directory)
        fixture = out / "Checks.swift"
        fixture.write_text(SWIFT)
        bridge = out / BRIDGE.name
        bridge.write_text(instrumented)
        original = out / "OriginalBridge.swift"
        original.write_text(source)
        contract = out / CONTRACT.name
        contract.write_bytes(CONTRACT.read_bytes())
        common = ["-parse-as-library", "-strict-concurrency=complete", "-warnings-as-errors",
                  "-module-cache-path", str(out / "module-cache")]
        if version >= (6, 2):
            common += ["-default-isolation", "nonisolated"]
        for index, (mode, flags) in enumerate(modes):
            binary = out / f"checks-{index}"
            run(["xcrun", "swiftc", *common, "-swift-version", mode, *flags,
                 str(contract), str(bridge), str(fixture), "-o", str(binary)])
            report = json.loads(run([str(binary)], timeout=20))
            assert report["passed"]
            print(json.dumps({"swiftMode": mode, "flags": flags, **report}), flush=True)
        if version >= (6, 2):
            # Exercise the source branch used by Swift 5.9, which has no @concurrent.
            # This is still the installed compiler in Swift 5 mode, not a 5.9 toolchain.
            concurrent = "    #if compiler(>=6.2)\n    @concurrent\n    #endif\n"
            assert instrumented.count(concurrent) == 1
            bridge.write_text(instrumented.replace(concurrent, ""))
            binary = out / "checks-legacy-nonisolated"
            run(["xcrun", "swiftc", *common, "-swift-version", "5",
                 str(contract), str(bridge), str(fixture), "-o", str(binary)])
            report = json.loads(run([str(binary)], timeout=20))
            assert report["passed"]
            print(json.dumps({"swiftMode": "5", "legacyNonisolatedBranch": True, **report}), flush=True)
        sdk = run(["xcrun", "--sdk", "iphoneos", "--show-sdk-path"]).strip()
        run(["xcrun", "swiftc", *common, "-swift-version", "5", "-typecheck",
             "-target", "arm64-apple-ios18.0", "-sdk", sdk, str(contract), str(original), str(fixture)])
        print(json.dumps({"iOS18Typecheck": True, "strictConcurrency": "complete", "defaultIsolation": "nonisolated",
                          "compiler": compiler, "bridgeSHA256": hashlib.sha256(source.encode()).hexdigest()}))


if __name__ == "__main__":
    main()
