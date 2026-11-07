// Appended to the unchanged core replay fixture and run in the real JSCore +
// SQLite host. The synthetic provider is gated; no model endpoint is called.
const workingReplayFixture=globalThis.AlmaMobileRuntime;
globalThis.AlmaMobileRuntime={async invoke(method,input){
  if(method!=='proof')throw new Error('Unexpected test entry');
  const originalExports=AlmaTAH, native=__almaPlatformCall, checks=[];
  const expect=(condition,label)=>{if(!condition)throw new Error(label);checks.push(label);};
  const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
  const waitFor=async(promise,label)=>{
    let timer;
    try{
      return await Promise.race([promise,new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new Error(`Fixture barrier timed out: ${label}`)),10000);
      })]);
    }finally{clearTimeout(timer);}
  };
  const until=async (fn,test)=>{for(let n=0;n<2000;n++){const v=await fn();if(test(v))return v;await new Promise(r=>setTimeout(r,2));}throw new Error('Fixture barrier timed out');};
  const rejects=async (fn,code,label)=>{let error;try{await fn();}catch(e){error=e;}expect(error?.code===code,label);};
  const ackDelayMS=input.workingStreamACKDelayMS??0;
  if(![0,20].includes(ackDelayMS))throw new Error('Unsupported fixture ACK delay');
  const activeCompletion=deferred(),inactiveCompletion=deferred(),uiBlocked=deferred(),uiRelease=deferred();
  let base,storeCalls=0,providerCalls=0,liveCore,observedOperationID,holdNextAction=false;
  let completedWhileActive=false,completedWhileInactive=false;
  const originalView=originalExports.AppActions.prototype.workingView;
  originalExports.AppActions.prototype.workingView=function(...args){liveCore=this;return originalView.apply(this,args);};
  const captured=new Error('Captured replay provider');
  globalThis.AlmaTAH={...originalExports,createMobileRuntime(adapters){base=adapters.get('codex');return {async invoke(){throw captured;}};}};
  try{await workingReplayFixture.invoke('proof',input);}catch(error){if(error!==captured)throw error;}
  finally{globalThis.AlmaTAH=originalExports;}
  // Observe the real synchronous publication while the actor's UI ACK is gated.
  // Delivery may coalesce this intermediate state with the final cleanup state.
  const {LatestAppNotifications}=__almaWorkingTestRequire('/upstream/src/app-runtime/notifications.ts');
  const originalPublish=LatestAppNotifications.prototype.publish;
  LatestAppNotifications.prototype.publish=function(key,value){
    if(value.operationID===observedOperationID&&value.phase==='completed'&&liveCore?.busy){
      const view=originalView.call(liveCore,value.actionID,value.operationID);
      expect(view.phase==='completed'&&!view.finished,'Completed phase is not finished while Core is active');
      completedWhileActive=true;activeCompletion.resolve(value.sourceRevision);
    }
    return originalPublish.call(this,key,value);
  };
  globalThis.__almaPlatformCall=async(method,value)=>{
    if(method.startsWith('provider.')){providerCalls++;throw new Error('Native provider forbidden');}
    if(method.startsWith('store.'))storeCalls++;
    if(method==='ui.actionChanged'&&value.operationID===observedOperationID&&holdNextAction){
      holdNextAction=false;uiBlocked.resolve();await waitFor(uiRelease.promise,'release gated UI ACK');
    }
    let finalRevision;
    if(method==='ui.actionChanged'&&value.operationID===observedOperationID&&value.phase==='completed'&&liveCore){
      const view=originalView.call(liveCore,value.actionID,value.operationID);
      expect(!liveCore.busy&&view.finished,'Final cleanup notification exposes inactive finished owner');
      completedWhileInactive=true;finalRevision=value.sourceRevision;
    }
    if(method==='ui.actionChanged'&&ackDelayMS)await new Promise(resolve=>setTimeout(resolve,ackDelayMS));
    const result=await native(method,value);
    if(finalRevision!==undefined)inactiveCompletion.resolve(finalRevision);
    return result;
  };
  const actors=[], actorReady=[deferred(),deferred()], guardianRelease=deferred(),guardianReady=deferred();
  const provider={...base,async run(built,bytes,emit,signal){
    const role=built.attempt.role;
    if(role==='extra_guardian'){
      guardianReady.resolve(); await waitFor(guardianRelease.promise,'release Guardian');
    }
    if(role!=='actor')return base.run(built,bytes,emit,signal);
    let sequence=0;
    const actor={release:deferred(),emit:async e=>emit({...e,attemptID:built.attempt.attemptID,sequence:++sequence})};
    actors.push(actor);actorReady[actors.length-1].resolve(actor);
    if(signal.aborted)actor.release.resolve();
    signal.addEventListener('abort',()=>actor.release.resolve(),{once:true});
    await waitFor(actor.release.promise,'release actor');
    if(signal.aborted)return {terminal:{kind:'cancelled'},candidateManifest:[],candidateFiles:new Map()};
    return base.run(built,bytes,e=>emit({...e,sequence:++sequence}),signal);
  }};
  const runtime=originalExports.createMobileRuntime(new Map([['codex',provider]])),call=(m,v={})=>runtime.invoke(m,v);
  try{
    await call('runtime.initialize',input.config);await call('auth.select',{providerID:'codex'});await call('auth.authorize');
    const ready=()=>until(()=>call('auth.snapshot'),s=>s.inspection?.state==='succeeded'&&!s.inspecting&&s.phase==='idle');
    await ready();
    const actionID=__almaUUID(),operationID=__almaUUID(),materialID=__almaUUID(),transcriptID=__almaUUID();
    observedOperationID=operationID;
    await call('material.put',{materialID,transcriptID,title:'Working stream fixture',rawTranscript:input.transcript});
    await call('raw.check',{materialID,operationID:__almaUUID(),consent:true,interactionLanguage:'en'});
    await until(()=>call('raw.status',{materialID}),s=>!s.busy);await call('action.create',{actionID,materialID,language:'en'});
    const send=operationID=>call('action.send',{actionID,operationID,instructions:actors.length?input.deltas[1]:input.deltas[0],inference:{modelID:'gpt-5.6-luna',reasoningEffortID:'low'},interactionLanguage:'en',grantWeb:false,consent:true});
    await rejects(()=>call('action.workingOpen',{actionID,operationID}),'unavailable','No in-memory execution does not fall back to journal');
    await send(operationID);const actor=await waitFor(actorReady[0].promise,'first actor ready');
    await actor.emit({kind:'tool_started',toolCallID:'read',operation:'text_read',detail:'A'});
    let frame=await call('action.workingOpen',{actionID,operationID});
    expect(frame.reset&&frame.revision===1&&!frame.finished&&frame.events.at(-1).detail==='A','Real runtime opens actor memory');
    holdNextAction=true;
    await actor.emit({kind:'tool_updated',toolCallID:'read',detail:'A'});
    await waitFor(uiBlocked.promise,'actor UI notification entered');
    const before=storeCalls;
    for(let n=0;n<100;n++)await actor.emit({kind:'tool_updated',toolCallID:'read',detail:'latest-'+n});
    frame=await call('action.workingNext',{streamID:frame.streamID,afterRevision:frame.revision});
    expect(frame.events.length===1&&frame.events[0].detail==='latest-99'&&frame.baseRevision===1,'Actual AppActions emits latest diff');
    const same=await call('action.workingNext',{streamID:frame.streamID,afterRevision:frame.revision});
    expect(same.unchanged&&Object.keys(same).length===3,'Real runtime unchanged response is minimal');
    expect(storeCalls===before,'Live Open/Next perform zero journal reads or writes');
    await rejects(()=>call('action.workingNext',{streamID:frame.streamID,afterRevision:1}),'invalid_request','Real runtime rejects stale ACK');
    await actor.emit({kind:'tool_completed',toolCallID:'read',status:'completed',detail:'latest-99'});
    await actor.emit({kind:'activity',phase:'queued',detail:'Queued'});
    actor.release.resolve();
    const activeRevision=await waitFor(activeCompletion.promise,'completed publication while active');
    // Completion barrier uses the session itself, never reads a snapshot/log.
    frame=await until(async()=>{
      const next=await call('action.workingNext',{streamID:frame.streamID,afterRevision:frame.revision});
      if(!next.unchanged)frame=next;return frame;
    },value=>value.finished);
    expect(frame.phase==='completed'&&frame.finished,'Retained owner survives terminal cleanup');
    expect(completedWhileActive&&!completedWhileInactive,'Core completes while its intermediate UI ACK remains gated');
    uiRelease.resolve();
    const inactiveRevision=await waitFor(inactiveCompletion.promise,'inactive terminal notification delivered');
    expect(completedWhileActive&&completedWhileInactive,'Same-phase active-to-inactive handoff observed on actual Core');
    expect(inactiveRevision>activeRevision,'Delivered terminal revision includes final cleanup after active publication');
    const terminal=await call('action.workingOpen',{actionID,operationID});
    expect(terminal.finished&&terminal.reset&&terminal.events.some(e=>e.role==='actor'),'Open after completion returns same-operation retained view');
    expect(!JSON.stringify(terminal).includes('PRIVATE_GUARDIAN_REPLAY'),'Private Guardian data excluded');
    const terminalBefore=storeCalls;
    await call('action.workingNext',{streamID:terminal.streamID,afterRevision:1});
    expect(storeCalls===terminalBefore,'Retained terminal read has no historical journal fallback');
    const otherRuntime=originalExports.createMobileRuntime(new Map([['codex',provider]]));
    await otherRuntime.invoke('runtime.initialize',input.config);
    await rejects(()=>otherRuntime.invoke('action.workingOpen',{actionID,operationID}),'unavailable','Restarted runtime cannot claim old in-memory owner');
    await otherRuntime.invoke('runtime.shutdown',{});
    await ready();
    const nextOperation=__almaUUID();await send(nextOperation);await waitFor(guardianReady.promise,'Guardian ready');
    await rejects(()=>call('action.workingNext',{streamID:terminal.streamID,afterRevision:1}),'unavailable','New execution invalidates old operation stream');
    await rejects(()=>call('action.workingOpen',{actionID,operationID:nextOperation}),'unavailable','Guardian-only current scope is unavailable');
    guardianRelease.resolve();const second=await waitFor(actorReady[1].promise,'second actor ready');
    const current=await call('action.workingOpen',{actionID,operationID:nextOperation});
    expect(current.operationID===nextOperation&&!current.finished&&current.events.every(e=>!e.id.endsWith(':read')),'New scope has its own tracker');
    await rejects(()=>call('action.workingOpen',{actionID,operationID}),'unavailable','Retained old operation never crosses revision');
    await rejects(()=>call('action.workingNext',{streamID:current.streamID,afterRevision:1}),'unavailable','Failed new Open still invalidates preceding session');
    await second.emit({kind:'tool_started',toolCallID:'cancelled-row',operation:'text_read',detail:'Still running'});
    let latest=await call('action.workingOpen',{actionID,operationID:nextOperation});
    expect(latest.events.some(e=>e.id.endsWith(':cancelled-row')&&e.status==='running'),'Actual Core event is running before cancellation');
    await call('action.cancel');
    await until(async()=>{const n=await call('action.workingNext',{streamID:latest.streamID,afterRevision:latest.revision});if(!n.unchanged)latest=n;return latest;},x=>x.finished);
    expect(latest.finished&&latest.phase==='cancelled'&&latest.events.some(e=>e.id.endsWith(':cancelled-row')&&e.status==='stopped'),
      'Actual Core terminal view changes running status to stopped only after inactive');
    await call('runtime.shutdown');
    await rejects(()=>call('action.workingOpen',{actionID,operationID:nextOperation}),'unavailable','Shutdown clears owner and session');
    return {passed:true,modelCalls:false,realCredentials:false,nativeProviderCalls:providerCalls,
      ackDelayMS,activeRevision,inactiveRevision,checks};
  }finally{
    uiRelease.resolve();guardianRelease.resolve();for(const actor of actors)actor.release.resolve();
    try{await call('runtime.shutdown');}finally{
      globalThis.__almaPlatformCall=native;originalExports.AppActions.prototype.workingView=originalView;
      LatestAppNotifications.prototype.publish=originalPublish;
    }
  }
}};
