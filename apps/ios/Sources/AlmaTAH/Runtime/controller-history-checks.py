#!/usr/bin/env python3
"""Adversarial Swift cases compiled by controller-pressure-checks.py.

The fixture supplies committed records and delayed RPC replies; cache decisions,
history paging, visibility replacement, auth ordering and UI projection execute
the production Swift methods. No host, provider, model task or device is used.
"""

CHECKS = r'''
extension Checks {
    @MainActor static func cacheChecks() async throws -> [String] {
        var passed: [String] = []
        func expect(_ condition: Bool, _ name: String) throws {
            guard condition else { throw NSError(domain: "ControllerHistory", code: 1,
                userInfo: [NSLocalizedDescriptionKey: name]) }
            passed.append(name)
        }
        func until(_ predicate: () -> Bool) async throws {
            for _ in 0..<2000 {
                if predicate() { return }
                try await Task.sleep(for: .milliseconds(1))
            }
            throw TAHRuntimeError.busy
        }
        func idle(_ p: Probe) async throws {
            try await until { !p.commandBusy && p.refreshTask == nil && !p.refreshPending }
        }
        func message(_ position: Int, cycle: String = "cycle", final: Bool = false) -> [String: Any] {
            ["id": "message-\(position)", "position": position, "cycleID": cycle,
             "role": final ? "workflow" : "user", "phase": final ? "completed" : "running",
             "revisionIndex": 0, "modelID": "model", "text": final ? "Accepted answer \(position)" : "Literal user \(position)",
             "truncated": false, "isFinalAnswer": final]
        }
        func publication(_ cycle: String) -> [String: Any] {
            ["revisionIndex": 0, "providerID": "p", "commitID": "publication/" + cycle, "modelID": "model"]
        }
        func selectFixture(_ p: Probe) throws {
            p.action = try Probe.decode(Probe.AppAction.self, p.json(p.coreAction))
        }
        func refresh(_ p: Probe, full: Bool = false) async throws {
            if full { p.refresh() } else { p.requestRefresh() }
            try await idle(p)
        }
        func prime(_ p: Probe) async throws {
            try selectFixture(p); try await refresh(p, full: true)
        }
        func copyCore(_ p: Probe, to other: Probe) {
            other.coreAuth = p.coreAuth; other.coreRaw = p.coreRaw; other.coreAction = p.coreAction
            other.coreRows = p.coreRows; other.records = p.records; other.hiddenCycles = p.hiddenCycles
        }
        func equalToFull(_ p: Probe, _ reference: Probe, _ label: String) async throws {
            copyCore(p, to: reference)
            try await refresh(p); try await refresh(reference, full: true)
            try expect(p.presentation == reference.presentation, "full-read differential: " + label)
        }
        func commit(_ p: Probe, method: String = "store.commit", _ effect: @escaping () -> Void) async throws {
            p.journal.mutation = effect
            _ = try await p.platform(method, json: "opaque, deliberately not business JSON")
            try await idle(p)
        }

        // 1. A full-read oracle sees exactly the same public projection while the
        // optimized path avoids list/history, but continues every live Core read.
        let live = Probe(), reference = Probe()
        live.records = [message(1, cycle: "old", final: true), message(2)]
        live.coreAction["revisions"] = [publication("old")]
        copyCore(live, to: reference)
        try await prime(live); try await prime(reference)
        let listReads = live.counts["action.list", default: 0]
        let historyReads = live.counts["action.conversation", default: 0]
        let liveReads = live.counts["action.snapshot", default: 0]
        for index in 0..<8 {
            let event: [String: Any] = ["id": "event-\(index)", "title": "Actor", "detail": index == 3 ? "retrying" : "progress \(index)",
                "role": "actor", "kind": "activity"]
            live.coreAction["events"] = [event]
            live.coreAction["presentation"] = ["stages": [["phase": "actor", "at": "start"]], "events": [event]]
            try await equalToFull(live, reference, "stream event \(index), including native retry")
        }
        try expect(live.counts["action.list"] == listReads && live.counts["action.conversation"] == historyReads,
            "stable running never rereads action metadata or committed conversation")
        try expect(live.counts["action.snapshot"] == liveReads + 8 && live.counts["auth.snapshot"] == liveReads + 8
            && live.counts["raw.status"] == liveReads + 8, "auth raw snapshot remain fresh for every automatic read")
        try expect(live.presentation.currentActivity?.events.last?.detail == "progress 7", "current events are never frozen with history")
        for phase in ["critic", "actor"] {
            live.coreAction["phase"] = phase
            try await equalToFull(live, reference, "Critic and second Actor round: " + phase)
        }
        try expect(live.counts["action.list"] == listReads + 2, "phase changes conservatively take full reads")
        live.coreAction["operationID"] = "infrastructure-retry-execution"
        live.records.append(message(3)) // same cycle, a new execution ID
        try await equalToFull(live, reference, "infrastructure retry retains cycle-visible history")
        try expect(live.history.contains { $0.id == "message-3" }, "executionID is never used as a cycle visibility filter")

        // 2. Running can precede the admission commit. Capture an old conversation
        // reply while a store write is in flight, then release the commit first.
        let admission = Probe()
        admission.coreAction["phase"] = "preparing"
        admission.records = [message(1, cycle: "old", final: true)]
        admission.coreAction["revisions"] = [publication("old")]
        try await prime(admission)
        admission.pauseMethod = "action.snapshot"; admission.requestRefresh()
        try await until { admission.methodGate != nil }
        admission.journal.pause = true
        admission.journal.mutation = { admission.records.append(message(2)) }
        let admissionWrite = Task { try await admission.platform("store.commit", json: "admission") }
        try await until { admission.journal.gate != nil }
        admission.pauseMethod = "action.conversation"; admission.releaseMethod()
        try await until { admission.methodGate != nil }
        try expect(admission.writesInFlight == 1 && admission.historyBaseline == nil, "in-flight admission cannot establish a reusable history baseline")
        admission.journal.release(); _ = try await admissionWrite.value
        admission.releaseMethod(); try await idle(admission)
        try expect(admission.history.map(\.id) == ["message-1", "message-2"], "delayed admission commit appears once despite an older in-flight history reply")
        try expect(admission.maximumReads == 1 && admission.historyBaseline != nil, "write overlap drains to one valid serialized baseline")

        // Publication and operation-final metadata are separate commits. Keep the
        // operation/token/phase unchanged for the second commit to require write
        // invalidation, not just the obvious token/phase checks.
        admission.coreAction["phase"] = "critic"
        try await refresh(admission)
        try await commit(admission) {
            admission.coreAction["revisions"] = [publication("old"), publication("cycle")]
            admission.coreAction["editorToken"] = "published/cycle"
        }
        try expect(admission.presentation.revisions.count == 2 && admission.presentation.timeline.count == 2,
            "publication commit does not invent an uncommitted final conversation")
        let afterPublication = admission.counts["action.conversation", default: 0]
        try await commit(admission) {
            var final = message(3, final: true)
            final["criticRounds"] = [["decision": "PASS"]]
            final["presentation"] = ["workingLogSHA256": String(repeating: "a", count: 64), "stages": [], "events": []]
            admission.records.append(final)
        }
        try expect(admission.counts["action.conversation", default: 0] > afterPublication
            && admission.presentation.timeline.last?.rawText == "Accepted answer 3",
            "second terminal commit refreshes history even with identical running operation and token")
        admission.coreAction["phase"] = "completed"
        admission.coreAction["presentation"] = ["workingLogSHA256": String(repeating: "a", count: 64), "stages": [], "events": []]
        try await refresh(admission)
        try expect(admission.presentation.currentActivity?.criticPassed == true, "Critic PASS comes from committed matching history")
        admission.coreAction["editorMode"] = "editing"
        try await refresh(admission)
        try expect(admission.historyBaseline == nil && admission.presentation.currentActivity == nil, "completion exits reuse and removes the running activity")
        let unpublished = Probe()
        unpublished.records = [message(1, final: true)]
        try await prime(unpublished)
        try expect(unpublished.history.count == 1 && unpublished.presentation.timeline.isEmpty, "unaccepted final answer remains filtered by production timeline")

        // 3. Auth snapshots share the callback revision fence. A late response
        // cannot restore the old account/provider; permission is always projected.
        let authRace = Probe()
        authRace.records = [message(1)]
        try await prime(authRace)
        authRace.pauseRead = true; authRace.requestRefresh()
        try await until { authRace.readGate != nil }
        authRace.coreAuth["providerID"] = "q"; authRace.coreAuth["account"] = "new-account"
        authRace.wireRevision += 1
        var callback = authRace.coreAuth; callback["sourceRevision"] = authRace.wireRevision
        _ = try await authRace.platform("ui.auth", json: authRace.json(callback))
        let changedIdentity = authRace.identityEpoch
        authRace.pauseMethod = "raw.status"; authRace.releaseRead()
        try await until { authRace.methodGate != nil }
        try expect(authRace.auth?.providerID == "q" && authRace.auth?.account == "new-account"
            && authRace.identityEpoch == changedIdentity, "late auth.snapshot cannot overwrite a newer ui.auth identity")
        authRace.releaseMethod(); try await idle(authRace)
        try expect(authRace.presentation.disabledReason?.contains("current provider") == true
            && authRace.raw?.allows(providerID: "q", now: Date()) == false, "old-provider Raw permission is never reused for a new identity")
        let beforeAccount = authRace.counts["action.list", default: 0]
        authRace.coreAuth["account"] = "same-provider-new-account"
        authRace.wireRevision += 1; callback = authRace.coreAuth; callback["sourceRevision"] = authRace.wireRevision
        _ = try await authRace.platform("ui.auth", json: authRace.json(callback))
        try await idle(authRace)
        try expect(authRace.counts["action.list", default: 0] > beforeAccount, "same-provider account replacement forces a full read")
        let currentAccount = authRace.auth?.account
        callback["account"] = "stale"; callback["sourceRevision"] = authRace.wireRevision - 1
        _ = try await authRace.platform("ui.auth", json: authRace.json(callback))
        try expect(authRace.auth?.account == currentAccount && !authRace.refreshPending, "stale auth callbacks remain rejected without unnecessary refresh")
        authRace.pauseRead = true; authRace.inspectAuthorization()
        try await until { authRace.readGate != nil }
        authRace.coreAuth["account"] = "inspection-replacement"
        authRace.wireRevision += 1; callback = authRace.coreAuth; callback["sourceRevision"] = authRace.wireRevision
        _ = try await authRace.platform("ui.auth", json: authRace.json(callback))
        authRace.pauseRead = true; authRace.releaseRead()
        try await until { authRace.readGate != nil }
        try expect(authRace.auth?.account == "inspection-replacement", "late auth.inspect also respects the callback identity fence")
        authRace.releaseRead(); try await idle(authRace)
        authRace.coreRaw["providerID"] = "q"; authRace.coreRaw["expiresAt"] = "2000-01-01T00:00:00Z"
        try await refresh(authRace)
        try expect(authRace.presentation.rawStatus == "Transcript safety: expired", "fresh Raw expiry is reflected while Actor stays running")
        authRace.coreAuth["state"] = "invalid"
        try await refresh(authRace)
        try expect(authRace.presentation.disabledReason == "Provider authorization inspection is required.", "auth failure still controls permission projection")

        // 4. Explicit full intent must survive both command admission and a live
        // automatic read; automatic events must never downgrade it.
        let full = Probe(); full.records = [message(1)]; try await prime(full)
        let beforeBusy = full.counts["action.list", default: 0]
        full.command(refreshAfter: false) { await full.waitForCommand() }
        try await until { full.commandGate != nil }
        full.refresh()
        for _ in 0..<100 { full.requestRefresh() }
        full.releaseCommand(); try await idle(full)
        try expect(full.counts["action.list"] == beforeBusy + 1 && !full.fullRefreshPending,
            "busy command retains one full request through an automatic event burst")
        let beforeRead = full.counts["action.list", default: 0]
        full.pauseMethod = "action.snapshot"; full.requestRefresh()
        try await until { full.methodGate != nil }
        full.refresh(); full.requestRefresh(); full.releaseMethod()
        try await idle(full)
        try expect(full.counts["action.list", default: 0] >= beforeRead + 1 && full.maximumReads == 1,
            "full request arriving inside an automatic read is not swallowed")
        let drained = full.counts["action.list", default: 0]
        try await refresh(full)
        try expect(full.counts["action.list"] == drained, "drained full request permits subsequent stable reuse")
        full.failureMethod = "action.conversation"; full.refresh(); try await idle(full)
        try expect(full.lastError != nil && full.historyBaseline == nil, "failed full read cannot validate the old cache")
        try await refresh(full)
        try expect(full.lastError == nil && full.history.map(\.id) == ["message-1"], "automatic follow-up recovers a failed full read")

        // 5. Authoritative paging removes invisible cycles, preserves expanded
        // surviving records, and keeps a cursor for the actual oldest loaded page.
        let paging = Probe()
        paging.records = (1...6).map { message($0, cycle: $0 >= 5 ? "hidden-later" : "old") }
        paging.records[2]["truncated"] = true
        paging.coreAction["editorMode"] = "needs_edit"
        paging.coreAction["editorToken"] = "submission/hidden-later"
        try await prime(paging)
        paging.command(refreshAfter: false) { try await paging.loadHistory(reset: false) }
        try await idle(paging)
        try expect(paging.history.map(\.position) == [3, 4, 5, 6] && paging.historyCursor == "3", "load-more retains its immutable position fence")
        paging.history[0].text = "Expanded full literal"; paging.history[0].truncated = false
        paging.failureMethod = "action.conversation"
        try await commit(paging) {
            paging.hiddenCycles.insert("hidden-later")
            paging.coreAction["editorMode"] = "editing"; paging.coreAction["phase"] = "editing"
        }
        try expect(paging.history.isEmpty && paging.presentation.timeline.isEmpty && paging.historyBaseline == nil,
            "failed reedit reload cannot leave a hidden cycle on screen")
        try await refresh(paging)
        try expect(paging.action?.editorToken == "submission/hidden-later" && paging.history.map(\.position) == [3, 4],
            "same-token reedit removes every hidden-cycle row instead of merging it back")
        try expect(paging.history.first?.text == "Expanded full literal" && paging.history.first?.truncated == false
            && paging.historyCursor == "3", "visible expanded text and remaining-history cursor survive authoritative reload")
        paging.command(refreshAfter: false) { try await paging.loadHistory(reset: false) }
        try await idle(paging); try await refresh(paging, full: true)
        try expect(paging.history.map(\.position) == [1, 2, 3, 4] && paging.historyCursor == nil,
            "full refresh preserves loaded depth and never resurrects hidden pages")
        // Pause a head-page reply and add a committed row before it returns.
        // The follow-up must still traverse down to the previously loaded floor.
        paging.pauseMethod = "action.conversation"; paging.refresh()
        try await until { paging.methodGate != nil }
        paging.journal.mutation = { paging.records.append(message(7, cycle: "old")) }
        _ = try await paging.platform("store.commit", json: "head moved during page read")
        paging.releaseMethod(); try await idle(paging)
        try expect(paging.history.map(\.position) == [1, 2, 3, 4, 7] && paging.historyCursor == nil
            && paging.history.first(where: { $0.position == 3 })?.text == "Expanded full literal",
            "overlapping head-page commit preserves loaded depth and expanded immutable text")
        try await commit(paging, method: "store.deleteAction") { paging.coreRows = []; paging.missingActions.insert("a") }
        try expect(paging.presentation.actions.isEmpty && paging.action == nil && paging.history.isEmpty
            && paging.historyCursor == nil && paging.lastError == nil,
            "Core-confirmed deletion clears selected action metadata history and cursor")
        try await commit(paging) { paging.coreRows = [["id": "b", "customTitle": "Renamed", "createdAt": "today"]] }
        try expect(paging.presentation.actions.first?.title == "Renamed", "App-side create or rename is visible without operation or editor-token changes")
        paging.coreAction["id"] = "b"; paging.coreAction["operationID"] = "b-execution"
        paging.coreAction["editorToken"] = "published/b"; paging.records = [message(1, cycle: "b")]
        paging.selectAction(id: "b"); try await idle(paging)
        try expect(paging.action?.id == "b" && paging.history.map(\.cycleID) == ["b"] && paging.historyCursor == nil,
            "real action-selection entry clears old history and cursor")

        // Method observation is conservative and payload opaque, including a write
        // whose committed effect survives an uncertain/failed acknowledgement.
        let transport = Probe(); transport.records = [message(1)]; try await prime(transport)
        let readOnlyCount = transport.counts["action.list", default: 0]
        _ = try await transport.platform("store.head", json: "opaque")
        try await refresh(transport)
        try expect(transport.counts["action.list"] == readOnlyCount, "known read-only store RPC does not invalidate presentation history")
        try await commit(transport, method: "store.futureMutation") { transport.coreRows[0]["customTitle"] = "Future mutation" }
        try expect(transport.presentation.actions.first?.title == "Future mutation"
            && transport.journal.received.last?.1 == "opaque, deliberately not business JSON",
            "unknown store methods invalidate and forward payload bytes unchanged")
        transport.journal.fail = true
        transport.journal.mutation = { transport.records.append(message(2)) }
        do { _ = try await transport.platform("store.commit", json: "uncertain ACK") }
        catch TAHRuntimeError.unavailable {}
        try await idle(transport)
        try expect(transport.history.map(\.position) == [1, 2] && transport.writesInFlight == 0,
            "failed commit ACK still invalidates and reveals a committed terminal effect")
        let beforeSuspendedWrite = transport.reads
        transport.journal.pause = true
        let suspendedWrite = Task { try await transport.platform("store.putChunk", json: "in flight") }
        try await until { transport.journal.gate != nil }
        transport.requestRefresh(forceFull: true)
        for _ in 0..<20 { await Task.yield() }
        try expect(transport.reads == beforeSuspendedWrite && transport.refreshTask == nil && transport.fullRefreshPending,
            "pending writes retain full intent without an immediate refresh spin loop")
        transport.journal.release(); _ = try await suspendedWrite.value; try await idle(transport)
        try expect(transport.reads == beforeSuspendedWrite + 1, "store completion schedules the retained full read")
        transport.pauseMethod = "action.snapshot"; transport.requestRefresh()
        try await until { transport.methodGate != nil }
        await transport.shutdown(); transport.releaseMethod()
        try await until { !transport.commandBusy }
        try expect(transport.historyBaseline == nil && transport.refreshTask == nil && !transport.refreshPending,
            "shutdown during a suspended live read cannot resurrect a cache or refresh task")
        return passed
    }
}
'''
