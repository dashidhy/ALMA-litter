import Foundation

// All mutable test state stays on the production method's existing actor.
// This store is in memory; no Security/Keychain functions are called.
@MainActor
final class ChatGPTOAuthTokenStore {
    static let shared = ChatGPTOAuthTokenStore()
    var value: ChatGPTOAuthTokenBundle?
    var saved: [ChatGPTOAuthTokenBundle] = []
    var loads = 0

    func load() throws -> ChatGPTOAuthTokenBundle? {
        loads += 1
        return value
    }

    func save(_ tokens: ChatGPTOAuthTokenBundle) throws {
        saved.append(tokens)
        value = tokens
    }
}

@MainActor
enum ExchangeFixture {
    static var payload: [String: Any]?
    static var calls = 0
    static var receivedRefreshToken: String?
    static var receivedFallback: String?
}

extension ChatGPTOAuth {
    // The network boundary is replaced; real tokenBundle/claim decoding remains.
    static func exchangeRefreshToken(
        _ refreshToken: String,
        fallbackRefreshToken: String? = nil
    ) async throws -> ChatGPTOAuthTokenBundle {
        ExchangeFixture.calls += 1
        ExchangeFixture.receivedRefreshToken = refreshToken
        ExchangeFixture.receivedFallback = fallbackRefreshToken
        return try tokenBundle(
            from: ExchangeFixture.payload,
            statusCode: 200,
            fallbackRefreshToken: fallbackRefreshToken
        )
    }
}

enum Outcome: Equatable {
    case account(String)
    case mismatch
    case missingStored
    case missingRefresh
    case missingAccount
    case missingTokenFields
    case unexpectedError
}

struct Scenario {
    let name: String
    let expected: String?
    let stored: ChatGPTOAuthTokenBundle?
    let response: [String: Any]?
    let outcome: Outcome
    var loadFromStore = false
}

struct CheckFailure: Error {
    let check: String
}

@main
@MainActor
struct RegressionRunner {
    static let accountA = "dummy-account-A"
    static let accountB = "dummy-account-B"
    static let accountC = "dummy-account-C"
    static func stored(
        _ account: String,
        refreshToken: String? = "DUMMY_SECRET_refresh_not_a_credential"
    ) -> ChatGPTOAuthTokenBundle {
        ChatGPTOAuthTokenBundle(
            accessToken: "DUMMY_SECRET_stored_access",
            idToken: "DUMMY_SECRET_stored_id",
            refreshToken: refreshToken,
            accountID: account,
            planType: nil
        )
    }

    static func dummyJWT(_ claims: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: claims, options: [.sortedKeys])
        let encoded = data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        // Deliberately unsigned and unusable; only the local claim parser sees it.
        return "DUMMY_SECRET_header.\(encoded).DUMMY_SECRET_signature"
    }

    static func payload(_ account: String?) throws -> [String: Any] {
        let claims: [String: Any] = account.map { ["chatgpt_account_id": $0] } ?? [:]
        return [
            "access_token": try dummyJWT([:]),
            "id_token": try dummyJWT(claims)
            // No new refresh_token: exercise the production fallback path too.
        ]
    }

    static func require(_ condition: Bool, _ check: String) throws {
        if !condition { throw CheckFailure(check: check) }
    }

    static func run(_ scenario: Scenario) async throws {
        let store = ChatGPTOAuthTokenStore.shared
        store.value = scenario.stored
        store.saved = []
        store.loads = 0
        ExchangeFixture.payload = scenario.response
        ExchangeFixture.calls = 0
        ExchangeFixture.receivedRefreshToken = nil
        ExchangeFixture.receivedFallback = nil
        var returned: ChatGPTOAuthTokenBundle?
        let outcome: Outcome
        do {
            returned = try await ChatGPTOAuth.refreshStoredTokens(
                previousAccountID: scenario.expected,
                storedTokens: scenario.loadFromStore ? nil : scenario.stored
            )
            outcome = .account(returned!.accountID)
        } catch ChatGPTOAuthError.refreshAccountMismatch {
            outcome = .mismatch
        } catch ChatGPTOAuthError.missingStoredTokens {
            outcome = .missingStored
        } catch ChatGPTOAuthError.missingRefreshToken {
            outcome = .missingRefresh
        } catch ChatGPTOAuthError.missingAccountID {
            outcome = .missingAccount
        } catch ChatGPTOAuthError.tokenExchangeFailed {
            outcome = .missingTokenFields
        } catch {
            outcome = .unexpectedError
        }
        try require(outcome == scenario.outcome, "outcome")
        try require(store.loads == (scenario.loadFromStore || scenario.stored == nil ? 1 : 0), "store load count")
        let expectsExchange = scenario.outcome != .missingStored && scenario.outcome != .missingRefresh
        try require(ExchangeFixture.calls == (expectsExchange ? 1 : 0), "exchange count")
        if expectsExchange {
            try require(ExchangeFixture.receivedRefreshToken == scenario.stored?.refreshToken, "exchange input")
            try require(ExchangeFixture.receivedFallback == scenario.stored?.refreshToken, "fallback input")
        }
        if case .account = scenario.outcome {
            try require(returned != nil && store.saved.count == 1, "single save")
            try require(store.saved.first == returned && store.value == returned, "saved refreshed bundle")
            try require(returned?.refreshToken == scenario.stored?.refreshToken, "refresh fallback")
        } else {
            try require(returned == nil && store.saved.isEmpty, "rejection before save")
            try require(store.value == scenario.stored, "stored bundle unchanged")
        }
    }

    static func scenarios() throws -> [Scenario] {
        let a = stored(accountA)
        let b = stored(accountB)
        let empty = stored("")
        let responseA = try payload(accountA)
        let responseB = try payload(accountB)
        let missing = try payload(nil)
        var missingAccess = responseA
        missingAccess.removeValue(forKey: "access_token")
        var emptyAccess = responseA
        emptyAccess["access_token"] = " \n"
        var missingID = responseA
        missingID.removeValue(forKey: "id_token")
        var emptyID = responseA
        emptyID["id_token"] = " \n"
        let accessAccount: [String: Any] = [
            "access_token": try dummyJWT(["https://api.openai.com/auth": ["chatgpt_account_id": accountA]]),
            "id_token": try dummyJWT([:])
        ]
        return [
            Scenario(name: "expected_stored_match_refresh_mismatch", expected: accountA, stored: a, response: responseB, outcome: .mismatch),
            Scenario(name: "expected_mismatch_stored_refreshed_match", expected: accountA, stored: b, response: responseB, outcome: .mismatch),
            Scenario(name: "all_accounts_differ", expected: accountA, stored: stored(accountC), response: responseB, outcome: .mismatch),
            Scenario(name: "same_account", expected: accountA, stored: a, response: responseA, outcome: .account(accountA)),
            Scenario(name: "refreshed_matches_expected_despite_stale_store", expected: accountA, stored: b, response: responseA, outcome: .account(accountA)),
            Scenario(name: "empty_stored_matching_refresh", expected: accountA, stored: empty, response: responseA, outcome: .account(accountA)),
            Scenario(name: "empty_stored_mismatched_refresh", expected: accountA, stored: empty, response: responseB, outcome: .mismatch),
            Scenario(name: "nil_expectation_preserves_unpinned_refresh", expected: nil, stored: a, response: responseB, outcome: .account(accountB)),
            Scenario(name: "empty_expectation_preserves_unpinned_refresh", expected: "", stored: a, response: responseB, outcome: .account(accountB)),
            Scenario(name: "nil_expectation_empty_stored", expected: nil, stored: empty, response: responseA, outcome: .account(accountA)),
            Scenario(name: "whitespace_expectation_remains_exact", expected: " ", stored: a, response: responseA, outcome: .mismatch),
            Scenario(name: "missing_refreshed_account", expected: accountA, stored: a, response: missing, outcome: .missingAccount),
            Scenario(name: "nil_expectation_missing_refreshed_account", expected: nil, stored: a, response: missing, outcome: .missingAccount),
            Scenario(name: "empty_expectation_missing_refreshed_account", expected: "", stored: a, response: missing, outcome: .missingAccount),
            Scenario(name: "empty_refreshed_account", expected: accountA, stored: a, response: try payload(""), outcome: .missingAccount),
            Scenario(name: "blank_refreshed_account", expected: accountA, stored: a, response: try payload(" \n"), outcome: .missingAccount),
            Scenario(name: "account_from_access_claims", expected: accountA, stored: a, response: accessAccount, outcome: .account(accountA)),
            Scenario(name: "missing_stored_tokens", expected: accountA, stored: nil, response: responseA, outcome: .missingStored),
            Scenario(name: "nil_refresh_token", expected: accountA, stored: stored(accountA, refreshToken: nil), response: responseA, outcome: .missingRefresh),
            Scenario(name: "empty_refresh_token", expected: accountA, stored: stored(accountA, refreshToken: ""), response: responseA, outcome: .missingRefresh),
            Scenario(name: "missing_payload", expected: accountA, stored: a, response: nil, outcome: .missingTokenFields),
            Scenario(name: "missing_access_token", expected: accountA, stored: a, response: missingAccess, outcome: .missingTokenFields),
            Scenario(name: "blank_access_token", expected: accountA, stored: a, response: emptyAccess, outcome: .missingTokenFields),
            Scenario(name: "missing_id_token", expected: accountA, stored: a, response: missingID, outcome: .missingTokenFields),
            Scenario(name: "blank_id_token", expected: accountA, stored: a, response: emptyID, outcome: .missingTokenFields),
            Scenario(name: "loaded_stored_account_cannot_bypass_mismatch", expected: accountA, stored: a, response: responseB, outcome: .mismatch, loadFromStore: true),
            Scenario(name: "loaded_stored_same_account", expected: accountA, stored: a, response: responseA, outcome: .account(accountA), loadFromStore: true)
        ]
    }

    static func main() async {
        do {
            var cases = try scenarios()
            if CommandLine.arguments.contains("--original-guard-control") {
                cases = [cases[0]]
            }
            var failures = 0
            for scenario in cases {
                do {
                    try await run(scenario)
                    print("PASS \(scenario.name)")
                } catch let failure as CheckFailure {
                    failures += 1
                    // Print check names only, never account/token values.
                    print("FAIL \(scenario.name): \(failure.check)")
                } catch {
                    failures += 1
                    print("FAIL \(scenario.name): test setup")
                }
            }
            if failures != 0 { exit(1) }
            print("PASS \(cases.count) source-derived refresh scenarios; no credential output")
        } catch {
            print("FAIL fixture setup")
            exit(1)
        }
    }
}
