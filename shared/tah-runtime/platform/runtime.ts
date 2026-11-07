import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { AppActions } from '../upstream/src/app-runtime/actions.js';
import { AppBridgeError, type AppRuntimeBridge } from '../upstream/src/app-runtime/bridge.js';
import { appAuthSnapshot } from '../upstream/src/app-runtime/auth-projection.js';
import { isAppModelAllowed } from '../upstream/src/app-runtime/model-policy.js';
import { ServiceJournal, prepareJournalWrite } from '../upstream/src/app-runtime/journal.js';
import { LatestAppNotifications } from '../upstream/src/app-runtime/notifications.js';
import { transcriptMaterialSchema } from '../upstream/src/app-runtime/raw-safety.js';
import { AuthService } from '../upstream/src/auth-prototype/service.js';
import type { AuthStorage, AuthRecord } from '../upstream/src/auth-prototype/storage.js';
import { BoundedTahHostOperationSchedulerV1 } from '../upstream/src/host/operation-scheduler.js';
import type { AppProviderProfile } from '../upstream/src/app-runtime/attempt-port.js';
import { nativeCall } from './bridge.js';
import { mobileAttemptPort } from './attempt-port.js';
import type { MobileProviderAdapter } from './provider.js';
import { WorkingStream, type WorkingViewSource } from './working-stream.js';

// The bundle applies the documented, hash-checked optional observer seam to
// AppActions, plus its synchronous scoped Working memory accessor.
const ObservedAppActions=AppActions as unknown as new (
  ...args:[...ConstructorParameters<typeof AppActions>, onRawSafetyChanged?:()=>void]
)=>AppActions & WorkingViewSource;

const id=z.uuid(), empty=z.strictObject({});
const configSchema=z.strictObject({profiles:z.array(z.strictObject({id:z.enum(['codex','qoder','kimi','zcode']),displayName:z.string(),authRouteID:z.string(),taskRouteID:z.string(),guardianModel:z.string(),guardianEffort:z.string(),disabledModels:z.array(z.string()),allowedModels:z.array(z.string()).optional(),profileIdentity:z.string().regex(/^[a-f0-9]{64}$/)})).min(1),
  resources:z.strictObject({actorPromptTemplate:z.string(),rawGuardianPrompt:z.string(),extraGuardianPrompt:z.string(),safetyPolicy:z.string()}),actionInstructions:z.string()});

/** iOS composition root. No role ordering, policy decisions, receipt acceptance,
 * revision merge, or publication is implemented here: those remain Mac core code. */
export function createMobileRuntime(adapters: ReadonlyMap<string,MobileProviderAdapter>) {
  const scheduler=new BoundedTahHostOperationSchedulerV1();
  let auth:AuthService|undefined,actions:(AppActions & WorkingViewSource)|undefined,profiles:readonly AppProviderProfile[]=[];
  let initialized=false,sourceRevision=0;const sourceID=randomUUID();
  const snapshot=()=>{if(!auth)throw new AppBridgeError('unavailable');return {...appAuthSnapshot(auth.snapshot(),profiles),sourceID,sourceRevision:++sourceRevision};};
  let notificationClosed=false;
  const bridge={call:nativeCall,close:()=>{
    if(notificationClosed)return;notificationClosed=true;
    workingStream.clear();rawNotifications.close();void actions?.close();
    void nativeCall('ui.runtimeFailed',{code:'unavailable'}).catch(()=>{});
  }} as AppRuntimeBridge;
  let rawRevision=0;
  const rawNotifications=new LatestAppNotifications(value=>nativeCall('ui.rawChanged',value),()=>bridge.close());
  const journal=new ServiceJournal(bridge);
  const storage:AuthStorage={load:()=>nativeCall<AuthRecord>('credential.load',{}),save:record=>nativeCall<void>('credential.save',{record}),reset:providerID=>nativeCall<void>('credential.reset',{providerID}),close:async()=>{}};
  const required=()=>{if(!actions)throw new AppBridgeError('unavailable');return actions;};
  const workingStream=new WorkingStream(required);
  const handlers:Record<string,(v:any)=>Promise<unknown>>={
    'runtime.initialize':async value=>{
      if(initialized)throw new AppBridgeError('busy');const config=configSchema.parse(value);
      if(config.profiles.some(p=>!adapters.has(p.id)))throw new AppBridgeError('unavailable');
      initialized=true;profiles=config.profiles;
      auth=new AuthService(storage,context=>scheduler.schedule({declaredInputBytes:0,signal:context.signal,run:signal=>adapters.get(context.providerID)!.authenticate({...context,signal})}),
        (provider,catalog)=>{const p=profiles.find(p=>p.id===provider);return !!p&&catalog.models.some(m=>isAppModelAllowed(p,m.handle))&&catalog.models.some(m=>m.handle===p.guardianModel&&m.efforts.some(e=>e.handle===p.guardianEffort));});
      await auth.initialize();
      const selected = auth.snapshot().providerID;
      if (selected) await adapters.get(selected)?.prepare?.();
      // The build's hash-checked observation seam adds only this optional callback.
      // It fires after Core changes Raw state, particularly after terminal cleanup;
      // a store commit ACK alone is too early to infer that checking has finished.
      actions=new ObservedAppActions(bridge,auth,profiles,scheduler,config.resources,config.actionInstructions,mobileAttemptPort(auth,scheduler,profiles,adapters),
        ()=>rawNotifications.publish('raw',{sourceID,sourceRevision:++rawRevision}));
      auth.observe(()=>{void nativeCall('ui.auth',snapshot()).catch(()=>{});});
      if(auth.snapshot().state==='valid')await auth.inspect();
      return snapshot();
    },
    'auth.snapshot':async v=>{empty.parse(v);return snapshot();},
    'auth.inspect':async v=>{empty.parse(v);if(required().busy)throw new AppBridgeError('busy');await auth!.inspect();return snapshot();},
    'auth.select':async v=>{const input=z.strictObject({providerID:z.enum(['codex','qoder','kimi','zcode'])}).parse(v);if(!profiles.some(p=>p.id===input.providerID))throw new AppBridgeError('invalid_request');await auth!.select(input.providerID);await adapters.get(input.providerID)?.prepare?.();return snapshot();},
    'auth.authorize':async v=>{empty.parse(v);await auth!.authorize();return snapshot();},
    'auth.cancel':async v=>{empty.parse(v);await auth!.cancel();return snapshot();},
    'auth.replacement':async v=>{
      const input=z.strictObject({kind:z.enum(['switch_provider','switch_account','reauth','sign_out']),providerID:z.enum(['codex','qoder','kimi','zcode']).optional()}).parse(v);
      if(input.providerID&&!profiles.some(p=>p.id===input.providerID))throw new AppBridgeError('invalid_request');
      await auth!.requestReplacement(input.kind,input.providerID);return snapshot();
    },
    'auth.confirm':async v=>{const input=z.strictObject({id,confirmed:z.boolean()}).parse(v);await auth!.confirmReplacement(input.id,input.confirmed);const selected=auth!.snapshot().providerID;if(selected)await adapters.get(selected)?.prepare?.();return snapshot();},
    'material.put':async v=>{
      const {materialID,...value}=z.strictObject({...transcriptMaterialSchema.shape,materialID:id}).parse(v);
      const stream=`material/${materialID}`,existing=await journal.readLast(stream);
      if(existing){if(JSON.stringify(existing.value)!==JSON.stringify(value))throw new AppBridgeError('integrity_locked');}
      else {const {write,bytes}=prepareJournalWrite(stream,`transcript/${value.transcriptID}`,0,'document',value);await journal.append(write,bytes);}
      return {materialID,transcriptID:value.transcriptID};
    },
    'raw.status':async v=>required().rawSafetyStatus(z.strictObject({materialID:id}).parse(v).materialID),
    'raw.check':async v=>required().checkRawSafety(v),
    'raw.cancel':async v=>required().cancelRawSafety(z.strictObject({operationID:id}).parse(v).operationID),
    'action.create':async v=>required().create(v),
    'action.rename':async v=>required().rename(v),
    'action.list':async v=>{const i=z.strictObject({transcriptID:id,cursor:z.string().nullable()}).parse(v);return required().list(i.transcriptID,i.cursor);},
    'action.snapshot':async v=>required().snapshot(z.strictObject({actionID:id}).parse(v).actionID),
    'action.send':async v=>required().send(v),
    'action.cancel':async v=>{empty.parse(v);await required().cancel();return {cancelled:true};},
    'action.retry':async v=>{const i=z.strictObject({actionID:id,operationID:id}).parse(v);return required().retry(i.actionID,i.operationID);},
    'action.reedit':async v=>{const i=z.strictObject({actionID:id,operationID:id}).parse(v);return required().reedit(i.actionID,i.operationID);},
    'action.conversation':async v=>{const i=z.strictObject({actionID:id,cursor:z.string().nullable()}).parse(v);return required().conversation(i.actionID,i.cursor);},
    'action.conversationText':async v=>{const i=z.strictObject({actionID:id,position:z.number().int().positive(),offset:z.number().int().nonnegative()}).parse(v);return required().conversationText(i.actionID,i.position,i.offset);},
    'action.workingOpen':async v=>workingStream.open(v),
    'action.workingNext':async v=>workingStream.next(v),
    'action.workingClose':async v=>workingStream.close(v),
    'action.workingText':async v=>{const i=z.strictObject({actionID:id,position:z.number().int().positive().nullable(),sha256:z.string().regex(/^[a-f0-9]{64}$/),offset:z.number().int().nonnegative()}).parse(v);return required().workingText(i.actionID,i.position,i.sha256,i.offset);},
    'action.outcome':async v=>{const i=z.strictObject({actionID:id,revisionIndex:z.number().int().nonnegative(),path:z.string(),offset:z.number().int().nonnegative()}).parse(v);return required().outcome(i.actionID,i.revisionIndex,i.path,i.offset);},
    'action.transcriptMaterial':async v=>{const i=z.strictObject({actionID:id,offset:z.number().int().nonnegative()}).parse(v);return required().transcriptMaterial(i.actionID,i.offset);},
    'runtime.shutdown':async v=>{empty.parse(v);workingStream.clear();rawNotifications.close();await actions?.close();await auth?.close();await scheduler.close();return {stopped:true};},
  };
  return {async invoke(method:string,value:unknown){const h=Object.hasOwn(handlers,method)?handlers[method]:undefined;if(!h)throw new AppBridgeError('invalid_request');return h(value);}};
}
