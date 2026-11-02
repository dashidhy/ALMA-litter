globalThis.AlmaMobileRuntime={async invoke(method,input){
  if(method!=='proof')throw new Error('Unexpected proof method');
  const definition=AlmaTAH.createStructuredNotesActionDefinitionV1(input.action);
  const raw=AlmaTAH.buildRawGuardianAttemptV1({attemptID:'00000000-0000-4000-8000-000000000001',providerID:'codex',inference:{modelID:'gpt-5.6-luna',reasoningEffortID:'low'},guardianPrompt:input.guardian,safetyPolicy:input.policy,rawTranscript:input.transcript,interactionLanguage:'zh-CN'});
  const encoded=Buffer.from(input.transcript).toString('base64url');
  if(Buffer.from(encoded,'base64url').toString()!==input.transcript)throw new Error('base64url mismatch');
  const echo=await __almaPlatformCall('proof.echo',{unicode:input.transcript});
  await new Promise(resolve=>setTimeout(resolve,1));
  const controller=new AbortController();let aborted=false;controller.signal.addEventListener('abort',()=>{aborted=true;},{once:true});controller.abort();
  return {definition:definition.definitionDigest,language:definition.renderActionInstructions('zh-CN','en'),raw:raw.attempt,files:[...raw.inputBytes].map(([path,bytes])=>({path,base64:Buffer.from(bytes).toString('base64')})),echo,aborted};
}};
