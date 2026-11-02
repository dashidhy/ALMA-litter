"""Host notification/lifecycle regression checks; no UIKit launch, Core, provider or phone.

Compile the production host's observation/lifecycle methods verbatim against an
Observable controller fixture and Foundation notifications on macOS. The actual
iOS Host and dependencies must also pass the separate iOS Swift typecheck.
"""
from pathlib import Path
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[2]
host = (repo / 'tools/mobile-tah/Sources/TauriNativeHost.swift').read_text()
start = host.index('@MainActor private final class TauriTAHService: NSObject {')
end = host.index('    func call(_ text: String)', start)
methods = host[start:end]
stubs = r'''
import Foundation
import Observation
public typealias TAHUIChanged = @convention(c) () -> Void
public typealias TAHUIWorkingSend = @convention(c) (UInt64, UInt64, UnsafePointer<CChar>?) -> Bool
private struct TAHUIWorkingLog {}
// The independent working-channel checks exercise real sender semantics. This
// fixture isolates the unchanged Observation/lifecycle methods below.
@MainActor private final class TAHWorkingLogChannel {
    init(send: @escaping @MainActor (UInt64, UInt64, String) -> Bool, readiness: @escaping @MainActor (Bool) -> Void) {}
    func subscribe(_ id: UInt64, value: TAHUIWorkingLog?) {}
    func unsubscribe(_ id: UInt64) {}
    func acknowledge(_ id: UInt64, sequence: UInt64) {}
    func update(_ value: TAHUIWorkingLog?) {}
}
private enum UIApplication {
    static let didBecomeActiveNotification = Notification.Name("test.didBecomeActive")
    static let significantTimeChangeNotification = Notification.Name("test.timeChange")
}
@MainActor @Observable private final class TAHMobileController {
    struct Presentation: Equatable { var material = 0; var log = 0; var auth = 0; var workingLog: TAHUIWorkingLog? { nil } }
    var presentation = Presentation()
    var draft = ""
    var refreshes = 0
    func refresh() { refreshes += 1 }
    func setWorkingChannelEnabled(_ value: Bool) {}
    func setWorkingConsumerReady(_ value: Bool) {}
}
private final class TAHCodexPlatform {}
private final class TAHWebPresentationBridge {}
@MainActor private enum Probe { static var changed = 0 }
private func didChange() { MainActor.assumeIsolated { Probe.changed += 1 } }
'''
tests = r'''
    private func startIfNeeded() {}
    func install(_ core: TAHMobileController) { controller = core }
}
@main private struct Checks {
    @MainActor static func drain() async {
        // Let Observation's main-actor tasks and the two lifecycle hops finish.
        for _ in 0..<30 { await Task.yield() }
    }
    @MainActor static func main() async {
        let host = TauriTAHService(), core = TAHMobileController()
        host.install(core); host.setChangedCallback(didChange)
        assert(Probe.changed == 0)
        for i in 1...500 { core.presentation.material = i; core.draft = "draft \(i)" }
        assert(Probe.changed == 0, "must not notify before mutation")
        await drain()
        assert(Probe.changed == 1, "synchronous burst coalesces")
        assert(core.presentation.material == 500 && core.draft == "draft 500")
        core.presentation.log = 1; await drain()
        core.presentation.auth = 1; await drain()
        core.draft = "later"; await drain()
        assert(Probe.changed == 4, "observation re-arms for log, auth and draft")
        await drain(); assert(Probe.changed == 4, "idle never notifies")
        assert(core.refreshes == 0, "projection changes never refresh Core")
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        await drain(); assert(core.refreshes == 1)
        NotificationCenter.default.post(name: UIApplication.significantTimeChangeNotification, object: nil)
        await drain(); assert(core.refreshes == 2)
        core.presentation.material = 501
        host.setChangedCallback(nil); await drain()
        assert(Probe.changed == 4, "unsubscribed pending observation is discarded")
        NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
        await drain(); assert(core.refreshes == 2, "lifecycle observer removed")
        host.setChangedCallback(didChange)
        core.presentation.log = 2
        host.setChangedCallback(didChange) // replace an already queued observation
        core.presentation.log = 3; await drain()
        assert(Probe.changed == 5, "old generation must not duplicate callbacks")
        host.setChangedCallback(nil)
        print("PASS Host: burst/re-arm, material/log/auth/draft, idle, teardown/re-subscribe, active/time-change")
    }
}
'''
with tempfile.TemporaryDirectory(prefix='tah-host-events-') as directory:
    source = Path(directory) / 'HostChecks.swift'
    binary = Path(directory) / 'host-checks'
    source.write_text(stubs + methods + tests)
    subprocess.run(['xcrun', 'swiftc', '-parse-as-library', '-swift-version', '5',
                    '-strict-concurrency=complete', '-warnings-as-errors',
                    str(source), '-o', str(binary)], check=True)
    subprocess.run([str(binary)], check=True, timeout=20)
