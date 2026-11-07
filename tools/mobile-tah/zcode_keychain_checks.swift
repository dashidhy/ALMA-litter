import Foundation
import Security

// A deterministic Security boundary. Production TAHZCodeCredentialStore is
// compiled verbatim, and no test invokes the computer's real Keychain.
protocol ZCodeCredentialStore: Sendable {
    func load() throws -> String
    func compareExchange(expectedRevision: String, accountJson: String) throws -> String
}
enum MobileTahError: Error { case Unavailable, InvalidRequest }
nonisolated(unsafe) private var stored: Data?
nonisolated(unsafe) private var failRead = false
nonisolated(unsafe) private var failWrite = false
func SecItemCopyMatching(_ query: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
    if failRead { return errSecInteractionNotAllowed }
    guard let stored else { return errSecItemNotFound }
    result?.pointee = stored as CFData
    return errSecSuccess
}
func SecItemUpdate(_ query: CFDictionary, _ attributes: CFDictionary) -> OSStatus {
    if failWrite { return errSecNotAvailable }
    guard stored != nil else { return errSecItemNotFound }
    stored = (attributes as NSDictionary)[kSecValueData] as? Data
    return errSecSuccess
}
func SecItemAdd(_ attributes: CFDictionary, _ result: UnsafeMutablePointer<CFTypeRef?>?) -> OSStatus {
    if failWrite { return errSecNotAvailable }
    guard stored == nil else { return errSecDuplicateItem }
    stored = (attributes as NSDictionary)[kSecValueData] as? Data
    return errSecSuccess
}
func parse(_ value: String) throws -> [String: Any] {
    try JSONSerialization.jsonObject(with: Data(value.utf8)) as! [String: Any]
}
func rejects(_ body: () throws -> Void) {
    do { try body(); fatalError("Expected rejection") } catch {}
}
@main struct KeychainChecks {
    static func main() throws {
        let store = TAHZCodeCredentialStore()
        let empty = try parse(store.load())
        precondition(empty["revision"] as? String == "empty")
        let first = try parse(store.compareExchange(expectedRevision: "empty", accountJson: "{\"fixture\":true}"))
        let revision = first["revision"] as! String
        rejects { _ = try store.compareExchange(expectedRevision: "empty", accountJson: "null") }
        let results = LockedResults()
        DispatchQueue.concurrentPerform(iterations: 20) { _ in
            do { _ = try store.compareExchange(expectedRevision: revision, accountJson: "{\"fixture\":true}"); results.add() }
            catch {}
        }
        precondition(results.count == 1)
        let before = try store.load()
        failRead = true
        rejects { _ = try store.load() }
        rejects { _ = try store.compareExchange(expectedRevision: revision, accountJson: "null") }
        failRead = false
        do { let after = try store.load(); precondition(after == before) }
        failWrite = true
        let current = try parse(before)["revision"] as! String
        rejects { _ = try store.compareExchange(expectedRevision: current, accountJson: "null") }
        failWrite = false
        do { let after = try store.load(); precondition(after == before) }
        let cleared = try parse(store.compareExchange(expectedRevision: current, accountJson: "null"))
        precondition(cleared["account"] is NSNull && cleared["revision"] as? String != current)
        print("{\"passed\":true,\"concurrentWriters\":20,\"acceptedWriters\":1,\"realKeychainTouched\":false}")
    }
}
private final class LockedResults: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0
    func add() { lock.lock(); defer { lock.unlock() }; value += 1 }
    var count: Int { lock.lock(); defer { lock.unlock() }; return value }
}
