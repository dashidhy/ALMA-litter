import Foundation
import SafariServices
import UIKit

/// The native OAuth owner supplies URLs, expiry and polling cadence. This UI
/// owns only presentation and a cancellable foreground login operation.
@MainActor
final class TAHZCodeLogin: NSObject, SFSafariViewControllerDelegate, UIAdaptivePresentationControllerDelegate {
    private let backend: MobileTahHost
    private let challenge: UInt64
    private let safari: SFSafariViewController
    private var operation: Task<Void, Never>?
    private var cancellation: Task<Void, Error>?
    private var cancellationRequested = false
    private var continuation: CheckedContinuation<Void, Error>?

    private init(backend: MobileTahHost, challenge: UInt64, url: URL) {
        self.backend = backend; self.challenge = challenge
        safari = SFSafariViewController(url: url)
        super.init()
        safari.delegate = self
        safari.modalPresentationStyle = .fullScreen
    }

    static func authorize(_ backend: MobileTahHost) async throws {
        let json = try await backend.call(method: "auth.zcode.begin", payload: "{}")
        struct Challenge: Decodable { let id: UInt64; let authorizeURL: String }
        let challenge = try JSONDecoder().decode(Challenge.self, from: Data(json.utf8))
        guard let url = URL(string: challenge.authorizeURL), url.scheme == "https", url.host == "bigmodel.cn" else {
            _ = try? await backend.call(method: "auth.zcode.cancel", payload: "{\"id\":\(challenge.id)}")
            throw TAHRuntimeError.unavailable
        }
        let login = TAHZCodeLogin(backend: backend, challenge: challenge.id, url: url)
        try await login.run()
    }

    private func run() async throws {
        guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
            .first(where: { $0.activationState == .foregroundActive }),
              var presenter = scene.windows.first(where: \.isKeyWindow)?.rootViewController else {
            _ = try? await backend.call(method: "auth.zcode.cancel", payload: payload)
            throw TAHRuntimeError.unavailable
        }
        while let presented = presenter.presentedViewController { presenter = presented }
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.continuation = continuation
                presenter.present(safari, animated: true)
                safari.presentationController?.delegate = self
                operation = Task { await self.poll() }
            }
        } onCancel: { Task { @MainActor in self.requestCancel() } }
    }
    private var payload: String { "{\"id\":\(challenge)}" }
    private func poll() async {
        var outcome: Result<Void, Error> = .success(())
        do {
            var ready = false
            for _ in 0..<300 {
                try Task.checkCancellation()
                if cancellationRequested { throw CancellationError() }
                let json = try await backend.call(method: "auth.zcode.poll", payload: payload)
                if cancellationRequested { throw CancellationError() }
                struct Progress: Decodable { let ready: Bool; let retryAfterMs: UInt64? }
                let progress = try JSONDecoder().decode(Progress.self, from: Data(json.utf8))
                if progress.ready { ready = true; break }
                try await Task.sleep(for: .milliseconds(min(max(progress.retryAfterMs ?? 1000, 250), 30000)))
            }
            try Task.checkCancellation()
            guard ready else { throw TAHProviderPlatformError.timeout }
        } catch { outcome = .failure(error) }
        // Cancel the exact login generation on every exit. Completed login
        // remains stored by the owner's protocol, pending login is invalidated.
        do { try await cancelNative().value }
        catch { outcome = .failure(TAHProviderPlatformError.cleanup) }
        safari.dismiss(animated: true)
        let pending = continuation; continuation = nil; operation = nil
        pending?.resume(with: outcome)
    }
    private func cancelNative() -> Task<Void, Error> {
        if let cancellation { return cancellation }
        let task = Task { _ = try await backend.call(method: "auth.zcode.cancel", payload: payload) }
        cancellation = task
        return task
    }
    private func requestCancel() {
        cancellationRequested = true
        // Native cancellation runs independently of the outstanding poll. The
        // owner's generation fence prevents a late ready reply from committing.
        _ = cancelNative()
        operation?.cancel()
    }
    nonisolated func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
        Task { @MainActor [weak self] in self?.requestCancel() }
    }
    nonisolated func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        Task { @MainActor [weak self] in self?.requestCancel() }
    }
}
