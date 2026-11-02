import Foundation

@main
@MainActor
struct GateTests {
    static func main() async {
        let model = ProbeModel()
        precondition(!model.canPrepare && !model.canSignIn && !model.canCheckAccount)
        precondition(!model.canCheckModels && !model.canCreateSession && !model.canRunTask)
        precondition(!model.canCheckTask && !model.canInterrupt)
        await model.prepare()
        await model.signIn()
        await model.checkAccount()
        await model.checkModels()
        await model.createSession()
        await model.runTask()
        await model.checkTask()
        await model.interruptTask()
        precondition(!model.busy && !model.connected && !model.accountReady && !model.sessionReady)
        precondition(!model.taskAttempted && model.modelCount == 0)
        precondition(model.runtimeStatus == "Not prepared")
        precondition(model.taskStatus == "Not submitted")
        precondition(QualificationWorkspace.output == "/workspace/output")
        precondition(QualificationWorkspace.home == "/workspace/tmp/home")
        print("PASS: disabled shell rejects all eight live actions; no fake readiness or submission")
    }
}
