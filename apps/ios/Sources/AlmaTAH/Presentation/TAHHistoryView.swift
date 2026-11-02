import SwiftUI

@MainActor
struct TAHHistorySection<C: TAHPresentationController>: View {
    let controller: C
    let actionID: String

    var body: some View {
        let state = controller.presentation
        Section("Conversation") {
            if state.hasMoreHistory {
                Button("Load earlier entries") { controller.loadMoreConversation(actionID: actionID) }
                    .disabled(!state.permissions.loadHistory)
            }
            if state.timeline.isEmpty { Text("No conversation entries yet.").foregroundStyle(.secondary) }
            ForEach(state.timeline) { item in
                VStack(alignment: .leading, spacing: 8) {
                    Text(verbatim: item.title).font(.headline)
                    Text(item.content).textSelection(.enabled)
                    if let detail = item.detail { Text(verbatim: detail).font(.caption).foregroundStyle(.secondary) }
                    if item.canExpand {
                        Button("Show full entry") { controller.expandConversation(actionID: actionID, itemID: item.id) }
                            .disabled(!state.permissions.loadHistory)
                    }
                }
            }
        }
        Section("Accepted revisions") {
            Button("Read raw transcript") { controller.readMaterial(.rawTranscript(actionID: actionID)) }
                .disabled(!state.permissions.readMaterial)
            if state.revisions.isEmpty { Text("No accepted revisions yet.").foregroundStyle(.secondary) }
            ForEach(state.revisions) { revision in
                VStack(alignment: .leading, spacing: 8) {
                    Text("Revision v\(revision.revisionIndex)").font(.headline)
                    Text(verbatim: revision.configurationLabel).font(.caption).foregroundStyle(.secondary)
                    Button("Read notes") { read(revision, .notes) }
                    Button("Read ASR terms") { read(revision, .asrTerms) }
                }
                // Automatic List row buttons can invoke both actions together.
                .buttonStyle(.borderless)
                .disabled(!state.permissions.readMaterial)
            }
        }
    }

    private func read(_ revision: TAHUIRevision, _ file: TAHUIOutcomeFile) {
        controller.readMaterial(.outcome(actionID: actionID, revisionIndex: revision.revisionIndex, file: file))
    }
}

@MainActor
struct TAHMaterialSheet<C: TAHPresentationController>: View {
    let controller: C

    var body: some View {
        let material = controller.presentation.material
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if material?.isLoading == true { ProgressView("Loading material") }
                    if let error = material?.error { Text(verbatim: error) }
                    if let content = material?.content { Text(content).textSelection(.enabled) }
                }.frame(maxWidth: .infinity, alignment: .leading).padding()
            }
            .navigationTitle(material?.title ?? "Material")
            .toolbar { Button("Done") { controller.dismissMaterial() } }
        }
    }
}
