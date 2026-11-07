import Foundation
import Observation

// Presentation projections, not wire DTOs. Provenance: docs/ios-tah-ui-adoption.json.
enum TAHUILanguage: String, Codable, CaseIterable, Hashable, Sendable {
    case english = "en", simplifiedChinese = "zh-CN"
    var title: String { self == .english ? "English" : "简体中文" }
}

struct TAHUIChoice: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    var enabled = true
}

struct TAHUIContextWindow: Identifiable, Equatable, Sendable {
    let id: Int
    let title: String
    var enabled = true
}

struct TAHUIRevisionSettings: Codable, Equatable, Sendable {
    var providerID: String?
    var modelID: String?
    var reasoningEffortID: String?
    var contextWindowTokens: Int?
    var webEnabled = false
}

struct TAHUIDraft: Codable, Equatable, Sendable {
    var outputLanguage = TAHUILanguage.english
    var settings = TAHUIRevisionSettings()
    var instructions = ""
    var consent = false
}

struct TAHUIEditorContext: Equatable, Sendable {
    let actionID: String
    let editorToken: String
}

struct TAHUISubmission: Sendable {
    let context: TAHUIEditorContext
    let instructions: String
    let settings: TAHUIRevisionSettings
    let initialLanguage: TAHUILanguage?
    let interactionLanguage: TAHUILanguage
    let consent: Bool
}

struct TAHUITimelineItem: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    // Controller supplies bounded, public, already-formatted text; user input is literal.
    let content: AttributedString
    var detail: String?
    var canExpand = false
    // Exact source for web Markdown rendering; attributed content remains the native fallback.
    var rawText: String? = nil
    var markdown = false
    var role = TAHUIMessageRole.system
    var revisionIndex = 0
    var phase = ""
    var working: TAHUIWorkingSummary? = nil
}

enum TAHUIMessageRole: String, Sendable { case user, assistant, system }
struct TAHUIWorkingEvent: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let detail: String
    let role: String
    let kind: String
    let titleCode: String?
    let status: String?
    let detailTruncated: Bool
    let round: Int?
}
struct TAHUIWorkingSummary: Identifiable, Equatable, Sendable {
    let id: String
    let position: Int?
    let revisionIndex: Int
    let phase: String
    let startedAt: String?
    let endedAt: String?
    let events: [TAHUIWorkingEvent]
    let canOpen: Bool
    let live: Bool
    let progressing: Bool
    let criticPassed: Bool
}
struct TAHUIWorkingLog: Identifiable, Equatable, Sendable {
    let id: String
    let actionID: String
    let position: Int?
    let revisionIndex: Int
    var startedAt: String?
    var endedAt: String?
    var events: [TAHUIWorkingEvent] = []
    var criticPassed = false
    var loading = false
    var failed = false
    var limited = false
    var superseded = false
    var progressing = false
    var error: String? = nil
}

struct TAHUIRevision: Identifiable, Equatable, Sendable {
    let id: String // publication commit ID, never a transient attempt ID
    let revisionIndex: Int
    let configurationLabel: String // provider/model/effort/context; no invented Web history
}

enum TAHUIOutcomeFile: String, Sendable {
    case notes = "structured-notes.md", asrTerms = "suspicious-asr-terms.md"
}

enum TAHUIMaterialRequest: Sendable {
    case rawTranscript(actionID: String)
    case outcome(actionID: String, revisionIndex: Int, file: TAHUIOutcomeFile)
}

struct TAHUIMaterial: Identifiable, Equatable, Sendable {
    let id: String // includes action/revision/file identity
    let title: String
    var content: AttributedString?
    var isLoading = false
    var error: String?
    var rawText: String? = nil
    var markdown = false
}

struct TAHUIPermissions: Equatable, Sendable {
    var selectTranscript = false
    var importTranscript = false
    var selectAction = false
    var checkRaw = false
    var createAction = false
    var edit = false
    var editConsent = false
    var editInteractionLanguage = false
    var send = false
    var readMaterial = false
    var loadHistory = false
}

struct TAHUIAuthorization: Equatable, Sendable {
    struct Replacement: Decodable, Equatable, Sendable {
        let id: String
        let kind: String
        let providerID: String
    }
    var providers: [TAHUIChoice] = []
    var providerID: String?
    var state = "unauthed"
    var phase = "idle"
    var inspecting = false
    var account: String?
    var noticeCode: String?
    var replacement: Replacement?
    var canManage = false
    var canConfirmReplacement = false
}

struct TAHUIPresentation: Equatable, Sendable {
    var authorization = TAHUIAuthorization()
    var transcripts: [TAHUIChoice] = []
    var transcriptID: String?
    var actions: [TAHUIChoice] = []
    var editor: TAHUIEditorContext?
    var models: [TAHUIChoice] = []
    var efforts: [TAHUIChoice] = []
    var contextWindows: [TAHUIContextWindow] = []
    var interactionLanguage = TAHUILanguage.english
    var initialSettingsFrozen = true
    var canOmitInstructions = false
    var consentGranted = false
    var rawStatus = "Select a transcript to begin."
    var rawExplanation: String?
    var rawValidityLabel: String?
    var status = ""
    var disabledReason: String?
    var error: String?
    var isBusy = false // authoritative activity only; never inferred from a request
    var timeline: [TAHUITimelineItem] = [] // chronological, unique stable IDs
    var revisions: [TAHUIRevision] = [] // accepted publications only
    var hasMoreHistory = false
    var material: TAHUIMaterial?
    var currentActivity: TAHUIWorkingSummary?
    var workingLog: TAHUIWorkingLog?
    var permissions = TAHUIPermissions()
}

/// Main supplies an @Observable @MainActor implementation; no implementation lives here.
/// Callbacks enqueue intent and synchronously publish admission/busy state before returning.
/// Main owns validation, editor-token checks, draft persistence, request IDs, polling,
/// material formatting/paging and all Framework -> Adapter -> Backend orchestration.
@MainActor
protocol TAHPresentationController: AnyObject, Observable {
    var presentation: TAHUIPresentation { get }
    var draft: TAHUIDraft { get }
    func refresh()
    func selectTranscript(id: String)
    func importTranscript(title: String, text: String)
    func selectAction(id: String)
    func updateDraft(_ draft: TAHUIDraft, context: TAHUIEditorContext?)
    func selectInteractionLanguage(_ language: TAHUILanguage)
    func checkRawSafety(transcriptID: String, consent: Bool, interactionLanguage: TAHUILanguage)
    func createStructuredNotesAction(transcriptID: String, language: TAHUILanguage, settings: TAHUIRevisionSettings)
    func sendAction(_ submission: TAHUISubmission)
    func loadMoreConversation(actionID: String)
    func expandConversation(actionID: String, itemID: String)
    func readMaterial(_ request: TAHUIMaterialRequest)
    func dismissMaterial()
}
