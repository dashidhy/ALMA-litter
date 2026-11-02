#!/usr/bin/env python3
"""Isolated Swift/UI compilation and App snapshot projection checks; no provider/model calls.
The integration portion uses main's real bundled AppActions + original SQLite journal,
with an explicitly empty test credential store. It does not emulate any workflow.
"""
from pathlib import Path
import hashlib,json,os,subprocess,tempfile
ROOT=Path(__file__).resolve().parents[5]
BASE=ROOT/'apps/ios/Sources/AlmaTAH'
SWIFT=r'''
import Foundation

@main struct ControllerSmoke {
    @MainActor static func main() async throws {
        var checks: [String] = []
        func expect(_ value: Bool, _ name: String) throws {
            guard value else { throw NSError(domain: "ProjectionCheck", code: 1, userInfo: [NSLocalizedDescriptionKey:name]) }
            checks.append(name)
        }
        func decode<T: Decodable>(_ object: [String: Any], _ type: T.Type) throws -> T {
            try JSONDecoder().decode(type, from: JSONSerialization.data(withJSONObject: object))
        }
        typealias C = TAHMobileController
        let nilValue = NSNull()
        let authJSON: [String: Any] = ["providerID":"codex","state":"valid","phase":"idle","inspecting":false,
            "inspection":["state":"succeeded","finishedAt":"2030-01-01T00:00:00Z","failures":[]],
            "replacement":nilValue,"actorCatalog":["models":[["handle":"catalog-model","displayName":"Catalog Model",
                "efforts":[["handle":"medium","displayName":"Medium"]],"defaultEffortHandle":"medium",
                "contextWindows":["availableTokens":[32000],"defaultTokens":32000]]],"defaultModelHandle":"catalog-model"]]
        var rawJSON: [String: Any] = ["materialID":"material","providerID":"codex","state":"allowed","busy":false,
            "consentGranted":true,"expiresAt":"2030-02-01T00:00:00Z","explanation":"Public Guardian explanation"]
        var actionJSON: [String: Any] = ["id":"action","transcriptID":"transcript","language":"en","phase":"draft",
            "initialSettingsFrozen":false,"draftSettings":nilValue,"editorMode":"editing","editorToken":"published/initial",
            "canOmitInstructions":true,"contentConsentProviderID":"codex","contentConsentGranted":false,
            "operationID":nilValue,"error":nilValue,"revisions":[],"events":[]]
        let auth = try decode(authJSON,C.AppAuth.self)
        let now = ISO8601DateFormatter().date(from:"2030-01-15T00:00:00Z")!
        var draft = TAHUIDraft(settings:.init(providerID:"codex",modelID:"catalog-model",reasoningEffortID:"medium",contextWindowTokens:32000,webEnabled:false))
        func project(_ auth: C.AppAuth? = auth) throws -> TAHUIPresentation {
            C.project(auth:auth,raw:try decode(rawJSON,C.AppRaw.self),action:try decode(actionJSON,C.AppAction.self),
                draft:draft,language:.simplifiedChinese,commandBusy:false,now:now)
        }
        var state = try project()
        try expect(state.permissions.send && state.canOmitInstructions && !state.initialSettingsFrozen,"empty V0 is allowed only by core snapshot")
        try expect(state.interactionLanguage == .simplifiedChinese && state.models.first?.id == "catalog-model","interaction language and live catalog projected independently")
        actionJSON["initialSettingsFrozen"] = true; actionJSON["canOmitInstructions"] = false
        state = try project()
        try expect(state.initialSettingsFrozen && !state.permissions.send,"first-send language freeze and blank revision denial")
        draft.instructions = "Change the title only."
        try expect(try project().permissions.send,"nonblank later revision admission")
        var submission = TAHUISubmission(context:.init(actionID:"action",editorToken:"published/initial"),instructions:draft.instructions,
            settings:draft.settings,initialLanguage:nil,interactionLanguage:.simplifiedChinese,consent:false)
        var fields = try C.sendFields(submission)
        try expect(fields["grantWeb"] == .bool(false) && fields["initialLanguage"] == nil && fields["interactionLanguage"] == .string("zh-CN"),"per-revision Web false and omitted frozen language")
        draft.settings.reasoningEffortID = nil; draft.settings.contextWindowTokens = nil
        submission = .init(context:submission.context,instructions:draft.instructions,settings:draft.settings,initialLanguage:.english,interactionLanguage:.english,consent:true)
        fields = try C.sendFields(submission)
        try expect(fields["inference"]?["reasoningEffortID"] == .null && fields["inference"]?["contextWindowTokens"] == nil,"exact nullable effort and optional context wire shape")
        rawJSON["expiresAt"] = "2029-01-01T00:00:00Z"
        state = try project()
        try expect(!state.permissions.send && !state.permissions.createAction && state.permissions.checkRaw,"expired receipt gates execution and permits recheck")
        rawJSON["expiresAt"] = "2030-02-01T00:00:00Z"; rawJSON["consentGranted"] = false
        try expect(!project().permissions.send,"no implicit content consent")
        draft.consent = true; state = try project()
        try expect(state.permissions.send && !state.consentGranted,"explicit draft consent remains editable until persisted")
        draft.settings.providerID = "other"
        try expect(!project().permissions.send,"provider-specific draft cannot cross provider")
        draft.settings.providerID = "codex"; draft.settings.modelID = "unsupported"
        try expect(!project().permissions.send,"unavailable saved model is not silently substituted")
        var failedAuth = authJSON; failedAuth["inspection"] = ["state":"failed","finishedAt":"2030-01-01T00:00:00Z","failures":["models_unavailable"]]
        draft.settings.modelID = "catalog-model"
        try expect(!project(try decode(failedAuth,C.AppAuth.self)).permissions.createAction,"valid credential without successful inspection is insufficient")
        actionJSON["revisions"] = [["revisionIndex":0,"providerID":"codex","commitID":"publication/accepted","modelID":"catalog-model"]]
        actionJSON["events"] = [
            ["id":"secret","title":"Guardian chatter","detail":"must not render","role":"extra_guardian","kind":"tool"],
            ["id":"extra-safety-pass","title":"Safety Guardian","detail":"Allowed","role":"extra_guardian","kind":"activity","titleCode":"safety_guardian","status":"pass"],
            ["id":"actor-event","title":"Read","detail":"Public tool event","role":"actor","kind":"tool","status":"completed"]]
        func message(_ id:String,_ cycle:String) throws -> C.AppMessage {
            try decode(["id":id,"position":1,"cycleID":cycle,"role":"workflow","phase":"completed","revisionIndex":0,
                        "modelID":"catalog-model","text":"Public final","truncated":false,"isFinalAnswer":true],C.AppMessage.self)
        }
        let timeline = try C.timeline([message("good","accepted"),message("uncommitted","not-accepted")],action:decode(actionJSON,C.AppAction.self))
        try expect(timeline.count == 1 && timeline.first?.id == "good" && timeline.first?.role == .assistant && !timeline.contains(where:{$0.title=="Guardian chatter"}),"accepted final only; live events belong to currentActivity")

        // Main-owned real JS bundle + production journal, with no account or provider execution.
        let directory = URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
        let bundle = URL(fileURLWithPath:CommandLine.arguments[2])
        let config = try String(contentsOfFile:CommandLine.arguments[3],encoding:.utf8)
        var delegated: [String] = []
        let platform: C.ProviderPlatform = { method,_ in
            delegated.append(method)
            guard method == "credential.load" else { throw TAHRuntimeError.invalid_request }
            return #"{"version":1,"providerID":null,"state":"unauthed","credential":null,"account":null,"checkedAt":null}"#
        }
        let controller = try await C(bundleURL:bundle,configurationJSON:config,journalDirectory:directory,providerPlatform:platform)
        try expect(controller.presentation.permissions.importTranscript && !controller.presentation.permissions.createAction,"real core unauthenticated projection")
        let text = "[00:00:00 - 00:00:02]\nLiteral transcript 中文 **not code**.\n"
        controller.importTranscript(title:"Smoke transcript",text:text)
        for _ in 0..<250 {
            if !controller.presentation.isBusy { break }
            try await Task.sleep(for:.milliseconds(20))
        }
        try expect(controller.presentation.transcripts.count == 1 && controller.presentation.error == nil,"real material.put through native journal")
        let transcriptID = controller.presentation.transcriptID!
        try expect(!controller.presentation.permissions.checkRaw && !controller.draft.consent,"import never grants consent or invokes Guardian")
        await controller.shutdown()
        let reopened = try await C(bundleURL:bundle,configurationJSON:config,journalDirectory:directory,providerPlatform:platform)
        try expect(reopened.presentation.transcriptID == transcriptID,"transcript selection recovered from persisted UI index")
        await reopened.shutdown()
        let store = try TAHJournalStore(directory:directory)
        let streams = try await store.streams(ownerID:"transcript/"+transcriptID)
        guard let stream = streams.first(where:{$0.hasPrefix("material/")}), let entry = try await store.entries(streamID:stream,afterVersion:0).first else { throw TAHRuntimeError.unavailable }
        let bytes = try await store.readChunk(operationID:entry.operationID,index:0)
        let material = try JSONDecoder().decode(TAHRuntimeValue.self,from:bytes)
        try expect(material["rawTranscript"] == .string(text),"production SQLite retains exact imported UTF-8")
        await store.close()
        try expect(delegated.allSatisfy{$0=="credential.load"},"zero provider/model operations")
        let output: [String:Any] = ["passed":true,"checks":checks,"providerCalls":0,"realCoreMaterialImport":true]
        print(String(data:try JSONSerialization.data(withJSONObject:output,options:[.sortedKeys]),encoding:.utf8)!)
    }
}
'''

def run(args,**kwargs):
    p=subprocess.run(args,text=True,capture_output=True,timeout=90,**kwargs)
    if p.returncode: raise RuntimeError(json.dumps({'args':args,'exit':p.returncode,'stderr':p.stderr,'stdout':p.stdout}))
    return p

def main():
    out=Path(tempfile.mkdtemp(prefix='alma-controller-checks-')).resolve()
    fixture=out/'ControllerSmoke.swift';fixture.write_text(SWIFT)
    sources=[]; source_hashes={}
    # Main owns the host and may edit it concurrently: compile immutable byte snapshots.
    for original in sorted(BASE.rglob('*.swift')):
        if original.name == 'TAHCodexPlatform.swift': continue  # actual Rust bindings belong to full native builds
        data=original.read_bytes(); source_hashes[str(original.relative_to(ROOT))]=hashlib.sha256(data).hexdigest()
        copied=out/'sources'/original.relative_to(BASE); copied.parent.mkdir(parents=True,exist_ok=True)
        copied.write_bytes(data); sources.append(str(copied))
    mac=ROOT/'shared/tah-runtime/upstream/prompts'
    config={'profiles':[{'id':'codex','displayName':'Codex','authRouteID':'codex-auth','taskRouteID':'codex-task','guardianModel':'unused-offline-smoke','guardianEffort':'medium','disabledModels':[],'profileIdentity':'0'*64}],
            'resources':{key:(mac/'system_prompts'/file).read_text() for key,file in [('actorPromptTemplate','actor_prompt_v4_2.txt'),('rawGuardianPrompt','safety_guardian_raw_prompt_v0_3.txt'),('extraGuardianPrompt','safety_guardian_extra_prompt_v0_6.txt'),('safetyPolicy','safety_guardian_policy_v0_2.txt')]},
            'actionInstructions':(mac/'action_instructions/structured_notes_v4_3.txt').read_text()}
    (out/'configuration.json').write_text(json.dumps(config))
    bundle=ROOT/'shared/tah-runtime/generated/alma-tah.js'
    common=['-swift-version','6','-strict-concurrency=complete','-parse-as-library','-module-cache-path',str(out/'cache')]
    commands={};diagnostics={}
    for target,sdkname in [('host','macosx'),('simulator','iphonesimulator')]:
        sdk=run(['xcrun','--sdk',sdkname,'--show-sdk-path']).stdout.strip()
        compiler=run(['xcrun','--find','swiftc']).stdout.strip()
        command=[compiler,*common,'-sdk',sdk,'-emit-library','-module-name','AlmaTAHMobile']
        if target=='simulator':command+=['-target','arm64-apple-ios18.0-simulator']
        command+=[*sources,'-lsqlite3','-framework','JavaScriptCore','-o',str(out/(target+'.dylib'))]
        env=dict(os.environ,SDKROOT=sdk)
        diagnostics[target]=run(command,env=env).stderr;commands[target]=command
    command=['xcrun','swiftc',*common,*sources,str(fixture),'-lsqlite3','-framework','JavaScriptCore','-o',str(out/'checks')]
    diagnostics['checks']=run(command).stderr;commands['checks']=command
    result=json.loads(run([str(out/'checks'),str(out/'journal'),str(bundle),str(out/'configuration.json')]).stdout)
    result.update({'artifacts':str(out),'commands':commands,'diagnostics':diagnostics,
        'sourceSHA256':source_hashes,
        'bundleSHA256':hashlib.sha256(bundle.read_bytes()).hexdigest(),
        'simulatorPlatform':run(['xcrun','vtool','-show-build',str(out/'simulator.dylib')]).stdout,
        'limits':['No simulator/device launch','No live authorization, Guardian, actor or provider/backend flow','Formatting uses native inline Markdown; full desktop Markdown parity not established']})
    (Path(__file__).parent/'controller-smoke-result.json').write_text(json.dumps(result,indent=2)+'\n')
    print(json.dumps(result,indent=2))

if __name__=='__main__':main()
