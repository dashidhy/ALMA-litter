import Foundation
import Observation
import Darwin
#if canImport(UIKit)
import UIKit
#endif

@MainActor
@Observable
final class ProbeModel {
    private(set) var busy = false
    private(set) var runtimeStatus = "Not prepared"
    private(set) var accountStatus = "Not checked"
    private(set) var modelCount = 0
    private(set) var sessionStatus = "Not created"
    private(set) var taskStatus = "Not submitted"
    private(set) var notice = "No connection or sign-in starts automatically."
    private(set) var connected = false
    private(set) var preparationAttempted = false
    private(set) var verificationAttempted = false
    private(set) var accountReady = false
    private(set) var sessionReady = false
    private(set) var tasksReady = false
    private(set) var taskAttempted = false
    private(set) var canInterrupt = false
    @ObservationIgnored private let bootstrap: any TrustedProbeBootstrap
    @ObservationIgnored private let preparationOrigin = ProcessInfo.processInfo.systemUptime
    #if PROBE_HAS_BINDINGS
    @ObservationIgnored private var session: BoundProbeSession?
    #endif

    init() {
        bootstrap = ProbeIntegration.makeBootstrap()
    }

    var canPrepare: Bool { ProbeBuildReadiness.hasBindings && bootstrap.isWired && !preparationAttempted && !connected && !busy }
    var canSignIn: Bool { connected && ProbeBuildReadiness.oauthLoggingReady && !busy && !sessionReady }
    var canCheckAccount: Bool { connected && ProbeBuildReadiness.oauthLoggingReady && !busy }
    var canCheckModels: Bool { canCheckAccount && accountReady && !sessionReady }
    var canCreateSession: Bool { canCheckModels && tasksReady && modelCount > 0 }
    var canRunTask: Bool { sessionReady && accountReady && tasksReady && !taskAttempted && !busy }
    var canCheckTask: Bool { sessionReady && !busy }

    var readinessMessage: String {
        if !ProbeBuildReadiness.hasBindings { return "UI review shell: the shared client is not included. All live actions are disabled." }
        if !bootstrap.isWired { return "Waiting for the trusted local environment connection." }
        if preparationAttempted && !connected && !busy { return "Restart this app before another preparation attempt." }
        if !ProbeBuildReadiness.oauthLoggingReady { return "Sign-in is waiting for the shared authentication logging update." }
        return "Ready for explicit preparation and sign-in."
    }

    func prepare() async {
        guard canPrepare else { return }
        preparationAttempted = true
        #if PROBE_HAS_BINDINGS
        busy = true
        runtimeStatus = "Preparing"
        recordPreparation("booting")
        #if canImport(UIKit)
        if ProcessInfo.processInfo.arguments.contains("--prepare-only") {
            // This App-only setting lasts for the explicitly started foreground
            // test. The user's system Auto-Lock setting is never modified.
            UIApplication.shared.isIdleTimerDisabled = true
            Task { @MainActor in
                let tah = ProcessInfo.processInfo.arguments.contains("--run-tah-attempt") ||
                    ProcessInfo.processInfo.arguments.contains("--inspect-tah-auth")
                try? await Task.sleep(nanoseconds: tah ? 260_000_000_000 : 180_000_000_000)
                UIApplication.shared.isIdleTimerDisabled = false
            }
        }
        #endif
        defer { busy = false }
        do {
            let environment = try await bootstrap.prepare()
            recordPreparation("kernel-ready")
            let prepared = BoundProbeSession(environment: environment)
            recordPreparation("connecting")
            try await prepared.connect()
            session = prepared
            connected = true
            tasksReady = prepared.tasksReady
            runtimeStatus = "Local connection ready"
            recordPreparation("ready")
            notice = tasksReady ? "Choose Sign in when ready." : "Account checks are available; task environment is not ready."
        } catch {
            runtimeStatus = "Preparation failed"
            notice = "Preparation failed. Restart this app before retrying."
            recordPreparation("failed", error: error)
        }
        #endif
    }

    private func recordPreparation(_ phase: String, error: Error? = nil) {
        guard ProcessInfo.processInfo.arguments.contains("--prepare-only") else { return }
        var report: [String: Any] = [
            "phase": phase,
            "pid": ProcessInfo.processInfo.processIdentifier,
            "elapsedSeconds": ProcessInfo.processInfo.systemUptime - preparationOrigin,
            "scope": "local bootstrap before login or model requests"
        ]
        if let error {
            report["errorType"] = String(reflecting: type(of: error))
            let detail = String(describing: error)
            let lowered = detail.lowercased()
            let sensitive = ["token", "bearer", "authorization", "api_key", "sk-", "eyj"]
                .contains { lowered.contains($0) }
            report["detail"] = sensitive ? "Sensitive error detail omitted" :
                String(detail.replacingOccurrences(of: NSHomeDirectory(), with: "<app>").prefix(1200))
        }
        guard let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) else { return }
        try? data.write(to: directory.appendingPathComponent("preparation-status.json"), options: .atomic)
    }

    func verifySubscription(toolsAndWeb: Bool = false) async {
        #if PROBE_HAS_BINDINGS
        guard connected, !busy, !verificationAttempted, let session else {
            recordVerification("not-ready"); return
        }
        verificationAttempted = true
        busy = true
        let resourceGuard = ProbeResourceGuard()
        defer {
            _ = resourceGuard.finish()
            busy = false
            #if canImport(UIKit)
            UIApplication.shared.isIdleTimerDisabled = false
            #endif
        }
        do {
            recordVerification("restoring-account")
            try await session.restoreStoredAccount()
            accountReady = true
            accountStatus = "ChatGPT account ready"
            recordVerification("checking-models")
            modelCount = try await session.checkModels()
            guard modelCount > 0 else { throw ProbeGateError.modelVerificationFailed }
            recordVerification("creating-session", detail: ["modelCount": modelCount])
            try await session.createSession()
            sessionReady = true
            sessionStatus = "Test session created"
            taskAttempted = true
            taskStatus = "Awaiting model reply"
            recordVerification("requesting-model", detail: ["modelCount": modelCount])
            let result = try await session.verifyIdentityReply(toolsAndWeb: toolsAndWeb)
            taskStatus = (result["allChecksPassed"] as? Bool) == true ? "Verification passed" : "Verification needs review"
            recordVerification("completed", detail: result)
        } catch {
            taskStatus = "Verification failed"
            let raw = String(describing: error)
            let sensitive = ["token", "bearer", "authorization", "api_key", "sk-", "eyj"].contains { raw.lowercased().contains($0) }
            recordVerification("failed", detail: ["errorType": String(reflecting: type(of: error)),
                "detail": sensitive ? "Sensitive error detail omitted" : String(raw.prefix(1200))])
        }
        #endif
    }

    /// One explicit host-issued qualification process. The Mac must observe
    /// process exit and independently inspect files before accepting a result.
    func runTah(inspectOnly: Bool) async {
        #if PROBE_HAS_BINDINGS
        guard !verificationAttempted else { return }
        verificationAttempted = true
        busy = true
        UIApplication.shared.isIdleTimerDisabled = true
        let guardrail = ProbeResourceGuard(deadlineSeconds: 240)
        let began = Date()
        let arguments = ProcessInfo.processInfo.arguments
        let runID = arguments.firstIndex(of: "--qualification-run-id").flatMap { index in
            index + 1 < arguments.count ? arguments[index + 1] : nil
        }
        var observation: [String: Any]
        do {
            guard let runID, UUID(uuidString: runID)?.uuidString.lowercased() == runID else {
                throw ProbeGateError.modelVerificationFailed
            }
            if !inspectOnly, tahQualificationInfo()?.challenge != runID {
                throw ProbeGateError.modelVerificationFailed
            }
            guard connected, let session else { throw ProbeGateError.localConnectionUnavailable }
            try await session.restoreStoredAccount()
            accountReady = true
            accountStatus = "ChatGPT account ready"
            taskStatus = inspectOnly ? "Inspecting account" : "Running one TAH attempt"
            let text: String
            if inspectOnly { text = try await session.inspectTah() }
            else { text = try await session.executeTah() }
            guard let parsed = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else {
                throw ProbeGateError.modelVerificationFailed
            }
            observation = parsed
        } catch {
            observation = ["outcome": "failure", "failure": "qualification_operation_failed",
                           "errorType": String(reflecting: type(of: error))]
        }
        let peak = guardrail.finish()
        let finish = Date()
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let result: [String: Any] = [
            "schema": "alma.phone-observation/v1", "pid": ProcessInfo.processInfo.processIdentifier,
            "runID": runID ?? "",
            "kind": inspectOnly ? "inspection" : "attempt", "profileDigest": ProbeBuildReadiness.profileDigest,
            "startedAt": formatter.string(from: began), "finishedAt": formatter.string(from: finish),
            "sampledPeakAppFootprintBytes": peak, "observation": observation,
            "requiresExternalProcessExitVerification": true,
        ]
        var saved = false
        do {
            let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
            let path = directory.appendingPathComponent("tah-observation.json")
            let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
            try data.write(to: path, options: .atomic)
            let handle = try FileHandle(forWritingTo: path)
            try handle.synchronize()
            try handle.close()
            saved = true
        } catch { }
        UIApplication.shared.isIdleTimerDisabled = false
        // This disposable App process contains the whole iSH/native execution
        // environment. Exit is NOT reported as observed; the host verifies it.
        _exit(saved && (observation["outcome"] as? String) == "observed" ? 0 : 1)
        #endif
    }

    private func recordVerification(_ phase: String, detail: [String: Any] = [:]) {
        var report = detail
        report["phase"] = phase
        report["pid"] = ProcessInfo.processInfo.processIdentifier
        report["accountReady"] = accountReady
        report["modelCount"] = modelCount
        report["scope"] = "explicit synthetic subscription check; no transcript or credential output"
        guard let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first,
              let data = try? JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]) else { return }
        try? data.write(to: directory.appendingPathComponent("verification-status.json"), options: .atomic)
    }

    func signIn() async {
        guard canSignIn else { return }
        #if PROBE_HAS_BINDINGS
        busy = true
        accountStatus = "Sign-in in progress"
        defer { busy = false }
        do {
            guard let session else { throw ProbeGateError.localConnectionUnavailable }
            try await session.signIn()
            accountReady = session.accountReady
            accountStatus = accountReady ? "ChatGPT account ready" : "No ChatGPT account confirmed"
            notice = "Sign-in returned. Check models before creating a session."
        } catch ChatGPTOAuthError.cancelled {
            accountReady = false
            accountStatus = "Sign-in cancelled"
        } catch {
            accountReady = false
            accountStatus = "Sign-in did not finish"
            notice = "Retry sign-in when the local connection is ready."
        }
        #endif
    }

    func checkAccount() async {
        guard canCheckAccount else { return }
        #if PROBE_HAS_BINDINGS
        busy = true
        defer { busy = false }
        do {
            guard let session else { throw ProbeGateError.localConnectionUnavailable }
            accountReady = try await session.checkAccount()
            accountStatus = accountReady ? "ChatGPT account ready" : "ChatGPT sign-in required"
        } catch {
            accountReady = false
            accountStatus = "Account check failed"
        }
        #endif
    }

    func checkModels() async {
        guard canCheckModels else { return }
        #if PROBE_HAS_BINDINGS
        busy = true
        defer { busy = false }
        do {
            guard let session else { throw ProbeGateError.localConnectionUnavailable }
            modelCount = try await session.checkModels()
            notice = modelCount > 0 ? "Model catalog received." : "No visible Codex models returned."
        } catch {
            modelCount = 0
            notice = "Model check failed."
        }
        #endif
    }

    func createSession() async {
        guard canCreateSession else { return }
        #if PROBE_HAS_BINDINGS
        busy = true
        defer { busy = false }
        do {
            guard let session else { throw ProbeGateError.localConnectionUnavailable }
            try await session.createSession()
            sessionReady = session.hasSession
            sessionStatus = "Test session created"
            notice = "Run one fixed qualification prompt when ready."
        } catch { sessionStatus = "Session creation failed" }
        #endif
    }

    func runTask() async {
        guard canRunTask else { return }
        #if PROBE_HAS_BINDINGS
        busy = true
        taskAttempted = true
        defer { busy = false }
        do {
            guard let session else { throw ProbeGateError.localConnectionUnavailable }
            try await session.runTask()
            taskStatus = "Submitted; check status"
        } catch {
            taskStatus = "Submission uncertain; check status"
        }
        #endif
    }

    func checkTask() async {
        guard canCheckTask else { return }
        #if PROBE_HAS_BINDINGS
        busy = true
        defer { busy = false }
        do {
            guard let session else { throw ProbeGateError.localConnectionUnavailable }
            taskStatus = try await session.checkTaskStatus()
            canInterrupt = session.canInterrupt
        } catch { notice = "Task status check failed." }
        #endif
    }

    func interruptTask() async {
        guard canCheckTask, canInterrupt else { return }
        #if PROBE_HAS_BINDINGS
        busy = true
        defer { busy = false }
        do {
            guard let session else { throw ProbeGateError.localConnectionUnavailable }
            try await session.interruptTask()
            canInterrupt = false
            taskStatus = "Interrupt acknowledged; check status"
        } catch { notice = "Interrupt request failed; check status." }
        #endif
    }
}
