#!/usr/bin/env python3
"""Deterministic display-channel / Core cursor checks against copied production Swift.

The shared synthetic Fixture prefix is AST-extracted, never imported or executed.
Expected frames/RPCs are explicit examples, not a duplicate sender or reducer.
Continuations gate async calls and deliveries; bounded yields are used only to
check absence of work where production offers no completion hook. No sleeps,
provider/network calls, device access, or changes to production sources.
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
RESULT = Path(__file__).with_name("working-channel-checks-result.json")

SWIFT = r'''
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
}
@MainActor enum Check {
    static func require(_ condition: Bool, _ message: String) throws {
        if !condition { throw NSError(domain: "WorkingChannelChecks", code: 1,
                                      userInfo: [NSLocalizedDescriptionKey: message]) }
    }
    static func idle() async { for _ in 0..<128 { await Task.yield() } }
    static func event(_ id: String, _ detail: String = "public") -> TAHUIWorkingEvent {
        .init(id: id, title: "Public tool", detail: detail, role: "actor", kind: "tool",
              titleCode: nil, status: "completed", detailTruncated: false, round: 0)
    }
    static func wireEvent(_ id: String, _ detail: String = "public") -> [String: Any] {
        var value = Fixture.event(id); value["detail"] = detail; return value
    }
    static func log(_ id: String = "pane", _ events: [TAHUIWorkingEvent] = []) -> TAHUIWorkingLog {
        .init(id: id, actionID: "a", position: nil, revisionIndex: 1,
              startedAt: "2026-11-01T01:00:00Z", endedAt: nil, events: events, progressing: true)
    }
    static func reply(events: [[String: Any]] = [wireEvent("seed")], order: [String] = ["seed"],
                      reset: Bool = true, base: Int = 0, revision: Int = 1,
                      stream: String = "stream-1", removed: [String] = [], finished: Bool = false) -> [String: Any] {
        ["schemaVersion": 1, "streamID": stream, "actionID": "a", "operationID": "op",
         "baseRevision": base, "revision": revision, "reset": reset, "events": events,
         "removed": removed, "order": order, "limited": false, "phase": "actor", "finished": finished]
    }
    static func unchanged(_ revision: Int = 1) -> [String: Any] {
        ["unchanged": true, "streamID": "stream-1", "revision": revision]
    }
}
// Decode independently of the production frame encoder. Optional log accepts
// both JSON null and an omitted field; present metadata fields are asserted below.
struct Frame: Decodable {
    struct Event: Decodable {
        let id: String, title: String, detail: String, role: String, kind: String
        let titleCode: String?, status: String?, detailTruncated: Bool, round: Int?
    }
    struct Log: Decodable {
        let id: String, actionID: String, position: Int?, revisionIndex: Int
        let startedAt: String?, endedAt: String?, events: [Event]?
        let loading: Bool, failed: Bool, limited: Bool, superseded: Bool, progressing: Bool
    }
    let schemaVersion: Int, subscriptionID: UInt64, sequence: UInt64, baseSequence: UInt64
    let reset: Bool, log: Log?, events: [Event], removed: [String], order: [String]
}
@MainActor final class Sender {
    struct Delivery { let id: UInt64, sequence: UInt64, json: String }
    var deliveries: [Delivery] = []
    var readiness: [Bool] = []
    var ready = false, accepts = true, autoACK = false
    var onReady: (@MainActor (Bool) -> Void)?
    private var deliveryWaiters: [(Int, CheckedContinuation<Void, Never>)] = []
    lazy var channel: TAHWorkingLogChannel = TAHWorkingLogChannel(send: { [weak self] id, sequence, json in
        guard let self else { return false }
        deliveries.append(.init(id: id, sequence: sequence, json: json))
        let satisfied = deliveryWaiters.filter { $0.0 <= deliveries.count }
        deliveryWaiters.removeAll { $0.0 <= deliveries.count }
        for (_, waiter) in satisfied { waiter.resume() }
        if autoACK { channel.acknowledge(id, sequence: sequence) }
        return accepts
    }, readiness: { [weak self] value in
        guard let self else { return }
        ready = value
        if readiness.last != value { readiness.append(value) }
        onReady?(value)
    })
    func wait(_ count: Int) async {
        if deliveries.count >= count { return }
        await withCheckedContinuation { deliveryWaiters.append((count, $0)) }
    }
    func frame(_ index: Int) throws -> Frame {
        let sent = deliveries[index]
        let value = try JSONDecoder().decode(Frame.self, from: Data(sent.json.utf8))
        let raw = try JSONSerialization.jsonObject(with: Data(sent.json.utf8)) as! [String: Any]
        if let metadata = raw["log"] as? [String: Any] {
            try Check.require(metadata["events"] == nil, "log metadata must omit events entirely; event bodies belong at frame root")
        }
        try Check.require(value.schemaVersion == 1 && value.subscriptionID == sent.id && value.sequence == sent.sequence,
                          "wire schema/subscription/sequence differs from send callback")
        try Check.require(value.log?.events?.isEmpty != false, "metadata duplicated event bodies")
        return value
    }
    func ack(_ index: Int) { let f = deliveries[index]; channel.acknowledge(f.id, sequence: f.sequence) }
    func report() -> [String: Any] {
        let decoded = deliveries.compactMap { try? JSONDecoder().decode(Frame.self, from: Data($0.json.utf8)) }
        return ["readinessTransitions": readiness, "frameCount": deliveries.count,
                "resetCount": decoded.filter(\.reset).count, "deltaCount": decoded.filter { !$0.reset }.count,
                "metadataOnlyDeltaCount": decoded.filter { !$0.reset && $0.events.isEmpty && $0.removed.isEmpty }.count,
                "frames": deliveries.map { d in
            let f = try? JSONDecoder().decode(Frame.self, from: Data(d.json.utf8))
            let raw = (try? JSONSerialization.jsonObject(with: Data(d.json.utf8))) as? [String: Any]
            return ["subscriptionID": d.id, "sequence": d.sequence, "baseSequence": f?.baseSequence as Any? ?? NSNull(),
                    "reset": f?.reset as Any? ?? NSNull(), "paneID": f?.log?.id as Any? ?? NSNull(),
                    "upsertCount": f?.events.count ?? 0, "removedCount": f?.removed.count ?? 0, "orderCount": f?.order.count ?? 0,
                    "metadataContainsEvents": (raw?["log"] as? [String: Any])?["events"] != nil,
                    "eventIDs": f?.events.map(\.id) ?? [], "detailBytes": f?.events.map { $0.detail.utf8.count } ?? [],
                    "removed": f?.removed ?? [], "order": f?.order ?? [], "wireBytes": d.json.utf8.count] as [String: Any]
        }]
    }
}
@MainActor final class Source {
    struct Call: Equatable { let method: String, fields: [String: TAHRuntimeValue] }
    struct Response { let body: [String: Any]?, gate: Gate? }
    var responses: [Response] = [], calls: [Call] = [], releases: [String] = []
    var releaseSignals: [String: Signal] = [:]
    var cursor = 0
    func enqueue(_ body: [String: Any]?, gate: Gate? = nil) { responses.append(.init(body: body, gate: gate)) }
    func call(_ method: String, _ fields: [String: TAHRuntimeValue]) async throws -> TAHMemoryWorkingLogReader.Reply {
        calls.append(.init(method: method, fields: fields))
        guard cursor < responses.count else { throw TAHRuntimeError.unavailable }
        let response = responses[cursor]; cursor += 1
        if let gate = response.gate { await gate.stop() }
        guard let body = response.body else { throw TAHRuntimeError.unavailable }
        return try Fixture.decode(body, TAHMemoryWorkingLogReader.Reply.self)
    }
    func release(_ id: String) { releases.append(id); releaseSignals[id]?.fire() }
    func released(_ id: String) async {
        if releases.contains(id) { return }
        let signal = releaseSignals[id] ?? Signal(); releaseSignals[id] = signal; await signal.wait()
    }
    func expectCalls(_ nextRevisions: [Int], opens: Int = 1) throws {
        let expected = Array(repeating: Call(method: "action.workingOpen", fields: ["actionID": .string("a"), "operationID": .string("op")]), count: opens)
            + nextRevisions.map { Call(method: "action.workingNext", fields: ["streamID": .string("stream-1"), "afterRevision": .integer($0)]) }
        try Check.require(calls == expected, "RPC sequence/fields differ: \(calls) != \(expected)")
    }
    func report() -> [String: Any] {
        ["calls": calls.map { ["method": $0.method, "fields": $0.fields.mapValues { String(describing: $0) }] }, "releases": releases]
    }
}
@MainActor final class Reader {
    let source = Source()
    var ready = true
    var states: [TAHUIWorkingLog?] = []
    var onChange: (@MainActor (TAHUIWorkingLog?) -> Void)?
    lazy var reader = TAHMemoryWorkingLogReader(call: { [source] in try await source.call($0, $1) },
        release: { [source] in source.release($0) }, canRead: { [weak self] in self?.ready == true },
        changed: { [weak self] state in self?.states.append(state); self?.onChange?(state) })
    func open(_ hash: String = "initial") throws { reader.open(try Fixture.reference(hash)) }
    func update(_ hash: String, op: String = "op", sourceKey: String? = nil) throws {
        reader.update(reference: try Fixture.reference(hash, op: op), actionID: "a", operationID: op, sourceKey: sourceKey)
    }
    func settle() async { await reader.waitForUpdates() }
    func seed() async throws { source.enqueue(Check.reply()); try open(); await settle() }
    func join() async -> Task<Void, Never> {
        let entered = Signal()
        let joined = Task { @MainActor in entered.fire(); await reader.waitForUpdates() }
        await entered.wait(); return joined
    }
    func report() -> [String: Any] {
        var result = source.report()
        result["states"] = states.map { state -> Any in
            guard let s = state else { return NSNull() }
            return ["id": s.id, "eventIDs": s.events.map(\.id), "loading": s.loading, "failed": s.failed,
                    "superseded": s.superseded, "progressing": s.progressing, "limited": s.limited]
        }
        return result
    }
}
@MainActor final class Integrated {
    let sender = Sender(), reader = Reader()
    init() {
        reader.ready = false
        sender.onReady = { [weak reader] ready in
            guard let reader else { return }
            reader.ready = ready
            if ready { reader.reader.resume() }
        }
        reader.onChange = { [weak sender] in sender?.channel.update($0) }
    }
    func drainLoading() async throws {
        sender.channel.subscribe(70, value: nil)
        try reader.open()
        await sender.wait(1)
        try Check.require(reader.source.calls.isEmpty, "RPC before reset ACK")
        sender.ack(0); await sender.wait(2)
        try Check.require(reader.source.calls.isEmpty, "RPC before loading ACK")
        sender.ack(1); await reader.settle(); await sender.wait(3)
    }
    func report() -> [String: Any] { ["sender": sender.report(), "reader": reader.report()] }
}
@main struct ChannelChecks {
    @MainActor static func main() async throws {
        let selected = CommandLine.arguments.dropFirst().first
        var results: [[String: Any]] = [], names: [String] = []
        func run(_ name: String, _ body: () async throws -> [String: Any]) async {
            names.append(name)
            guard selected != "--list", selected == nil || selected == name else { return }
            var result: [String: Any] = ["name": name]
            do { result.merge(try await body()) { _, new in new }; result["passed"] = true }
            catch { result["passed"] = false; result["error"] = (error as NSError).localizedDescription }
            results.append(result)
        }
        await run("sender-first-nil-reset") {
            let s = Sender(); s.channel.subscribe(1, value: nil); await s.wait(1)
            let f = try s.frame(0)
            try Check.require(f.reset && f.sequence == 1 && f.baseSequence == 0 && f.log == nil && f.events.isEmpty && f.removed.isEmpty && f.order.isEmpty,
                              "nil first frame must be an empty reset")
            try Check.require(!s.ready, "unacknowledged nil reset was ready")
            s.ack(0); s.channel.update(nil); await Check.idle()
            try Check.require(s.ready && s.deliveries.count == 1, "nil ACK did not settle")
            return s.report()
        }
        await run("sender-first-state-roundtrip") {
            let s = Sender(), detail = "公开\n\"quoted\"\\tool 🚀"
            s.channel.subscribe(2, value: Check.log("pane", [Check.event("e", detail)])); await s.wait(1)
            let f = try s.frame(0), e = f.events[0]
            try Check.require(f.reset && f.baseSequence == 0 && f.order == ["e"] && f.removed.isEmpty,
                              "initial state frame envelope differs")
            try Check.require(f.log?.id == "pane" && f.log?.actionID == "a" && f.log?.position == nil && f.log?.revisionIndex == 1 && f.log?.endedAt == nil,
                              "pane metadata/nullable values changed")
            try Check.require(e.id == "e" && e.title == "Public tool" && e.detail == detail && e.role == "actor" && e.kind == "tool" && e.titleCode == nil && e.status == "completed" && !e.detailTruncated && e.round == 0,
                              "event body failed JSON roundtrip")
            return s.report()
        }
        await run("sender-10000-noack-latest-delta-and-invalid-acks") {
            let s = Sender(), keep = Check.event("keep", String(repeating: "UNCHANGED-公开", count: 100_000))
            s.channel.subscribe(3, value: Check.log("pane", [Check.event("edit", "0"), keep, Check.event("gone")])); await s.wait(1)
            for index in 1...10_000 { s.channel.update(Check.log("pane", [Check.event("added"), Check.event("edit", "\(index)"), keep])) }
            s.channel.acknowledge(999, sequence: 1); s.channel.acknowledge(3, sequence: 0); s.channel.acknowledge(3, sequence: 2)
            await Check.idle()
            try Check.require(s.deliveries.count == 1 && !s.ready, "no-ACK updates or invalid ACK grew delivery queue")
            s.ack(0); await s.wait(2)
            let f = try s.frame(1)
            try Check.require(!f.reset && f.baseSequence == 1 && f.sequence == 2 && f.events.map(\.id) == ["added", "edit"] && f.events[1].detail == "10000" && f.removed == ["gone"] && f.order == ["added", "edit", "keep"],
                              "ACK did not send just latest same-ID delta/removal/order")
            try Check.require(s.deliveries[1].json.utf8.count < 2048 && !s.deliveries[1].json.contains("UNCHANGED"), "unchanged large event retransmitted")
            s.ack(0); s.channel.acknowledge(88, sequence: 2); await Check.idle()
            try Check.require(!s.ready && s.deliveries.count == 2, "duplicate/wrong-subscription ACK released latest flight")
            s.ack(1); await Check.idle()
            try Check.require(s.ready && s.deliveries.count == 2, "10000 intermediate states queued instead of coalesced")
            return s.report()
        }
        await run("sender-pane-close-reopen-with-old-frame-inflight") {
            let s = Sender(); s.channel.subscribe(4, value: Check.log("old", [Check.event("old")])); await s.wait(1)
            s.channel.update(nil); s.channel.update(Check.log("new", [Check.event("new")]))
            s.ack(0); await s.wait(2); let f = try s.frame(1)
            try Check.require(f.reset && f.log?.id == "new" && f.events.map(\.id) == ["new"] && f.order == ["new"], "old pane overwrote reopened pane")
            s.ack(0); try Check.require(!s.ready, "stale pane ACK released new flight")
            s.ack(1); try Check.require(s.ready, "new pane ACK failed")
            return s.report()
        }
        await run("sender-large-changed-body-and-metadata-only-delta") {
            let s = Sender(), body = String(repeating: "公开\n", count: 100_000)
            var log = Check.log("large", [Check.event("keep", body), Check.event("edit", body)])
            s.channel.subscribe(14, value: log); await s.wait(1); s.ack(0)
            log.events[1] = Check.event("edit", body + "changed")
            s.channel.update(log); await s.wait(2); let delta = try s.frame(1)
            try Check.require(!delta.reset && delta.baseSequence == 1 && delta.events.count == 1 && delta.events[0].id == "edit" && delta.events[0].detail == body + "changed" && delta.removed.isEmpty && delta.order == ["keep", "edit"], "large content delta duplicated, truncated, or lost unchanged IDs")
            s.ack(1); log.progressing = false; log.endedAt = "2026-11-01T02:00:00Z"
            s.channel.update(log); await s.wait(3); let metadata = try s.frame(2)
            try Check.require(!metadata.reset && metadata.baseSequence == 2 && metadata.events.isEmpty && metadata.removed.isEmpty && metadata.order == ["keep", "edit"] && metadata.log?.progressing == false && metadata.log?.endedAt == log.endedAt && s.deliveries[2].json.utf8.count < 1024, "metadata-only delta resent event bodies or lost terminal metadata")
            s.ack(2); await Check.idle()
            try Check.require(s.ready && s.deliveries.count == 3, "large-content updates did not settle")
            return s.report()
        }
        await run("sender-unsubscribe-cancels-pending-encode-and-new-subscription") {
            let s = Sender()
            // Both calls run synchronously on MainActor before the encoding task can start.
            s.channel.subscribe(5, value: Check.log("cancelled", [Check.event("old")]))
            s.channel.unsubscribe(5); await Check.idle()
            try Check.require(s.deliveries.isEmpty && !s.ready, "cancelled encoding sent a frame")
            s.channel.subscribe(6, value: Check.log("new", [Check.event("new")])); await s.wait(1)
            s.channel.unsubscribe(5); s.channel.acknowledge(5, sequence: 1)
            try Check.require(!s.ready && (try s.frame(0)).log?.id == "new", "stale subscription affected replacement")
            s.ack(0); try Check.require(s.ready, "replacement subscription cannot settle")
            return s.report()
        }
        await run("sender-resubscribe-old-flight-and-encode-generation") {
            let s = Sender(); s.channel.subscribe(10, value: Check.log("old")); await s.wait(1)
            s.channel.unsubscribe(10); s.channel.subscribe(11, value: Check.log("abandoned"))
            s.channel.subscribe(12, value: Check.log("latest", [Check.event("latest")]))
            await s.wait(2); await Check.idle()
            try Check.require(s.deliveries.count == 2 && s.deliveries[1].id == 12 && (try s.frame(1)).log?.id == "latest", "cancelled generation sent/overwrote latest frame")
            s.channel.acknowledge(10, sequence: 1); s.channel.acknowledge(11, sequence: 1)
            try Check.require(!s.ready, "old subscription ACK accepted")
            s.ack(1); return s.report()
        }
        await run("sender-send-failure-unsubscribes") {
            let s = Sender(); s.accepts = false; s.channel.subscribe(9, value: nil); await s.wait(1)
            s.channel.update(Check.log()); s.ack(0); await Check.idle()
            try Check.require(s.deliveries.count == 1 && !s.ready, "failed send retained active subscription")
            return s.report()
        }
        await run("reader-blocked-10000-events-resume-one-latest-open") {
            let p = Reader(); p.ready = false; p.source.enqueue(Check.reply(events: [Check.wireEvent("latest", "10000")], order: ["latest"]))
            try p.open()
            for index in 1...10_000 { try p.update("hash-\(index)") }
            await p.settle(); await Check.idle()
            try Check.require(p.source.calls.isEmpty && p.reader.state?.loading == true, "blocked consumer made RPC")
            p.ready = true; p.reader.resume(); await p.settle(); p.reader.resume(); await p.settle()
            try p.source.expectCalls([])
            try Check.require(p.reader.state?.events.first?.detail == "10000" && p.reader.state?.failed == false, "resume did not open latest Core state")
            return p.report()
        }
        await run("reader-valid-upsert-remove-order-and-cursor") {
            let p = Reader()
            p.source.enqueue(Check.reply(events: [Check.wireEvent("edit", "old"), Check.wireEvent("gone"), Check.wireEvent("keep")], order: ["edit", "gone", "keep"]))
            try p.open(); await p.settle(); let id = p.reader.state?.id
            p.source.enqueue(Check.reply(events: [Check.wireEvent("edit", "new"), Check.wireEvent("added")], order: ["added", "keep", "edit"], reset: false, base: 1, revision: 2, removed: ["gone"]))
            try p.update("new"); await p.settle(); try p.source.expectCalls([1])
            try Check.require(p.reader.state?.id == id && p.reader.state?.events.map(\.id) == ["added", "keep", "edit"] && p.reader.state?.events.last?.detail == "new", "valid delta did not replace same-ID body/remove/reorder")
            return p.report()
        }
        await run("reader-unchanged-fast-path-settles") {
            let p = Reader(); try await p.seed(); let before = p.states.count
            p.source.enqueue(Check.unchanged()); try p.update("notification"); await p.settle()
            for _ in 0..<100 { p.reader.resume(); try p.update("notification") }
            await p.settle(); try p.source.expectCalls([1])
            try Check.require(p.states.count == before && p.reader.state?.loading == false && p.reader.state?.failed == false,
                              "unchanged response caused publication or polling loop")
            return p.report()
        }
        await run("reader-samehash-new-sourceKey-flushes-finished-metadata") {
            let p = Reader(); try await p.seed()
            p.source.enqueue(Check.unchanged()); try p.update("initial", sourceKey: "active-op"); await p.settle()
            p.source.enqueue(Check.reply(events: [], order: ["seed"], reset: false, base: 1, revision: 2, finished: true))
            try p.update("initial", sourceKey: nil); await p.settle()
            try p.source.expectCalls([1, 1])
            try Check.require(p.reader.state?.progressing == false && p.reader.state?.events.map(\.id) == ["seed"], "same hash/phase sourceKey change did not flush finished metadata")
            // Repeating the source key must not issue another RPC.
            try p.update("initial", sourceKey: nil); await p.settle(); try p.source.expectCalls([1, 1])
            return p.report()
        }
        await run("reader-repeated-summary-preserves-Core-finished-metadata") {
            let p = Reader(); try await p.seed()
            p.source.enqueue(Check.reply(events: [], order: ["seed"], reset: false, base: 1, revision: 2, finished: true))
            try p.update("initial", sourceKey: "finished-source"); await p.settle()
            try Check.require(p.reader.state?.progressing == false, "Core finished response did not stop progression")
            try p.update("initial", sourceKey: "finished-source"); await p.settle(); try p.source.expectCalls([1])
            try Check.require(p.reader.state?.progressing == false, "same unchanged summary restarted progression after Core finished=true, without an RPC")
            return p.report()
        }
        await run("reader-superseded-operation-releases-live-stream") {
            let p = Reader(); try await p.seed(); let prior = p.reader.state!.events, id = p.reader.state!.id
            try p.update("new", op: "replacement"); await p.source.released("stream-1")
            p.reader.refresh(id: id); p.reader.resume(); await p.settle()
            try p.source.expectCalls([])
            try Check.require(p.source.releases == ["stream-1"] && p.reader.state?.events == prior && p.reader.state?.superseded == true && p.reader.state?.progressing == false && p.reader.state?.loading == false,
                              "superseded stream was not released/preserved/stopped")
            return p.report()
        }
        await run("reader-source-error-preserves-prior-state-and-retry") {
            let p = Reader(); try await p.seed(); let prior = p.reader.state!, id = prior.id
            p.source.enqueue(nil); try p.update("failing"); await p.settle(); try p.source.expectCalls([1])
            try Check.require(p.reader.state?.id == id && p.reader.state?.events == prior.events && p.reader.state?.failed == true && p.reader.state?.loading == false && p.reader.state?.error != nil,
                              "source error discarded previous content or did not surface failure")
            try p.update("failing"); await p.settle(); try p.source.expectCalls([1])
            p.source.enqueue(Check.reply(events: [Check.wireEvent("recovered")], order: ["recovered"], stream: "stream-2"))
            p.reader.refresh(id: id); await p.settle(); await p.source.released("stream-1")
            try Check.require(p.source.calls.map(\.method) == ["action.workingOpen", "action.workingNext", "action.workingOpen"] && p.reader.state?.id == id && p.reader.state?.failed == false && p.reader.state?.events.map(\.id) == ["recovered"], "explicit retry did not release/reopen/recover")
            return p.report()
        }
        await run("reader-close-reopen-discards-late-open-and-releases-lease") {
            let p = Reader(), gate = Gate()
            p.source.enqueue(Check.reply(events: [Check.wireEvent("old")], order: ["old"]), gate: gate)
            try p.open(); await gate.entered.wait(); let old = await p.join()
            p.reader.close()
            p.source.enqueue(Check.reply(events: [Check.wireEvent("new")], order: ["new"], stream: "stream-2"))
            try p.open("new"); await p.settle(); let current = p.reader.state!
            gate.released.fire(); await old.value; await p.source.released("stream-1")
            try Check.require(p.reader.state == current && current.events.map(\.id) == ["new"] && p.source.releases == ["stream-1"], "late open overwrote new pane/leaked lease")
            return p.report()
        }
        await run("reader-supersede-during-next-discards-late-data") {
            let p = Reader(), gate = Gate(); try await p.seed(); let prior = p.reader.state!.events
            p.source.enqueue(Check.reply(events: [Check.wireEvent("late")], order: ["seed", "late"], reset: false, base: 1, revision: 2), gate: gate)
            try p.update("pending"); await gate.entered.wait(); let old = await p.join()
            try p.update("replacement", op: "new-op"); await p.source.released("stream-1")
            gate.released.fire(); await old.value
            try Check.require(p.reader.state?.superseded == true && p.reader.state?.events == prior && p.source.releases == ["stream-1"], "late next mutated superseded pane or released twice")
            return p.report()
        }
        // Invalid replies must leave all prior verified events and the Core cursor intact.
        let invalid: [(String, (inout [String: Any]) -> Void)] = [
            ("schema", { $0["schemaVersion"] = 2 }),
            ("action-ID", { $0["actionID"] = "other" }),
            ("operation-ID", { $0["operationID"] = "other" }),
            ("stream-ID", { $0["streamID"] = "other" }),
            ("base-revision", { $0["baseRevision"] = 0 }),
            ("revision-skip", { $0["revision"] = 3 }),
            ("unexpected-reset", { $0["reset"] = true }),
            ("duplicate-event-ID", { $0["events"] = [Check.wireEvent("seed"), Check.wireEvent("seed")] }),
            ("duplicate-removed-ID", { $0["removed"] = ["missing", "missing"] }),
            ("duplicate-order-ID", { $0["order"] = ["seed", "seed"] }),
            ("unknown-order-ID", { $0["order"] = ["seed", "missing"] }),
            ("missing-order-ID", { $0["order"] = [] }),
            ("overlapping-upsert-remove", { $0["removed"] = ["seed"] }),
            ("private-event", { var e = Check.wireEvent("seed", "PRIVATE-GUARDIAN"); e["role"] = "raw_guardian"; $0["events"] = [e] }),
            ("disguised-guardian", { var e = Check.wireEvent("extra-safety-pass"); e["role"] = "extra_guardian"; e["titleCode"] = "safety_guardian"; e["status"] = "pass"; $0["events"] = [e]; $0["order"] = ["seed", "extra-safety-pass"] }),
            ("513-events", { $0["events"] = (0..<513).map { Check.wireEvent("\($0)") }; $0["order"] = (0..<513).map { "\($0)" } }),
            ("4MiB-body-bound", { $0["events"] = [Check.wireEvent("seed", String(repeating: "x", count: 4 * 1024 * 1024 + 1))] }),
            ("unchanged-wrong-stream", { $0 = ["unchanged": true, "streamID": "wrong", "revision": 1] }),
            ("unchanged-wrong-revision", { $0 = Check.unchanged(2) })
        ]
        for (name, mutate) in invalid {
            await run("reader-rejects-\(name)-preserves-events-and-cursor") {
                let p = Reader(); try await p.seed(); let prior = p.reader.state!
                var bad = Check.reply(events: [Check.wireEvent("seed", "must not publish")], reset: false, base: 1, revision: 2)
                mutate(&bad); p.source.enqueue(bad); try p.update("bad"); await p.settle()
                try Check.require(p.reader.state?.id == prior.id && p.reader.state?.events == prior.events && p.reader.state?.failed == true && p.reader.state?.loading == false,
                                  "invalid \(name) reply was applied or discarded prior events")
                try Check.require(!p.states.compactMap { $0 }.flatMap(\.events).contains { $0.detail.contains("PRIVATE-GUARDIAN") || $0.detail == "must not publish" }, "rejected content escaped through changed callback")
                p.source.enqueue(Check.unchanged()); try p.update("recover"); await p.settle()
                try p.source.expectCalls([1, 1])
                try Check.require(p.reader.state?.failed == false && p.reader.state?.events == prior.events, "invalid reply advanced cursor or prevented unchanged recovery")
                return p.report()
            }
        }
        for (name, key, value) in [("initial-base", "baseRevision", 1), ("initial-revision", "revision", 2)] {
            await run("reader-rejects-\(name)") {
                let p = Reader(); var bad = Check.reply(); bad[key] = value; p.source.enqueue(bad)
                try p.open(); await p.settle()
                try Check.require(p.reader.state?.failed == true && p.reader.state?.events.isEmpty == true, "invalid initial cursor accepted")
                return p.report()
            }
        }
        await run("integration-ACK-gates-open-next-coalesces-and-unchanged-settles") {
            let p = Integrated(); p.reader.source.enqueue(Check.reply())
            try await p.drainLoading(); try p.reader.source.expectCalls([])
            let loaded = try p.sender.frame(2)
            try Check.require(loaded.events.map(\.id) == ["seed"] && !p.sender.ready, "loaded data frame did not gate reader")
            for index in 1...10_000 { try p.reader.update("pending-\(index)") }
            await p.reader.settle(); try p.reader.source.expectCalls([])
            p.reader.source.enqueue(Check.reply(events: [Check.wireEvent("seed", "latest")], reset: false, base: 1, revision: 2))
            p.sender.ack(2); await p.reader.settle(); await p.sender.wait(4)
            try p.reader.source.expectCalls([1]); let delta = try p.sender.frame(3)
            try Check.require(!delta.reset && delta.baseSequence == 3 && delta.events.map(\.detail) == ["latest"], "ACK did not resume one latest next/delta")
            p.reader.source.enqueue(Check.unchanged(2)); try p.reader.update("unchanged")
            p.sender.ack(3); await p.reader.settle(); await Check.idle()
            try p.reader.source.expectCalls([1, 2])
            try Check.require(p.sender.ready && p.sender.deliveries.count == 4 && !p.reader.reader.state!.failed, "unchanged response deadlocked or emitted unnecessary frame")
            return p.report()
        }
        await run("integration-synchronous-send-ACK-reentrancy") {
            let p = Integrated(); p.sender.autoACK = true
            p.reader.source.enqueue(Check.reply()); p.sender.channel.subscribe(70, value: nil)
            try p.reader.open(); await p.sender.wait(3); await p.reader.settle()
            try p.reader.source.expectCalls([])
            let gate = Gate()
            p.reader.source.enqueue(Check.reply(events: [Check.wireEvent("seed", "B")], reset: false, base: 1, revision: 2), gate: gate)
            p.reader.source.enqueue(Check.reply(events: [Check.wireEvent("seed", "C")], reset: false, base: 2, revision: 3))
            try p.reader.update("B"); await gate.entered.wait(); try p.reader.update("C"); gate.released.fire()
            await p.sender.wait(5); await p.reader.settle()
            try p.reader.source.expectCalls([1, 2])
            try Check.require(p.sender.ready && p.reader.reader.state?.events.first?.detail == "C" && (try p.sender.frame(4)).events.map(\.detail) == ["C"], "synchronous ACK/changed/readiness cycle lost dirty update or deadlocked")
            return p.report()
        }
        let output: Any = selected == "--list" ? names : ["passed": !results.isEmpty && results.allSatisfy { $0["passed"] as? Bool == true }, "checks": results]
        print(String(decoding: try JSONSerialization.data(withJSONObject: output, options: [.sortedKeys]), as: UTF8.self))
    }
}
'''


def fixture_prefix():
    module = ast.parse(BASE.read_text())
    values = [ast.literal_eval(node.value) for node in module.body
              if isinstance(node, ast.Assign)
              and any(isinstance(target, ast.Name) and target.id == "SWIFT" for target in node.targets)]
    if len(values) != 1 or values[0].count("@MainActor final class Source") != 1:
        raise RuntimeError("Fixture prefix boundary changed; inspect working-log-checks.py")
    return values[0].split("@MainActor final class Source", 1)[0]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--case", help="Run one named scenario")
    parser.add_argument("--skip-simulator", action="store_true", help="Host-only diagnostic run")
    args = parser.parse_args()
    out = Path(tempfile.mkdtemp(prefix="alma-working-channel-")).resolve()
    result = {"passed": False, "artifacts": str(out), "commands": [], "sourceSHA256": {},
              "checks": [], "providerCalls": 0, "phoneTouched": False, "timedSleeps": 0,
              "scheduling": "manual continuations; 128 bounded yields only for no-work assertions",
              "caseTimeoutSeconds": 20}

    def run(command, label, timeout=120, **kwargs):
        result["commands"].append(command)
        proc = subprocess.run(command, text=True, capture_output=True, timeout=timeout, **kwargs)
        (out / f"{label}.stdout").write_text(proc.stdout)
        (out / f"{label}.stderr").write_text(proc.stderr)
        if proc.stderr:
            result[f"{label}Diagnostics"] = proc.stderr
        if proc.returncode:
            raise RuntimeError(f"{label} exited {proc.returncode}: {proc.stderr}{proc.stdout}")
        return proc.stdout

    try:
        fixture = out / "ChannelChecks.swift"
        fixture.write_text(fixture_prefix() + SWIFT)
        result["fixtureSHA256"] = hashlib.sha256(fixture.read_bytes()).hexdigest()
        result["fixtureSourceSHA256"] = hashlib.sha256(BASE.read_bytes()).hexdigest()
        sources = []
        root = ROOT / "apps/ios/Sources/AlmaTAH"
        for source in sorted(root.rglob("*.swift")):
            if source.name == "TAHCodexPlatform.swift":
                continue
            data = source.read_bytes()
            target = out / "sources" / source.relative_to(root)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            sources.append(str(target))
            result["sourceSHA256"][str(source.relative_to(ROOT))] = hashlib.sha256(data).hexdigest()
        common = ["-swift-version", "6", "-strict-concurrency=complete", "-parse-as-library", "-module-cache-path", str(out / "cache")]
        run(["xcrun", "swiftc", *common, *sources, str(fixture), "-lsqlite3", "-framework", "JavaScriptCore", "-o", str(out / "checks")], "hostCompile")
        result["hostCompilePassed"] = True
        names = json.loads(run([str(out / "checks"), "--list"], "list", timeout=20))
        if args.case and args.case not in names:
            raise RuntimeError(f"Unknown case {args.case}; available: {names}")
        for index, name in enumerate([args.case] if args.case else names):
            try:
                checked = json.loads(run([str(out / "checks"), name], f"case-{index}", timeout=20))
                result["checks"].extend(checked["checks"])
            except Exception as error:
                result["checks"].append({"name": name, "passed": False, "error": str(error)})
        if not args.skip_simulator:
            sdk = run(["xcrun", "--sdk", "iphonesimulator", "--show-sdk-path"], "simulatorSDK").strip()
            sim_sources = [p for p in sources if Path(p).name not in {"TAHHistoryView.swift", "TAHMobileView.swift"}]
            run(["xcrun", "--sdk", "iphonesimulator", "swiftc", *common, "-sdk", sdk,
                 "-target", "arm64-apple-ios18.0-simulator", "-typecheck", *sim_sources, str(fixture)],
                "simulatorTypecheck", env=dict(os.environ, SDKROOT=sdk))
            result["simulatorTypecheckPassed"] = True
        result["passed"] = bool(result["checks"]) and all(c["passed"] for c in result["checks"])
    except Exception as error:
        result["error"] = str(error)
        result["passed"] = False
    result["sourcesChangedDuringRun"] = [path for path, digest in result["sourceSHA256"].items()
                                         if hashlib.sha256((ROOT / path).read_bytes()).hexdigest() != digest]
    RESULT.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({"passed": result["passed"], "checks": len(result["checks"]),
                      "failures": [c for c in result["checks"] if not c["passed"]],
                      "error": result.get("error"), "result": str(RESULT), "artifacts": str(out),
                      "sourcesChangedDuringRun": result["sourcesChangedDuringRun"]}))
    return 0 if result["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
