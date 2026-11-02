import {createHash} from "node:crypto";
import {z} from "zod";
import type {AuthService} from "../auth-prototype/service.js";
import type {TahWorkflowCoordinatorV1, TahWorkflowResourcesV1} from "../framework/workflow.js";
import {parseRawGuardianAssessmentV2} from "../framework/guardian-assessment.js";
import {AppBridgeError} from "./bridge.js";
import type {AppDocuments} from "./documents.js";
import type {AppProviderProfile} from "./attempt-port.js";
import {authorizationCheckSucceeded} from "../auth-prototype/inspection.js";

export const CONTENT_CONSENT_VERSION = "tah-v4.2-content-v1";
export const contentConsentSchema = z.strictObject({accepted:z.boolean(), recordedAt:z.iso.datetime().optional()});
export const transcriptMaterialSchema = z.strictObject({transcriptID:z.uuid(), title:z.string().max(512), rawTranscript:z.string().min(1).max(32*1024*1024)});
export const rawReceiptSchema = z.strictObject({key:z.string(), checkedAt:z.number().finite(), allowed:z.boolean(), assessment:z.unknown(), interactionLanguage:z.enum(["en","zh-CN"]).optional()});
export const rawCheckSchema = z.strictObject({operationID:z.uuid(), phase:z.enum(["checking","completed","failed","cancelled","integrity_locked"]), errorCode:z.string().nullable()});
export const RAW_SAFETY_TTL_MS = 60*24*60*60_000;
type Material = z.infer<typeof transcriptMaterialSchema>;
type Receipt = z.infer<typeof rawReceiptSchema>;
type Phase = "unchecked"|"checking"|"allowed"|"blocked"|"expired"|"failed"|"cancelled"|"unavailable"|"integrity_locked";
export interface RawSafetyStatus {
  materialID:string; providerID:string|null; state:Phase; busy:boolean; activeCheckID:string|null;
  consentGranted:boolean; checkedAt:string|null; expiresAt:string|null;
  explanation:string|null; interactionLanguage:"en"|"zh-CN"|null; reasonCodes:readonly string[]; errorCode:string|null;
}

/** Transcript/Provider preflight. Reads never start inference. A check runs only
 * after explicit consent and a user command; receipts are independent of Actions. */
export class RawSafetyPreflight {
  #active: {key:string; materialID:string; transcriptID:string; operationID:string; controller:AbortController; task:Promise<void>} | null = null;
  constructor(private readonly documents:AppDocuments, private readonly auth:AuthService,
    private readonly profiles:readonly AppProviderProfile[], private readonly workflow:TahWorkflowCoordinatorV1,
    private readonly resources:TahWorkflowResourcesV1, private readonly actionBusy:()=>boolean,
    private readonly changed:()=>void, private readonly now:()=>number = Date.now) {}
  get busy() { return this.#active !== null; }
  get transcriptID() { return this.#active?.transcriptID; }
  async material(id:string):Promise<Material> {
    const value=await this.documents.last(`material/${z.uuid().parse(id)}`,transcriptMaterialSchema);
    if(!value)throw new AppBridgeError("invalid_request"); return value;
  }
  #profile() { const id=this.auth.snapshot().providerID; return this.profiles.find(p=>p.id===id); }
  #key(material:Material,profile:AppProviderProfile) {
    // Keep the existing cache identity so previously verified unchanged material
    // does not need another model call just because preflight moved into the UI.
    return createHash("sha256").update(JSON.stringify({providerID:profile.id,profileIdentity:profile.profileIdentity,
      guardianModel:profile.guardianModel,guardianEffort:profile.guardianEffort,
      raw:material.rawTranscript,prompt:this.resources.rawGuardianPrompt,policy:this.resources.safetyPolicy})).digest("hex");
  }
  #stream(material:Material,key:string) { return `raw/${material.transcriptID}/${key}`; }
  #checkStream(material:Material,key:string) { return `raw-check/${material.transcriptID}/${key}`; }
  #consentStream(profile:AppProviderProfile) { return `consent/${profile.id}/${profile.profileIdentity}/${CONTENT_CONSENT_VERSION}`; }
  #valid(receipt:Receipt) { const age=this.now()-receipt.checkedAt; return age>=0&&age<RAW_SAFETY_TTL_MS; }
  async #receipt(material:Material,profile:AppProviderProfile) {
    const key=this.#key(material,profile), receipt=await this.documents.last(this.#stream(material,key),rawReceiptSchema);
    if(receipt) {
      const assessment=parseRawGuardianAssessmentV2(JSON.stringify(receipt.assessment));
      if(receipt.key!==key || receipt.allowed!==(assessment.decision==="ALLOW"))throw new AppBridgeError("integrity_locked");
    }
    return receipt;
  }
  async status(materialID:string):Promise<RawSafetyStatus> {
    const material=await this.material(materialID), profile=this.#profile();
    const result:RawSafetyStatus={materialID,providerID:profile?.id??null,state:"unavailable",busy:this.busy||this.actionBusy(),activeCheckID:this.#active?.operationID??null,
      consentGranted:false,checkedAt:null,expiresAt:null,explanation:null,interactionLanguage:null,reasonCodes:[],errorCode:null};
    if(!profile || this.auth.snapshot().state!=="valid")return result;
    const consent=await this.documents.last(this.#consentStream(profile),contentConsentSchema);
    result.consentGranted=consent?.accepted===true&&consent.recordedAt!==undefined;
    const key=this.#key(material,profile);
    let receipt:Receipt|null;
    try { receipt=await this.#receipt(material,profile); }
    catch { return {...result,state:"integrity_locked",errorCode:"receipt_unavailable"}; }
    if(receipt) {
      result.checkedAt=new Date(receipt.checkedAt).toISOString(); result.expiresAt=new Date(receipt.checkedAt+RAW_SAFETY_TTL_MS).toISOString();
      result.state=this.#valid(receipt)?receipt.allowed?"allowed":"blocked":"expired";
      if(result.state==="allowed"||result.state==="blocked") {
        const assessment=parseRawGuardianAssessmentV2(JSON.stringify(receipt.assessment));
        result.explanation=assessment.explanation;result.reasonCodes=assessment.reasonCodes;result.interactionLanguage=receipt.interactionLanguage??"en";
      }
    } else result.state="unchecked";
    if(this.#active?.key===key) { result.state="checking"; result.explanation=null; result.reasonCodes=[]; result.interactionLanguage=null; }
    else if(!receipt||!this.#valid(receipt)) {
      const check=await this.documents.last(this.#checkStream(material,key),rawCheckSchema);
      if(check&&check.phase!=="completed") {result.state=check.phase==="checking"?"integrity_locked":check.phase;result.errorCode=check.phase==="checking"?"check_interrupted":check.errorCode;}
    }
    return result;
  }
  async requireAllowed(materialID:string) {
    const epoch=this.auth.identityVersion;
    const state=await this.status(materialID);
    if(state.state!=="allowed"||epoch!==this.auth.identityVersion||state.providerID!==this.auth.snapshot().providerID)throw new AppBridgeError("invalid_request");
    return state;
  }
  async start(input:{materialID:string;operationID:string;consent:boolean;interactionLanguage:"en"|"zh-CN"}) {
    z.uuid().parse(input.operationID);
    if(this.#active?.operationID===input.operationID) {
      if(this.#active.materialID!==input.materialID)throw new AppBridgeError("integrity_locked");
      return this.status(input.materialID);
    }
    if(!authorizationCheckSucceeded(this.auth.snapshot()))throw new AppBridgeError("unavailable");
    if(this.busy||this.actionBusy()||this.auth.snapshot().inspecting)throw new AppBridgeError("busy");
    const epoch=this.auth.identityVersion, material=await this.material(input.materialID), profile=this.#profile();
    if(!profile || this.auth.snapshot().state!=="valid" || this.auth.snapshot().phase!=="idle")throw new AppBridgeError("unavailable");
    const state=await this.status(input.materialID);
    const prior=await this.documents.last(this.#checkStream(material,this.#key(material,profile)),rawCheckSchema);
    if(prior?.operationID===input.operationID)return state;
    if(state.state==="allowed"||state.state==="blocked")return state;
    if(state.state==="integrity_locked")throw new AppBridgeError("integrity_locked");
    if(!state.consentGranted&&!input.consent)throw new AppBridgeError("invalid_request");
    if(this.busy||this.actionBusy()||epoch!==this.auth.identityVersion)throw new AppBridgeError("busy");
    const key=this.#key(material,profile), controller=new AbortController();
    const active={key,materialID:input.materialID,transcriptID:material.transcriptID,operationID:input.operationID,controller,task:Promise.resolve()};
    this.#active=active;this.changed();
    active.task=(async()=>{
      const signal=controller.signal, stream=this.#checkStream(material,key), owner=`transcript/${material.transcriptID}`;
      try {
        await this.documents.save(stream,owner,{operationID:input.operationID,phase:"checking",errorCode:null},signal);
        if(!state.consentGranted)await this.documents.save(this.#consentStream(profile),"preferences",{accepted:true,recordedAt:new Date(this.now()).toISOString()},signal);
        const auth=this.auth.snapshot();
        if(!authorizationCheckSucceeded(auth))throw new AppBridgeError("unavailable");
        if(signal.aborted||epoch!==this.auth.identityVersion||auth.state!=="valid"||auth.providerID!==profile.id)throw new AppBridgeError("cancelled");
        if(!auth.catalog?.models.some(m=>m.handle===profile.guardianModel&&m.efforts.some(e=>e.handle===profile.guardianEffort)))throw new AppBridgeError("unavailable");
        const verdict=await this.workflow.runRawSafety({providerID:profile.id,guardianInference:{modelID:profile.guardianModel,reasoningEffortID:profile.guardianEffort},
          interactionLanguage:input.interactionLanguage,rawTranscript:material.rawTranscript,resources:this.resources,signal});
        if(verdict.kind==="allow"||verdict.kind==="block") {
          if(signal.aborted||epoch!==this.auth.identityVersion)throw new AppBridgeError("cancelled");
          await this.documents.save(this.#stream(material,key),owner,{key,checkedAt:this.now(),allowed:verdict.kind==="allow",assessment:verdict.assessment,interactionLanguage:input.interactionLanguage},signal);
          await this.documents.save(stream,owner,{operationID:input.operationID,phase:"completed",errorCode:null},signal);
        } else throw new AppBridgeError(verdict.kind==="integrity_locked"?"integrity_locked":verdict.kind==="cancelled"?"cancelled":"unavailable");
      } catch(error) {
        const integrity=error instanceof AppBridgeError&&error.code==="integrity_locked";
        await this.documents.save(stream,owner,{operationID:input.operationID,phase:integrity?"integrity_locked":signal.aborted?"cancelled":"failed",
          errorCode:integrity?"cleanup_unconfirmed":signal.aborted?"check_cancelled":"check_unavailable"},undefined,signal);
      }
    })().catch(()=>{}).finally(()=>{if(this.#active===active){this.#active=null;this.changed();}});
    return this.status(input.materialID);
  }
  async cancel(operationID?:string) {
    const active=this.#active;
    if(active&&(operationID===undefined||operationID===active.operationID)){active.controller.abort();await active.task;}
  }
}
