import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MobileProviderAdapter } from '../provider.js';
import { nativeCall } from '../bridge.js';
import { CodexGuestAdapterV1 } from './guest-adapter.js';
import { resolveCodexNativeProfile } from '../../upstream/providers/codex/adapter/src/native-profile.js';
import { assertInitializeReceipt, assertAccountReceipt, parseModelPage } from './receipts.js';
import { projectCodexAccountUsage } from '../../upstream/providers/codex/adapter/src/account-usage.js';
import { CodexAppServerRPCErrorV1, CodexAppServerTransportErrorV1 } from '../../upstream/providers/codex/adapter/src/process-facade.js';
import { NormalizedEventLedgerV1, normalizedEventSchema } from '../../upstream/src/contract/events.js';
import { parseFrozenAttempt, compareCanonicalUTF8V1 } from '../../upstream/src/contract/index.js';
import { catalogSchema, AuthOperationError } from '../../upstream/src/auth-prototype/protocol.js';
import type { CodexAppServerConnectionV1 } from '../../upstream/providers/codex/adapter/src/process-facade.js';
import type { BuiltAttemptV1 } from '../../upstream/src/framework/attempt-builders.js';

const sha=(data:string|Uint8Array)=>createHash('sha256').update(data).digest('hex');
const scopeSchema=z.strictObject({handle:z.string().uuid(),workspaceRoot:z.string().startsWith('/workspace/'),scratchRoot:z.string().startsWith('/workspace/'),controllerHome:z.string().startsWith('/')});
const captureSchema=z.strictObject({scopeID:z.string().uuid(),quiescent:z.literal(true),entries:z.array(z.strictObject({relativePath:z.string(),kind:z.enum(['file','directory']),byteLength:z.number().int().nonnegative().nullable(),base64:z.string().nullable()})).max(512)});

function assertClosed(receipt:any) {
  if(receipt?.kind!=='in_process'||receipt.runtimeClosed!==true||receipt.requestsJoined!==true||receipt.eventsRetained!==true||receipt.scopeQuiescent!==true)throw new AuthOperationError('cleanup');
}
function serializeInput(built:BuiltAttemptV1) {
  parseFrozenAttempt(built.attempt);
  const files=[...built.attempt.workspace.materials,...built.attempt.workspace.candidateSeeds.filter(s=>s.kind==='file')].sort((a,b)=>compareCanonicalUTF8V1(a.relativePath,b.relativePath));
  if(files.length!==built.inputBytes.size)throw new Error('Unexpected input files');
  return files.map(meta=>{const bytes=built.inputBytes.get(meta.relativePath);if(!bytes||bytes.byteLength!==meta.byteLength||sha(bytes)!==meta.sha256)throw new Error('Frozen input identity mismatch');return {relativePath:meta.relativePath,base64:Buffer.from(bytes).toString('base64')};});
}

/** Platform config conversion stays inside the Codex Adapter. Native scope
 * enforcement independently checks these exact roots and environment values. */
export function mobileNativeProfile(built:BuiltAttemptV1,workspaceRoot:string,scratchRoot:string) {
  const p=resolveCodexNativeProfile(built.attempt,workspaceRoot),config=structuredClone(p.threadConfig) as any;
  const filesystem:Record<string,string>={'/':'deny','/bin':'read','/sbin':'read','/usr':'read','/lib':'read','/etc':'read',[workspaceRoot]:'read',[scratchRoot]:'write','/dev':'write','/proc':'read'};
  for(const root of p.writableRoots)filesystem[root]='write';
  config.permissions={[p.permissionProfileID]:{filesystem,network:{enabled:false}}};
  config.shell_environment_policy={inherit:'none',ignore_default_excludes:false,set:{PATH:'/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',HOME:`${scratchRoot}/home`,TMPDIR:scratchRoot,LANG:'C.UTF-8',LC_ALL:'C.UTF-8',SHELL:'/bin/bash',BASH_ENV:'/dev/null',ENV:'/dev/null'}};
  // Preserve the native base feature policy. Codex 0.166 may select its required
  // Code Mode mechanism from model metadata; the host supplies that runtime.
  const runtimeWritableRoots=Object.keys(filesystem).filter(path=>filesystem[path]==='write').sort(compareCanonicalUTF8V1);
  return Object.freeze({...p,threadConfig:config,runtimeWritableRoots});
}

export const mobileCodexProvider:MobileProviderAdapter={
  id:'codex',
  async authenticate(context){
    if(context.providerID!=='codex')throw new AuthOperationError('protocol');
    // Native inspection performs account/model/quota calls with the existing
    // same-App Keychain. Only a revocable opaque handle reaches trusted JS.
    const receipt=await nativeCall<any>('provider.codex.inspect',{kind:context.kind,credentialHandle:context.credential?Buffer.from(context.credential).toString('utf8'):null});
    if(context.signal.aborted)throw new DOMException('Aborted','AbortError');
    assertClosed(receipt.closed);
    assertInitializeReceipt(receipt.initialize,receipt.controllerHome);
    assertAccountReceipt(receipt.account);
    const models:any[]=[];let defaultModelHandle:string|null=null;
    if(!Array.isArray(receipt.modelPages)||receipt.modelPages.length<1||receipt.modelPages.length>16)throw new AuthOperationError('protocol');
    for(const page of receipt.modelPages){for(const m of parseModelPage(page).models){
      if(m.isDefault===true){if(defaultModelHandle!==null)throw new AuthOperationError('protocol');defaultModelHandle=String(m.model??m.id);}
      if(!Array.isArray(m.supportedReasoningEfforts))throw new AuthOperationError('protocol');
      models.push({handle:m.model??m.id,displayName:m.displayName,efforts:m.supportedReasoningEfforts.map((e:any)=>({handle:e.reasoningEffort,displayName:e.description??e.reasoningEffort})),defaultEffortHandle:m.defaultReasoningEffort??null});
    }}
    const catalog=catalogSchema.parse({models,defaultModelHandle});
    const credential=Buffer.from(z.uuid().parse(receipt.credentialHandle),'utf8');
    const accountUsage=projectCodexAccountUsage(receipt.quota);
    return {state:'valid',credential,account:receipt.account.account.email??null,catalog,catalogUnavailable:false,accountUsage,accountUsageUnavailable:accountUsage===null};
  },
  async run(built,credential,onEvent,signal){
    const scope=scopeSchema.parse(await nativeCall('provider.codex.prepare',{attempt:built.attempt,inputFiles:serializeInput(built),credentialHandle:Buffer.from(credential).toString('utf8')}));
    const call=<T=any>(operation:string,value:object={})=>nativeCall<T>(`provider.codex.${operation}`,{handle:scope.handle,...value});
    const profile=mobileNativeProfile(built,scope.workspaceRoot,scope.scratchRoot);
    const ledger=new NormalizedEventLedgerV1(built.attempt.attemptID);
    let sequence=0,eventTail=Promise.resolve(),eventError:unknown,closeReceipt:any;
    const connection:CodexAppServerConnectionV1={
      async request(method,params){
        const result=await call('request',{method,params});
        if(result.error)throw new CodexAppServerRPCErrorV1(result.error.code,result.error.data,method);
        if(!Object.hasOwn(result,'value'))throw new CodexAppServerTransportErrorV1('invalid_message');return result.value;
      },
      async notify(method,params){await call('notify',{method,params:params??null});},
      async *events(){for(;;){const result=await call('nextEvent');if(result.done)return;yield result.event;}},
      async close(){closeReceipt??=await call('close');assertClosed(closeReceipt);return closeReceipt;},
    };
    const adapter=new CodexGuestAdapterV1({executablePath:'/opt/alma/provider/codex/bin/codex',workspaceRoot:scope.workspaceRoot,
      // Native in_process does not construct the standalone daemon's remote
      // control service. Do not fabricate that service's disabled notification.
      requiresRemoteControlStatus:false,
      auth:{home:scope.controllerHome,
        async install(handle){const bytes=handle?.consume();try{if(!bytes)throw new AuthOperationError('auth_invalid');await call('authBind',{credentialHandle:Buffer.from(bytes).toString('utf8')});}finally{bytes?.fill(0);}},
        async verifyBeforeTurn(){await call('authVerify');},async removeBeforeTurn(){await call('authSeal');},async removeAfterProcessExit(){await call('authRelease');}},
      appServer:{async start(){await call('start',{profile});return connection;}},resolveProfile:()=>profile,assertRuntimeReceipt:assertInitializeReceipt,assertClosed});
    let consumed=false;
    try{
      const terminal=await adapter.run({attempt:built.attempt,signal,credential:{byteLength:credential.byteLength,consume(){if(consumed)throw new Error('Credential already borrowed');consumed=true;return Uint8Array.from(credential);}},
        workspace:{listMaterials:()=>built.attempt.workspace.materials,readMaterial:path=>{const b=built.inputBytes.get(path);if(!b)throw new Error('Unknown material');return Uint8Array.from(b);},putCandidate(){throw new Error('Qualification-only workspace writer is not enabled');}},
        emit:event=>{const e=normalizedEventSchema.parse({...event,attemptID:built.attempt.attemptID,sequence:++sequence});ledger.observe(e);eventTail=eventTail.then(()=>onEvent?.(e)).then(()=>{},error=>{eventError??=error;});}});
      await eventTail;if(eventError)throw eventError;ledger.assertTerminal(terminal);
      if(terminal.kind==='failed'&&terminal.failure.family==='cleanup')throw new AuthOperationError('cleanup');
      assertClosed(closeReceipt);
      const capture=captureSchema.parse(await call('capture'));
      if(capture.scopeID!==scope.handle)throw new Error('Candidate scope mismatch');
      const files=new Map<string,Uint8Array>();let total=0;
      const manifest=capture.entries.map(entry=>{
        if(entry.kind==='file'){
          if(entry.base64===null||files.has(entry.relativePath))throw new Error('Invalid candidate file');
          const bytes=Buffer.from(entry.base64,'base64');total+=bytes.byteLength;
          if(bytes.toString('base64')!==entry.base64||bytes.byteLength!==entry.byteLength||total>64*1024*1024)throw new Error('Candidate bytes mismatch');
          files.set(entry.relativePath,bytes);
        }
        return {relativePath:entry.relativePath,kind:entry.kind,byteLength:entry.byteLength};
      });
      return {terminal,candidateManifest:manifest,candidateFiles:files};
    }finally{await call('release');}
  },
};
