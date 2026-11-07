import Foundation

/// Test-build-only receipt projection. Content never enters this diagnostic file.
actor TAHLoadProfile {
    private struct Row: Codable, Sendable {
        let provider: String
        let operation: String
        let hostMs: Double
        let cacheStatus: String?
        let preparationMs: Double?
        let sdkLoadMs: Double?
        let totalMs: Double?
    }
    private let directory: URL
    private let enabled: Bool
    private var rows: [Row] = []

    init(directory: URL, enabled: Bool) {
        self.directory = directory
        self.enabled = enabled
    }

    func project(method: String, result: String, hostMs: Double) throws -> String {
        let parts = method.split(separator: ".")
        guard parts.count == 3, parts[0] == "provider", ["kimi", "zcode"].contains(String(parts[1])) else { return result }
        let provider = String(parts[1]), operation = String(parts[2])
        guard ["prepare", "start", "nextEvent", "close"].contains(operation) else { return result }
        var value = try JSONSerialization.jsonObject(with: Data(result.utf8), options: .fragmentsAllowed) as? [String: Any]
        var timing: [String: Any]?
        var stripped = false
        if var terminal = value?["terminal"] as? [String: Any], terminal.keys.contains("almaLoadTiming") {
            timing = terminal.removeValue(forKey: "almaLoadTiming") as? [String: Any]
            value?["terminal"] = terminal
            stripped = true
        }
        // close 重复返回同一收据，只去掉诊断字段，不重复计入样本。
        if enabled, operation == "prepare" || operation == "start" || (operation == "nextEvent" && value?["done"] as? Bool == true) {
            let status = timing?["cacheStatus"] as? String
            let allowed = ["prepared", "missing", "identity-mismatch", "invalid", "unavailable", "unsupported", "already-enabled"]
            rows.append(Row(provider: provider, operation: operation, hostMs: Self.number(hostMs) ?? 0,
                            cacheStatus: status.flatMap { allowed.contains($0) ? $0 : nil },
                            preparationMs: Self.number(timing?["preparationMs"]), sdkLoadMs: Self.number(timing?["sdkLoadMs"]),
                            totalMs: Self.number(timing?["totalMs"])))
            if rows.count > 32 { rows.removeFirst(rows.count - 32) }
            let data = try JSONEncoder().encode(rows)
            // 独立 actor 执行小文件落盘，不占用 MainActor；每个任务最多三次。
            try data.write(to: directory.appendingPathComponent("provider-load-profile.json"), options: .atomic)
        }
        guard stripped, let value else { return result }
        return String(decoding: try JSONSerialization.data(withJSONObject: value), as: UTF8.self)
    }

    private static func number(_ value: Any?) -> Double? {
        guard let value = value as? Double, value.isFinite, value >= 0, value <= 3_600_000 else { return nil }
        return value
    }
}
