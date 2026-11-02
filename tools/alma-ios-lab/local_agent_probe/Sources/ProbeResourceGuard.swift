import Foundation
import Darwin

/// Disposable qualification-process guard, not a per-isolate memory guarantee.
/// Records only resource numbers. It never reads credentials or task content.
final class ProbeResourceGuard: @unchecked Sendable {
    private let lock = NSLock()
    private let started = ProcessInfo.processInfo.systemUptime
    private let deadlineSeconds: Double
    private var peak: UInt64 = 0
    private var lowestFreeDisk: UInt64 = .max
    private var stopped = false
    private var timer: DispatchSourceTimer?

    init(deadlineSeconds: Double = 180) {
        self.deadlineSeconds = min(240, max(1, deadlineSeconds))
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "alma.probe.resources"))
        self.timer = timer
        timer.schedule(deadline: .now(), repeating: .milliseconds(200))
        timer.setEventHandler { [weak self] in self?.sample() }
        timer.resume()
    }

    private static func footprint() -> UInt64 {
        var value = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
        let code = withUnsafeMutablePointer(to: &value) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
            }
        }
        return code == KERN_SUCCESS ? value.phys_footprint : 0
    }

    private func sample() {
        let bytes = Self.footprint()
        let available = os_proc_available_memory()
        let freeDisk = ((try? FileManager.default.attributesOfFileSystem(forPath: NSHomeDirectory()))?[.systemFreeSize] as? NSNumber)?.uint64Value
        lock.lock()
        if stopped { lock.unlock(); return }
        peak = max(peak, bytes)
        if let freeDisk { lowestFreeDisk = min(lowestFreeDisk, freeDisk) }
        let elapsed = ProcessInfo.processInfo.systemUptime - started
        let reason: String? = bytes > 900 * 1024 * 1024 ? "app-memory-ceiling" :
            (available > 0 && available < 180 * 1024 * 1024 ? "low-available-memory" :
                (freeDisk.map { $0 < 8 * 1024 * 1024 * 1024 } == true ? "phone-disk-floor" :
                    (elapsed > deadlineSeconds ? "qualification-hard-deadline" : nil)))
        if let reason {
            write(phase: "stopped", reason: reason, elapsed: elapsed)
            lock.unlock()
            // Terminate only this disposable test App if normal cancellation
            // cannot be reached. Never claim a successful cleanup in this case.
            _exit(125)
        }
        lock.unlock()
    }

    func finish() -> UInt64 {
        lock.lock()
        stopped = true
        let result = peak
        write(phase: "finished", reason: nil, elapsed: ProcessInfo.processInfo.systemUptime - started)
        lock.unlock()
        timer?.cancel()
        timer = nil
        return result
    }

    private func write(phase: String, reason: String?, elapsed: Double) {
        var report: [String: Any] = ["phase": phase, "sampledPeakFootprintBytes": peak,
            "sampleIntervalMilliseconds": 200, "elapsedSeconds": elapsed,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "scope": "whole disposable qualification App; not per-isolate enforcement"]
        if let reason { report["reason"] = reason }
        if lowestFreeDisk != .max { report["lowestObservedFreeDiskBytes"] = lowestFreeDisk }
        guard let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) else { return }
        try? data.write(to: directory.appendingPathComponent("resource-status.json"), options: .atomic)
    }
}
