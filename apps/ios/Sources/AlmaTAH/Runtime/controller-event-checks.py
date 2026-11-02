"""Event-driven cases loaded by controller-pressure-checks.py.
Use production controller bodies, independent canonical replies, and suspended
RPCs to check no-query steady updates and authoritative boundary reconciliation.
"""
CHECKS = r'''
extension Checks {
    @MainActor static func eventChecks() async throws -> [String] {
        var passed: [String] = []
        func expect(_ value: Bool, _ name: String) throws {
            guard value else { throw NSError(domain: "ControllerEvents", code: 1, userInfo: [NSLocalizedDescriptionKey: name]) }
            passed.append(name)
        }
        func until(_ predicate: () -> Bool) async throws {
            let deadline = ContinuousClock().now + .seconds(2)
            while !predicate() {
                guard ContinuousClock().now < deadline else { throw NSError(domain: "ControllerEvents", code: 2) }
                await Task.yield()
            }
        }
        func idle(_ p: Probe) async throws { try await until { !p.commandBusy && p.refreshTask == nil && !p.refreshPending } }
        func event(_ p: Probe, revision: Int, phase: String = "actor", operation: String = "execution") -> [String: Any] {
            let entry: [String: Any] = ["id": "event-\(revision)", "role": "actor", "kind": "activity", "title": "Actor", "detail": "event \(revision)"]
            return ["actionID": p.coreAction["id"]!, "transcriptID": "t", "operationID": operation,
                "sourceID": "runtime", "sourceRevision": revision, "phase": phase, "events": [entry],
                "presentation": ["stages": [["phase": phase, "at": "start"]], "events": [entry]]]
        }
        func deliver(_ p: Probe, _ value: [String: Any]) async throws {
            _ = try await p.platform("ui.actionChanged", json: p.json(value))
        }
        func prime(_ p: Probe) async throws {
            p.coreAction["progressSourceID"] = "runtime"; p.coreAction["progressRevision"] = 0
            p.coreAction["rawSafety"] = p.coreRaw
            p.action = try Probe.decode(Probe.AppAction.self, p.json(p.coreAction))
            p.refresh(); try await idle(p)
        }

        let live = Probe(); try await prime(live)
        let baseline = live.counts
        try expect(live.counts["raw.status", default: 0] == 0, "canonical action snapshot reuses its included Raw status")
        for i in 1...500 { try await deliver(live, event(live, revision: i)) }
        for _ in 0..<40 { await Task.yield() }
        try expect(live.counts == baseline && live.refreshTask == nil && !live.refreshPending,
            "500 ordinary progress events cause zero additional Core RPCs")
        try expect(live.action?.events.last?.detail == "event 500", "latest streamed event is visible without a query")
        try await deliver(live, event(live, revision: 1))
        try expect(live.action?.events.last?.detail == "event 500", "stale notification cannot roll back live events")

        // A response captured before an event must not overwrite its newer text.
        live.pauseMethod = "action.snapshot"; live.refresh()
        try await until { live.methodGate != nil }
        try await deliver(live, event(live, revision: 501))
        live.releaseMethod(); try await idle(live)
        try expect(live.action?.events.last?.detail == "event 501", "late full snapshot merges a newer same-phase notification")

        // A phase transition cannot be fabricated from partial progress fields.
        live.coreAction["progressRevision"] = 502
        live.coreAction["phase"] = "critic"
        try await deliver(live, event(live, revision: 502, phase: "critic")); try await idle(live)
        try expect(live.action?.phase == "critic" && live.action?.editorMode == "running",
            "phase transition rereads canonical editor state")
        let beforeCritic = live.counts
        try await deliver(live, event(live, revision: 503, phase: "critic"))
        try expect(live.counts == beforeCritic, "same-phase Critic updates also avoid Core reads")
        live.coreAction["phase"] = "completed"; live.coreAction["editorMode"] = "editing"
        live.coreAction["editorToken"] = "published/new"; live.coreAction["progressRevision"] = 504
        try await deliver(live, event(live, revision: 504, phase: "completed")); try await idle(live)
        try expect(live.action?.editorMode == "editing" && live.action?.editorToken == "published/new",
            "terminal notification restores canonical completed editor state without polling")

        let race = Probe(); try await prime(race)
        race.pauseMethod = "action.snapshot"; race.refresh()
        try await until { race.methodGate != nil }
        race.coreAction["phase"] = "critic"; race.coreAction["progressRevision"] = 1
        try await deliver(race, event(race, revision: 1, phase: "critic"))
        race.releaseMethod(); try await idle(race)
        try expect(race.action?.phase == "critic" && race.counts["action.snapshot"] == 3,
            "phase change during old read preserves exactly one authoritative follow-up")

        let raw = Probe(); raw.action = nil; raw.coreRaw["state"] = "checking"; raw.coreRaw["busy"] = true
        raw.refresh(); try await idle(raw)
        raw.pauseMethod = "raw.status"; raw.refresh(); try await until { raw.methodGate != nil }
        raw.coreRaw["state"] = "allowed"; raw.coreRaw["busy"] = false
        _ = try await raw.platform("ui.rawChanged", json: #"{"sourceID":"raw-runtime","sourceRevision":1}"#)
        raw.releaseMethod(); try await idle(raw)
        try expect(raw.raw?.state == "allowed" && raw.raw?.busy == false,
            "Raw finally notification survives an older in-flight status reply")
        let rawReads = raw.reads
        _ = try await raw.platform("ui.rawChanged", json: #"{"sourceID":"raw-runtime","sourceRevision":1}"#)
        try await idle(raw)
        try expect(raw.reads == rawReads, "duplicate Raw invalidation does not start another read")

        let store = Probe(); try await prime(store); let storeReads = store.reads
        _ = try await store.platform("store.begin", json: "opaque")
        for _ in 0..<32 { _ = try await store.platform("store.putChunk", json: "opaque") }
        try expect(store.reads == storeReads && !store.refreshPending,
            "begin and 32 successful upload chunks do not independently reread history")
        _ = try await store.platform("store.commit", json: "opaque"); try await idle(store)
        try expect(store.reads == storeReads + 1, "committed upload has one canonical refresh")
        store.journal.fail = true
        do { _ = try await store.platform("store.putChunk", json: "uncertain") } catch TAHRuntimeError.unavailable {}
        try await idle(store)
        try expect(store.reads == storeReads + 2, "uncertain upload failure still reconciles canonical state")

        let deadline = Probe(); deadline.raw = try Probe.decode(Probe.AppRaw.self, deadline.json(deadline.coreRaw))
        deadline.scheduleExpiry(); let task = deadline.expiryTask
        deadline.scheduleExpiry()
        try expect(task != nil && deadline.expiryTask == task, "same real deadline does not create repeated timers")
        deadline.coreRaw["expiresAt"] = "2020-01-01T00:00:00Z"
        deadline.raw = try Probe.decode(Probe.AppRaw.self, deadline.json(deadline.coreRaw))
        let key = deadline.expiryKey!; deadline.expiryTask?.cancel()
        deadline.expiryReached(key)
        try expect(!deadline.presentation.permissions.createAction, "expiry event immediately disables create before the Core reply")
        try await idle(deadline)
        let deadlineReads = deadline.reads
        deadline.expiryReached(key)
        try expect(deadline.reads == deadlineReads, "stale deadline callback cannot refresh a newer selection")
        await deadline.shutdown()

        let failed = Probe(); try await prime(failed)
        _ = try await failed.platform("ui.runtimeFailed", json: #"{"code":"unavailable"}"#)
        try expect(!failed.ready && failed.lastError != nil && !failed.presentation.permissions.send,
            "lost notification channel makes stale UI unavailable instead of silently healthy")
        let failedReads = failed.reads
        try await deliver(failed, event(failed, revision: 999))
        try expect(failed.reads == failedReads, "late progress cannot revive a failed runtime")
        return passed
    }
}
'''
