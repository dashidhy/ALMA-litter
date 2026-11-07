import CryptoKit
import Foundation
#if canImport(UIKit)
import UIKit
#endif

// The foreground-only test driver must not diagnose a passcode lock from
// applicationState: Control Center and ordinary app transitions are inactive too.
enum TAHQualificationAvailability: String, Encodable, Sendable {
    case ready, needs_foreground, needs_user_unlocked

    static func classify(protectedDataAvailable: Bool, applicationIsActive: Bool) -> Self {
        if !protectedDataAvailable { return .needs_user_unlocked }
        return applicationIsActive ? .ready : .needs_foreground
    }
}

/// Optional phone-owned runner. Main calls `await TAHMobileQualification.run(controller: app)`.
/// Read-only bundled fixture: mobile-qualification-fixture.json
/// {"title":"Synthetic check","transcript":"...","deltas":["","Revise...","Retitle..."]}
/// Main alone loads mobile-config.json into the controller. No additional config is required.
/// The explicitly authorized launch flag is the qualification's content-consent source.
@MainActor
enum TAHMobileQualification {
    private static var started = false

    static func run(controller: TAHMobileController) async {
        let long = ProcessInfo.processInfo.arguments.contains("--mobile-tah-long-qualification")
        guard (long || ProcessInfo.processInfo.arguments.contains("--mobile-tah-qualification")), !started else { return }
        started = true // never restart or resubmit automatically in this process
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let runner = Runner(controller: controller, reportURL: documents.appendingPathComponent(long ? "mobile-tah-long-qualification.json" : "mobile-tah-qualification.json"), long: long)
        await runner.run()
    }

    private struct Fixture: Decodable, Sendable {
        let title: String
        let transcript: String
        let deltas: [String]
        let outputLanguage: String?
        let interactionLanguage: String?
        let modelIDs: [String]?
        let efforts: [String?]?
        let webEnabled: Bool?
    }
    private struct State: Encodable, Equatable, Sendable {
        let phase: String
        let busy: Bool
        let hasError: Bool
        let canCheckRaw: Bool
        let canCreateAction: Bool
        let canSend: Bool
        let outputLanguageFrozen: Bool
        let acceptedRevisions: [Int]
    }
    private struct Step: Encodable, Sendable {
        let stage: String
        let elapsedSeconds: Double
        let state: State
    }
    private struct Outcome: Encodable, Sendable {
        let revision: Int
        let file: String
        // Controller material is rendered text: this is not the canonical Markdown file hash.
        let renderedUTF8Bytes: Int
        let renderedSHA256: String
        let sanitizedText: String
        let textTruncated: Bool
    }
    private struct Report: Encodable, Sendable {
        let schemaVersion = 1
        let phoneOwned = true
        let consentSource = "explicit_mobile_tah_qualification_launch_flag"
        var phaseDeadlineSeconds = 300
        let startedAt = ISO8601DateFormatter().string(from: Date())
        var providerID: String?
        var modelID: String?
        var reasoningEffortID: String?
        var transcriptID: String?
        var actionID: String?
        var status = "running"
        var stage = "fixture"
        var elapsedSeconds = 0.0
        var needsUserUnlocked = false
        var needsUserForeground = false
        var availability: TAHQualificationAvailability?
        var applicationState: String?
        var protectedDataAvailable: Bool?
        var workflowMayStillBeRunning = false
        var failureCode: String?
        var steps: [Step] = []
        var outcomes: [Outcome] = []
        var energySamples: [EnergySample] = []
    }
    private struct EnergySample: Encodable, Sendable {
        let elapsedSeconds: Double
        let stage: String
        let batteryPercent: Double?
        let batteryState: String
        let thermalState: String
        let lowPowerMode: Bool
        let brightness: Double
    }
    private enum Stop: String, Error {
        case fixture_invalid, permission_unavailable, content_consent_required
        case controller_error, unexpected_selection, unexpected_revision, material_read_failed
        case timed_out, needs_user_unlocked, needs_foreground, cancelled, not_admitted, provider_mismatch
    }

    @MainActor private final class Runner {
        let controller: TAHMobileController
        let reportURL: URL
        let start = ProcessInfo.processInfo.systemUptime
        var report = Report()
        var transcriptID: String?
        var actionID: String?
        let long: Bool

        init(controller: TAHMobileController, reportURL: URL, long: Bool = false) {
            self.controller = controller; self.reportURL = reportURL
            self.long = long
            if long { report.phaseDeadlineSeconds = 2700 }
        }

        func run() async {
            #if canImport(UIKit)
            let previousMonitoring = UIDevice.current.isBatteryMonitoringEnabled
            if long { UIDevice.current.isBatteryMonitoringEnabled = true }
            defer { if long { UIDevice.current.isBatteryMonitoringEnabled = previousMonitoring } }
            #endif
            do {
                try unlocked()
                guard let url = Bundle.main.url(forResource: long ? "mobile-qualification-nvidia" : "mobile-qualification-fixture", withExtension: "json") else { throw Stop.fixture_invalid }
                let fixture = try await Self.loadFixture(url)
                guard fixture.title.count <= 512, !fixture.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      fixture.deltas.count == 3, fixture.deltas.allSatisfy({ $0.utf8.count <= 64 * 1024 }),
                      fixture.deltas.dropFirst().allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else { throw Stop.fixture_invalid }

                if long {
                    try await stage("awaiting_power_trace")
                    try await Task.sleep(for: .seconds(30))
                    try unlocked()
                }

                try await stage("authorization")
                try await wait { !$0.isBusy && $0.authorization.canManage }
                if let argument = ProcessInfo.processInfo.arguments.first(where: { $0.hasPrefix("--mobile-tah-expected-provider=") }) {
                    let expected = String(argument.dropFirst("--mobile-tah-expected-provider=".count))
                    guard ["codex", "kimi", "zcode"].contains(expected),
                          controller.presentation.authorization.providerID == expected else { throw Stop.provider_mismatch }
                }
                // 当前 AuthService 恢复已保存账号后仍要求本次进程完成
                // inspect；缓存目录不等于授权检查成功。复用用户的同一入口。
                controller.inspectAuthorization()
                try await wait { !$0.isBusy && $0.authorization.state == "valid" && !$0.models.isEmpty }
                report.providerID = controller.presentation.authorization.providerID
                if let language=fixture.interactionLanguage {
                    guard let value=TAHUILanguage(rawValue:language) else { throw Stop.fixture_invalid }
                    controller.selectInteractionLanguage(value)
                }
                try await stage("import")
                guard controller.presentation.permissions.importTranscript else { throw Stop.permission_unavailable }
                let previous = controller.presentation.transcriptID
                controller.importTranscript(title: fixture.title, text: fixture.transcript)
                try await wait { !$0.isBusy && $0.transcriptID != nil && $0.transcriptID != previous }
                transcriptID = controller.presentation.transcriptID
                report.transcriptID = transcriptID

                try await stage("raw_check")
                var draft = controller.draft; draft.consent = true
                controller.updateDraft(draft, context: controller.presentation.editor)
                guard controller.draft.consent else { throw Stop.content_consent_required }
                // 新 controller 的导入确认与 raw 状态投影是异步的；选中
                // transcript 不等于安全检查权限已就绪。等待同一个公开权限，
                // 不抢先提交，也不新增 Core 轮询或直接调度 Guardian。
                try await wait { !$0.isBusy && $0.permissions.checkRaw }
                guard let transcriptID, controller.presentation.permissions.checkRaw else { throw Stop.permission_unavailable }
                controller.checkRawSafety(transcriptID: transcriptID, consent: true,
                                          interactionLanguage: controller.presentation.interactionLanguage)
                try await wait { !$0.isBusy && $0.permissions.createAction }

                if ProcessInfo.processInfo.arguments.contains("--mobile-tah-load-profile") {
                    // 第二份合成输入产生新的 Raw 任务进程，测复用缓存而不复用 SDK 会话。
                    try await stage("profile_second_raw")
                    let previous = controller.presentation.transcriptID
                    self.transcriptID = nil // 此处是驱动主动切换；恢复后重新绑定选择守卫。
                    controller.importTranscript(title: fixture.title + " — load sample 2", text: fixture.transcript)
                    try await wait { !$0.isBusy && $0.transcriptID != nil && $0.transcriptID != previous }
                    self.transcriptID = controller.presentation.transcriptID
                    var second = controller.draft; second.consent = true
                    controller.updateDraft(second, context: controller.presentation.editor)
                    try await wait { !$0.isBusy && $0.permissions.checkRaw }
                    guard let secondID = controller.presentation.transcriptID else { throw Stop.unexpected_selection }
                    controller.checkRawSafety(transcriptID: secondID, consent: true, interactionLanguage: controller.presentation.interactionLanguage)
                    try await wait { !$0.isBusy && $0.permissions.createAction }
                    report.status = "completed"; report.stage = "load_profile_completed"
                    try await record()
                    return
                }

                try await stage("create_action")
                controller.createStructuredNotesAction(transcriptID: transcriptID, language: controller.draft.outputLanguage,
                                                       settings: controller.draft.settings)
                try await wait { !$0.isBusy && $0.editor != nil }
                actionID = controller.presentation.editor?.actionID
                report.actionID = actionID
                guard controller.presentation.revisions.isEmpty else { throw Stop.unexpected_revision }

                for revision in 0..<3 {
                    try await stage("send_v\(revision)")
                    guard let context = controller.presentation.editor, context.actionID == actionID,
                          controller.presentation.permissions.edit else { throw Stop.unexpected_selection }
                    draft = controller.draft; draft.instructions = fixture.deltas[revision]
                    if let language=fixture.outputLanguage, revision==0 {
                        guard let value=TAHUILanguage(rawValue:language) else { throw Stop.fixture_invalid }
                        draft.outputLanguage=value
                    }
                    if let models=fixture.modelIDs {
                        guard models.count==3, controller.presentation.models.contains(where:{$0.id==models[revision]}) else { throw Stop.fixture_invalid }
                        draft.settings.modelID=models[revision]
                    }
                    if let web=fixture.webEnabled { draft.settings.webEnabled=web }
                    controller.updateDraft(draft, context: context)
                    if let efforts=fixture.efforts {
                        guard efforts.count==3 else { throw Stop.fixture_invalid }
                        draft=controller.draft;draft.settings.reasoningEffortID=efforts[revision]
                        controller.updateDraft(draft,context:context)
                    }
                    report.modelID = controller.draft.settings.modelID
                    report.reasoningEffortID = controller.draft.settings.reasoningEffortID
                    guard controller.presentation.permissions.send else { throw Stop.permission_unavailable }
                    controller.sendAction(.init(context: context, instructions: draft.instructions, settings: controller.draft.settings,
                        initialLanguage: controller.presentation.initialSettingsFrozen ? nil : controller.draft.outputLanguage,
                        interactionLanguage: controller.presentation.interactionLanguage, consent: controller.draft.consent))
                    try await wait { !$0.isBusy && $0.revisions.contains(where: { $0.revisionIndex == revision }) }
                    guard controller.presentation.revisions.map(\.revisionIndex).sorted() == Array(0...revision) else { throw Stop.unexpected_revision }
                    for file in [TAHUIOutcomeFile.notes, .asrTerms] {
                        try await stage("read_v\(revision)_\(file == .notes ? "notes" : "asr_terms")")
                        guard let actionID, controller.presentation.permissions.readMaterial else { throw Stop.permission_unavailable }
                        controller.readMaterial(.outcome(actionID: actionID, revisionIndex: revision, file: file))
                        guard let materialID = controller.presentation.material?.id else { throw Stop.material_read_failed }
                        try await wait {
                            !$0.isBusy && $0.material?.id == materialID && $0.material?.isLoading == false && $0.material?.content != nil
                        }
                        guard let content = controller.presentation.material?.content else { throw Stop.material_read_failed }
                        let text = String(content.characters), bytes = Data(text.utf8)
                        guard !bytes.isEmpty else { throw Stop.material_read_failed }
                        report.outcomes.append(.init(revision: revision, file: file.rawValue,
                            renderedUTF8Bytes: bytes.count, renderedSHA256: SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined(),
                            sanitizedText: Self.sanitize(String(decoding: bytes.prefix(64 * 1024), as: UTF8.self)), textTruncated: bytes.count > 64 * 1024))
                        controller.dismissMaterial()
                        try await record()
                    }
                }
                report.status = "completed"; report.stage = "completed"
            } catch {
                let code = error as? Stop ?? (error is CancellationError ? .cancelled : .controller_error)
                switch code {
                case .needs_user_unlocked, .needs_foreground, .timed_out: report.status = code.rawValue
                default: report.status = "failed"
                }
                report.failureCode = code.rawValue
                report.needsUserUnlocked = code == .needs_user_unlocked
                report.needsUserForeground = code == .needs_foreground
                report.workflowMayStillBeRunning = controller.presentation.isBusy
            }
            // No cancellation/retry/role dispatch here. Core may continue after a timeout or lock.
            do { try await record() } catch { print("Mobile TAH qualification report could not be saved.") }
        }

        private func unlocked() throws {
            try Task.checkCancellation()
            #if canImport(UIKit)
            let app = UIApplication.shared
            let state = app.applicationState
            switch state {
            case .active: report.applicationState = "active"
            case .inactive: report.applicationState = "inactive"
            case .background: report.applicationState = "background"
            @unknown default: report.applicationState = "unknown"
            }
            report.protectedDataAvailable = app.isProtectedDataAvailable
            let availability = TAHQualificationAvailability.classify(
                protectedDataAvailable: app.isProtectedDataAvailable, applicationIsActive: state == .active)
            report.availability = availability
            switch availability {
            case .ready: break
            case .needs_foreground: throw Stop.needs_foreground
            case .needs_user_unlocked: throw Stop.needs_user_unlocked
            }
            #endif
        }
        private func stage(_ name: String) async throws {
            try unlocked(); report.stage = name; try await record()
        }
        private func wait(_ completed: (TAHUIPresentation) -> Bool) async throws {
            let deadline = ProcessInfo.processInfo.systemUptime + Double(report.phaseDeadlineSeconds)
            var last: State?, idleSince: Double?
            var lastRecord = ProcessInfo.processInfo.systemUptime
            while ProcessInfo.processInfo.systemUptime < deadline {
                try unlocked()
                let state = controller.presentation
                if let transcriptID, state.transcriptID != transcriptID { throw Stop.unexpected_selection }
                if let actionID, state.editor?.actionID != actionID { throw Stop.unexpected_selection }
                if state.error != nil { throw Stop.controller_error }
                if state.material?.error != nil { throw Stop.material_read_failed }
                if completed(state) { try await record(); return }
                let current = snapshot()
                if current != last || (long && ProcessInfo.processInfo.systemUptime - lastRecord >= 60) {
                    try await record(); last = current; lastRecord = ProcessInfo.processInfo.systemUptime
                }
                if state.isBusy { idleSince = nil }
                else {
                    idleSince = idleSince ?? ProcessInfo.processInfo.systemUptime
                    if ProcessInfo.processInfo.systemUptime - idleSince! > 2 { throw Stop.not_admitted }
                }
                try await Task.sleep(for: .milliseconds(250)) // yields; the public SwiftUI stays rendered
            }
            throw Stop.timed_out
        }
        private func snapshot() -> State {
            let state = controller.presentation
            let phases = ["", "draft", "idle", "preparing", "running", "raw_guardian", "extra_guardian", "saving_safety", "actor", "critic", "persistence_pending", "completed", "published", "editing", "failed", "cancelled", "integrity_locked", "extra_blocked", "extra_unavailable", "actor_failed", "needs_user_revision"]
            return State(phase: phases.contains(state.status) ? state.status : "other", busy: state.isBusy, hasError: state.error != nil,
                         canCheckRaw: state.permissions.checkRaw, canCreateAction: state.permissions.createAction,
                         canSend: state.permissions.send, outputLanguageFrozen: state.initialSettingsFrozen,
                         acceptedRevisions: state.revisions.map(\.revisionIndex).sorted())
        }
        private func record() async throws {
            report.elapsedSeconds = ProcessInfo.processInfo.systemUptime - start
            report.steps.append(.init(stage: report.stage, elapsedSeconds: report.elapsedSeconds, state: snapshot()))
            #if canImport(UIKit)
            if long, report.energySamples.last?.stage != report.stage || report.elapsedSeconds - (report.energySamples.last?.elapsedSeconds ?? -60) >= 60 {
                let level = UIDevice.current.batteryLevel
                let battery: String
                switch UIDevice.current.batteryState {
                case .unplugged: battery = "unplugged"
                case .charging: battery = "charging"
                case .full: battery = "full"
                default: battery = "unknown"
                }
                let thermal: String
                switch ProcessInfo.processInfo.thermalState {
                case .nominal: thermal = "nominal"
                case .fair: thermal = "fair"
                case .serious: thermal = "serious"
                case .critical: thermal = "critical"
                @unknown default: thermal = "unknown"
                }
                report.energySamples.append(.init(elapsedSeconds: report.elapsedSeconds, stage: report.stage,
                    batteryPercent: level < 0 ? nil : Double(level) * 100, batteryState: battery,
                    thermalState: thermal, lowPowerMode: ProcessInfo.processInfo.isLowPowerModeEnabled,
                    brightness: Double(UIScreen.main.brightness)))
            }
            #endif
            try await Self.write(report, to: reportURL)
        }
        nonisolated private static func loadFixture(_ url: URL) async throws -> Fixture {
            guard (try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max) <= 1024 * 1024 else { throw Stop.fixture_invalid }
            return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
        }
        nonisolated private static func write(_ report: Report, to url: URL) async throws {
            let encoder = JSONEncoder(); encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
            try encoder.encode(report).write(to: url, options: .atomic)
        }
        private static func sanitize(_ text: String) -> String {
            var value = text.replacingOccurrences(of: #"(?im)^.*\b(token|password|credential|authorization|bearer|api[ _-]?key|account)\b.*$"#, with: "[redacted]", options: .regularExpression)
            for pattern in [#"(?i)[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}"#, #"\bsk[-_][A-Za-z0-9_-]+"#, #"(?<![A-Za-z0-9])[A-Za-z0-9_+/-]{40,}={0,2}(?![A-Za-z0-9])"#] {
                value = value.replacingOccurrences(of: pattern, with: "[redacted]", options: .regularExpression)
            }
            return value
        }
    }
}
