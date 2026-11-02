import Foundation

/// UniFFI invokes this stateless bridge off the UI actor. Only immutable Swift
/// values cross to the existing main-actor auth/store owner; no JSON or tokens
/// are routed through AppModel's UI event reducer.
final class ChatGPTAuthRefreshProvider: ChatgptAuthRefreshProvider, Sendable {
    func refresh(request: ChatgptAuthRefreshRequest) async throws -> ChatgptAuthRefreshTokens {
        let previousAccountID = request.previousAccountId
        let deadline = Date().addingTimeInterval(Double(request.timeoutMs) / 1_000)
        do {
            let tokens = try await ChatGPTOAuth.refreshStoredTokens(
                previousAccountID: previousAccountID,
                deadline: deadline
            )
            try Task.checkCancellation()
            return ChatgptAuthRefreshTokens(
                accessToken: tokens.accessToken,
                accountId: tokens.accountID,
                planType: tokens.planType
            )
        } catch ChatGPTOAuthError.refreshAccountMismatch {
            throw ChatgptAuthRefreshError.AccountChanged
        } catch ChatGPTOAuthError.staleRefresh {
            throw ChatgptAuthRefreshError.AccountChanged
        } catch ChatGPTOAuthError.refreshTimedOut {
            throw ChatgptAuthRefreshError.TimedOut
        } catch ChatGPTOAuthError.missingStoredTokens {
            throw ChatgptAuthRefreshError.Unavailable
        } catch ChatGPTOAuthError.missingRefreshToken {
            throw ChatgptAuthRefreshError.Unavailable
        } catch is CancellationError {
            throw ChatgptAuthRefreshError.TimedOut
        } catch {
            // Never return/log a transport error body, Keychain value, or token.
            throw ChatgptAuthRefreshError.RefreshFailed
        }
    }
}
