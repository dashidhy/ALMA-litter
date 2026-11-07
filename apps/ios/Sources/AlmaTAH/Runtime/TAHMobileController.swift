import Foundation
import CryptoKit
import Observation

/// Native App-contract projection only. All role/policy/revision/publication decisions stay in AppActions.
@MainActor @Observable
final class TAHMobileController: TAHPresentationController {
    typealias ProviderPlatform = AlmaTAHJavaScriptHost.PlatformCall
    typealias Value = TAHRuntimeValue
    private(set) var presentation = TAHUIPresentation()
    private(set) var draft = TAHUIDraft()
    @ObservationIgnored private var host: AlmaTAHJavaScriptHost?
    @ObservationIgnored private let journal: TAHJournalStore
    @ObservationIgnored private let providerPlatform: ProviderPlatform
    @ObservationIgnored private let prompts: [String: String]
    @ObservationIgnored private let localURL: URL
    @ObservationIgnored private var saved: SavedUI
    @ObservationIgnored private var auth: AppAuth?
    @ObservationIgnored private var raw: AppRaw?
    @ObservationIgnored private var action: AppAction?
    @ObservationIgnored private var actions: [AppActionRow] = []
    @ObservationIgnored private var history: [AppMessage] = []
    @ObservationIgnored private var formattedHistory: [String: AttributedString] = [:]
    @ObservationIgnored private var historyCursor: String?
    @ObservationIgnored private var selectedTranscript: String?
    @ObservationIgnored private var commandBusy = false
    @ObservationIgnored private var ready = false
    @ObservationIgnored private var refreshPending = false
    @ObservationIgnored private var fullRefreshPending = false
    @ObservationIgnored private var writeEpoch = 0
    @ObservationIgnored private var writesInFlight = 0
    @ObservationIgnored private var identityEpoch = 0
    @ObservationIgnored private var historyBaseline: HistoryBaseline?
    @ObservationIgnored private var historyReload: HistoryReload?
    @ObservationIgnored private var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var expiryTask: Task<Void, Never>?
    @ObservationIgnored private var expiryKey: String?
    @ObservationIgnored private var latestProgress: AppProgress?
    @ObservationIgnored private var progressVersions: [String: Int] = [:]
    @ObservationIgnored private var logReader: TAHMobileWorkingLogReader?
    @ObservationIgnored private var memoryLogReader: TAHMemoryWorkingLogReader?
    @ObservationIgnored private(set) var workingLogUsesChannel = false
    @ObservationIgnored private var workingConsumerReady = false
    @ObservationIgnored var workingLogDidChange: (@MainActor (TAHUIWorkingLog?) -> Void)?
    @ObservationIgnored private var lastError: String?

    /// bundleURL must contain main's boot-composed AlmaMobileRuntime, not just its factory export.
    /// configurationJSON is passed unchanged: {profiles, resources, actionInstructions}.
    init(bundleURL: URL, promptURLs: [String: URL] = [:], configurationJSON: String,
         journalDirectory: URL, providerPlatform: @escaping ProviderPlatform) async throws {
        self.providerPlatform = providerPlatform
        localURL = journalDirectory.appendingPathComponent("mobile-ui.json")
        journal = try await Self.openJournal(journalDirectory)
        saved = try await Self.loadSaved(localURL)
        var resources: [String: String] = [:]
        for (path, url) in promptURLs { resources[path] = try await Self.readUTF8(url, limit: 1024 * 1024) }
        prompts = resources
        let source = try await Self.readUTF8(bundleURL, limit: 32 * 1024 * 1024)
        guard case .object = try Self.decode(Value.self, configurationJSON) else { throw TAHRuntimeError.invalid_request }
        do {
            host = try await AlmaTAHJavaScriptHost(bundle: source, platform: { [weak self] method, json in
                guard let self else { throw TAHRuntimeError.unavailable }
                return try await self.platform(method, json: json)
            }, providerDirectory: bundleURL.deletingLastPathComponent())
            _ = try await host!.invoke("runtime.initialize", json: configurationJSON)
            ready = true; commandBusy = true
            selectedTranscript = saved.transcripts.first?.id
            try await refreshState()
            commandBusy = false; rebuild(); scheduleRefresh()
        } catch {
            ready = false; refreshTask?.cancel(); refreshTask = nil; refreshPending = false
            await host?.shutdown(); await journal.close(); throw error
        }
    }

    func shutdown() async {
        ready = false; expiryTask?.cancel(); expiryTask = nil; expiryKey = nil; latestProgress = nil; logReader?.close(); memoryLogReader?.close()
        historyBaseline = nil; historyReload = nil; fullRefreshPending = false
        refreshTask?.cancel(); refreshTask = nil; refreshPending = false
        try? await checkpoint()
        if let host { _ = try? await host.invoke("runtime.shutdown", json: "{}") }
        await host?.shutdown(); host = nil; await journal.close(); rebuild()
    }

    private func platform(_ method: String, json: String) async throws -> String {
        if method.hasPrefix("store.") {
            return try await forwardStore(method, json: json)
        }
        switch method {
        case "resources.read":
            let value = try Self.decode(Value.self, json); try value.requireKeys(["path"])
            guard let path = try value["path"]?.string(), let text = prompts[path] else { throw TAHRuntimeError.invalid_request }
            return try Self.encode(Value.object(["base64": .string(Data(text.utf8).base64EncodedString())]))
        case "ui.auth":
            let incoming = try Self.decode(AppAuth.self, json)
            if acceptAuth(incoming, notification: true) {
                rebuild(); requestRefresh(forceFull: true)
            }
            return "null"
        case "ui.actionChanged":
            let incoming = try Self.decode(AppProgress.self, json)
            receiveProgress(incoming)
            return "null" // ACK before any JS read; never await a reentrant snapshot here.
        case "ui.rawChanged":
            let incoming = try Self.decode(AppInvalidation.self, json)
            if accept(source: incoming.sourceID, revision: incoming.sourceRevision, channel: "raw") {
                requestRefresh()
            }
            return "null"
        case "ui.runtimeFailed":
            ready = false; expiryTask?.cancel(); expiryTask = nil; expiryKey = nil
            refreshTask?.cancel(); refreshTask = nil; refreshPending = false; fullRefreshPending = false
            historyBaseline = nil; latestProgress = nil
            lastError = "The local runtime connection stopped. Reopen the app to reconnect."
            rebuild()
            return "null"
        default:
            guard method.hasPrefix("provider.") || method.hasPrefix("credential.") || method == "runtime.prepareProvider" else { throw TAHRuntimeError.invalid_request }
            return try await providerPlatform(method, json) // opaque provider boundary; never decode Codex wire
        }
    }

    private func forwardStore(_ method: String, json: String) async throws -> String {
        // Observe only the transport method. Payload validation, commit authority
        // and all business decisions remain in the original Store/Core.
        let writing: Bool
        switch method {
        case "store.head", "store.entries", "store.readChunk", "store.pending",
             "store.pendingChunk", "store.pendingIsComplete", "store.streams", "store.actionStreams": writing = false
        default: writing = true // unknown methods fail conservatively
        }
        let provisional = method == "store.begin" || method == "store.putChunk"
        var succeeded = false
        if writing { writesInFlight += 1; writeEpoch += 1; historyBaseline = nil }
        defer {
            if writing {
                writesInFlight -= 1; writeEpoch += 1
                historyBaseline = nil
                // Also invalidate failed/uncertain ACKs. Never await a JS read here.
                // Uploading each chunk does not publish a new committed view.
                // Commit/cancel/deletion and uncertain failures do. Core's phase
                // and Raw notifications cover transitions after the store ACK.
                if !provisional || !succeeded { requestRefresh(forceFull: true) }
                scheduleRefresh() // release a pre-existing explicit read held behind a chunk write
            }
        }
        let result = try await journal.handleJSONRPC(method, json: json)
        succeeded = true
        return result
    }

    @discardableResult private func acceptAuth(_ incoming: AppAuth, notification: Bool = false) -> Bool {
        guard ready, accept(source: incoming.sourceID, revision: incoming.sourceRevision, channel: "auth") else { return false }
        // sourceRevision advances even for an unchanged auth.snapshot. It orders
        // responses, but is not an identity/cache generation.
        if notification || auth?.sourceID != incoming.sourceID || auth?.providerID != incoming.providerID
            || auth?.account != incoming.account || auth?.state != incoming.state || auth?.phase != incoming.phase
            || auth?.inspecting != incoming.inspecting || auth?.inspection != incoming.inspection
            || auth?.replacement != incoming.replacement || auth?.actorCatalog != incoming.actorCatalog {
            identityEpoch += 1; historyBaseline = nil; latestProgress = nil
        }
        auth = incoming
        return true
    }

    private func accept(source: String?, revision: Int?, channel: String) -> Bool {
        guard let source, let revision else { return true }
        let key = channel + "/" + source
        guard revision > (progressVersions[key] ?? -1) else { return false }
        progressVersions[key] = revision; return true
    }
    private func call<T: Decodable & Sendable>(_ method: String, _ fields: [String: Value] = [:], as: T.Type = T.self) async throws -> T {
        guard let host else { throw TAHRuntimeError.unavailable }
        let json = try await host.invoke(method, json: Self.encode(Value.object(fields)))
        return try await Self.decodeResponse(T.self, json)
    }
    private func command(refreshAfter: Bool = true, _ operation: @escaping @MainActor () async throws -> Void) {
        guard ready, !commandBusy else { return }
        if refreshAfter { historyBaseline = nil }
        commandBusy = true; lastError = nil; rebuild()
        Task { [self] in
            do { try await operation(); if refreshAfter { try await refreshState() } }
            catch { lastError = "TAH request failed. Refresh to inspect the current state." }
            commandBusy = false; rebuild()
            scheduleRefresh()
        }
    }
    func refresh() {
        guard ready else { return }
        // Explicit refresh/foreground/clock-change recalibrates the deadline.
        expiryTask?.cancel(); expiryTask = nil; expiryKey = nil
        if commandBusy { requestRefresh(forceFull: true); return }
        runRefresh(forceFull: true)
    }
    private func runRefresh(forceFull: Bool) {
        command(refreshAfter: false) { [self] in try await refreshState(forceFull: forceFull) }
    }
    /// Explicit authorization inspection; never silently triggered by a read/refresh.
    func inspectAuthorization() { command { [self] in acceptAuth(try await call("auth.inspect")) } }
    func selectProvider(id: String) {
        guard presentation.authorization.canManage, auth?.providers?.contains(where: { $0.id == id }) == true,
              auth?.providerID != id else { return }
        command { [self] in
            if auth?.state == "unauthed" {
                acceptAuth(try await call("auth.select", ["providerID": .string(id)]))
            } else {
                acceptAuth(try await call("auth.replacement", ["kind": .string("switch_provider"), "providerID": .string(id)]))
            }
        }
    }
    func authorizeProvider() {
        guard presentation.authorization.canManage, auth?.providerID != nil else { return }
        command { [self] in
            if auth?.state == "unauthed" { acceptAuth(try await call("auth.authorize")) }
            else { acceptAuth(try await call("auth.replacement", ["kind": .string("reauth")])) }
        }
    }
    func requestAuthorizationReplacement(kind: String) {
        guard presentation.authorization.canManage, ["reauth", "switch_account", "sign_out"].contains(kind) else { return }
        command { [self] in acceptAuth(try await call("auth.replacement", ["kind": .string(kind)])) }
    }
    func confirmAuthorizationReplacement(id: String, confirmed: Bool) {
        guard !commandBusy, auth?.replacement?.id == id else { return }
        command { [self] in
            acceptAuth(try await call("auth.confirm", ["id": .string(id), "confirmed": .bool(confirmed)]))
        }
    }
    private func requestRefresh(forceFull: Bool = false) {
        guard ready else { return }
        refreshPending = true
        fullRefreshPending = fullRefreshPending || forceFull
        if forceFull { historyBaseline = nil }
        scheduleRefresh()
    }
    private func scheduleRefresh() {
        guard ready, refreshPending, !commandBusy, writesInFlight == 0, refreshTask == nil else { return }
        // One queued read for a callback burst. Do not await it from a platform ACK.
        refreshTask = Task { [weak self] in
            guard let self, !Task.isCancelled, self.ready else { return }
            self.refreshTask = nil
            if self.refreshPending, !self.commandBusy { self.runRefresh(forceFull: false) }
        }
    }
    private func receiveProgress(_ incoming: AppProgress) {
        guard ready, accept(source: incoming.sourceID, revision: incoming.sourceRevision, channel: incoming.actionID) else { return }
        guard action?.id == incoming.actionID else {
            if incoming.transcriptID == selectedTranscript { requestRefresh(forceFull: true) }
            return
        }
        latestProgress = incoming
        guard let current = action, canApplyLive(incoming, to: current) else {
            // Phase/operation/terminal boundaries need a canonical snapshot for
            // editor, publication and permission fields absent from progress.
            requestRefresh(); return
        }
        action = applyingLive(incoming, to: current)
        rebuild()
    }
    private func canApplyLive(_ progress: AppProgress, to current: AppAction) -> Bool {
        current.editorMode == "running" && current.id == progress.actionID
            && current.operationID != nil && current.operationID == progress.operationID
            && current.phase == progress.phase && progress.events != nil && progress.pendingSave == nil
            && ["preparing", "raw_guardian", "extra_guardian", "actor", "critic", "saving_safety"].contains(current.phase)
    }
    private func applyingLive(_ progress: AppProgress, to current: AppAction) -> AppAction {
        var next = current
        next.events = progress.events ?? current.events
        next.presentation = progress.presentation
        next.progressSourceID = progress.sourceID; next.progressRevision = progress.sourceRevision
        return next
    }
    private func currentSnapshot(_ incoming: AppAction) -> AppAction? {
        guard let progress = latestProgress, progress.actionID == incoming.id,
              progress.sourceID == incoming.progressSourceID,
              let revision = progress.sourceRevision, revision > (incoming.progressRevision ?? -1) else { return incoming }
        guard canApplyLive(progress, to: incoming) else { requestRefresh(); return nil }
        return applyingLive(progress, to: incoming)
    }
    private func scheduleExpiry() {
        guard ready, let raw, let date = raw.expiryDate, date > Date(),
              raw.state == "allowed" || raw.state == "blocked" else {
            expiryTask?.cancel(); expiryTask = nil; expiryKey = nil; return
        }
        let key = "\(raw.materialID)/\(raw.providerID ?? "")/\(raw.expiresAt ?? "")"
        guard key != expiryKey else { return }
        expiryTask?.cancel(); expiryKey = key
        expiryTask = Task { [weak self] in
            do { try await Task.sleep(for: .seconds(max(0.001, date.timeIntervalSinceNow))) } catch { return }
            guard let self, self.ready, self.expiryKey == key, !Task.isCancelled else { return }
            self.expiryReached(key)
        }
    }
    private func expiryReached(_ key: String) {
        guard ready, expiryKey == key else { return }
        expiryTask = nil; expiryKey = nil
        // Disable the UI at the real deadline before its one authoritative read.
        // Core still independently checks permission at submission.
        rebuild(); requestRefresh()
    }

    func selectTranscript(id: String) {
        guard presentation.permissions.selectTranscript, saved.transcripts.contains(where: { $0.id == id }) else { return }
        command { [self] in
            logReader?.close(); memoryLogReader?.close(); try await checkpoint(); selectedTranscript = id; action = nil; raw = nil
            actions = []; history = []; formattedHistory = [:]; historyCursor = nil; historyReload = nil; draft = TAHUIDraft(); dismissMaterial()
        }
    }
    func importTranscript(title: String, text: String) {
        guard presentation.permissions.importTranscript, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf8.count <= 32 * 1024 * 1024, title.count <= 512 else { return }
        command { [self] in
            logReader?.close(); memoryLogReader?.close(); try await checkpoint()
            let item = Transcript(id: UUID().uuidString.lowercased(), materialID: UUID().uuidString.lowercased(),
                                  title: title.isEmpty ? "Transcript" : title)
            let _: Value = try await call("material.put", ["transcriptID": .string(item.id), "materialID": .string(item.materialID),
                                                         "title": .string(item.title), "rawTranscript": .string(text)])
            saved.transcripts.append(item); try await persist()
            selectedTranscript = item.id; action = nil; raw = nil; history = []; formattedHistory = [:]; historyCursor = nil; historyReload = nil
            draft = TAHUIDraft(); dismissMaterial()
        }
    }

    /// Trusted file-import entry. Stable identities make a retried transfer
    /// idempotent; material.put retains the core's immutable-byte check.
    func importPreparedTranscript(id: String, materialID: String, title: String, text: String) async throws {
        guard ready, !commandBusy, !presentation.isBusy,
              UUID(uuidString: id)?.uuidString.lowercased() == id,
              UUID(uuidString: materialID)?.uuidString.lowercased() == materialID,
              title.count <= 512, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              text.utf8.count <= 32 * 1024 * 1024 else { throw TAHRuntimeError.invalid_request }
        commandBusy = true; lastError = nil; rebuild()
        defer { commandBusy = false; rebuild(); scheduleRefresh() }
        logReader?.close(); memoryLogReader?.close(); try await checkpoint()
        let item = Transcript(id: id, materialID: materialID, title: title)
        if let old = saved.transcripts.first(where: { $0.id == id }),
           old.materialID != materialID || old.title != title { throw TAHRuntimeError.integrity_locked }
        let _: Value = try await call("material.put", ["transcriptID": .string(id), "materialID": .string(materialID),
                                                     "title": .string(title), "rawTranscript": .string(text)])
        if !saved.transcripts.contains(where: { $0.id == id }) { saved.transcripts.append(item) }
        try await persist()
        selectedTranscript = id; action = nil; raw = nil; actions = []; history = []; formattedHistory = [:]; historyCursor = nil; historyReload = nil
        draft = TAHUIDraft(); dismissMaterial()
        try await refreshState()
    }
    func selectAction(id: String) {
        guard presentation.permissions.selectAction, actions.contains(where: { $0.id == id }) else { return }
        command { [self] in
            logReader?.close(); memoryLogReader?.close(); try await checkpoint(); action = try await call("action.snapshot", ["actionID": .string(id)])
            history = []; formattedHistory = [:]; historyCursor = nil; historyReload = nil; restoreDraft(); dismissMaterial()
        }
    }
    func updateDraft(_ value: TAHUIDraft, context: TAHUIEditorContext?) {
        guard context == presentation.editor else { return }
        if presentation.permissions.edit {
            let previousModel = draft.settings.modelID
            let previousSettings = draft.settings
            draft = value
            if presentation.initialSettingsFrozen, let language = action?.language { draft.outputLanguage = language }
            if draft.settings.providerID != auth?.providerID { draft.settings = previousSettings }
            if previousModel != draft.settings.modelID { chooseModelDefaults() }
        } else if presentation.permissions.editConsent { draft.consent = value.consent }
        rebuild()
    }
    func selectInteractionLanguage(_ language: TAHUILanguage) {
        guard presentation.permissions.editInteractionLanguage else { return }
        saved.interactionLanguage = language; rebuild()
    }
    func checkRawSafety(transcriptID: String, consent: Bool, interactionLanguage: TAHUILanguage) {
        guard presentation.permissions.checkRaw, transcriptID == selectedTranscript, let material = selectedMaterial else { return }
        command { [self] in
            raw = try await call("raw.check", ["materialID": .string(material.materialID), "operationID": .string(UUID().uuidString.lowercased()),
                                              "consent": .bool(consent), "interactionLanguage": .string(interactionLanguage.rawValue)])
        }
    }
    func createStructuredNotesAction(transcriptID: String, language: TAHUILanguage, settings: TAHUIRevisionSettings) {
        guard presentation.permissions.createAction, transcriptID == selectedTranscript, let material = selectedMaterial else { return }
        command { [self] in
            logReader?.close(); memoryLogReader?.close(); try await checkpoint()
            action = try await call("action.create", ["actionID": .string(UUID().uuidString.lowercased()), "materialID": .string(material.materialID),
                                                     "language": .string(language.rawValue), "draftSettings": Self.settingsValue(settings)])
            history = []; formattedHistory = [:]; historyCursor = nil; historyReload = nil; restoreDraft(); dismissMaterial()
        }
    }
    func sendAction(_ submission: TAHUISubmission) {
        guard presentation.permissions.send, submission.context == presentation.editor,
              submission.settings == draft.settings, submission.instructions == draft.instructions else { return }
        command { [self] in
            try await checkpoint()
            let fields = try Self.sendFields(submission)
            let _: Value = try await call("action.send", fields)
            // Clear only the exact submitted draft after admission. Frozen/history state comes from core.
            if presentation.editor == submission.context { draft.instructions = "" }
        }
    }
    private var selectedMaterial: Transcript? { saved.transcripts.first { $0.id == selectedTranscript } }

    private struct HistoryBaseline {
        let transcriptID: String; let materialID: String
        let identityEpoch: Int; let writeEpoch: Int
        let action: AppAction; let raw: AppRaw
    }
    private struct HistoryReload {
        let actionID: String; let editorToken: String
        let items: [AppMessage]; let formatted: [String: AttributedString]
    }
    private func canReuseHistory(_ next: AppAction, raw nextRaw: AppRaw, selected: Transcript) -> Bool {
        guard let baseline = historyBaseline, writesInFlight == 0,
              baseline.transcriptID == selected.id, baseline.materialID == selected.materialID,
              baseline.identityEpoch == identityEpoch, baseline.writeEpoch == writeEpoch,
              baseline.raw == nextRaw, baseline.action.editorMode == "running", next.editorMode == "running",
              let operation = next.operationID, baseline.action.operationID == operation else { return false }
        let old = baseline.action
        // Only live presentation/events may change on the fast path. A new phase,
        // publication or editor scope takes the original full read path.
        return old.id == next.id && old.transcriptID == next.transcriptID && old.editorToken == next.editorToken
            && old.phase == next.phase && old.revisions == next.revisions && old.revisionIndex == next.revisionIndex
            && old.latestSubmittedRevisionIndex == next.latestSubmittedRevisionIndex && old.language == next.language
            && old.initialSettingsFrozen == next.initialSettingsFrozen && old.draftSettings == next.draftSettings
            && old.canOmitInstructions == next.canOmitInstructions && old.error == next.error
            && old.contentConsentProviderID == next.contentConsentProviderID && old.contentConsentGranted == next.contentConsentGranted
    }

    private func refreshState(forceFull: Bool = true) async throws {
        // This read covers every request received before it starts. Requests arriving
        // across an await remain pending for one follow-up read of the latest state.
        let full = forceFull || fullRefreshPending
        fullRefreshPending = false
        refreshPending = false; refreshTask?.cancel(); refreshTask = nil
        let startWrite = writeEpoch, overlappedWrite = writesInFlight != 0
        var completed = false
        defer { if !completed { historyBaseline = nil } }
        acceptAuth(try await call("auth.snapshot"))
        guard ready else { throw CancellationError() }
        let readIdentity = identityEpoch
        if draft.settings.providerID != auth?.providerID {
            draft.settings = TAHUIRevisionSettings(providerID: auth?.providerID)
            draft.consent = false
        }
        if draft.settings.modelID == nil { chooseDefaultModel() }
        guard let selected = selectedMaterial else { historyBaseline = nil; historyReload = nil; rebuild(); return }
        var nextAction: AppAction?
        var missingActionID: String?
        if let id = action?.id {
            do {
                let next: AppAction = try await call("action.snapshot", ["actionID": .string(id)])
                guard next.id == id, next.transcriptID == selected.id else { throw TAHRuntimeError.integrity_locked }
                guard let current = currentSnapshot(next) else { return }
                nextAction = current
            } catch TAHRuntimeError.invalid_request {
                // A different App command may have deleted the selected Action.
                // Confirm absence through Core's list before clearing selection.
                missingActionID = id
            }
        }
        // action.snapshot already contains the exact Raw status it used. Avoid
        // reading/hashing the same transcript again for the separate status row.
        let nextRaw: AppRaw
        if let included = nextAction?.rawSafety {
            guard included.materialID == selected.materialID else { throw TAHRuntimeError.integrity_locked }
            nextRaw = included
        } else {
            nextRaw = try await call("raw.status", ["materialID": .string(selected.materialID)])
        }
        guard ready else { throw CancellationError() }
        guard readIdentity == identityEpoch else { requestRefresh(forceFull: true); rebuild(); return }
        let reuse = !full && !fullRefreshPending && !overlappedWrite && startWrite == writeEpoch
            && nextAction.map { canReuseHistory($0, raw: nextRaw, selected: selected) } == true
        raw = nextRaw
        if let next = nextAction {
            let previousToken = action?.editorToken
            action = next
            if previousToken != next.editorToken { history = []; historyCursor = nil; formattedHistory = [:]; historyReload = nil; restoreDraft() }
            else if next.initialSettingsFrozen { draft.outputLanguage = next.language }
        } else if draft.settings.modelID == nil { chooseDefaultModel() }
        if !reuse {
            historyBaseline = nil
            var rows: [AppActionRow] = [], cursor: String?
            repeat {
                let page: ActionPage = try await call("action.list", ["transcriptID": .string(selected.id), "cursor": cursor.map(Value.string) ?? .null])
                rows.append(contentsOf: page.actions); cursor = page.nextCursor
                guard rows.count <= 4096 else { throw TAHRuntimeError.invalid_request }
            } while cursor != nil
            guard ready else { throw CancellationError() }
            actions = rows
            if let missingActionID {
                guard !rows.contains(where: { $0.id == missingActionID }) else { throw TAHRuntimeError.invalid_request }
                action = nil; history = []; historyCursor = nil; formattedHistory = [:]; historyReload = nil
                draft = TAHUIDraft(); logReader?.close(); memoryLogReader?.close(); dismissMaterial()
            }
            try await loadHistory(reset: true)
        }
        guard ready else { throw CancellationError() }
        if let next = action {
            guard let current = currentSnapshot(next) else { return }
            action = current
        }
        if overlappedWrite || startWrite != writeEpoch || writesInFlight != 0 || readIdentity != identityEpoch {
            historyBaseline = nil
            requestRefresh(forceFull: true)
        } else if !fullRefreshPending, let next = nextAction, next.editorMode == "running", next.operationID != nil {
            historyBaseline = HistoryBaseline(transcriptID: selected.id, materialID: selected.materialID,
                identityEpoch: identityEpoch, writeEpoch: writeEpoch, action: next, raw: nextRaw)
        } else { historyBaseline = nil }
        completed = true
        rebuild()
    }
    private func restoreDraft() {
        guard let action else { return }
        draft = saved.drafts[action.id + "/" + action.editorToken] ?? TAHUIDraft(outputLanguage: action.language,
            settings: action.draftSettings ?? TAHUIRevisionSettings(), instructions: "", consent: false)
        if action.initialSettingsFrozen { draft.outputLanguage = action.language }
        if draft.settings.providerID != auth?.providerID {
            draft.settings = TAHUIRevisionSettings(providerID: auth?.providerID)
            draft.consent = false
        }
        if draft.settings.modelID == nil { chooseDefaultModel() }
    }
    private func chooseDefaultModel() {
        guard let catalog = auth?.actorCatalog else { return }
        draft.settings.providerID = auth?.providerID
        draft.settings.modelID = catalog.models.first(where: { $0.handle == catalog.defaultModelHandle })?.handle ?? catalog.models.first?.handle
        chooseModelDefaults()
    }
    private func chooseModelDefaults() {
        let model = auth?.actorCatalog?.models.first { $0.handle == draft.settings.modelID }
        draft.settings.reasoningEffortID = model?.defaultEffortHandle ?? model?.efforts.first?.handle
        draft.settings.contextWindowTokens = model?.contextWindows?.defaultTokens
    }
    private func checkpoint() async throws {
        if let action { saved.drafts[action.id + "/" + action.editorToken] = draft }
        try await persist()
    }
    /// Explicit UI reload checkpoint; admission stays serialized with existing controller commands.
    func checkpointDraft() async throws {
        guard ready else { throw TAHRuntimeError.unavailable }
        guard !commandBusy else { throw TAHRuntimeError.busy }
        commandBusy = true; rebuild()
        defer {
            commandBusy = false; rebuild()
            scheduleRefresh()
        }
        try await checkpoint()
    }
    private func persist() async throws { try await Self.save(saved, to: localURL) }

    func loadMoreConversation(actionID: String) {
        guard actionID == action?.id, historyCursor != nil, presentation.permissions.loadHistory else { return }
        command { [self] in try await loadHistory(reset: false) }
    }
    private func loadHistory(reset: Bool) async throws {
        guard let action else { return }
        let retained = historyReload.flatMap { $0.actionID == action.id && $0.editorToken == action.editorToken ? $0 : nil }
        let priorItems = reset ? retained?.items ?? history : history
        let previous = Dictionary(uniqueKeysWithValues: priorItems.map { ($0.id, $0) })
        let previousFormatted = reset ? retained?.formatted ?? formattedHistory : formattedHistory
        let oldest = priorItems.first?.position
        let readIdentity = identityEpoch, readWrite = writeEpoch
        let overlappedWrite = writesInFlight != 0
        var cursor = reset ? nil : historyCursor
        // Reset is authoritative over the previously loaded depth, not a union:
        // Core can hide a cycle on reedit without changing the editorToken.
        if reset {
            // Retain only a reload seed, never a display/permission authority.
            // A failed or overlapping read must neither expose hidden cycles nor
            // forget the loaded depth and expanded text for the next full read.
            historyReload = HistoryReload(actionID: action.id, editorToken: action.editorToken,
                items: priorItems, formatted: previousFormatted)
            history = []; historyCursor = nil; formattedHistory = [:]
        }
        var incoming: [AppMessage] = []
        repeat {
            let page: ConversationPage = try await call("action.conversation", ["actionID": .string(action.id), "cursor": cursor.map(Value.string) ?? .null])
            incoming.append(contentsOf: page.items); cursor = page.nextCursor
            guard incoming.count <= 4096 else { throw TAHRuntimeError.invalid_request }
            if !reset || oldest == nil || (page.items.last?.position ?? Int.max) <= oldest! { break }
        } while cursor != nil
        var merged: [String: AppMessage] = reset ? [:] : previous
        for var item in incoming {
            if let expanded = previous[item.id], !expanded.truncated, item.truncated {
                item.text = expanded.text; item.truncated = false
            }
            merged[item.id] = item
        }
        // Core conversationPage already applies visibleCycles. operationID may be an executionID,
        // so it must not be compared with a conversation cycleID here.
        let nextHistory = merged.values.sorted { $0.position < $1.position }
        var formatted = previousFormatted.filter { merged[$0.key] != nil }
        for item in nextHistory where item.isFinalAnswer == true && formatted[item.id] == nil {
            formatted[item.id] = try await Self.format(item.text, markdown: true)
        }
        guard ready else { throw CancellationError() }
        guard readIdentity == identityEpoch, readWrite == writeEpoch, !overlappedWrite, writesInFlight == 0 else {
            requestRefresh(forceFull: true); return
        }
        history = nextHistory; formattedHistory = formatted; historyCursor = cursor; historyReload = nil
    }
    func expandConversation(actionID: String, itemID: String) {
        guard actionID == action?.id, presentation.permissions.loadHistory, let item = history.first(where: { $0.id == itemID }) else { return }
        command { [self] in
            let text = try await readText("action.conversationText", ["actionID": .string(actionID), "position": .integer(item.position)], limit: 4 * 1024 * 1024)
            if let index = history.firstIndex(where: { $0.id == itemID }) {
                history[index].text = text; history[index].truncated = false
                if item.isFinalAnswer == true { formattedHistory[itemID] = try await Self.format(text, markdown: true) }
            }
        }
    }
    func readMaterial(_ request: TAHUIMaterialRequest) {
        guard presentation.permissions.readMaterial, let action else { return }
        let method: String, fields: [String: Value], title: String, limit: Int
        switch request {
        case .rawTranscript(let id):
            guard id == action.id else { return }
            method = "action.transcriptMaterial"; fields = ["actionID": .string(id)]; title = "Raw transcript"; limit = 32 * 1024 * 1024
        case .outcome(let id, let revision, let file):
            guard id == action.id, action.revisions.contains(where: { $0.revisionIndex == revision }) else { return }
            method = "action.outcome"; fields = ["actionID": .string(id), "revisionIndex": .integer(revision), "path": .string(file.rawValue)]
            title = "v\(revision) · \(file == .notes ? "Notes" : "ASR terms")"; limit = 9 * 1024 * 1024
        }
        let identity = UUID().uuidString
        presentation.material = TAHUIMaterial(id: identity, title: title, isLoading: true, markdown: method == "action.outcome")
        command { [self] in
            do {
                let text = try await readText(method, fields, limit: limit, materialIdentity: identity)
                guard presentation.material?.id == identity else { return }
                let content = try await Self.format(text, markdown: method == "action.outcome")
                if presentation.material?.id == identity {
                    presentation.material = .init(id: identity, title: title, content: content, rawText: text, markdown: method == "action.outcome")
                }
            } catch {
                if presentation.material?.id == identity { presentation.material = .init(id: identity, title: title, error: "Could not read material.", markdown: method == "action.outcome") }
            }
        }
    }
    func dismissMaterial() { presentation.material = nil }
    private func readText(_ method: String, _ fields: [String: Value], limit: Int, materialIdentity: String? = nil) async throws -> String {
        var bytes = Data(), expected: Int?
        repeat {
            if let materialIdentity, presentation.material?.id != materialIdentity { throw CancellationError() }
            var input = fields; input["offset"] = .integer(bytes.count)
            let chunk: TextChunk = try await call(method, input)
            guard chunk.totalBytes >= 0, chunk.totalBytes <= limit, expected == nil || expected == chunk.totalBytes,
                  let data = Data(base64Encoded: chunk.data), data.count <= 48 * 1024,
                  bytes.count + data.count <= chunk.totalBytes, !data.isEmpty || chunk.totalBytes == 0 else { throw TAHRuntimeError.integrity_locked }
            expected = chunk.totalBytes; bytes.append(data)
        } while bytes.count < expected!
        guard let text = String(data: bytes, encoding: .utf8) else { throw TAHRuntimeError.integrity_locked }
        return text
    }

    private func rebuild() {
        let material = presentation.material
        var next = Self.project(auth: auth, raw: raw, action: action, draft: draft, language: saved.interactionLanguage,
                                    commandBusy: commandBusy || !ready, now: Date())
        next.material = material
        next.transcriptID = selectedTranscript
        next.transcripts = saved.transcripts.map { .init(id: $0.id, title: $0.title) }
        next.actions = actions.map { .init(id: $0.id, title: $0.customTitle ?? "Structured Notes · " + $0.createdAt) }
        next.timeline = Self.timeline(history, action: action, formatted: formattedHistory)
        next.hasMoreHistory = historyCursor != nil
        next.error = lastError ?? action?.error
        next.currentActivity = Self.currentSummary(action, history: history)
        logReader?.update(reference: workingReference(position: nil), actionID: action?.id, operationID: action?.operationID)
        memoryLogReader?.update(reference: workingReference(position: nil), actionID: action?.id, operationID: action?.operationID,
                               sourceKey: action.flatMap { value in value.progressSourceID.map { $0 + "/" + String(value.progressRevision ?? 0) } })
        next.workingLog = memoryLogReader?.state ?? logReader?.state
        let previousLog = presentation.workingLog
        if presentation != next { presentation = next }
        if previousLog != next.workingLog { workingLogDidChange?(next.workingLog) }
        scheduleExpiry()
    }

    // Pure App-contract projection, shared by the live controller and isolated checks.
    static func project(auth: AppAuth?, raw: AppRaw?, action: AppAction?, draft: TAHUIDraft,
                        language: TAHUILanguage, commandBusy: Bool, now: Date) -> TAHUIPresentation {
        var state = TAHUIPresentation()
        let authorization = auth?.ready == true
        let busy = commandBusy || raw?.busy == true || action?.editorMode == "running" || auth?.inspecting == true
            || (auth != nil && auth?.phase != "idle") || auth?.replacement != nil
        let editable = !busy && action?.editorMode == "editing"
        let allowed = raw?.allows(providerID: auth?.providerID, now: now) == true
        let storedConsent = (raw?.providerID == auth?.providerID && raw?.consentGranted == true)
            || (action?.contentConsentProviderID == auth?.providerID && action?.contentConsentGranted == true)
        let consent = draft.consent || storedConsent
        let models = auth?.actorCatalog?.models ?? []
        let model = models.first { $0.handle == draft.settings.modelID }
        let validModel = draft.settings.providerID == auth?.providerID && model != nil
            && (draft.settings.reasoningEffortID == nil || model!.efforts.contains { $0.handle == draft.settings.reasoningEffortID })
            && (draft.settings.contextWindowTokens == nil || model!.contextWindows?.availableTokens.contains(draft.settings.contextWindowTokens!) == true)
        state.authorization = .init(providers: (auth?.providers ?? []).map { .init(id: $0.id, title: $0.displayName) },
            providerID: auth?.providerID, state: auth?.state ?? "unauthed", phase: auth?.phase ?? "idle",
            inspecting: auth?.inspecting ?? false, account: auth?.account, noticeCode: auth?.noticeCode,
            replacement: auth?.replacement, canManage: !busy && auth != nil,
            canConfirmReplacement: !commandBusy && auth?.replacement != nil && auth?.phase == "idle")
        state.editor = action.map { .init(actionID: $0.id, editorToken: $0.editorToken) }
        state.models = models.map { .init(id: $0.handle, title: $0.displayName) }
        // Show the exact selected level; provider descriptions are explanatory prose.
        state.efforts = (model?.efforts ?? []).map { .init(id: $0.handle, title: $0.handle) }
        state.contextWindows = (model?.contextWindows?.availableTokens ?? []).map { .init(id: $0, title: String($0)) }
        state.initialSettingsFrozen = action?.initialSettingsFrozen ?? true
        state.canOmitInstructions = action?.canOmitInstructions ?? false
        state.interactionLanguage = language; state.consentGranted = storedConsent; state.isBusy = busy
        state.rawStatus = raw.map { "Transcript safety: " + ($0.state == "allowed" && !allowed ? "expired" : $0.state) } ?? "Select a transcript to begin."
        state.rawExplanation = raw?.explanation; state.rawValidityLabel = raw?.expiresAt.map { "Valid until " + $0 }
        state.status = action?.phase ?? ""
        state.revisions = (action?.revisions ?? []).map { revision in
            let displayName = revision.providerID == auth?.providerID
                ? models.first(where: { $0.handle == revision.modelID })?.displayName.trimmingCharacters(in: .whitespacesAndNewlines) : nil
            return .init(id: revision.commitID, revisionIndex: revision.revisionIndex,
                         configurationLabel: [revision.providerID, displayName.flatMap { $0.isEmpty ? nil : $0 } ?? revision.modelID, revision.reasoningEffortID,
                                              revision.contextWindowTokens.map(String.init)].compactMap { $0 }.joined(separator: " · "))
        }
        state.permissions = .init(selectTranscript: !busy, importTranscript: !busy, selectAction: !busy,
            checkRaw: !busy && authorization && raw != nil && consent && (["unchecked", "expired", "failed", "cancelled", "unavailable"].contains(raw!.state) || (raw!.state == "allowed" && !allowed)),
            createAction: !busy && authorization && allowed, edit: editable, editConsent: !busy,
            editInteractionLanguage: !busy, send: editable && authorization && allowed && consent && validModel
                && (state.canOmitInstructions || !draft.instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                && draft.instructions.utf8.count <= 64 * 1024,
            readMaterial: !commandBusy && action != nil, loadHistory: !commandBusy && action != nil)
        state.disabledReason = !authorization ? "Provider authorization inspection is required."
            : !allowed ? "Check the transcript with the current provider before starting an action."
            : action != nil && !validModel ? "Choose a supported model configuration." : nil
        return state
    }
    static func timeline(_ messages: [AppMessage], action: AppAction?, formatted: [String: AttributedString] = [:]) -> [TAHUITimelineItem] {
        let accepted = Set((action?.revisions ?? []).map(\.commitID))
        return messages.compactMap { item -> TAHUITimelineItem? in
            if item.isFinalAnswer == true && !accepted.contains("publication/" + item.cycleID) { return nil }
            return .init(id: item.id, title: (item.role == "user" ? "You" : "TAH") + " · v\(item.revisionIndex)",
                         content: item.isFinalAnswer == true ? formatted[item.id] ?? AttributedString(item.text) : AttributedString(item.text),
                         detail: [item.phase, item.modelID, item.criticSummary, item.errorText].compactMap { $0 }.joined(separator: " · "),
                         canExpand: item.truncated, rawText: item.text, markdown: item.isFinalAnswer == true,
                         role: Self.messageRole(item), revisionIndex: item.revisionIndex, phase: item.phase,
                         working: item.role == "user" ? nil : Self.summary(id: "\(action?.id ?? "")/\(item.position)", position: item.position,
                            revision: item.revisionIndex, phase: item.phase, metadata: item.presentation, live: false,
                            running: false, criticPassed: item.criticRounds?.last?.decision == "PASS"))
        }
    }
    static func isGuardianPhase(_ phase: String) -> Bool {
        ["raw_guardian", "extra_guardian", "saving_safety", "raw_blocked", "extra_blocked", "raw_unavailable", "extra_unavailable"].contains(phase)
    }
    static func messageRole(_ item: AppMessage) -> TAHUIMessageRole {
        if item.role == "user" { return .user }
        if isGuardianPhase(item.phase) || ["raw_guardian", "extra_guardian"].contains(item.role) { return .system }
        return item.role == "workflow" || item.role == "actor" ? .assistant : .system
    }
    static func canShowWorking(_ phase: String, _ metadata: AppPresentation) -> Bool {
        if isGuardianPhase(phase) || ["preparing", "running", "editing", "draft"].contains(phase) { return false }
        return ["actor", "critic", "completed", "published", "needs_user_revision"].contains(phase)
            || metadata.stages.contains { ["actor", "critic"].contains($0.phase) }
            || metadata.events.contains { $0.role == "actor" }
    }
    static func validLogHash(_ value: String?) -> Bool {
        value?.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil
    }
    static func summary(id: String, position: Int?, revision: Int, phase: String, metadata: AppPresentation?,
                        live: Bool, running: Bool, criticPassed: Bool) -> TAHUIWorkingSummary? {
        guard let metadata else { return nil }
        let visible = canShowWorking(phase, metadata)
        guard visible || (live && isGuardianPhase(phase)) else { return nil }
        let completed = ["completed", "published"].contains(phase)
        let events = visible && !completed ? metadata.events.filter(\.isPublic).map(\.projected) : []
        return .init(id: id, position: position, revisionIndex: revision, phase: phase,
                     startedAt: metadata.startedAt ?? metadata.stages.first?.at,
                     endedAt: metadata.endedAt ?? (!live ? metadata.stages.last?.at : nil),
                     events: live ? Array(events.suffix(3)) : events,
                     canOpen: visible && validLogHash(metadata.workingLogSHA256), live: live,
                     progressing: live && running && phase == "actor", criticPassed: criticPassed)
    }
    static func currentSummary(_ action: AppAction?, history: [AppMessage]) -> TAHUIWorkingSummary? {
        guard let action, action.editorMode == "running", let operation = action.operationID,
              let revision = action.latestSubmittedRevisionIndex ?? action.revisionIndex else { return nil }
        return summary(id: action.id + "/" + operation, position: nil, revision: revision, phase: action.phase,
                       metadata: action.presentation, live: true, running: true, criticPassed: currentCritic(action, history))
    }
    private static func currentCritic(_ action: AppAction, _ history: [AppMessage]) -> Bool {
        guard let digest = action.presentation?.workingLogSHA256 else { return false }
        return history.last(where: { $0.role == "workflow" && $0.presentation?.workingLogSHA256 == digest
            && $0.phase == action.phase && $0.revisionIndex == action.latestSubmittedRevisionIndex })?.criticRounds?.last?.decision == "PASS"
    }
    private func workingReference(position: Int?) -> TAHMobileWorkingLogReader.Reference? {
        guard let action else { return nil }
        let metadata: AppPresentation?, summary: TAHUIWorkingSummary?
        if let position {
            guard let item = history.first(where: { $0.position == position }), item.role != "user" else { return nil }
            metadata = item.presentation
            summary = Self.summary(id: action.id + "/\(position)", position: position, revision: item.revisionIndex,
                phase: item.phase, metadata: metadata, live: false, running: false, criticPassed: item.criticRounds?.last?.decision == "PASS")
        } else {
            guard let operation = action.operationID, let revision = action.latestSubmittedRevisionIndex ?? action.revisionIndex else { return nil }
            metadata = action.presentation
            summary = Self.summary(id: action.id + "/" + operation, position: nil, revision: revision, phase: action.phase,
                metadata: metadata, live: true, running: action.editorMode == "running", criticPassed: Self.currentCritic(action, history))
        }
        guard let summary, summary.canOpen, let hash = metadata?.workingLogSHA256 else { return nil }
        return .init(actionID: action.id, position: position, operationID: position == nil ? action.operationID : nil,
                     hash: hash, summary: summary, limited: metadata?.workingLogLimited ?? false)
    }
    func openWorkingLog(actionID: String, position: Int?) {
        guard ready, action?.id == actionID, position.map({ $0 > 0 }) ?? true, let reference = workingReference(position: position) else { return }
        logReader?.close(); memoryLogReader?.close()
        if workingLogUsesChannel, position == nil, action?.editorMode == "running" {
            if memoryLogReader == nil {
                memoryLogReader = TAHMemoryWorkingLogReader(call: { [weak self] method, fields in
                    guard let self else { throw TAHRuntimeError.unavailable }
                    return try await self.call(method, fields)
                }, release: { [weak self] id in
                    guard let self else { return }
                    let _: Value? = try? await self.call("action.workingClose", ["streamID": .string(id)])
                }, canRead: { [weak self] in self?.workingConsumerReady == true }, changed: { [weak self] state in
                    self?.setWorkingLog(state)
                })
            }
            memoryLogReader?.open(reference)
            return
        }
        if logReader == nil {
            logReader = TAHMobileWorkingLogReader(snapshot: { [weak self] id in
                guard let self else { throw TAHRuntimeError.unavailable }
                return try await self.call("action.snapshot", ["actionID": .string(id)])
            }, chunk: { [weak self] reference, offset in
                guard let self else { throw TAHRuntimeError.unavailable }
                return try await self.call("action.workingText", ["actionID": .string(reference.actionID),
                    "position": reference.position.map(Value.integer) ?? .null, "sha256": .string(reference.hash), "offset": .integer(offset)])
            }, changed: { [weak self] state in
                self?.setWorkingLog(state)
            })
        }
        // Read-only channel intentionally bypasses commandBusy, including while Actor is running.
        logReader?.open(reference)
    }
    func refreshWorkingLog(id: String) {
        if ready, memoryLogReader?.state?.id == id { memoryLogReader?.refresh(id: id); return }
        guard ready, logReader?.state?.id == id else { return }
        logReader?.update(reference: workingReference(position: nil), actionID: action?.id, operationID: action?.operationID)
        logReader?.refresh(id: id)
    }
    func closeWorkingLog(id: String) {
        if memoryLogReader?.state?.id == id { memoryLogReader?.close(); return }
        guard logReader?.state?.id == id else { return }; logReader?.close()
    }

    private func setWorkingLog(_ state: TAHUIWorkingLog?) {
        guard presentation.workingLog != state else { return }
        presentation.workingLog = state
        workingLogDidChange?(state)
    }
    func setWorkingChannelEnabled(_ enabled: Bool) {
        workingLogUsesChannel = enabled
        if !enabled { workingConsumerReady = false }
    }
    func setWorkingConsumerReady(_ ready: Bool) {
        workingConsumerReady = workingLogUsesChannel && ready
        if workingConsumerReady { memoryLogReader?.resume() }
    }

    static func sendFields(_ submission: TAHUISubmission) throws -> [String: Value] {
        guard let model = submission.settings.modelID, !model.isEmpty, let provider = submission.settings.providerID,
              submission.instructions.utf8.count <= 64 * 1024 else { throw TAHRuntimeError.invalid_request }
        var inference: [String: Value] = ["modelID": .string(model), "reasoningEffortID": submission.settings.reasoningEffortID.map(Value.string) ?? .null]
        if let context = submission.settings.contextWindowTokens { inference["contextWindowTokens"] = .integer(context) }
        var fields: [String: Value] = ["actionID": .string(submission.context.actionID), "operationID": .string(UUID().uuidString.lowercased()),
            "instructions": .string(submission.instructions), "inference": .object(inference), "expectedProviderID": .string(provider),
            "interactionLanguage": .string(submission.interactionLanguage.rawValue), "grantWeb": .bool(submission.settings.webEnabled), "consent": .bool(submission.consent)]
        if let language = submission.initialLanguage { fields["initialLanguage"] = .string(language.rawValue) }
        return fields
    }
    private static func settingsValue(_ value: TAHUIRevisionSettings) -> Value {
        .object(["providerID": value.providerID.map(Value.string) ?? .null, "modelID": .string(value.modelID ?? ""),
                 "reasoningEffortID": value.reasoningEffortID.map(Value.string) ?? .null,
                 "contextWindowTokens": value.contextWindowTokens.map(Value.integer) ?? .null, "webEnabled": .bool(value.webEnabled)])
    }

    // Only neutral Mac App contract JSON is decoded here. Unknown extra App fields are ignored.
    struct AppAuth: Decodable, Sendable {
        struct Inspection: Decodable, Equatable, Sendable { let state: String; let finishedAt: String?; let failures: [String] }
        struct Provider: Decodable, Sendable { let id: String; let displayName: String }
        let providers: [Provider]?
        let noticeCode: String?
        let providerID: String?; let state: String; let phase: String; let inspecting: Bool
        let account: String?
        let inspection: Inspection?; let replacement: TAHUIAuthorization.Replacement?; let actorCatalog: Catalog?
        let sourceID: String?; let sourceRevision: Int?
        var ready: Bool { state == "valid" && phase == "idle" && !inspecting && replacement == nil && inspection?.state == "succeeded" && inspection?.finishedAt != nil && inspection?.failures.isEmpty == true }
    }
    struct Catalog: Decodable, Equatable, Sendable {
        struct Model: Decodable, Equatable, Sendable {
            struct Effort: Decodable, Equatable, Sendable { let handle: String; let displayName: String }
            struct Windows: Decodable, Equatable, Sendable { let availableTokens: [Int]; let defaultTokens: Int? }
            let handle: String; let displayName: String; let efforts: [Effort]; let defaultEffortHandle: String?; let contextWindows: Windows?
        }
        let models: [Model]; let defaultModelHandle: String?
    }
    struct AppRaw: Decodable, Equatable, Sendable {
        let materialID: String; let providerID: String?; let state: String; let busy: Bool; let consentGranted: Bool
        let expiresAt: String?; let explanation: String?
        private let expiry: Date?
        var expiryDate: Date? { expiry }
        // Value-type Foundation strategies; both forms are needed on iOS 18.
        private static let fractionalExpiry = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        private static let wholeSecondExpiry = Date.ISO8601FormatStyle(includingFractionalSeconds: false)
        private enum CodingKeys: String, CodingKey {
            case materialID, providerID, state, busy, consentGranted, expiresAt, explanation
        }
        init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: CodingKeys.self)
            materialID = try fields.decode(String.self, forKey: .materialID)
            providerID = try fields.decodeIfPresent(String.self, forKey: .providerID)
            state = try fields.decode(String.self, forKey: .state)
            busy = try fields.decode(Bool.self, forKey: .busy)
            consentGranted = try fields.decode(Bool.self, forKey: .consentGranted)
            expiresAt = try fields.decodeIfPresent(String.self, forKey: .expiresAt)
            explanation = try fields.decodeIfPresent(String.self, forKey: .explanation)
            // A snapshot's timestamp is immutable. Parse once, then compare against
            // the current clock on each projection (never cache the permission).
            expiry = expiresAt.flatMap {
                (try? Self.fractionalExpiry.parse($0)) ?? (try? Self.wholeSecondExpiry.parse($0))
            }
        }
        func allows(providerID: String?, now: Date) -> Bool {
            guard state == "allowed", self.providerID == providerID, let expiry else { return false }
            return expiry > now
        }
    }
    struct AppAction: Decodable, Sendable {
        struct Revision: Decodable, Equatable, Sendable { let revisionIndex: Int; let providerID: String; let commitID: String; let modelID: String; let reasoningEffortID: String?; let contextWindowTokens: Int? }
        struct Event: Decodable, Sendable {
            let id: String; let title: String; let detail: String; let role: String; let kind: String
            let titleCode: String?; let status: String?; let detailTruncated: Bool?; let round: Int?
            var isPublic: Bool { role == "actor" || (id == "extra-safety-pass" && titleCode == "safety_guardian" && role == "extra_guardian" && kind == "activity" && status == "pass") }
            var projected: TAHUIWorkingEvent { .init(id: id, title: title, detail: detail, role: role, kind: kind, titleCode: titleCode, status: status, detailTruncated: detailTruncated ?? false, round: round) }
        }
        let id: String; let transcriptID: String; let language: TAHUILanguage; let phase: String
        let initialSettingsFrozen: Bool; let draftSettings: TAHUIRevisionSettings?; let editorMode: String; let editorToken: String
        let canOmitInstructions: Bool; let contentConsentProviderID: String?; let contentConsentGranted: Bool?
        let operationID: String?; let error: String?; let revisions: [Revision]; var events: [Event]
        let revisionIndex: Int?; let latestSubmittedRevisionIndex: Int?; var presentation: AppPresentation?
        var progressSourceID: String?; var progressRevision: Int?
        let rawSafety: AppRaw?
    }
    struct AppActionRow: Decodable, Sendable { let id: String; let customTitle: String?; let createdAt: String }
    struct ActionPage: Decodable, Sendable { let actions: [AppActionRow]; let nextCursor: String? }
    struct AppProgress: Decodable, Sendable {
        let actionID: String; let sourceID: String?; let sourceRevision: Int?
        let transcriptID: String?; let operationID: String?; let phase: String?
        let events: [AppAction.Event]?; let presentation: AppPresentation?; let pendingSave: String?
    }
    struct AppInvalidation: Decodable { let sourceID: String?; let sourceRevision: Int? }
    struct AppMessage: Decodable, Sendable {
        let id: String; let position: Int; let cycleID: String; let role: String; let phase: String; let revisionIndex: Int; let modelID: String
        var text: String; var truncated: Bool; let isFinalAnswer: Bool?; let criticSummary: String?; let errorText: String?
        let presentation: AppPresentation?; let criticRounds: [CriticRound]?
    }
    struct CriticRound: Decodable, Sendable { let decision: String }
    struct AppPresentation: Decodable, Sendable {
        struct Stage: Decodable, Sendable { let phase: String; let at: String }
        let startedAt: String?; let endedAt: String?
        let workingLogSHA256: String?; let workingLogBytes: Int?; let workingLogLimited: Bool?
        let stages: [Stage]; let events: [AppAction.Event]
    }
    struct ConversationPage: Decodable, Sendable { let items: [AppMessage]; let nextCursor: String? }
    struct TextChunk: Decodable, Sendable { let data: String; let totalBytes: Int }
    struct Transcript: Codable, Sendable { let id: String; let materialID: String; let title: String }
    struct SavedUI: Codable, Sendable {
        var transcripts: [Transcript] = []; var drafts: [String: TAHUIDraft] = [:]; var interactionLanguage = TAHUILanguage.english
    }
    nonisolated static func decode<T: Decodable>(_ type: T.Type, _ json: String) throws -> T { try JSONDecoder().decode(T.self, from: Data(json.utf8)) }
    // UTF-8 allocation, JSON decoding and expiry parsing leave MainActor together.
    // Swift 5.9 nonisolated async already hops; spell it explicitly on newer compilers
    // so enabling NonisolatedNonsendingByDefault cannot move this work back onto UI.
    #if compiler(>=6.2)
    @concurrent
    #endif
    nonisolated private static func decodeResponse<T: Decodable & Sendable>(_ type: T.Type, _ json: String) async throws -> T {
        try Task.checkCancellation()
        let response = try decode(type, json)
        try Task.checkCancellation()
        return response
    }
    nonisolated static func encode<T: Encodable>(_ value: T) throws -> String { String(decoding: try JSONEncoder().encode(value), as: UTF8.self) }
    nonisolated private static func openJournal(_ directory: URL) async throws -> TAHJournalStore { try TAHJournalStore(directory: directory) }
    nonisolated private static func readUTF8(_ url: URL, limit: Int) async throws -> String {
        guard url.isFileURL else { throw TAHRuntimeError.invalid_request }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? Int.max
        guard size <= limit else { throw TAHRuntimeError.invalid_request }
        let data = try Data(contentsOf: url)
        guard data.count <= limit, let value = String(data: data, encoding: .utf8) else { throw TAHRuntimeError.invalid_request }
        return value
    }
    nonisolated private static func loadSaved(_ url: URL) async throws -> SavedUI {
        guard FileManager.default.fileExists(atPath: url.path) else { return SavedUI() }
        return try decode(SavedUI.self, await readUTF8(url, limit: 4 * 1024 * 1024))
    }
    nonisolated private static func save(_ value: SavedUI, to url: URL) async throws {
        let data = try JSONEncoder().encode(value)
        guard data.count <= 4 * 1024 * 1024 else { throw TAHRuntimeError.invalid_request }
        try data.write(to: url, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }
    nonisolated private static func format(_ text: String, markdown: Bool) async throws -> AttributedString {
        markdown ? ((try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)) : AttributedString(text)
    }
}

/// A bounded read-only projection of the original immutable workingText stream.
/// Actor-isolated and independently scheduled: log reads never take the mutation admission lock.
@MainActor
final class TAHMobileWorkingLogReader {
    struct Reference: Sendable {
        let actionID: String
        let position: Int?
        let operationID: String?
        let hash: String
        let summary: TAHUIWorkingSummary
        let limited: Bool
    }
    struct Payload: Decodable, Sendable {
        let schemaVersion: Int
        let limited: Bool
        let events: [TAHMobileController.AppAction.Event]
    }
    private(set) var state: TAHUIWorkingLog?
    private let snapshot: @MainActor (String) async throws -> TAHMobileController.AppAction
    private let chunk: @MainActor (Reference, Int) async throws -> TAHMobileController.TextChunk
    private let changed: @MainActor (TAHUIWorkingLog?) -> Void
    private var anchor: Reference?
    private var desired: Reference?
    private var worker: Task<Void, Never>?
    private var generation = UUID()
    private var pending = false
    private var loadedHash: String?
    private var attemptedHash: String?

    init(snapshot: @escaping @MainActor (String) async throws -> TAHMobileController.AppAction,
         chunk: @escaping @MainActor (Reference, Int) async throws -> TAHMobileController.TextChunk,
         changed: @escaping @MainActor (TAHUIWorkingLog?) -> Void) {
        self.snapshot = snapshot; self.chunk = chunk; self.changed = changed
    }
    func open(_ reference: Reference) {
        close(); anchor = reference; desired = reference
        state = .init(id: UUID().uuidString.lowercased(), actionID: reference.actionID, position: reference.position,
            revisionIndex: reference.summary.revisionIndex, startedAt: reference.summary.startedAt, endedAt: reference.summary.endedAt,
            criticPassed: reference.summary.criticPassed, loading: true, limited: reference.limited, progressing: reference.summary.progressing)
        // Dispatch snapshots immediately; publish admission before the asynchronous read can run.
        changed(state)
        request()
    }
    func close() {
        generation = UUID(); worker?.cancel(); worker = nil; pending = false
        anchor = nil; desired = nil; loadedHash = nil; attemptedHash = nil; state = nil; changed(nil)
    }
    func update(reference: Reference?, actionID: String?, operationID: String?) {
        guard let anchor, state != nil else { return }
        guard actionID == anchor.actionID else { close(); return }
        guard anchor.position == nil else { return } // historical position + hash never follows another operation
        guard operationID == anchor.operationID else { supersede(); return }
        guard state?.superseded == false, let reference, reference.actionID == anchor.actionID,
              reference.position == nil, reference.operationID == anchor.operationID,
              reference.summary.revisionIndex == anchor.summary.revisionIndex else { return }
        desired = reference
        state?.startedAt = reference.summary.startedAt; state?.endedAt = reference.summary.endedAt
        state?.criticPassed = reference.summary.criticPassed; state?.progressing = reference.summary.progressing
        changed(state)
        request()
    }
    func refresh(id: String) {
        guard state?.id == id, state?.superseded == false, let desired, loadedHash != desired.hash else { return }
        request(force: true) // explicit retry only after a failed/unread hash; never reload an already loaded hash
    }
    func waitForUpdates() async { await worker?.value }
    private func supersede() {
        generation = UUID(); worker?.cancel(); worker = nil; pending = false
        state?.superseded = true; state?.loading = false; state?.progressing = false
        changed(state)
    }
    private func request(force: Bool = false) {
        guard let desired, state?.superseded == false, loadedHash != desired.hash,
              force || attemptedHash != desired.hash else { return }
        pending = true
        guard worker == nil else { return }
        let token = generation
        worker = Task { [weak self] in
            guard let self else { return }
            defer { if generation == token { worker = nil; state?.loading = false; changed(state) } }
            while pending, generation == token, !Task.isCancelled, let reference = self.desired {
                pending = false
                // A notification may have caught up with the snapshot used by the in-flight read.
                guard loadedHash != reference.hash else { continue }
                attemptedHash = reference.hash
                state?.loading = true; changed(state)
                do {
                    let result = try await read(reference, token: token)
                    guard generation == token, !Task.isCancelled else { return }
                    if let payload = result.payload {
                        state?.events = payload.events.filter(\.isPublic).map(\.projected)
                        state?.limited = payload.limited
                    }
                    state?.failed = false; state?.error = nil
                    loadedHash = result.hash
                } catch ReadFailure.superseded {
                    if generation == token { supersede() }; return
                } catch {
                    guard generation == token, !Task.isCancelled else { return }
                    state?.failed = true; state?.error = "Could not read this working log."
                    // Keep previously verified events and their limited flag on every read failure.
                }
                state?.loading = false; changed(state)
            }
        }
    }
    private enum ReadFailure: Error { case superseded, invalid, sourceUnavailable }
    private struct ReadResult { let hash: String; let payload: Payload? }
    private func check(_ token: UUID) throws {
        try Task.checkCancellation(); guard generation == token else { throw CancellationError() }
    }
    private func liveSnapshot(_ reference: Reference, token: UUID) async throws -> TAHMobileController.AppAction {
        let current = try await snapshot(reference.actionID)
        try check(token)
        guard current.id == reference.actionID, current.operationID == reference.operationID else { throw ReadFailure.superseded }
        return current
    }
    private func pinnedReference(_ reference: Reference, token: UUID) async throws -> Reference {
        guard reference.position == nil else { return reference }
        let current = try await liveSnapshot(reference, token: token)
        guard let metadata = current.presentation, TAHMobileController.canShowWorking(current.phase, metadata),
              let hash = metadata.workingLogSHA256, TAHMobileController.validLogHash(hash) else { throw ReadFailure.invalid }
        // action.snapshot pins its own hash, not the earlier hash advertised by ui.actionChanged.
        return .init(actionID: reference.actionID, position: nil, operationID: reference.operationID,
                     hash: hash, summary: reference.summary, limited: metadata.workingLogLimited ?? false)
    }
    private func read(_ advertised: Reference, token: UUID) async throws -> ReadResult {
        guard TAHMobileController.validLogHash(advertised.hash) else { throw ReadFailure.invalid }
        try check(token)
        var reference = try await pinnedReference(advertised, token: token)
        for attempt in 0..<2 {
            try check(token)
            if reference.hash == loadedHash { return .init(hash: reference.hash, payload: nil) }
            do {
                let payload = try await readPinned(reference, token: token)
                return .init(hash: reference.hash, payload: payload)
            } catch ReadFailure.sourceUnavailable {
                // A bounded lease can expire/evict. Retry once only if a fresh same-operation
                // snapshot proves the log has advanced. Integrity failures never enter this path.
                guard attempt == 0, reference.position == nil else { throw ReadFailure.sourceUnavailable }
                let latest = try await pinnedReference(reference, token: token)
                guard latest.hash != reference.hash else { throw ReadFailure.sourceUnavailable }
                reference = latest
            }
        }
        throw ReadFailure.sourceUnavailable
    }
    private func readPinned(_ reference: Reference, token: UUID) async throws -> Payload {
        guard TAHMobileController.validLogHash(reference.hash) else { throw ReadFailure.invalid }
        var bytes = Data(), expected: Int?
        repeat {
            try check(token)
            let part: TAHMobileController.TextChunk
            do { part = try await chunk(reference, bytes.count) }
            catch {
                try check(token)
                throw ReadFailure.sourceUnavailable
            }
            try check(token)
            guard part.totalBytes > 0, part.totalBytes <= 4 * 1024 * 1024,
                  expected == nil || expected == part.totalBytes,
                  let data = Data(base64Encoded: part.data), data.base64EncodedString() == part.data,
                  !data.isEmpty, data.count <= 48 * 1024, bytes.count + data.count <= part.totalBytes else { throw ReadFailure.invalid }
            expected = part.totalBytes; bytes.append(data)
        } while bytes.count < expected!
        let payload = try await Self.decodePayload(bytes, expectedHash: reference.hash)
        if reference.position == nil { _ = try await liveSnapshot(reference, token: token) }
        try check(token)
        return payload
    }

    #if compiler(>=6.2)
    @concurrent
    #endif
    nonisolated private static func decodePayload(_ bytes: Data, expectedHash: String) async throws -> Payload {
        try Task.checkCancellation()
        guard SHA256.hash(data: bytes).map({ String(format: "%02x", $0) }).joined() == expectedHash else { throw ReadFailure.invalid }
        let payload = try JSONDecoder().decode(Payload.self, from: bytes)
        guard payload.schemaVersion == 1, payload.events.count <= 512 else { throw ReadFailure.invalid }
        try Task.checkCancellation()
        return payload
    }
}
