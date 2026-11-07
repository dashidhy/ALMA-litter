import Foundation
import Security
import UIKit

/// Native composition for both providers. Only opaque handles cross into JSCore.
/// The historical type name is retained for existing native hosts/build manifests.
@MainActor
final class TAHCodexPlatform {
    private struct Record: Codable {
        var version = 1
        var providerID: String?
        var state = "unauthed"
        var credential: String?
        var account: String?
        var checkedAt: String?

        // AuthStorage requires explicit nulls, including for a fresh installation.
        var value: TAHRuntimeValue {
            .object(["version": .integer(version), "providerID": providerID.map(TAHRuntimeValue.string) ?? .null,
                     "state": .string(state), "credential": credential.map(TAHRuntimeValue.string) ?? .null,
                     "account": account.map(TAHRuntimeValue.string) ?? .null,
                     "checkedAt": checkedAt.map(TAHRuntimeValue.string) ?? .null])
        }
    }

    private let backend: MobileTahHost
    private lazy var authClient: AppClient = {
        let client = AppClient()
        client.setChatgptAuthRefreshProvider(provider: ChatGPTAuthRefreshProvider())
        return client
    }()
    private let recordURL: URL
    private var record: Record
    private var handles: [String: String] = [:]
    private var authorizing = false
    private var kimiDiagnostics: [[String: String]] = []
    private let loadProfile: TAHLoadProfile?

    init(bundleFS: URL, support: URL) async throws {
        if Bundle.main.object(forInfoDictionaryKey: "ALMALoadProfile") as? Bool == true,
           let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
            loadProfile = TAHLoadProfile(directory: directory, enabled: ProcessInfo.processInfo.arguments.contains("--mobile-tah-load-profile"))
        } else { loadProfile = nil }
        recordURL = support.appendingPathComponent("mobile-tah-auth-metadata.json")
        let exists = FileManager.default.fileExists(atPath: recordURL.path)
        let stored = try? JSONDecoder().decode(Record.self, from: Data(contentsOf: recordURL))
        record = stored ?? Record(providerID: "codex")
        if record.version != 1 || !Self.supports(record.providerID) || !["unauthed", "valid", "invalid"].contains(record.state) {
            record = Record(providerID: "codex")
        }
        backend = try await MobileTahHost(bundleFs: bundleFS.path, applicationSupport: support.path)
        try backend.configureZcodeStore(store: TAHZCodeCredentialStore())
        // Migrate an existing ChatGPT installation once. Explicitly signed-out
        // metadata stays signed out even while provider Keychain entries exist.
        let shouldRestore = record.state != "unauthed" || !exists
        record.credential = nil
        if shouldRestore, let provider = record.providerID {
            do {
                let handle = try await restoreCredential(provider)
                record.credential = Data(handle.utf8).base64EncodedString()
                if !exists { record.state = "valid" }
            } catch {
                record.state = "unauthed"
                record.account = nil
                record.checkedAt = nil
            }
        }
        // A failed Keychain read never overwrites persisted metadata at startup.
        // The next explicit AuthService mutation commits the new state atomically.
    }

    func call(_ method: String, json: String) async throws -> String {
        do {
            let start = ProcessInfo.processInfo.systemUptime
            var result = try await callProvider(method, json: json)
            if let loadProfile {
                result = try await loadProfile.project(method: method, result: result,
                    hostMs: (ProcessInfo.processInfo.systemUptime - start) * 1000)
            }
            if method.hasPrefix("provider.kimi.") {
                if method.hasSuffix("nextEvent") {
                    if let value = try? JSONSerialization.jsonObject(with: Data(result.utf8)) as? [String: Any],
                       value["done"] as? Bool == true, let terminal = value["terminal"] as? [String: Any] {
                        let failure = terminal["failure"] as? [String: Any]
                        recordKimiDiagnostic(method, outcome: terminal["kind"] as? String ?? "unknown", category: failure?["code"] as? String)
                    }
                } else { recordKimiDiagnostic(method, outcome: "returned", category: nil) }
            }
            return result
        }
        catch MobileTahError.Cleanup { recordKimiDiagnostic(method, outcome: "failed", category: "native_cleanup"); throw TAHProviderPlatformError.cleanup }
        catch MobileTahError.Unavailable { recordKimiDiagnostic(method, outcome: "failed", category: "native_unavailable"); throw TAHProviderPlatformError.unavailable }
        catch MobileTahError.InvalidRequest { recordKimiDiagnostic(method, outcome: "failed", category: "native_invalid_request"); throw TAHRuntimeError.invalid_request }
    }

    private func recordKimiDiagnostic(_ method: String, outcome: String, category: String?) {
        guard method.hasPrefix("provider.kimi.") else { return }
        var row = ["method": method, "outcome": outcome, "at": ISO8601DateFormatter().string(from: Date())]
        // Retain bounded protocol categories, never prompts, events or credentials.
        if let category, category.count <= 96, category.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }) { row["category"] = category }
        kimiDiagnostics.append(row)
        if kimiDiagnostics.count > 32 { kimiDiagnostics.removeFirst(kimiDiagnostics.count - 32) }
        let url = recordURL.deletingLastPathComponent().appendingPathComponent("kimi-runtime-diagnostics.json")
        if let data = try? JSONSerialization.data(withJSONObject: kimiDiagnostics) { try? data.write(to: url, options: .atomic) }
    }

    private func callProvider(_ method: String, json: String) async throws -> String {
        switch method {
        case "credential.load": return try encode(record.value)
        case "credential.save":
            struct Save: Decodable { let record: Record }
            let next = try JSONDecoder().decode(Save.self, from: Data(json.utf8)).record
            guard next.version == 1, Self.supports(next.providerID), ["unauthed", "valid", "invalid"].contains(next.state),
                  next.credential == nil || next.providerID.flatMap({ handles[$0] }).map({ Data($0.utf8).base64EncodedString() }) == next.credential,
                  next.state == "unauthed" || next.credential != nil else { throw TAHRuntimeError.invalid_request }
            try save(next)
            return "null"
        case "credential.reset":
            struct Reset: Decodable { let providerID: String? }
            let next = try JSONDecoder().decode(Reset.self, from: Data(json.utf8))
            guard Self.supports(next.providerID) else { throw TAHRuntimeError.invalid_request }
            try backend.clearCredentials()
            // Switching provider revokes active handles while retaining that
            // provider's device login. Sign-out/reauthorization removes its key.
            if next.providerID == record.providerID {
                if record.providerID == "kimi" { try TAHKimiCredentialStore.clear() }
                if record.providerID == "codex" { try ChatGPTOAuthTokenStore.shared.clear() }
                if record.providerID == "zcode" { _ = try await backend.call(method: "auth.zcode.logout", payload: "{}") }
            }
            try save(Record(providerID: next.providerID))
            handles.removeAll()
            return "null"
        case "provider.codex.inspect", "provider.kimi.inspect", "provider.zcode.inspect":
            struct Inspect: Decodable { let kind: String; let credentialHandle: String? }
            let input = try JSONDecoder().decode(Inspect.self, from: Data(json.utf8))
            let provider = method.split(separator: ".")[1].description
            guard record.providerID == provider else { throw TAHRuntimeError.invalid_request }
            let handle: String
            if input.kind == "authenticate" {
                guard !authorizing else { throw TAHRuntimeError.busy }
                authorizing = true
                defer { authorizing = false }
                handle = try await authorize(provider)
            } else {
                guard input.kind == "inspect", let supplied = input.credentialHandle,
                      handles[provider] == supplied else { throw TAHRuntimeError.invalid_request }
                handle = supplied
            }
            // Rust's inspection boundary accepts only the native credential handle.
            return try await backend.call(method: method, payload: encode(.object(["credentialHandle": .string(handle)])))
        default:
            guard method.hasPrefix("provider.codex.") || method.hasPrefix("provider.kimi.") || method.hasPrefix("provider.zcode.") || method == "runtime.prepareProvider" else { throw TAHRuntimeError.invalid_request }
            return try await backend.call(method: method, payload: json)
        }
    }

    private static func supports(_ provider: String?) -> Bool { provider == nil || provider == "codex" || provider == "kimi" || provider == "zcode" }

    private func save(_ next: Record) throws {
        try Data(encode(next.value).utf8).write(to: recordURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        record = next
    }

    private func restoreCredential(_ provider: String) async throws -> String {
        let handle: String
        if provider == "zcode" {
            struct Restore: Decodable { let credentialHandle: String }
            let json = try await backend.call(method: "auth.zcode.restore", payload: "{}")
            handle = try JSONDecoder().decode(Restore.self, from: Data(json.utf8)).credentialHandle
        } else if provider == "kimi" {
            guard let key = try TAHKimiCredentialStore.load() else { throw TAHRuntimeError.unavailable }
            handle = try backend.registerKimiCredential(apiKey: key)
        } else {
            _ = authClient // Register native refresh only when Codex is selected.
            let tokens = try await ChatGPTOAuth.loadStoredOrRefreshedTokens()
            handle = try backend.registerCredential(tokens: ChatgptAuthRefreshTokens(
                accessToken: tokens.accessToken, accountId: tokens.accountID, planType: tokens.planType))
        }
        handles[provider] = handle
        return handle
    }

    private func authorize(_ provider: String) async throws -> String {
        if let handle = try? await restoreCredential(provider) { return handle }
        // Unattended qualification may reuse credentials, but must leave an
        // interactive login for the user to perform later.
        if ProcessInfo.processInfo.arguments.contains("--mobile-tah-reuse-auth-only") {
            throw TAHRuntimeError.unavailable
        }
        let handle: String
        if provider == "zcode" {
            try await TAHZCodeLogin.authorize(backend)
            handle = try await restoreCredential(provider)
        } else if provider == "kimi" {
            let key = try await TAHKimiCredentialPrompt.request()
            handle = try backend.registerKimiCredential(apiKey: key)
            try TAHKimiCredentialStore.save(key)
        } else {
            _ = authClient
            let tokens = try await ChatGPTOAuth.login()
            handle = try backend.registerCredential(tokens: ChatgptAuthRefreshTokens(
                accessToken: tokens.accessToken, accountId: tokens.accountID, planType: tokens.planType))
        }
        handles[provider] = handle
        return handle
    }

    private func encode(_ value: TAHRuntimeValue) throws -> String {
        String(decoding: try JSONEncoder().encode(value), as: UTF8.self)
    }
}

private enum TAHKimiCredentialStore {
    private static var query: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: "com.alma.mobile-tah.kimi", kSecAttrAccount as String: "default"]
    }
    static func load() throws -> String? {
        var request = query
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data, let key = String(data: data, encoding: .utf8), !key.isEmpty else {
            throw TAHRuntimeError.unavailable
        }
        return key
    }
    static func save(_ key: String) throws {
        let attributes: [String: Any] = [kSecValueData as String: Data(key.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            guard SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil) == errSecSuccess else {
                throw TAHRuntimeError.unavailable
            }
        } else if status != errSecSuccess { throw TAHRuntimeError.unavailable }
    }
    static func clear() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw TAHRuntimeError.unavailable }
    }
}

@MainActor
private enum TAHKimiCredentialPrompt {
    static func request() async throws -> String {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }),
              var presenter = scene.windows.first(where: \.isKeyWindow)?.rootViewController else { throw TAHRuntimeError.unavailable }
        while let presented = presenter.presentedViewController { presenter = presented }
        return try await withCheckedThrowingContinuation { continuation in
            let alert = UIAlertController(title: "Connect Kimi Code", message: "Enter your Kimi Code API key. Alma stores it in this device’s Keychain.", preferredStyle: .alert)
            alert.addTextField { field in
                field.isSecureTextEntry = true
                field.placeholder = "Kimi Code API key"
                field.autocapitalizationType = .none
                field.autocorrectionType = .no
                field.spellCheckingType = .no
                field.accessibilityLabel = "Kimi Code API key"
            }
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak alert] _ in
                alert?.textFields?.first?.text = nil
                continuation.resume(throwing: TAHRuntimeError.cancelled)
            })
            alert.addAction(UIAlertAction(title: "Connect", style: .default) { [weak alert] _ in
                let key = alert?.textFields?.first?.text?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                alert?.textFields?.first?.text = nil
                guard !key.isEmpty, key.utf8.count <= 64 * 1024 else {
                    continuation.resume(throwing: TAHRuntimeError.invalid_request)
                    return
                }
                continuation.resume(returning: key)
            })
            presenter.present(alert, animated: true)
        }
    }
}
