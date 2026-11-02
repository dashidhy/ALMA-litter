import CryptoKit
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Optional phone-owned runner. Main calls `await TAHMobileQualification.run(controller: app)`.
/// Read-only bundled fixture: mobile-qualification-fixture.json
/// {"title":"Synthetic check","transcript":"...","deltas":["","Revise...","Retitle..."]}
/// Main alone loads mobile-config.json into the controller. No additional config is required.
/// The explicitly authorized launch flag is the qualification's content-consent source.
@MainActor
enum TAHMobileQualification {
    private static var started = false

    static func run(controller: TAHMobileController) async {
        guard ProcessInfo.processInfo.arguments.contains("--mobile-tah-qualification"), !started else { return }
        started = true // never restart or resubmit automatically in this process
        guard let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first else { return }
        let runner = Runner(controller: controller, reportURL: documents.appendingPathComponent("mobile-tah-qualification.json"))
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
        let phaseDeadlineSeconds = 300
        var status = "running"
        var stage = "fixture"
        var elapsedSeconds = 0.0
        var needsUserUnlocked = false
        var workflowMayStillBeRunning = false
        var failureCode: String?
        var steps: [Step] = []
        var outcomes: [Outcome] = []
    }
    private enum Stop: String, Error {
        case fixture_invalid, permission_unavailable, content_consent_required
        case controller_error, unexpected_selection, unexpected_revision, material_read_failed
        case timed_out, needs_user_unlocked, cancelled, not_admitted
    }

    @MainActor private final class Runner {
        let controller: TAHMobileController
        let reportURL: URL
        let start = ProcessInfo.processInfo.systemUptime
        var report = Report()
        var transcriptID: String?
        var actionID: String?

        init(controller: TAHMobileController, reportURL: URL) {
            self.controller = controller; self.reportURL = reportURL
        }

        func run() async {
            do {
                try unlocked()
                guard let url = Bundle.main.url(forResource: "mobile-qualification-fixture", withExtension: "json") else { throw Stop.fixture_invalid }
                let fixture = try await Self.loadFixture(url)
                guard fixture.title.count <= 512, !fixture.transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
                      fixture.deltas.count == 3, fixture.deltas.allSatisfy({ $0.utf8.count <= 64 * 1024 }),
                      fixture.deltas.dropFirst().allSatisfy({ !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) else { throw Stop.fixture_invalid }

                try await stage("authorization")
                try await wait { !$0.isBusy && !$0.models.isEmpty }
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

                try await stage("raw_check")
                var draft = controller.draft; draft.consent = true
                controller.updateDraft(draft, context: controller.presentation.editor)
                guard controller.draft.consent else { throw Stop.content_consent_required }
                guard let transcriptID, controller.presentation.permissions.checkRaw else { throw Stop.permission_unavailable }
                controller.checkRawSafety(transcriptID: transcriptID, consent: true,
                                          interactionLanguage: controller.presentation.interactionLanguage)
                try await wait { !$0.isBusy && $0.permissions.createAction }

                try await stage("create_action")
                controller.createStructuredNotesAction(transcriptID: transcriptID, language: controller.draft.outputLanguage,
                                                       settings: controller.draft.settings)
                try await wait { !$0.isBusy && $0.editor != nil }
                actionID = controller.presentation.editor?.actionID
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
                report.status = code == .needs_user_unlocked ? "needs_user_unlocked" : code == .timed_out ? "timed_out" : "failed"
                report.failureCode = code.rawValue
                report.needsUserUnlocked = code == .needs_user_unlocked
                report.workflowMayStillBeRunning = controller.presentation.isBusy
            }
            // No cancellation/retry/role dispatch here. Core may continue after a timeout or lock.
            do { try await record() } catch { print("Mobile TAH qualification report could not be saved.") }
        }

        private func unlocked() throws {
            try Task.checkCancellation()
            #if canImport(UIKit)
            guard UIApplication.shared.isProtectedDataAvailable, UIApplication.shared.applicationState == .active else { throw Stop.needs_user_unlocked }
            #endif
        }
        private func stage(_ name: String) async throws {
            try unlocked(); report.stage = name; try await record()
        }
        private func wait(_ completed: (TAHUIPresentation) -> Bool) async throws {
            let deadline = ProcessInfo.processInfo.systemUptime + Double(report.phaseDeadlineSeconds)
            var last: State?, idleSince: Double?
            while ProcessInfo.processInfo.systemUptime < deadline {
                try unlocked()
                let state = controller.presentation
                if let transcriptID, state.transcriptID != transcriptID { throw Stop.unexpected_selection }
                if let actionID, state.editor?.actionID != actionID { throw Stop.unexpected_selection }
                if state.error != nil { throw Stop.controller_error }
                if state.material?.error != nil { throw Stop.material_read_failed }
                if completed(state) { try await record(); return }
                let current = snapshot()
                if current != last { try await record(); last = current }
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
