import Foundation

// In-memory dummy Keychain. All access is isolated to the same actor as the
// production refresh coordinator. No Security API or network call is used.
@MainActor final class ChatGPTOAuthTokenStore {
    static let shared = ChatGPTOAuthTokenStore()
    private(set) var generation: UInt64 = 0
    var value: ChatGPTOAuthTokenBundle?
    var saves = 0
    func load() throws -> ChatGPTOAuthTokenBundle? { value }
    func save(_ tokens: ChatGPTOAuthTokenBundle) throws { generation &+= 1; value = tokens; saves += 1 }
    func clear() throws { generation &+= 1; value = nil }
    func reset(_ tokens: ChatGPTOAuthTokenBundle?) { generation &+= 1; value = tokens; saves = 0 }
}

// Signatures follow UniFFI 0.31's async callback/rich unit-error templates.
struct ChatgptAuthRefreshRequest: Sendable { let previousAccountId: String?; let timeoutMs: UInt32 }
struct ChatgptAuthRefreshTokens: Sendable { let accessToken: String; let accountId: String; let planType: String? }
enum ChatgptAuthRefreshError: Error { case Unavailable, TimedOut, AccountChanged, RefreshFailed, UnsupportedServer }
protocol ChatgptAuthRefreshProvider: Sendable {
    func refresh(request: ChatgptAuthRefreshRequest) async throws -> ChatgptAuthRefreshTokens
}

@MainActor enum ExchangeFixture {
    static var calls = 0
    static var pending: [CheckedContinuation<ChatGPTOAuthTokenBundle, Error>] = []
    static func reset() { precondition(pending.isEmpty); calls = 0 }
    static func release(_ result: Result<ChatGPTOAuthTokenBundle, Error>) { pending.removeFirst().resume(with: result) }
}
extension ChatGPTOAuth {
    static func exchangeRefreshToken(_ token: String, fallbackRefreshToken: String? = nil, timeout: TimeInterval = 20) async throws -> ChatGPTOAuthTokenBundle {
        ExchangeFixture.calls += 1
        return try await withCheckedThrowingContinuation { ExchangeFixture.pending.append($0) }
    }
}
struct FixtureError: Error {}
struct FailedCheck: Error { let name: String }

@main @MainActor struct Runner {
    static func tokens(_ account: String = "dummy-A", fresh: Bool = false) -> ChatGPTOAuthTokenBundle {
        ChatGPTOAuthTokenBundle(accessToken: fresh ? "DUMMY_NEW" : "DUMMY_OLD", idToken: "DUMMY_ID", refreshToken: "DUMMY_REFRESH", accountID: account, planType: "plus")
    }
    static func check(_ condition: Bool, _ name: String) throws { if !condition { throw FailedCheck(name: name) } }
    static func waitForCalls(_ count: Int) async throws {
        for _ in 0..<1000 { if ExchangeFixture.calls == count { return }; await Task.yield() }
        throw FailedCheck(name: "exchange_not_started")
    }
    static func reset(_ value: ChatGPTOAuthTokenBundle?) { ChatGPTOAuthTokenStore.shared.reset(value); ExchangeFixture.reset() }
    static func refresh() async throws -> ChatGPTOAuthTokenBundle { try await ChatGPTOAuth.refreshStoredTokens(previousAccountID: "dummy-A") }
    static func expectStale(_ task: Task<ChatGPTOAuthTokenBundle, Error>, _ name: String) async throws {
        do { _ = try await task.value; throw FailedCheck(name: name) }
        catch ChatGPTOAuthError.staleRefresh {}
    }
    static func run() async throws {
        let store = ChatGPTOAuthTokenStore.shared
        let fresh = tokens(fresh: true)
        // Successful refresh and strict Core account pin.
        reset(tokens()); let success = Task { try await refresh() }
        try await waitForCalls(1); ExchangeFixture.release(.success(fresh))
        let result = try await success.value
        try check(result == fresh && store.value == fresh && store.saves == 1, "success")

        reset(tokens()); let mismatch = Task { try await refresh() }
        try await waitForCalls(1); ExchangeFixture.release(.success(tokens("dummy-B", fresh: true)))
        do { _ = try await mismatch.value; throw FailedCheck(name: "response_account_pin") }
        catch ChatGPTOAuthError.refreshAccountMismatch {}
        try check(store.saves == 0 && store.value == tokens(), "mismatch_no_save")

        reset(tokens("dummy-B"))
        do { _ = try await refresh(); throw FailedCheck(name: "request_account_pin") }
        catch ChatGPTOAuthError.refreshAccountMismatch {}
        try check(ExchangeFixture.calls == 0, "mismatch_before_exchange")

        // Logout, account switch and ABA saves during suspension all invalidate.
        reset(tokens()); let logout = Task { try await refresh() }
        try await waitForCalls(1); try store.clear(); ExchangeFixture.release(.success(fresh))
        try await expectStale(logout, "logout")
        try check(store.value == nil && store.saves == 0, "logout_no_resurrection")

        reset(tokens()); let change = Task { try await refresh() }
        try await waitForCalls(1); try store.save(tokens("dummy-B")); ExchangeFixture.release(.success(fresh))
        try await expectStale(change, "account_change")
        try check(store.value == tokens("dummy-B") && store.saves == 1, "account_change_no_overwrite")

        reset(tokens()); let aba = Task { try await refresh() }
        try await waitForCalls(1); try store.save(tokens()); ExchangeFixture.release(.success(fresh))
        try await expectStale(aba, "same_token_generation_change")
        try check(store.value == tokens() && store.saves == 1, "aba_no_overwrite")

        // Concurrent callbacks share one rotation and one store commit.
        reset(tokens()); let first = Task { try await refresh() }; let second = Task { try await refresh() }
        try await waitForCalls(1)
        for _ in 0..<20 { await Task.yield() }
        try check(ExchangeFixture.calls == 1, "single_flight")
        ExchangeFixture.release(.success(fresh))
        let one = try await first.value; let two = try await second.value
        try check(one == two && store.saves == 1, "single_commit")

        // New generation can refresh while an old flight remains outstanding.
        reset(tokens()); let old = Task { try await refresh() }; try await waitForCalls(1)
        try store.save(tokens("dummy-B"))
        let newer = Task { try await ChatGPTOAuth.refreshStoredTokens(previousAccountID: "dummy-B") }
        try await waitForCalls(2)
        ExchangeFixture.release(.success(fresh)); try await expectStale(old, "old_flight")
        ExchangeFixture.release(.success(tokens("dummy-B", fresh: true))); _ = try await newer.value
        try check(store.value == tokens("dummy-B", fresh: true), "new_generation_wins")

        // A late network completion cannot commit after the callback deadline.
        reset(tokens())
        let late = Task { try await ChatGPTOAuth.refreshStoredTokens(previousAccountID: "dummy-A", deadline: Date().addingTimeInterval(0.01)) }
        try await waitForCalls(1); try await Task.sleep(nanoseconds: 30_000_000)
        ExchangeFixture.release(.success(fresh))
        do { _ = try await late.value; throw FailedCheck(name: "late_deadline") }
        catch ChatGPTOAuthError.refreshTimedOut {}
        try check(store.saves == 0 && store.value == tokens(), "timeout_no_commit")

        reset(tokens())
        do { _ = try await ChatGPTOAuth.refreshStoredTokens(previousAccountID: "dummy-A", deadline: .distantPast); throw FailedCheck(name: "expired_entry") }
        catch ChatGPTOAuthError.refreshTimedOut {}
        try check(ExchangeFixture.calls == 0, "expired_before_exchange")

        // Legacy convenience fallback must not return credentials captured before logout.
        reset(tokens()); let fallback = Task { try await ChatGPTOAuth.loadStoredOrRefreshedTokens() }
        try await waitForCalls(1); try store.clear(); ExchangeFixture.release(.failure(FixtureError()))
        do { _ = try await fallback.value; throw FailedCheck(name: "stale_fallback") } catch is FixtureError {}

        // Real native provider maps failures to typed, credential-free errors.
        reset(nil)
        do { _ = try await ChatGPTAuthRefreshProvider().refresh(request: .init(previousAccountId: "dummy-A", timeoutMs: 6000)); throw FailedCheck(name: "missing_store") }
        catch ChatgptAuthRefreshError.Unavailable {}
        reset(tokens()); let provider = Task { try await ChatGPTAuthRefreshProvider().refresh(request: .init(previousAccountId: "dummy-A", timeoutMs: 6000)) }
        try await waitForCalls(1); ExchangeFixture.release(.failure(FixtureError()))
        do { _ = try await provider.value; throw FailedCheck(name: "provider_error") }
        catch ChatgptAuthRefreshError.RefreshFailed {}
        try check(store.saves == 0, "provider_error_no_save")
    }
    static func main() async {
        do { try await run(); print("PASS: native refresh concurrency, account, deadline, logout and typed callback checks") }
        catch let error as FailedCheck { print("FAIL: " + error.name); exit(1) }
        catch { print("FAIL: unexpected typed outcome"); exit(1) }
    }
}
