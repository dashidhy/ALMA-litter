import Foundation

/// A display subscription to the Core's bounded, public in-memory event view.
/// No journal scan or hash/chunk catch-up loop runs on this path.
@MainActor
final class TAHMemoryWorkingLogReader {
    typealias Reference = TAHMobileWorkingLogReader.Reference
    typealias Value = TAHRuntimeValue
    struct Reply: Decodable, Sendable {
        let unchanged: Bool?
        let schemaVersion: Int?
        let streamID: String
        let actionID: String?
        let operationID: String?
        let baseRevision: Int?
        let revision: Int
        let reset: Bool?
        let events: [TAHMobileController.AppAction.Event]?
        let removed: [String]?
        let order: [String]?
        let limited: Bool?
        let phase: String?
        let finished: Bool?
    }
    private(set) var state: TAHUIWorkingLog?
    private let call: @MainActor (String, [String: Value]) async throws -> Reply
    private let release: @MainActor (String) async -> Void
    private let canRead: @MainActor () -> Bool
    private let changed: @MainActor (TAHUIWorkingLog?) -> Void
    private var anchor: Reference?
    private var generation = UUID()
    private var worker: Task<Void, Never>?
    private var streamID: String?
    private var revision = 0
    private var dirty = false
    private var observedHash: String?
    private var observedPhase: String?
    private var observedSourceKey: String?
    private var finished = false

    init(call: @escaping @MainActor (String, [String: Value]) async throws -> Reply,
         release: @escaping @MainActor (String) async -> Void,
         canRead: @escaping @MainActor () -> Bool,
         changed: @escaping @MainActor (TAHUIWorkingLog?) -> Void) {
        self.call = call; self.release = release; self.canRead = canRead; self.changed = changed
    }
    func open(_ reference: Reference) {
        close(); anchor = reference; observedHash = reference.hash; observedPhase = reference.summary.phase
        state = .init(id: UUID().uuidString.lowercased(), actionID: reference.actionID, position: nil,
                      revisionIndex: reference.summary.revisionIndex, startedAt: reference.summary.startedAt,
                      endedAt: reference.summary.endedAt, criticPassed: reference.summary.criticPassed,
                      loading: true, limited: reference.limited, progressing: reference.summary.progressing)
        dirty = true; changed(state); resume()
    }
    func close() {
        generation = UUID(); worker?.cancel(); worker = nil
        if let streamID { let release = release; Task { await release(streamID) } }
        streamID = nil; revision = 0; dirty = false; anchor = nil; finished = false
        observedHash = nil; observedPhase = nil; observedSourceKey = nil; state = nil; changed(nil)
    }
    func update(reference: Reference?, actionID: String?, operationID: String?, sourceKey: String? = nil) {
        guard let anchor, var next = state else { return }
        guard actionID == anchor.actionID else { close(); return }
        guard operationID == anchor.operationID else {
            generation = UUID(); worker?.cancel(); worker = nil; dirty = false
            if let streamID { let release = release; Task { await release(streamID) } }
            streamID = nil
            next.superseded = true; next.loading = false; next.progressing = false
            publish(next); return
        }
        guard !next.superseded, let reference, reference.actionID == anchor.actionID,
              reference.operationID == anchor.operationID, reference.position == nil else { return }
        next.startedAt = reference.summary.startedAt; next.endedAt = reference.summary.endedAt
        next.criticPassed = reference.summary.criticPassed; next.progressing = reference.summary.progressing && !finished
        if observedHash != reference.hash || observedPhase != reference.summary.phase || observedSourceKey != sourceKey {
            observedHash = reference.hash; observedPhase = reference.summary.phase; dirty = true
            observedSourceKey = sourceKey
        }
        publish(next); resume()
    }
    func refresh(id: String) {
        guard state?.id == id, state?.superseded == false else { return }
        if state?.failed == true {
            generation = UUID(); worker?.cancel(); worker = nil
            if let streamID { let release = release; Task { await release(streamID) } }
            streamID = nil; revision = 0
        }
        dirty = true; resume()
    }
    func waitForUpdates() async { await worker?.value }
    func resume() {
        guard dirty, worker == nil, canRead(), let anchor, state?.superseded == false else { return }
        let token = generation
        worker = Task { [weak self] in
            guard let self else { return }
            defer { if generation == token { worker = nil; if dirty, canRead() { resume() } } }
            while dirty, generation == token, !Task.isCancelled, canRead() {
                dirty = false
                do {
                    let reply: Reply
                    if let streamID {
                        reply = try await call("action.workingNext", ["streamID": .string(streamID), "afterRevision": .integer(revision)])
                    } else {
                        guard let operationID = anchor.operationID else { throw TAHRuntimeError.invalid_request }
                        reply = try await call("action.workingOpen", ["actionID": .string(anchor.actionID), "operationID": .string(operationID)])
                    }
                    guard generation == token, !Task.isCancelled else {
                        // A late open may have acquired a lease after the pane closed.
                        if reply.reset == true { await release(reply.streamID) }
                        return
                    }
                    try apply(reply, anchor: anchor)
                } catch {
                    guard generation == token, !Task.isCancelled, var next = state else { return }
                    next.loading = false; next.failed = true
                    next.error = "Could not update working events. The last loaded events are still shown."
                    publish(next)
                }
            }
        }
    }
    private func publish(_ next: TAHUIWorkingLog) {
        guard state != next else { return }; state = next; changed(next)
    }
    private func apply(_ reply: Reply, anchor: Reference) throws {
        guard var next = state else { throw CancellationError() }
        if reply.unchanged == true {
            guard reply.streamID == streamID, reply.revision == revision else { throw TAHRuntimeError.integrity_locked }
            next.loading = false; next.failed = false; next.error = nil; publish(next); return
        }
        guard reply.schemaVersion == 1, reply.actionID == anchor.actionID, reply.operationID == anchor.operationID,
              let reset = reply.reset, let base = reply.baseRevision, let events = reply.events,
              let removed = reply.removed, let order = reply.order, let limited = reply.limited,
              let phase = reply.phase, let finished = reply.finished,
              !self.finished || finished,
              events.count <= 512, removed.count <= 512, order.count <= 512,
              Set(events.map(\.id)).count == events.count, Set(removed).count == removed.count,
              Set(order).count == order.count, events.allSatisfy(\.isPublic),
              Set(events.map(\.id)).isDisjoint(with: Set(removed)) else { throw TAHRuntimeError.integrity_locked }
        if streamID == nil {
            guard reset, base == 0, reply.revision == 1 else { throw TAHRuntimeError.integrity_locked }
        } else {
            guard !reset, reply.streamID == streamID, base == revision, reply.revision == revision + 1 else { throw TAHRuntimeError.integrity_locked }
        }
        var byID = Dictionary(uniqueKeysWithValues: (reset ? [] : next.events).map { ($0.id, $0) })
        for id in removed { byID.removeValue(forKey: id) }
        for event in events { byID[event.id] = event.projected }
        guard Set(byID.keys) == Set(order), byID.values.reduce(0, { $0 + $1.detail.utf8.count }) <= 4 * 1024 * 1024 else { throw TAHRuntimeError.integrity_locked }
        next.events = order.compactMap { byID[$0] }; next.limited = limited
        next.loading = false; next.failed = false; next.error = nil
        next.progressing = !finished && phase == "actor"
        self.finished = finished
        streamID = reply.streamID; revision = reply.revision
        publish(next)
    }
}
