import Foundation
import Security

/// UniFFI invokes synchronous callbacks on the native provider workers. One lock
/// serializes the complete read/compare/write transaction for this Keychain item.
final class TAHZCodeCredentialStore: ZCodeCredentialStore, Sendable {
    private static let lock = NSLock()
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.alma.mobile-tah.zcode", kSecAttrAccount as String: "default"]
    }
    private func read() throws -> [String: Any] {
        var query = Self.query
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return ["revision": "empty", "account": NSNull()] }
        guard status == errSecSuccess, let data = result as? Data, data.count <= 65536,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              value["revision"] is String, value["account"] != nil else { throw MobileTahError.Unavailable }
        return value
    }
    private func encode(_ value: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]), as: UTF8.self)
    }
    func load() throws -> String {
        Self.lock.lock(); defer { Self.lock.unlock() }
        do { return try encode(read()) } catch { throw MobileTahError.Unavailable }
    }
    func compareExchange(expectedRevision: String, accountJson: String) throws -> String {
        Self.lock.lock(); defer { Self.lock.unlock() }
        do {
            let current = try read()
            guard current["revision"] as? String == expectedRevision, accountJson.utf8.count <= 60000 else {
                throw MobileTahError.Unavailable
            }
            let account = try JSONSerialization.jsonObject(with: Data(accountJson.utf8), options: [.fragmentsAllowed])
            guard account is NSNull || account is [String: Any] else { throw MobileTahError.InvalidRequest }
            let next: [String: Any] = ["revision": UUID().uuidString, "account": account]
            let serialized = try encode(next)
            let attributes: [String: Any] = [kSecValueData as String: Data(serialized.utf8),
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
            let status = SecItemUpdate(Self.query as CFDictionary, attributes as CFDictionary)
            if status == errSecItemNotFound {
                guard SecItemAdd(Self.query.merging(attributes) { _, new in new } as CFDictionary, nil) == errSecSuccess else {
                    throw MobileTahError.Unavailable
                }
            } else if status != errSecSuccess { throw MobileTahError.Unavailable }
            return serialized
        } catch { throw MobileTahError.Unavailable }
    }
}
