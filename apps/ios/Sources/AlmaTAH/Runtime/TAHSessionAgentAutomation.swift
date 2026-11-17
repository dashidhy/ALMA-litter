import Foundation
import UIKit

/// Explicit development launch only. The test driver uses the same normalized
/// UI operations as a finger; it cannot invoke arbitrary provider RPC or auth IO.
@MainActor
enum TAHSessionAgentAutomation {
    static func run(call: @escaping @MainActor (String) async throws -> String) async {
        guard ProcessInfo.processInfo.arguments.contains("--session-agent-automation"),
              let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let requestURL = documents.appendingPathComponent("session-agent-request.json")
        let responseURL = documents.appendingPathComponent("session-agent-response.json")
        let readyURL = documents.appendingPathComponent("session-agent-automation-ready.json")
        let previousIdle = UIApplication.shared.isIdleTimerDisabled
        UIApplication.shared.isIdleTimerDisabled = true
        defer { UIApplication.shared.isIdleTimerDisabled = previousIdle }
        // A command left behind by a terminated App is never auto-replayed.
        var lastID = (try? Data(contentsOf: requestURL)).flatMap { try? JSONDecoder().decode(Request.self, from: $0).id }
        let boot = UUID().uuidString
        try? JSONEncoder().encode(Ready(bootID: boot)).write(to: readyURL, options: .atomic)
        while !Task.isCancelled {
            do {
                if UIApplication.shared.applicationState == .active,
                   let data = try? Data(contentsOf: requestURL), data.count <= 128 * 1024,
                   let request = try? JSONDecoder().decode(Request.self, from: data), request.id != lastID,
                   UUID(uuidString: request.id) != nil, request.method.hasPrefix("agent.") {
                    lastID = request.id
                    let result: Response
                    do {
                        let body = try JSONEncoder().encode(Command(method: request.method, value: request.value))
                        let reply = try await call(String(decoding: body, as: UTF8.self))
                        result = Response(id: request.id, bootID: boot, result: try JSONDecoder().decode(TAHRuntimeValue.self, from: Data(reply.utf8)), error: nil)
                    } catch {
                        result = Response(id: request.id, bootID: boot, result: nil, error: "automation_command_failed")
                    }
                    try JSONEncoder().encode(result).write(to: responseURL, options: .atomic)
                }
                try await Task.sleep(nanoseconds: 300_000_000)
            } catch is CancellationError { return }
            catch { try? await Task.sleep(nanoseconds: 1_000_000_000) }
        }
    }

    private struct Request: Decodable { let id: String; let method: String; let value: TAHRuntimeValue }
    private struct Command: Encodable { let method: String; let value: TAHRuntimeValue }
    private struct Ready: Encodable { let bootID: String }
    private struct Response: Encodable { let id: String; let bootID: String; let result: TAHRuntimeValue?; let error: String? }
}
