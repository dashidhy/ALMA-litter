// Deliberate model-free replay. This validates the real Framework/AppActions,
// JSCore platform, and original SQLite publisher; it is not phone/LLM acceptance.
const liveRuntime=AlmaMobileRuntime;
globalThis.AlmaMobileRuntime={async invoke(method,input){
  if(method!=='proof')throw new Error('Unexpected method');
  const calls=[],credential=Buffer.from('00000000-0000-4000-8000-000000000009');let fixtureError=null;
  const provider={id:'codex',async authenticate(){return {state:'valid',credential:Uint8Array.from(credential),account:'Synthetic replay',catalog:{models:[{handle:'gpt-5.6-luna',displayName:'Replay fixture',efforts:[{handle:'low',displayName:'Low'}],defaultEffortHandle:'low'}],defaultModelHandle:'gpt-5.6-luna'},catalogUnavailable:false,accountUsage:{planLabel:'Replay fixture',buckets:[{id:'test',label:'Fixture',remainingPercent:100,quantity:null,period:null,unlimited:false,exhausted:false}],summaryBucketIDs:['test'],exhausted:false},accountUsageUnavailable:false};},
    async run(built,bytes,emit,signal){
      if(signal.aborted)throw new Error('Replay unexpectedly cancelled');
      const role=built.attempt.role;calls.push({role,inference:built.attempt.inference,web:built.attempt.requiredAbilities.includes('web')});
      const text=role==='actor'?'Recorded candidate replay.':JSON.stringify({decision:'ALLOW',reasonCodes:[],explanation:'Synthetic fixture allowed.'});
      const messageID='replay-final';let sequence=0;
      // Exercise real public-log collection and multi-chunk UTF-8 reads, while
      // keeping this a model-free replay and the accepted outcome bytes fixed.
      const commentaryID='replay-working';
      const commentary=role==='actor'?'Synthetic progress — 原文核对。\n'.repeat(3000):'PRIVATE_GUARDIAN_REPLAY';
      for(const e of [{kind:'message_started',messageID:commentaryID,role:'commentary'},
        {kind:'message_delta',messageID:commentaryID,text:commentary},
        {kind:'message_completed',messageID:commentaryID}])await emit?.({...e,attemptID:built.attempt.attemptID,sequence:++sequence});
      for(const e of [{kind:'message_started',messageID,role:'final_answer'},{kind:'message_delta',messageID,text},{kind:'message_completed',messageID}])await emit?.({...e,attemptID:built.attempt.attemptID,sequence:++sequence});
      const files=new Map(),manifest=[];
      if(role==='actor'){
        const root=built.attempt.workspace.writableRoots[0],version=Number(root.match(/revision_v(\d+)$/)[1]);
        for(const name of Object.keys(input.revisions[version]).sort()){const encoded=input.revisions[version][name],path=`${root}/${name}`,bytes=Buffer.from(encoded,'base64');files.set(path,bytes);manifest.push({relativePath:path,kind:'file',byteLength:bytes.length});}
      }
      if(role==='actor')try{AlmaTAH.buildCandidateOutcomeV1(built.attempt.workspace.writableRoots[0],manifest,files);}catch(error){fixtureError=String(error);throw error;}
      return {terminal:{kind:'end_turn',finalMessageID:messageID,finalText:text},candidateManifest:manifest,candidateFiles:files};
    }};
  const runtime=AlmaTAH.createMobileRuntime(new Map([['codex',provider]]));
  const call=(m,v={})=>runtime.invoke(m,v),uid=()=>__almaUUID();
  async function until(fn,predicate){for(let n=0;n<1000;n++){const v=await fn();if(predicate(v))return v;await new Promise(r=>setTimeout(r,2));}throw new Error('Replay timed out');}
  await call('runtime.initialize',input.config);
  await call('auth.select',{providerID:'codex'});await call('auth.authorize');
  await until(()=>call('auth.snapshot'),s=>s.inspection?.state==='succeeded'&&!s.inspecting&&s.phase==='idle');
  const transcriptID=uid(),materialID=uid(),actionID=uid();
  await call('material.put',{transcriptID,materialID,title:'Replay fixture',rawTranscript:input.transcript});
  await call('raw.check',{materialID,operationID:uid(),consent:true,interactionLanguage:'en'});
  const raw=await until(()=>call('raw.status',{materialID}),s=>!s.busy);
  if(raw.state!=='allowed')throw new Error(`Raw replay failed: ${JSON.stringify(raw)}`);
  await call('action.create',{actionID,materialID,language:'en'});
  const outcomes=[],workingLogs=[];
  async function readLog(position,sha256){
    let bytes=Buffer.alloc(0),total,parts=0;
    do{
      const chunk=await call('action.workingText',{actionID,position,sha256,offset:bytes.length});
      const part=Buffer.from(chunk.data,'base64');
      if(part.length>48*1024||chunk.totalBytes>4*1024*1024||(total!==undefined&&total!==chunk.totalBytes)||(!part.length&&chunk.totalBytes))throw new Error('Invalid working-log chunk');
      total=chunk.totalBytes;bytes=Buffer.concat([bytes,part]);parts++;
    }while(bytes.length<total);
    if(bytes.length!==total||__almaSHA256(bytes.toString('base64'))!==sha256)throw new Error('Working-log hash mismatch');
    const text=bytes.toString('utf8'),log=JSON.parse(text);
    if(log.schemaVersion!==1||text.includes('PRIVATE_GUARDIAN_REPLAY')||!log.events.some(e=>e.role==='actor')||parts<2)throw new Error('Working-log public/multichunk failure');
    return {sha256,parts,bytes:total};
  }
  for(let version=0;version<3;version++){
    await until(()=>call('auth.snapshot'),s=>s.inspection?.state==='succeeded'&&!s.inspecting&&s.phase==='idle');
    await call('action.send',{actionID,operationID:uid(),instructions:input.deltas[version],inference:{modelID:'gpt-5.6-luna',reasoningEffortID:version===1?null:'low'},interactionLanguage:version===2?'zh-CN':'en',initialLanguage:'en',grantWeb:version===1,consent:true,expectedProviderID:'codex'});
    const state=await until(()=>call('action.snapshot',{actionID}),s=>!['running','preparing','actor','critic','extra_guardian','saving_safety','saving'].includes(s.phase)&&s.editorMode!=='running');
    if(state.revisions.length!==version+1)throw new Error(`Revision ${version} failed: ${fixtureError} ${JSON.stringify(state)}`);
    for(const name of ['structured-notes.md','suspicious-asr-terms.md']){
      const result=await call('action.outcome',{actionID,revisionIndex:version,path:name,offset:0});
      if(result.data!==input.revisions[version][name])throw new Error('Published output drift');
    }
    outcomes.push({revision:version,language:state.language,phase:state.phase,revisions:state.revisions.length});
    const page=await call('action.conversation',{actionID,cursor:null});
    const row=page.items.find(item=>item.revisionIndex===version&&item.isFinalAnswer);
    if(!row?.presentation?.workingLogSHA256)throw new Error('Completed log descriptor missing');
    const proof=await readLog(row.position,row.presentation.workingLogSHA256);
    let rejected=false;
    try{await call('action.workingText',{actionID,position:row.position,sha256:'0'.repeat(64),offset:0});}catch(error){rejected=error.code==='busy';}
    if(!rejected)throw new Error('Wrong working-log hash was not rejected');
    workingLogs.push({revision:version,position:row.position,...proof,wrongHashRejected:true});
  }
  await readLog(workingLogs[0].position,workingLogs[0].sha256);
  const history=await call('action.conversation',{actionID,cursor:null});
  await call('runtime.shutdown');
  return {passed:true,modelCalls:false,hostOnly:true,calls,outcomes,workingLogs,previousLogStillReadable:true,historyItems:history.items?.length??history.messages?.length??null};
}};
