import Foundation

/// Display transport only. One unacknowledged frame, one latest immutable value.
/// A slow WebView never blocks the provider or grows a queue of intermediate logs.
@MainActor
final class TAHWorkingLogChannel {
    typealias Send = @MainActor (UInt64, UInt64, String) -> Bool
    private let send: Send
    private let readiness: @MainActor (Bool) -> Void
    private var subscription: UInt64?
    private var generation = UUID()
    private var sequence: UInt64 = 0
    private var acknowledgedSequence: UInt64 = 0
    private var acknowledged: TAHUIWorkingLog?
    private var latest: TAHUIWorkingLog?
    private var flight: (sequence: UInt64, value: TAHUIWorkingLog?)?
    private var encoding: Task<Void, Never>?
    private var hasAcknowledged = false

    init(send: @escaping Send, readiness: @escaping @MainActor (Bool) -> Void) {
        self.send = send; self.readiness = readiness
    }
    func subscribe(_ id: UInt64, value: TAHUIWorkingLog?) {
        generation = UUID(); encoding?.cancel(); encoding = nil; flight = nil
        subscription = id; sequence = 0; acknowledgedSequence = 0
        acknowledged = nil; hasAcknowledged = false; latest = value
        pump()
    }
    func unsubscribe(_ id: UInt64) {
        guard subscription == id else { return }
        generation = UUID(); encoding?.cancel(); encoding = nil; flight = nil
        subscription = nil; acknowledged = nil; latest = nil; readiness(false)
    }
    func update(_ value: TAHUIWorkingLog?) {
        latest = value
        guard subscription != nil else { return }
        pump()
    }
    func acknowledge(_ id: UInt64, sequence: UInt64) {
        guard subscription == id, let flight, flight.sequence == sequence else { return }
        acknowledged = flight.value; acknowledgedSequence = sequence
        hasAcknowledged = true; self.flight = nil
        pump()
    }
    private func pump() {
        guard let id = subscription else { return }
        guard encoding == nil, flight == nil else { readiness(false); return }
        guard !hasAcknowledged || latest != acknowledged else { readiness(true); return }
        readiness(false)
        let token = generation, value = latest, previous = acknowledged
        let reset = !hasAcknowledged || value?.id != previous?.id
        sequence += 1
        let current = sequence, base = acknowledgedSequence
        encoding = Task { [weak self] in
            do {
                let json = try await Self.encode(id, sequence: current, base: base, reset: reset, previous: previous, value: value)
                guard let self, self.generation == token, !Task.isCancelled else { return }
                self.encoding = nil
                self.flight = (current, value)
                if !self.send(id, current, json) { self.unsubscribe(id) }
            } catch {
                guard let self, self.generation == token else { return }
                self.unsubscribe(id)
            }
        }
    }
    #if compiler(>=6.2)
    @concurrent
    #endif
    nonisolated private static func encode(_ id: UInt64, sequence: UInt64, base: UInt64, reset: Bool,
                                          previous: TAHUIWorkingLog?, value: TAHUIWorkingLog?) async throws -> String {
        try Task.checkCancellation()
        let old = reset ? [] : previous?.events ?? []
        let events = value?.events ?? []
        guard events.count <= 512, Set(events.map(\.id)).count == events.count else { throw TAHRuntimeError.invalid_request }
        let oldByID = Dictionary(uniqueKeysWithValues: old.map { ($0.id, $0) })
        let ids = Set(events.map(\.id))
        let changed = events.filter { oldByID[$0.id] != $0 }
        var metadata = value
        metadata?.events = []
        var log: Any = NSNull()
        if metadata != nil, var fields = TAHWebPresentationBridge.log(metadata) as? [String: Any] {
            fields.removeValue(forKey: "events"); log = fields
        }
        let frame: [String: Any] = ["schemaVersion": 1, "subscriptionID": id, "sequence": sequence,
            "baseSequence": base, "reset": reset, "log": log,
            "events": changed.map(TAHWebPresentationBridge.event),
            "removed": old.filter { !ids.contains($0.id) }.map(\.id), "order": events.map(\.id)]
        let bytes = try JSONSerialization.data(withJSONObject: frame)
        guard bytes.count <= 8 * 1024 * 1024 else { throw TAHRuntimeError.invalid_request }
        try Task.checkCancellation()
        return String(decoding: bytes, as: UTF8.self)
    }
}
