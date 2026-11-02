import Foundation

/// Provider-native composition. Access tokens travel only through typed UniFFI
/// calls; trusted TAH JS borrows a revocable opaque handle, never token bytes.
@MainActor
final class TAHCodexPlatform {
    private let backend: MobileTahHost
    private let authClient = AppClient()
    private let handle: String
    private let recordURL: URL
    private var record: TAHRuntimeValue

    init(bundleFS: URL, support: URL) async throws {
        let tokens = try await ChatGPTOAuth.loadStoredOrRefreshedTokens()
        authClient.setChatgptAuthRefreshProvider(provider: ChatGPTAuthRefreshProvider())
        backend = try await MobileTahHost(bundleFs: bundleFS.path, applicationSupport: support.path)
        handle = try backend.registerCredential(tokens: ChatgptAuthRefreshTokens(
            accessToken: tokens.accessToken, accountId: tokens.accountID, planType: tokens.planType))
        recordURL = support.appendingPathComponent("mobile-tah-auth-metadata.json")
        // Login authority comes from this App's Keychain. A new handle is issued
        // each process; a stale persisted handle never restores authority.
        record = .object(["version": .integer(1), "providerID": .string("codex"), "state": .string("valid"),
                          "credential": .string(Data(handle.utf8).base64EncodedString()), "account": .null, "checkedAt": .null])
    }

    func call(_ method: String, json: String) async throws -> String {
        switch method {
        case "credential.load": return try encode(record)
        case "credential.save":
            let payload = try JSONDecoder().decode(TAHRuntimeValue.self, from: Data(json.utf8))
            guard let next = payload["record"], next["providerID"] == .string("codex"),
                  next["credential"] == .null || next["credential"] == .string(Data(handle.utf8).base64EncodedString()) else {
                throw TAHRuntimeError.invalid_request
            }
            record = next
            try Data(encode(next).utf8).write(to: recordURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return "null"
        case "credential.reset":
            record = .object(["version": .integer(1), "providerID": .string("codex"), "state": .string("unauthed"),
                              "credential": .null, "account": .null, "checkedAt": .null])
            try Data(encode(record).utf8).write(to: recordURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            return "null"
        default:
            guard method.hasPrefix("provider.codex.") else { throw TAHRuntimeError.invalid_request }
            return try await backend.call(method: method, payload: json)
        }
    }

    private func encode(_ value: TAHRuntimeValue) throws -> String {
        String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
    }
}
