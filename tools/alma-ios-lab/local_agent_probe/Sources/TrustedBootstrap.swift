import Foundation

/// This is a probe-owned integration contract, not a guessed generated Rust API.
/// Main supplies its real RustEnvironmentManager/workspace-registration bridge.
@MainActor
protocol TrustedProbeBootstrap {
    var isWired: Bool { get }
    func prepare() async throws -> PreparedProbeEnvironment
}

/// Values selected by the trusted controller; none are editable in this UI.
/// Return only after private CODEX_HOME, rootfs, scoped roots, network policy,
/// and execution backend are ready. Inputs/workdir contain synthetic tool
/// fixtures only, never actual user recordings or revision data. No desktop
/// auth may be imported. Main's host-authorized realfs extension owns mounts.
struct PreparedProbeEnvironment: Sendable {
    let serverID: String
    let displayName: String
    let host: String
    let port: UInt16
    let taskExecutionReady: Bool
}

enum QualificationWorkspace {
    static let input = "/workspace/input"
    static let output = "/workspace/output"
    static let temporary = "/workspace/tmp"
    static let home = "/workspace/tmp/home"
}

enum ProbeGateError: Error {
    case bootstrapUnavailable
    case bindingsUnavailable
    case authenticationUnavailable
    case localConnectionUnavailable
    case taskEnvironmentUnavailable
    case sessionUnavailable
    case modelVerificationFailed
    case modelVerificationTimedOut
}

@MainActor
enum ProbeIntegration {
    /// Main replaces this factory with its real trusted bootstrap implementation.
    /// No runtime, credentials, filesystem mount, or network work happens here.
    static func makeBootstrap() -> any TrustedProbeBootstrap {
        #if PROBE_HAS_BINDINGS
        if ProbeBuildReadiness.runtimeBootstrapEnabled {
            return ProductionIshBootstrap()
        }
        #endif
        return UnwiredProbeBootstrap()
    }
}

@MainActor
private struct UnwiredProbeBootstrap: TrustedProbeBootstrap {
    var isWired: Bool { false }
    func prepare() async throws -> PreparedProbeEnvironment {
        throw ProbeGateError.bootstrapUnavailable
    }
}
