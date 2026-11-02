import Foundation

/// UI-only front door. A platform transport supplies one retained controller; no provider/Core RPC is exposed.
@MainActor
protocol TAHWebPresentationControlling: TAHPresentationController {
    var workingLogUsesChannel: Bool { get }
    func inspectAuthorization()
    func checkpointDraft() async throws
    func openWorkingLog(actionID: String, position: Int?)
    func refreshWorkingLog(id: String)
    func closeWorkingLog(id: String)
}

extension TAHWebPresentationControlling { var workingLogUsesChannel: Bool { false } }

extension TAHMobileController: TAHWebPresentationControlling {}

/// Same-module Swift entry for any web transport (including main's C FFI).
/// Read snapshots in response to native presentation/draft changes; the transport owns event delivery.
/// Dispatch returns the immediate snapshot, not a workflow receipt.
/// Optional snapshot fields are always present as JSON null; text is never interpolated into HTML/JavaScript.
@MainActor
final class TAHWebPresentationBridge {
    enum BridgeError: String, Error, LocalizedError {
        case invalidJSON = "invalid_json"
        case invalidCommand = "invalid_command"
        case invalidPayload = "invalid_payload"
        var errorDescription: String? { rawValue }
    }

    private let controller: any TAHWebPresentationControlling

    private struct SnapshotKey: Equatable, Sendable {
        let presentation: TAHUIPresentation
        let draft: TAHUIDraft
    }

    private struct SnapshotRequest {
        let id = UUID()
        let key: SnapshotKey
        let task: Task<String, Error>
    }

    // MainActor owns this single-entry display cache; it is never an authority for UI intents.
    private var cachedSnapshot: (key: SnapshotKey, json: String)?
    private var snapshotRequest: SnapshotRequest?

    init(controller: any TAHWebPresentationControlling) { self.controller = controller }

    private func snapshotKey() -> SnapshotKey {
        var presentation = controller.presentation
        // The channel owns log contents. Ordinary command/state replies carry
        // admission/metadata only, never another copy of a potentially large log.
        if controller.workingLogUsesChannel { presentation.workingLog?.events = [] }
        return SnapshotKey(presentation: presentation, draft: controller.draft)
    }

    func snapshot() async throws -> String {
        // Capture both values before suspension, including when joining an in-flight encoding.
        let key = snapshotKey()
        if let cachedSnapshot, cachedSnapshot.key == key { return cachedSnapshot.json }

        let request: SnapshotRequest
        if let snapshotRequest, snapshotRequest.key == key {
            request = snapshotRequest
        } else {
            cachedSnapshot = nil
            // Shared work outlives any one waiter. Detach only immutable Sendable values so JSON
            // construction stays off MainActor, also with Swift 5.9's concurrency semantics.
            request = SnapshotRequest(key: key, task: Task.detached(priority: Task.currentPriority) {
                try await Self.encodeSnapshot(key.presentation, draft: key.draft)
            })
            snapshotRequest = request
        }

        do {
            let json = try await request.task.value
            // Identity also guards A -> B -> A requests; an old A must not retire the new A.
            if snapshotRequest?.id == request.id {
                snapshotRequest = nil
                if snapshotKey() == key {
                    cachedSnapshot = (key, json)
                }
            }
            return json // Each caller still receives the version it captured, even if now stale.
        } catch {
            if snapshotRequest?.id == request.id { snapshotRequest = nil }
            throw error // Failed encodings are retried by the next snapshot request.
        }
    }

    #if compiler(>=6.2)
    @concurrent
    #endif
    nonisolated private static func encodeSnapshot(_ state: TAHUIPresentation, draft: TAHUIDraft) async throws -> String {
        dispatchPrecondition(condition: .notOnQueue(.main))
        let presentation: [String: Any] = [
            "transcripts": state.transcripts.map(Self.choice), "transcriptID": Self.nullable(state.transcriptID),
            "actions": state.actions.map(Self.choice), "editor": Self.context(state.editor),
            "models": state.models.map(Self.choice), "efforts": state.efforts.map(Self.choice),
            "contextWindows": state.contextWindows.map { ["id": $0.id, "title": $0.title, "enabled": $0.enabled] as [String: Any] },
            "interactionLanguage": state.interactionLanguage.rawValue,
            "initialSettingsFrozen": state.initialSettingsFrozen, "canOmitInstructions": state.canOmitInstructions,
            "consentGranted": state.consentGranted, "rawStatus": state.rawStatus,
            "rawExplanation": Self.nullable(state.rawExplanation), "rawValidityLabel": Self.nullable(state.rawValidityLabel),
            "status": state.status, "disabledReason": Self.nullable(state.disabledReason), "error": Self.nullable(state.error),
            "isBusy": state.isBusy, "hasMoreHistory": state.hasMoreHistory,
            "timeline": state.timeline.map { item -> [String: Any] in
                ["id": item.id, "title": item.title, "text": item.rawText ?? String(item.content.characters),
                 "markdown": item.markdown, "detail": Self.nullable(item.detail), "canExpand": item.canExpand,
                 "role": item.role.rawValue, "revisionIndex": item.revisionIndex, "phase": item.phase, "working": Self.working(item.working)]
            },
            "revisions": state.revisions.map { ["id": $0.id, "revisionIndex": $0.revisionIndex, "configurationLabel": $0.configurationLabel] as [String: Any] },
            "material": Self.material(state.material), "permissions": Self.permissions(state.permissions),
            "currentActivity": Self.working(state.currentActivity), "workingLog": Self.log(state.workingLog)
        ]
        let result: [String: Any] = ["presentation": presentation, "draft": [
            "outputLanguage": draft.outputLanguage.rawValue, "settings": Self.settings(draft.settings),
            "instructions": draft.instructions, "consent": draft.consent
        ]]
        return String(decoding: try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), as: UTF8.self)
    }

    /// Only UI intents are decoded here. Admission, consent, editor-token checks and scheduling remain in the controller.
    /// checkpointDraft waits for the existing checkpoint; busy/unavailable errors propagate so callers must not reload on failure.
    func dispatch(method: String, valueJSON: String) async throws -> String {
        let input = try Input(valueJSON)
        switch method {
        case "refresh":
            try input.keys([]); controller.refresh()
        case "inspectAuthorization":
            try input.keys([]); controller.inspectAuthorization()
        case "selectTranscript":
            try input.keys(["id"]); controller.selectTranscript(id: try input.decode(ID.self).id)
        case "selectAction":
            try input.keys(["id"]); controller.selectAction(id: try input.decode(ID.self).id)
        case "importTranscript":
            try input.keys(["title", "text"])
            let value = try input.decode(Import.self); controller.importTranscript(title: value.title, text: value.text)
        case "updateDraft":
            try input.keys(["draft", "context"])
            let draft = try input.object("draft")
            try Self.keys(draft, required: ["outputLanguage", "settings", "instructions", "consent"])
            try Self.validateSettings(draft["settings"])
            try Self.validateContext(input.fields["context"], nullable: true)
            let value = try input.decode(Update.self)
            controller.updateDraft(value.draft, context: value.context?.native)
        case "selectInteractionLanguage":
            try input.keys(["language"])
            controller.selectInteractionLanguage(try input.decode(Language.self).language)
        case "checkRawSafety":
            try input.keys(["transcriptID", "consent", "interactionLanguage"])
            let value = try input.decode(RawCheck.self)
            controller.checkRawSafety(transcriptID: value.transcriptID, consent: value.consent, interactionLanguage: value.interactionLanguage)
        case "createStructuredNotesAction":
            try input.keys(["transcriptID", "language", "settings"]); try Self.validateSettings(input.fields["settings"])
            let value = try input.decode(Create.self)
            controller.createStructuredNotesAction(transcriptID: value.transcriptID, language: value.language, settings: value.settings)
        case "sendAction":
            try input.keys(["context", "instructions", "settings", "interactionLanguage", "consent"], optional: ["initialLanguage"])
            try Self.validateContext(input.fields["context"], nullable: false); try Self.validateSettings(input.fields["settings"])
            let value = try input.decode(Send.self)
            controller.sendAction(.init(context: value.context.native, instructions: value.instructions, settings: value.settings,
                initialLanguage: value.initialLanguage, interactionLanguage: value.interactionLanguage, consent: value.consent))
        case "loadMoreConversation":
            try input.keys(["actionID"]); controller.loadMoreConversation(actionID: try input.decode(ActionID.self).actionID)
        case "expandConversation":
            try input.keys(["actionID", "itemID"])
            let value = try input.decode(Expand.self); controller.expandConversation(actionID: value.actionID, itemID: value.itemID)
        case "readMaterial":
            try input.keys(["kind", "actionID"], optional: ["revisionIndex", "file"])
            let value = try input.decode(Read.self)
            switch value.kind {
            case "rawTranscript":
                guard value.revisionIndex == nil, value.file == nil else { throw BridgeError.invalidPayload }
                controller.readMaterial(.rawTranscript(actionID: value.actionID))
            case "outcome":
                guard let revision = value.revisionIndex, revision >= 0, let name = value.file,
                      let file = TAHUIOutcomeFile(rawValue: name) else { throw BridgeError.invalidPayload }
                controller.readMaterial(.outcome(actionID: value.actionID, revisionIndex: revision, file: file))
            default: throw BridgeError.invalidPayload
            }
        case "dismissMaterial":
            try input.keys([]); controller.dismissMaterial()
        case "checkpointDraft":
            try input.keys([]); try await controller.checkpointDraft()
        case "openWorkingLog":
            try input.keys(["actionID", "position"])
            let value = try input.decode(LogOpen.self)
            guard value.position.map({ $0 > 0 }) ?? true else { throw BridgeError.invalidPayload }
            controller.openWorkingLog(actionID: value.actionID, position: value.position)
        case "refreshWorkingLog":
            try input.keys(["id"]); controller.refreshWorkingLog(id: try input.decode(ID.self).id)
        case "closeWorkingLog":
            try input.keys(["id"]); controller.closeWorkingLog(id: try input.decode(ID.self).id)
        default: throw BridgeError.invalidCommand
        }
        return try await snapshot()
    }

    nonisolated private static func nullable<T>(_ value: T?) -> Any { value.map { $0 as Any } ?? NSNull() }
    nonisolated private static func choice(_ value: TAHUIChoice) -> [String: Any] {
        ["id": value.id, "title": value.title, "enabled": value.enabled]
    }
    nonisolated private static func context(_ value: TAHUIEditorContext?) -> Any {
        guard let value else { return NSNull() }
        return ["actionID": value.actionID, "editorToken": value.editorToken]
    }
    nonisolated private static func settings(_ value: TAHUIRevisionSettings) -> [String: Any] {
        ["providerID": nullable(value.providerID), "modelID": nullable(value.modelID),
         "reasoningEffortID": nullable(value.reasoningEffortID), "contextWindowTokens": nullable(value.contextWindowTokens),
         "webEnabled": value.webEnabled]
    }
    nonisolated private static func material(_ value: TAHUIMaterial?) -> Any {
        guard let value else { return NSNull() }
        let text = value.rawText ?? value.content.map { String($0.characters) }
        return ["id": value.id, "title": value.title, "text": nullable(text), "markdown": value.markdown,
                "isLoading": value.isLoading, "error": nullable(value.error)] as [String: Any]
    }
    nonisolated private static func permissions(_ value: TAHUIPermissions) -> [String: Bool] {
        ["selectTranscript": value.selectTranscript, "importTranscript": value.importTranscript,
         "selectAction": value.selectAction, "checkRaw": value.checkRaw, "createAction": value.createAction,
         "edit": value.edit, "editConsent": value.editConsent, "editInteractionLanguage": value.editInteractionLanguage,
         "send": value.send, "readMaterial": value.readMaterial, "loadHistory": value.loadHistory]
    }
    nonisolated static func event(_ value: TAHUIWorkingEvent) -> [String: Any] {
        ["id": value.id, "title": value.title, "detail": value.detail, "role": value.role, "kind": value.kind,
         "titleCode": nullable(value.titleCode), "status": nullable(value.status), "detailTruncated": value.detailTruncated, "round": nullable(value.round)]
    }
    nonisolated private static func working(_ value: TAHUIWorkingSummary?) -> Any {
        guard let value else { return NSNull() }
        return ["id": value.id, "position": nullable(value.position), "revisionIndex": value.revisionIndex, "phase": value.phase,
                "startedAt": nullable(value.startedAt), "endedAt": nullable(value.endedAt), "events": value.events.map(event),
                "canOpen": value.canOpen, "live": value.live, "progressing": value.progressing, "criticPassed": value.criticPassed] as [String: Any]
    }
    nonisolated static func log(_ value: TAHUIWorkingLog?) -> Any {
        guard let value else { return NSNull() }
        return ["id": value.id, "actionID": value.actionID, "position": nullable(value.position), "revisionIndex": value.revisionIndex,
                "startedAt": nullable(value.startedAt), "endedAt": nullable(value.endedAt), "events": value.events.map(event),
                "criticPassed": value.criticPassed, "loading": value.loading, "failed": value.failed, "limited": value.limited,
                "superseded": value.superseded, "progressing": value.progressing, "error": nullable(value.error)] as [String: Any]
    }
    nonisolated private static func keys(_ fields: [String: Any], required: Set<String>, optional: Set<String> = []) throws {
        let keys = Set(fields.keys)
        guard required.isSubset(of: keys), keys.isSubset(of: required.union(optional)) else { throw BridgeError.invalidPayload }
    }
    nonisolated private static func validateSettings(_ value: Any?) throws {
        guard let fields = value as? [String: Any] else { throw BridgeError.invalidPayload }
        try keys(fields, required: ["webEnabled"], optional: ["providerID", "modelID", "reasoningEffortID", "contextWindowTokens"])
    }
    nonisolated private static func validateContext(_ value: Any?, nullable: Bool) throws {
        if nullable && value is NSNull { return }
        guard let fields = value as? [String: Any] else { throw BridgeError.invalidPayload }
        try keys(fields, required: ["actionID", "editorToken"])
    }

    private struct Input {
        let data: Data
        let fields: [String: Any]
        init(_ json: String) throws {
            data = Data(json.utf8)
            guard let object = try? JSONSerialization.jsonObject(with: data), let fields = object as? [String: Any] else { throw BridgeError.invalidJSON }
            self.fields = fields
        }
        func keys(_ required: Set<String>, optional: Set<String> = []) throws { try TAHWebPresentationBridge.keys(fields, required: required, optional: optional) }
        func object(_ key: String) throws -> [String: Any] {
            guard let value = fields[key] as? [String: Any] else { throw BridgeError.invalidPayload }; return value
        }
        func decode<T: Decodable>(_ type: T.Type) throws -> T {
            guard let value = try? JSONDecoder().decode(type, from: data) else { throw BridgeError.invalidPayload }; return value
        }
    }
    private struct ID: Decodable { let id: String }
    private struct LogOpen: Decodable { let actionID: String; let position: Int? }
    private struct ActionID: Decodable { let actionID: String }
    private struct Import: Decodable { let title: String; let text: String }
    private struct Language: Decodable { let language: TAHUILanguage }
    private struct Context: Decodable {
        let actionID: String; let editorToken: String
        var native: TAHUIEditorContext { .init(actionID: actionID, editorToken: editorToken) }
    }
    private struct Update: Decodable { let draft: TAHUIDraft; let context: Context? }
    private struct RawCheck: Decodable { let transcriptID: String; let consent: Bool; let interactionLanguage: TAHUILanguage }
    private struct Create: Decodable { let transcriptID: String; let language: TAHUILanguage; let settings: TAHUIRevisionSettings }
    private struct Send: Decodable {
        let context: Context; let instructions: String; let settings: TAHUIRevisionSettings
        let initialLanguage: TAHUILanguage?; let interactionLanguage: TAHUILanguage; let consent: Bool
    }
    private struct Expand: Decodable { let actionID: String; let itemID: String }
    private struct Read: Decodable { let kind: String; let actionID: String; let revisionIndex: Int?; let file: String? }
}
