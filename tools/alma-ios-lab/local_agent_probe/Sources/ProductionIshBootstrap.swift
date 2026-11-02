#if PROBE_HAS_BINDINGS
import Foundation

/// Thin wrapper over the existing real UniFFI function. Main enables it only
/// with its policy-ready ALMA-local archive/rootfs. Rust owns all registration,
/// mappings and environment configuration; Swift must not recreate that policy.
@MainActor
struct ProductionIshBootstrap: TrustedProbeBootstrap {
    var isWired: Bool { ProbeBuildReadiness.runtimeBootstrapEnabled }

    func prepare() async throws -> PreparedProbeEnvironment {
        guard isWired, let rootfs = Bundle.main.url(forResource: "fs", withExtension: nil) else {
            throw ProbeGateError.bootstrapUnavailable
        }
        let manager = FileManager.default
        let support = try manager.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                      appropriateFor: nil, create: true)
        let documents = try manager.url(for: .documentDirectory, in: .userDomainMask,
                                        appropriateFor: nil, create: true)
        // Only immutable strings cross to this nonisolated async worker. The
        // project uses Swift 5 mode with no inherited/default actor isolation.
        try await Self.boot(rootfs: rootfs.path, support: support.path, documents: documents.path)
        return PreparedProbeEnvironment(
            serverID: "alma-local-agent-probe",
            displayName: "Local qualification runtime",
            host: "127.0.0.1",
            port: 0,
            taskExecutionReady: true
        )
    }

    private nonisolated static func boot(rootfs: String, support: String, documents: String) async throws {
        try ishBootstrap(bundleFsPath: rootfs, applicationSupportDir: support, documentsDir: documents)
    }
}
#endif
