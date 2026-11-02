import CryptoKit
import Foundation

/// Explicit development import only. Does not start Guardian, Action or revision.
@MainActor enum TAHTranscriptImportFile {
    private struct Entry: Decodable {
        let id: String
        let materialID: String
        let title: String
        let text: String
        let sha256: String
    }
    private struct Packet: Decodable { let version: Int; let transcripts: [Entry] }

    static func run(controller: TAHMobileController) async throws {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        let input = documents.appendingPathComponent("transcript-import.json")
        let report = documents.appendingPathComponent("transcript-import-result.json")
        guard (try input.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max) <= 64 * 1024 * 1024 else { throw TAHRuntimeError.invalid_request }
        let packet = try JSONDecoder().decode(Packet.self, from: Data(contentsOf: input))
        guard packet.version == 1, !packet.transcripts.isEmpty, packet.transcripts.count <= 32,
              Set(packet.transcripts.map(\.id)).count == packet.transcripts.count else { throw TAHRuntimeError.invalid_request }
        for entry in packet.transcripts {
            let digest = SHA256.hash(data: Data(entry.text.utf8)).map { String(format: "%02x", $0) }.joined()
            guard digest == entry.sha256 else { throw TAHRuntimeError.integrity_locked }
        }
        let deadline = ContinuousClock.now + .seconds(120)
        while controller.presentation.isBusy {
            guard ContinuousClock.now < deadline else { throw TAHRuntimeError.busy }
            try await Task.sleep(for: .milliseconds(100))
        }
        for entry in packet.transcripts {
            try await controller.importPreparedTranscript(id: entry.id, materialID: entry.materialID, title: entry.title, text: entry.text)
        }
        if let first = packet.transcripts.first { controller.selectTranscript(id: first.id) }
        let value: [String: Any] = ["status": "imported", "startedActions": false,
            "transcripts": packet.transcripts.map { ["id": $0.id, "materialID": $0.materialID, "title": $0.title,
                                                     "utf8Bytes": $0.text.utf8.count, "sha256": $0.sha256] as [String: Any] }]
        try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .prettyPrinted]).write(to: report, options: .atomic)
        try FileManager.default.removeItem(at: input)
    }
}
