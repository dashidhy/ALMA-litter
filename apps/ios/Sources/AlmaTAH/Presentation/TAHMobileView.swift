import Foundation
import SwiftUI

/// Embed in the host's NavigationStack. The host retains the observable controller.
@MainActor
struct TAHMobileView<Controller: TAHPresentationController>: View {
    let controller: Controller

    var body: some View {
        let state = controller.presentation
        List {
            Section {
                if state.isBusy { ProgressView().accessibilityLabel("Action in progress") }
                if !state.status.isEmpty { Text(verbatim: phaseTitle(state.status)) }
                if let reason = state.disabledReason { Text(verbatim: reason).foregroundStyle(.secondary) }
                if let error = state.error { Label(error, systemImage: "exclamationmark.triangle") }
            }
            TAHTranscriptSection(controller: controller)
            TAHActionSection(controller: controller)
            if let context = state.editor {
                TAHComposerSection(controller: controller, context: context)
                    .id(context.actionID + "/" + context.editorToken)
                TAHHistorySection(controller: controller, actionID: context.actionID)
            }
        }
        .navigationTitle("Structured Notes")
        .toolbar { Button("Refresh", systemImage: "arrow.clockwise") { controller.refresh() } }
        .sheet(item: Binding(get: { controller.presentation.material }, set: { value in
            if value == nil { controller.dismissMaterial() }
        })) { _ in
            TAHMaterialSheet(controller: controller)
        }
    }

    private func phaseTitle(_ phase: String) -> String {
        let titles = ["draft": "Ready to create notes", "preparing": "Preparing",
         "raw_guardian": "Checking transcript", "extra_guardian": "Checking revision instructions",
         "actor": "Creating notes", "critic": "Checking results",
         "saving_safety": "Saving safety check", "persistence_pending": "Waiting to save",
         "completed": "Completed", "published": "Completed", "editing": "Ready for your revision",
         "integrity_locked": "This action needs attention", "actor_failed": "The action could not finish"]
        return titles[phase] ?? phase.replacingOccurrences(of: "_", with: " ").capitalized
    }
}

@MainActor
private struct TAHTranscriptSection<C: TAHPresentationController>: View {
    let controller: C
    @State private var title = ""
    @State private var text = ""

    var body: some View {
        let state = controller.presentation
        Section("Transcript") {
            Picker("Saved transcript", selection: Binding(get: { state.transcriptID }, set: { id in
                if let id { controller.selectTranscript(id: id) }
            })) {
                Text("Choose a transcript").tag(String?.none)
                ForEach(state.transcripts) { choice in
                    Text(verbatim: choice.title).tag(Optional(choice.id)).disabled(!choice.enabled)
                }
            }
            .disabled(!state.permissions.selectTranscript)
            DisclosureGroup("Import transcript text") {
                TextField("Title (optional)", text: $title)
                TextEditor(text: $text).frame(minHeight: 140).accessibilityLabel("Transcript text")
                Button("Import text") { controller.importTranscript(title: title, text: text) }
                    .disabled(!state.permissions.importTranscript || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Text("Paste transcript text here. Your text stays in this form after submission.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            .disabled(!state.permissions.importTranscript)
        }
    }
}

@MainActor
private struct TAHActionSection<C: TAHPresentationController>: View {
    let controller: C

    var body: some View {
        let state = controller.presentation
        Section("Transcript safety") {
            Picker("Interaction language", selection: Binding(get: { state.interactionLanguage }, set: controller.selectInteractionLanguage)) {
                ForEach(TAHUILanguage.allCases, id: \.self) { Text($0.title).tag($0) }
            }.disabled(!state.permissions.editInteractionLanguage)
            Text(verbatim: state.rawStatus)
            if let validity = state.rawValidityLabel { Text(verbatim: validity).font(.caption) }
            if let explanation = state.rawExplanation { Text(verbatim: explanation).textSelection(.enabled) }
            if !state.consentGranted {
                Toggle("Allow the selected provider to process this transcript, instructions and prior outcomes", isOn: Binding(
                    get: { controller.draft.consent }, set: { consent in
                        var draft = controller.draft; draft.consent = consent
                        controller.updateDraft(draft, context: state.editor)
                    }))
                .disabled(!state.permissions.editConsent)
            }
            Button("Check transcript") {
                if let id = state.transcriptID {
                    controller.checkRawSafety(transcriptID: id, consent: controller.draft.consent,
                                              interactionLanguage: state.interactionLanguage)
                }
            }.disabled(!state.permissions.checkRaw || state.transcriptID == nil)
        }
        Section("Actions") {
            Picker("Saved action", selection: Binding(get: { state.editor?.actionID }, set: { id in
                if let id { controller.selectAction(id: id) }
            })) {
                Text("Choose an action").tag(String?.none)
                ForEach(state.actions) { choice in
                    Text(verbatim: choice.title).tag(Optional(choice.id)).disabled(!choice.enabled)
                }
            }.disabled(!state.permissions.selectAction)
            Button("New Structured Notes", systemImage: "plus") {
                if let id = state.transcriptID {
                    controller.createStructuredNotesAction(transcriptID: id, language: controller.draft.outputLanguage,
                                                           settings: controller.draft.settings)
                }
            }.disabled(!state.permissions.createAction || state.transcriptID == nil)
        }
    }
}

@MainActor
private struct TAHComposerSection<C: TAHPresentationController>: View {
    let controller: C
    let context: TAHUIEditorContext

    private func binding<Value>(_ key: WritableKeyPath<TAHUIDraft, Value>) -> Binding<Value> {
        Binding(get: { controller.draft[keyPath: key] }, set: { value in
            var draft = controller.draft; draft[keyPath: key] = value
            controller.updateDraft(draft, context: context)
        })
    }

    var body: some View {
        let state = controller.presentation
        Section("Revision settings") {
            Picker("Output language", selection: binding(\.outputLanguage)) {
                ForEach(TAHUILanguage.allCases, id: \.self) { Text($0.title).tag($0) }
            }.disabled(!state.permissions.edit || state.initialSettingsFrozen)
            if state.initialSettingsFrozen {
                Text("Output language was fixed at the first submission.").font(.caption).foregroundStyle(.secondary)
            }
            TAHChoicePicker(title: "Model", choices: state.models, selection: binding(\.settings.modelID), emptyLabel: "Choose a model")
                .disabled(!state.permissions.edit)
            TAHChoicePicker(title: "Reasoning effort", choices: state.efforts, selection: binding(\.settings.reasoningEffortID))
                .disabled(!state.permissions.edit)
            Picker("Context window", selection: binding(\.settings.contextWindowTokens)) {
                Text("Provider default").tag(Int?.none)
                if let saved = controller.draft.settings.contextWindowTokens, !state.contextWindows.contains(where: { $0.id == saved }) {
                    Text("Unavailable: \(saved)").tag(Optional(saved)).disabled(true)
                }
                ForEach(state.contextWindows) { choice in
                    Text(verbatim: choice.title).tag(Optional(choice.id)).disabled(!choice.enabled)
                }
            }.disabled(!state.permissions.edit)
            Toggle("Allow web access for this revision", isOn: binding(\.settings.webEnabled))
                .disabled(!state.permissions.edit)
        }
        Section(state.canOmitInstructions ? "Extra instructions (optional)" : "Revise these notes") {
            TextEditor(text: binding(\.instructions)).frame(minHeight: 120)
                .accessibilityLabel("Revision instructions").disabled(!state.permissions.edit)
            Button("Send revision", systemImage: "arrow.up") {
                let draft = controller.draft
                controller.sendAction(.init(context: context, instructions: draft.instructions, settings: draft.settings,
                    initialLanguage: state.initialSettingsFrozen ? nil : draft.outputLanguage,
                    interactionLanguage: state.interactionLanguage, consent: draft.consent))
            }.disabled(!state.permissions.send || (!state.canOmitInstructions && controller.draft.instructions.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty))
        }
    }
}

@MainActor
private struct TAHChoicePicker: View {
    let title: String
    let choices: [TAHUIChoice]
    @Binding var selection: String?
    var emptyLabel = "Provider default"

    var body: some View {
        Picker(title, selection: $selection) {
            Text(verbatim: emptyLabel).tag(String?.none)
            if let saved = selection, !choices.contains(where: { $0.id == saved }) {
                Text("Unavailable: \(saved)").tag(Optional(saved)).disabled(true)
            }
            ForEach(choices) { choice in
                Text(verbatim: choice.title).tag(Optional(choice.id)).disabled(!choice.enabled)
            }
        }
    }
}
