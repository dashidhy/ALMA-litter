import SwiftUI

@main
struct LocalAgentProbeApp: App {
    var body: some Scene {
        WindowGroup { ProbeView() }
    }
}

@MainActor
struct ProbeView: View {
    @State private var model = ProbeModel()

    var body: some View {
        NavigationStack {
            Form {
                Section("Readiness") {
                    Text("Standalone qualification · synthetic fixtures only")
                        .font(.headline)
                    LabeledContent("Fixed workdir", value: QualificationWorkspace.output)
                    Text(model.readinessMessage)
                        .font(.callout)
                    LabeledContent("Runtime", value: model.runtimeStatus)
                    Button("Prepare local runtime") { Task { await model.prepare() } }
                        .disabled(!model.canPrepare)
                }
                Section("ChatGPT account") {
                    LabeledContent("Account", value: model.accountStatus)
                    Button("Sign in with ChatGPT") { Task { await model.signIn() } }
                        .disabled(!model.canSignIn)
                    Button("Check account") { Task { await model.checkAccount() } }
                        .disabled(!model.canCheckAccount)
                    LabeledContent("Visible models", value: String(model.modelCount))
                    Button("Check models") { Task { await model.checkModels() } }
                        .disabled(!model.canCheckModels)
                }
                Section("One test session") {
                    LabeledContent("Session", value: model.sessionStatus)
                    LabeledContent("Task", value: model.taskStatus)
                    Button("Create test session") { Task { await model.createSession() } }
                        .disabled(!model.canCreateSession)
                    Button("Run one test task") { Task { await model.runTask() } }
                        .disabled(!model.canRunTask)
                    Button("Check task status") { Task { await model.checkTask() } }
                        .disabled(!model.canCheckTask)
                    Button("Interrupt task", role: .destructive) { Task { await model.interruptTask() } }
                        .disabled(!model.canCheckTask || !model.canInterrupt)
                }
                Section {
                    if model.busy { ProgressView("Operation in progress") }
                    Text(model.notice).font(.footnote)
                    Text("Host-controlled qualification only. Credentials and message bodies stay off this screen. TAH acceptance and version publication are checked separately on the Mac.")
                        .font(.footnote).foregroundStyle(.secondary)
                }
            }
            .navigationTitle("Local Agent Probe")
        }
        .task {
            // Host-invoked diagnostic only; normal user launches stay idle.
            // Login is always manual; model work requires an explicit test flag.
            if ProcessInfo.processInfo.arguments.contains("--prepare-only") {
                await model.prepare()
            }
            if ProcessInfo.processInfo.arguments.contains("--inspect-tah-auth") {
                await model.runTah(inspectOnly: true)
            } else if ProcessInfo.processInfo.arguments.contains("--run-tah-attempt") {
                await model.runTah(inspectOnly: false)
            } else if ProcessInfo.processInfo.arguments.contains("--verify-tools-web") {
                await model.verifySubscription(toolsAndWeb: true)
            } else if ProcessInfo.processInfo.arguments.contains("--verify-subscription") {
                await model.verifySubscription()
            }
        }
    }
}

#Preview { ProbeView() }
