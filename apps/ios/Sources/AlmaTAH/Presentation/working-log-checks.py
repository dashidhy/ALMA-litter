#!/usr/bin/env python3
"""Isolated public-log projection/identity checks. Synthetic data only; no device or models."""
from pathlib import Path
import hashlib,json,os,subprocess,tempfile
ROOT=Path(__file__).resolve().parents[5]
SWIFT=r'''
import Foundation
import CryptoKit

@MainActor enum Fixture {
    static func decode<T:Decodable>(_ value:Any,_ type:T.Type) throws -> T { try JSONDecoder().decode(type,from:JSONSerialization.data(withJSONObject:value,options:.sortedKeys)) }
    static func event(_ id:String="actor",role:String="actor",kind:String="tool",title:String="Public tool") -> [String:Any] {
        ["id":id,"title":title,"detail":String(repeating:"公开 text\n",count:9000),"role":role,"kind":kind,"titleCode":NSNull(),"status":"completed","round":0]
    }
    static func bytes(_ marker:String="a",limited:Bool=false) throws -> Data {
        var pass=event("extra-safety-pass",role:"extra_guardian",kind:"activity");pass["titleCode"]="safety_guardian";pass["status"]="pass";pass["detail"]="Allowed"
        var privateEvent=event("private",role:"raw_guardian");privateEvent["detail"]="PRIVATE-GUARDIAN"
        var event=event(marker);event["detailTruncated"]=false
        return try JSONSerialization.data(withJSONObject:["schemaVersion":1,"limited":limited,"events":[event,privateEvent,pass]],options:.sortedKeys)
    }
    static func hash(_ data:Data)->String { SHA256.hash(data:data).map{String(format:"%02x",$0)}.joined() }
    static func metadata(_ hash:String) -> [String:Any] {
        ["startedAt":"2026-11-01T01:00:00Z","endedAt":NSNull(),"workingLogSHA256":hash,"workingLogBytes":100,
         "workingLogLimited":false,"stages":[["phase":"actor","at":"2026-11-01T01:00:00Z"]],"events":[event("recent")]]
    }
    static func action(_ hash:String,op:String="op",phase:String="actor",mode:String="running") throws -> TAHMobileController.AppAction {
        try decode(["id":"a","transcriptID":"t","language":"en","phase":phase,"initialSettingsFrozen":true,"editorMode":mode,"editorToken":"submission/op",
            "canOmitInstructions":false,"operationID":op,"revisionIndex":1,"latestSubmittedRevisionIndex":1,"presentation":metadata(hash),
            "revisions":[["revisionIndex":0,"providerID":"codex","commitID":"publication/cycle","modelID":"m"]],"events":[event()]],TAHMobileController.AppAction.self)
    }
    static func message(_ hash:String,phase:String="completed",role:String="workflow",title:String="irrelevant") throws -> TAHMobileController.AppMessage {
        try decode(["id":"message","position":7,"cycleID":"cycle","role":role,"phase":phase,"revisionIndex":0,"modelID":"m","text":title,
            "truncated":false,"isFinalAnswer":phase=="completed","presentation":metadata(hash),"criticRounds":[["decision":"PASS"]]],TAHMobileController.AppMessage.self)
    }
    static func reference(_ hash:String,position:Int?=nil,op:String="op") throws -> TAHMobileWorkingLogReader.Reference {
        let meta=try decode(metadata(hash),TAHMobileController.AppPresentation.self)
        return .init(actionID:"a",position:position,operationID:position==nil ? op:nil,hash:hash,
            summary:TAHMobileController.summary(id:"summary",position:position,revision:1,phase:position==nil ? "actor":"completed",metadata:meta,live:position==nil,running:position==nil,criticPassed:position != nil)!,limited:false)
    }
}
@MainActor final class Source {
    var action: TAHMobileController.AppAction
    var blobs:[String:Data]
    var offsets:[Int]=[]
    var hashes:[String]=[]
    var invalidTotal=false
    var corrupt=false
    var pause=false
    var waiter:CheckedContinuation<Void,Never>?
    init(_ data:Data) throws {let h=Fixture.hash(data);action=try Fixture.action(h);blobs=[h:data]}
    func part(_ ref:TAHMobileWorkingLogReader.Reference,_ offset:Int) async throws -> TAHMobileController.TextChunk {
        offsets.append(offset);hashes.append(ref.hash)
        if pause { pause=false;await withCheckedContinuation{waiter=$0} }
        guard let data=blobs[ref.hash] else {throw TAHRuntimeError.unavailable}
        let body=corrupt ? Data("wrong".utf8):data.subdata(in:offset..<min(data.count,offset+48*1024))
        return .init(data:body.base64EncodedString(),totalBytes:invalidTotal ? 4*1024*1024+1 : corrupt ? body.count:data.count)
    }
    func release(){waiter?.resume();waiter=nil}
}
@main struct Checks {
    @MainActor static func main() async throws {
        var passed:[String]=[]
        func expect(_ ok:Bool,_ name:String)throws{guard ok else{throw NSError(domain:"WorkingLog",code:1,userInfo:[NSLocalizedDescriptionKey:name])};passed.append(name)}
        let data=try Fixture.bytes(), hash=Fixture.hash(data), action=try Fixture.action(hash)
        let completed=try Fixture.message(hash)
        let rows=TAHMobileController.timeline([completed],action:action)
        try expect(rows.count==1 && rows[0].role == .assistant,"workflow explicitly maps to assistant; no live rows appended")
        try expect(rows[0].working?.events.isEmpty == true && rows[0].working?.canOpen == true && rows[0].working?.position==7,"completed has metadata/full-log link and zero preview")
        try expect(rows[0].working?.endedAt=="2026-11-01T01:00:00Z","historical duration falls back to last saved stage")
        let published=try Fixture.message(hash,phase:"published")
        try expect(TAHMobileController.timeline([published],action:action)[0].working?.events.isEmpty == true,"published has zero preview")
        let user=try Fixture.message(hash,phase:"running",role:"user",title:"Safety Guardian Actor")
        try expect(TAHMobileController.messageRole(user) == .user,"role never inferred from title/text")
        let guardian=try Fixture.message(hash,phase:"extra_guardian")
        try expect(TAHMobileController.messageRole(guardian) == .system && TAHMobileController.timeline([guardian],action:action)[0].working==nil,"guardian system role has no private preview/log")
        let activity=TAHMobileController.currentSummary(action,history:[])
        try expect(activity?.position==nil && activity?.live==true && activity?.progressing==true && activity?.events.count==1,"actual actor activity is dedicated/live")
        try expect(activity?.endedAt==nil,"live end time is never fabricated")
        let done=try Fixture.action(hash,phase:"completed",mode:"editing")
        try expect(TAHMobileController.currentSummary(done,history:[])==nil,"completed action has no current activity")
        var disguised=Fixture.event("extra-safety-pass",role:"extra_guardian",kind:"tool");disguised["titleCode"]="safety_guardian";disguised["status"]="pass"
        try expect(!(try Fixture.decode(disguised,TAHMobileController.AppAction.Event.self)).isPublic,"Guardian verdict requires exact host activity identity")

        let source=try Source(data)
        var observedLogState: TAHUIWorkingLog?
        let reader=TAHMobileWorkingLogReader(snapshot:{_ in source.action},chunk:{try await source.part($0,$1)},changed:{observedLogState=$0})
        var ref=try Fixture.reference(hash)
        reader.open(ref)
        try expect(observedLogState?.id==reader.state?.id && observedLogState?.id.isEmpty==false && observedLogState?.loading==true && observedLogState?.events.isEmpty==true && source.offsets.isEmpty,
                   "open publishes new loading identity synchronously before await/read")
        await reader.waitForUpdates()
        try expect(reader.state?.failed==false && reader.state?.events.count==2 && reader.state?.events.contains(where:{$0.detail.contains("PRIVATE-GUARDIAN")})==false,"verified full log excludes private Guardian events")
        try expect(source.offsets.count>1 && source.offsets[1]==48*1024 && Set(source.hashes)==[hash],"multi-chunk UTF8 read pins one hash")
        let id=reader.state!.id, count=source.offsets.count
        reader.update(reference:ref,actionID:"a",operationID:"op");reader.refresh(id:id);await reader.waitForUpdates()
        try expect(source.offsets.count==count,"unchanged successful hash never reread")
        let next=try Fixture.bytes("next",limited:true),nextHash=Fixture.hash(next);source.blobs[nextHash]=next;source.action=try Fixture.action(nextHash)
        ref=try Fixture.reference(nextHash);reader.update(reference:ref,actionID:"a",operationID:"op");await reader.waitForUpdates()
        try expect(reader.state?.events.first?.id=="next" && reader.state?.limited==true,"changed live hash refreshes actual log")
        let paneID=reader.state!.id
        source.action=try Fixture.action(nextHash,phase:"completed",mode:"editing")
        let completedMeta=try Fixture.decode(Fixture.metadata(nextHash),TAHMobileController.AppPresentation.self)
        let completedSummary=TAHMobileController.summary(id:"a/op",position:nil,revision:1,phase:"completed",metadata:completedMeta,live:true,running:false,criticPassed:true)!
        reader.update(reference:.init(actionID:"a",position:nil,operationID:"op",hash:nextHash,summary:completedSummary,limited:true),actionID:"a",operationID:"op")
        await reader.waitForUpdates()
        try expect(reader.state?.id==paneID && reader.state?.superseded==false && reader.state?.progressing==false && reader.state?.events.first?.id=="next","same operation completion preserves open pane and log")
        let missing=String(repeating:"b",count:64);source.action=try Fixture.action(missing)
        reader.update(reference:try Fixture.reference(missing),actionID:"a",operationID:"op");await reader.waitForUpdates()
        try expect(reader.state?.failed==true && reader.state?.events.first?.id=="next" && reader.state?.limited==true,"refresh failure preserves previous verified events/limit")
        source.action=try Fixture.action(nextHash,op:"different")
        reader.update(reference:try Fixture.reference(nextHash,op:"different"),actionID:"a",operationID:"different")
        try expect(reader.state?.superseded==true && reader.state?.progressing==false && reader.state?.events.first?.id=="next","operation change supersedes without replacing old dialog")

        source.action=try Fixture.action(hash);source.pause=true
        reader.open(try Fixture.reference(hash));for _ in 0..<100 {if source.waiter != nil{break};await Task.yield()}
        reader.close();source.release();await Task.yield();await Task.yield()
        try expect(reader.state==nil,"close invalidates in-flight read immediately")
        source.pause=true;reader.open(try Fixture.reference(hash));for _ in 0..<100 {if source.waiter != nil{break};await Task.yield()}
        reader.update(reference:nil,actionID:"another-action",operationID:"op");source.release();await Task.yield()
        try expect(reader.state==nil,"selection change invalidates pending read")

        source.pause=true;reader.open(try Fixture.reference(hash));for _ in 0..<100 {if source.waiter != nil{break};await Task.yield()}
        source.action=try Fixture.action(hash,op:"changed-during-read");source.release();await reader.waitForUpdates()
        try expect(reader.state?.superseded==true && reader.state?.events.isEmpty==true,"post-read operation identity checked even with identical hash")
        let priorDialogID=observedLogState?.id
        reader.open(try Fixture.reference(hash,position:7))
        try expect(observedLogState?.id != priorDialogID && observedLogState?.id==reader.state?.id && observedLogState?.position==7 && observedLogState?.loading==true,
                   "completed historical open immediately publishes replacement dialog")
        await reader.waitForUpdates()
        let historic=reader.state!.events, before=source.offsets.count
        reader.update(reference:try Fixture.reference(nextHash,op:"new-op"),actionID:"a",operationID:"new-op");reader.refresh(id:reader.state!.id);await reader.waitForUpdates()
        try expect(reader.state?.position==7 && reader.state?.events==historic && source.offsets.count==before,"historical position/hash stays immutable across new operation")
        source.corrupt=true;reader.open(try Fixture.reference(hash,position:8));await reader.waitForUpdates()
        try expect(reader.state?.failed==true && reader.state?.events.isEmpty==true,"wrong SHA refuses content")
        source.corrupt=false;source.invalidTotal=true;reader.open(try Fixture.reference(hash,position:9));await reader.waitForUpdates()
        try expect(reader.state?.failed==true,"4MiB total bound enforced")
        source.invalidTotal=false;source.pause=true;reader.open(try Fixture.reference(hash,position:7));for _ in 0..<100{if source.waiter != nil{break};await Task.yield()}
        reader.open(try Fixture.reference(nextHash,position:8));source.release();await reader.waitForUpdates()
        try expect(reader.state?.position==8 && reader.state?.events.first?.id=="next","old pending position cannot overwrite new dialog")
        reader.close()
        print(String(data:try JSONSerialization.data(withJSONObject:["passed":true,"checks":passed,"providerCalls":0],options:.sortedKeys),encoding:.utf8)!)
    }
}
'''
def run(cmd,**kw):
 r=subprocess.run(cmd,text=True,capture_output=True,timeout=90,**kw)
 if r.returncode:raise RuntimeError(r.stderr+r.stdout)
 return r

def main():
 out=Path(tempfile.mkdtemp(prefix='alma-working-checks-')).resolve();fixture=out/'Checks.swift';fixture.write_text(SWIFT)
 sources=[];hashes={}
 for p in sorted((ROOT/'apps/ios/Sources/AlmaTAH').rglob('*.swift')):
  if p.name=='TAHCodexPlatform.swift':continue
  data=p.read_bytes();t=out/'sources'/p.relative_to(ROOT/'apps/ios/Sources/AlmaTAH');t.parent.mkdir(parents=True,exist_ok=True);t.write_bytes(data);sources.append(str(t));hashes[str(p.relative_to(ROOT))]=hashlib.sha256(data).hexdigest()
 common=['-swift-version','6','-strict-concurrency=complete','-parse-as-library','-module-cache-path',str(out/'cache')]
 command=['xcrun','swiftc',*common,*sources,str(fixture),'-lsqlite3','-framework','JavaScriptCore','-o',str(out/'checks')]
 compile=run(command);result=json.loads(run([str(out/'checks')]).stdout)
 sdk=run(['xcrun','--sdk','iphonesimulator','--show-sdk-path']).stdout.strip()
 sim=['xcrun','--sdk','iphonesimulator','swiftc',*common,'-sdk',sdk,'-target','arm64-apple-ios18.0-simulator','-emit-library',*[p for p in sources if Path(p).name not in ['TAHHistoryView.swift','TAHMobileView.swift']],'-lsqlite3','-framework','JavaScriptCore','-o',str(out/'web.dylib')]
 sim_result=run(sim,env=dict(os.environ,SDKROOT=sdk))
 result.update(artifacts=str(out),sourceSHA256=hashes,hostDiagnostics=compile.stderr,simulatorDiagnostics=sim_result.stderr,commands=[command,sim])
 target=Path(__file__).with_name('working-log-checks-result.json');target.write_text(json.dumps(result,indent=2)+'\n')
 print(json.dumps({'passed':result['passed'],'checks':len(result['checks']),'hostDiagnostics':compile.stderr,'simulatorDiagnostics':sim_result.stderr,'artifacts':str(out)}))
if __name__=='__main__':main()
