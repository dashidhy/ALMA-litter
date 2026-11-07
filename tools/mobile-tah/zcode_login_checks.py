"""Compile the real login owner against UI/native substitutes, without a browser."""
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
source = (ROOT / 'apps/ios/Sources/AlmaTAH/Runtime/TAHZCodeLogin.swift').read_text()
source = source.replace('import SafariServices\n', '').replace('import UIKit\n', '')
stubs = r'''
import Foundation
protocol SFSafariViewControllerDelegate: AnyObject {
    func safariViewControllerDidFinish(_ controller: SFSafariViewController)
}
protocol UIAdaptivePresentationControllerDelegate: AnyObject {
    func presentationControllerDidDismiss(_ controller: UIPresentationController)
}
@MainActor final class UIPresentationController {
    weak var delegate: (any UIAdaptivePresentationControllerDelegate)?
}
@MainActor class UIViewController: NSObject {
    enum PresentationStyle { case automatic, fullScreen }
    var modalPresentationStyle = PresentationStyle.automatic
    let presentationController: UIPresentationController? = UIPresentationController()
    var presentedViewController: UIViewController?
    func present(_ controller: UIViewController, animated: Bool) {
        presentedViewController = controller
        if let safari = controller as? SFSafariViewController { UI.last = safari }
    }
    func dismiss(animated: Bool) { UI.dismissed = true }
}
@MainActor final class SFSafariViewController: UIViewController {
    weak var delegate: (any SFSafariViewControllerDelegate)?
    init(url: URL) { super.init() }
}
@MainActor enum UI { static var last: SFSafariViewController?; static var dismissed = false }
@MainActor final class Window {
    var isKeyWindow = true
    var rootViewController: UIViewController? = UIViewController()
}
@MainActor class Scene {}
@MainActor final class UIWindowScene: Scene {
    enum State { case foregroundActive }
    let activationState = State.foregroundActive
    let windows = [Window()]
}
@MainActor final class UIApplication {
    static let shared = UIApplication()
    let connectedScenes: [Scene] = [UIWindowScene()]
}
enum TAHRuntimeError: Error { case unavailable }
enum TAHProviderPlatformError: Error { case timeout, cleanup }
actor NativeFixture {
    let rejectCancel: Bool
    private var waiter: CheckedContinuation<String, Never>?
    private(set) var polls = 0
    private(set) var cancels = 0
    init(rejectCancel: Bool) { self.rejectCancel = rejectCancel }
    func call(_ method: String) async throws -> String {
        switch method {
        case "auth.zcode.begin": return #"{"id":1,"authorizeURL":"https://bigmodel.cn/login"}"#
        case "auth.zcode.poll":
            polls += 1
            // Deliberately ignores Swift cancellation until late Ready is released.
            return await withCheckedContinuation { waiter = $0 }
        case "auth.zcode.cancel":
            cancels += 1
            if rejectCancel { throw TAHRuntimeError.unavailable }
            return "null"
        default: fatalError("Unexpected native call")
        }
    }
    func lateReady() { let pending = waiter; waiter = nil; pending?.resume(returning: #"{"ready":true}"#) }
}
final class MobileTahHost: Sendable {
    let fixture: NativeFixture
    init(_ fixture: NativeFixture) { self.fixture = fixture }
    func call(method: String, payload: String) async throws -> String { try await fixture.call(method) }
}
'''
checks = r'''
@main struct LoginChecks {
    @MainActor static func main() async throws {
        for (rejectCancel, swipe) in [(false, false), (true, false), (false, true), (true, true)] {
            UI.last = nil; UI.dismissed = false
            let native = NativeFixture(rejectCancel: rejectCancel)
            let backend = MobileTahHost(native)
            let login = Task { try await TAHZCodeLogin.authorize(backend) }
            for _ in 0..<100 {
                if await native.polls == 1 { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            let polls = await native.polls
            precondition(polls == 1)
            guard let safari = UI.last else { fatalError("Browser was not presented") }
            precondition(safari.modalPresentationStyle == .fullScreen)
            if swipe {
                let presentation = safari.presentationController!
                presentation.delegate?.presentationControllerDidDismiss(presentation)
            } else {
                safari.delegate?.safariViewControllerDidFinish(safari)
                // Duplicate UIKit notifications must still send one cancellation.
                safari.delegate?.safariViewControllerDidFinish(safari)
            }
            for _ in 0..<100 {
                if await native.cancels == 1 { break }
                try await Task.sleep(for: .milliseconds(10))
            }
            let cancelsBeforeReply = await native.cancels
            precondition(cancelsBeforeReply == 1, "Native cancel must precede the blocked poll result")
            await native.lateReady()
            do { try await login.value; fatalError("Late ready accepted after cancellation") }
            catch {
                if rejectCancel { precondition(error is TAHProviderPlatformError) }
            }
            precondition(UI.dismissed)
            let cancels = await native.cancels
            let totalPolls = await native.polls
            precondition(cancels == 1 && totalPolls == 1)
        }
        print("{\"passed\":true,\"lateReadyRejected\":true,\"nativeCancelBeforePollReply\":true,\"cleanupFailureRejected\":true,\"doneAndInteractiveDismissal\":true}")
    }
}
'''
with tempfile.TemporaryDirectory(prefix='zcode-login-checks-') as temporary:
    directory = Path(temporary)
    file = directory / 'Login.swift'
    file.write_text(stubs + source + checks)
    subprocess.run(['xcrun', 'swiftc', '-swift-version', '6', '-strict-concurrency=complete',
                    '-parse-as-library', str(file), '-o', str(directory / 'checks')], check=True, timeout=30)
    subprocess.run([str(directory / 'checks')], check=True, timeout=10)
