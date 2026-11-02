import CryptoKit
import Darwin
import Foundation

// Exact portable journal helpers extracted from Mac TAHRuntimeResources.swift.
// Signed Node/XPC bundle loading is intentionally outside this persistence module.
public struct TAHRuntimeResources: Sendable {
    static func digest(_ data: Data) -> String { SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined() }
    static func isDigest(_ value: String) -> Bool {
        value.range(of: "^[0-9a-f]{64}$", options: .regularExpression) != nil
    }

    static func canonicalPath(_ path: String) throws -> String {
        guard let resolved = realpath(path, nil) else { throw TAHRuntimeError.integrity_locked }
        defer { free(resolved) }
        return String(cString: resolved)
    }

}
