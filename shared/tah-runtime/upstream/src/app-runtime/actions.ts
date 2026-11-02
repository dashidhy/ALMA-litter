import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { AppBridgeError, type AppRuntimeBridge } from "./bridge.js";
import { AppDocuments } from "./documents.js";
import { DurableTahPersistence } from "./durable-persistence.js";
import { ServiceJournal, prepareJournalWrite } from "./journal.js";
import { serviceAttemptPort, type AppProviderProfile } from "./attempt-port.js";
import { AuthService } from "../auth-prototype/service.js";
import { authorizationCheckSucceeded } from "../auth-prototype/inspection.js";
import { BoundedTahHostOperationSchedulerV1 } from "../host/operation-scheduler.js";
import { LivenessTahAttemptPortV1 } from "../framework/liveness-attempt-port.js";
import { createStructuredNotesActionDefinitionV1 } from "../framework/action-definition.js";
import { frozenAttemptSchema, type NormalizedEventV1 } from "../contract/index.js";
import { TahWorkflowCoordinatorV1, type RevisionCycleResultV1, type TahWorkflowResourcesV1, type TahAttemptScopeV1, type TahFrameworkAttemptPortV1 } from "../framework/workflow.js";
import { readCandidateOutcomeFileV1 } from "../framework/outcome-contract.js";
import type { UserInstructionLedgerV1 } from "../framework/user-instructions.js";
import { parseRawGuardianAssessmentV1, parseRawGuardianAssessmentV2 } from "../framework/guardian-assessment.js";
import { restoredActionPhase } from "./recovery.js";
import { conversationPage, publicConversation } from "./conversation.js";
import { submissionAlreadyRecorded, submissionDigest } from "./submission.js";
import { LatestAppNotifications } from "./notifications.js";
import { stableSnapshot } from "./stable-snapshot.js";
import { AppPresentationTracker, appPresentationSchema, canReadWorkingLog, publicPresentation, MAX_WORKING_LOG_BYTES } from "./presentation.js";
import { safetyReasonCodes, safetyExplanation, safetyExplanationsSchema } from "./safety-presentation.js";
import {RawSafetyPreflight, rawReceiptSchema, rawCheckSchema, CONTENT_CONSENT_VERSION, contentConsentSchema} from "./raw-safety.js";
import {WorkingLogReadCache} from "./working-log-cache.js";
import {isAppModelAllowed} from "./model-policy.js";

const identity = z.string().uuid().transform(value => value.toLowerCase());
const inference = frozenAttemptSchema.shape.inference;
const materialSchema = z.strictObject({ transcriptID: identity, title: z.string().max(512), rawTranscript: z.string().min(1).max(32 * 1024 * 1024) });
const draftSettingsSchema = z.strictObject({providerID:z.string().max(64).nullable().default(null),modelID:z.string().max(256),
  reasoningEffortID:z.string().max(64).nullable().default(null),contextWindowTokens:z.number().int().positive().nullable().default(null),webEnabled:z.boolean()});
const actionSchema = z.strictObject({ id: identity, transcriptID: identity, materialID: identity, title: z.string().max(512),
  actionTypeID:z.literal("structured-notes").default("structured-notes"), customTitle:z.string().max(256).nullable().default(null),
  language: z.enum(["en", "zh-CN"]), createdAt: z.string(), draftSettings:draftSettingsSchema.optional() });
const operationSchema = z.object({ cycleID: identity, providerID: z.string(), profileIdentity: z.string(), phase: z.string(), revisionIndex: z.number().int(),
  interactionLanguage: z.enum(["en", "zh-CN"]),
  actionLanguage: z.enum(["en", "zh-CN"]).optional(),
  inference, webEnabled: z.boolean(), instructions: z.string(), previousLedger: z.unknown(), result: z.unknown().nullable(), error: z.string().nullable(),
  submissionDigest: z.string().regex(/^[a-f0-9]{64}$/u).optional(), submissionKind: z.enum(["send", "retry"]).optional(), executionID: identity.optional(),
  presentation: appPresentationSchema.optional(), rawAssessment: z.unknown().optional(),
  reeditFromPhase: z.string().optional(), safetyExplanations: safetyExplanationsSchema.optional(),
  workingLog: z.string().max(MAX_WORKING_LOG_BYTES).refine(value => Buffer.byteLength(value) <= MAX_WORKING_LOG_BYTES).optional() });
type Action = z.infer<typeof actionSchema>;
type Operation = z.infer<typeof operationSchema>;
const sendSchema = z.strictObject({ actionID: identity, operationID: identity, instructions: z.string().max(64 * 1024).refine(text => Buffer.byteLength(text, "utf8") <= 64 * 1024), inference,
  interactionLanguage: z.enum(["en", "zh-CN"]).default("en"),
  initialLanguage:z.enum(["en","zh-CN"]).optional(), expectedProviderID:z.string().max(64).optional(),
  grantWeb: z.boolean(), consent: z.boolean() });
const CONSENT_VERSION = CONTENT_CONSENT_VERSION;
const consentSchema = contentConsentSchema;

export class AppActions {
  get busy(): boolean { return this.#active !== null || this.#raw.busy || this.#reediting; }
  #reediting = false;
  #activeOperation: Operation | null = null;
  #closed = false;
  readonly #journal: ServiceJournal;
  readonly #documents: AppDocuments;
  readonly #persistence: DurableTahPersistence;
  readonly #workflow: TahWorkflowCoordinatorV1;
  readonly #raw: RawSafetyPreflight;
  readonly #owners = new Map<string, string>();
  #active: { action: Action; controller: AbortController; task: Promise<void>; operationID: string; digest: string } | null = null;
  #phase = "idle";
  #pendingSave: string | null = null;
  #presentation = new AppPresentationTracker();
  readonly #workingReads = new WorkingLogReadCache();
  #stateRevision = 0;
  readonly #notificationSource = randomUUID();
  #notificationRevision = 0;
  readonly #errors = new Map<string, "operation_failed" | "retry_restore_failed">();
  readonly #notifications: LatestAppNotifications<unknown>;
  constructor(private readonly bridge: AppRuntimeBridge, private readonly auth: AuthService,
    private readonly profiles: readonly AppProviderProfile[], scheduler: BoundedTahHostOperationSchedulerV1,
    private readonly resources: TahWorkflowResourcesV1, private readonly actionInstructions: string,
    attemptPort?: TahFrameworkAttemptPortV1,
  ) {
    this.#notifications = new LatestAppNotifications(value => bridge.call("ui.actionChanged", value), () => bridge.close());
    this.#journal = new ServiceJournal(bridge);
    this.#documents = new AppDocuments(this.#journal, id => { this.#pendingSave = id; if (id) this.#stage("persistence_pending"); });
    this.#persistence = new DurableTahPersistence(this.#journal, id => {
      const owner = this.#owners.get(id); if (!owner) throw new Error("Action owner is unknown"); return owner;
    }, saves => { this.#pendingSave = saves[0]?.operationID ?? null; if (this.#pendingSave) this.#stage("persistence_pending"); });
    const attempts = attemptPort ?? serviceAttemptPort(bridge, auth, scheduler, profiles);
    // Phase ownership belongs here, not to the transport: log admission must
    // have the same role boundary for every attempt port.
    const staged: TahFrameworkAttemptPortV1 = { run: async (built, onEvent, signal) => {
      this.#stage(built.attempt.role);
      const result = await attempts.run(built, onEvent, signal);
      if (result.terminal.kind === "end_turn") this.#stage(built.attempt.role === "actor" ? "critic" : "saving_safety");
      return result;
    } };
    this.#workflow = new TahWorkflowCoordinatorV1(new LivenessTahAttemptPortV1(staged), this.#persistence);
    this.#raw = new RawSafetyPreflight(this.#documents, auth, profiles, this.#workflow, resources,
      () => this.#active !== null || this.#closed, () => { this.#stateRevision++; });
    auth.onIdentityInvalidated(async () => { await this.#raw.cancel(); await this.cancel(); });
  }

  static async load(bridge: AppRuntimeBridge, auth: AuthService, profiles: readonly AppProviderProfile[], scheduler: BoundedTahHostOperationSchedulerV1) {
    const load = async (name: string) => readFile(new URL(`../../prompts/${name}`, import.meta.url), "utf8");
    const [actionInstructions, actorPromptTemplate, rawGuardianPrompt, extraGuardianPrompt, safetyPolicy] = await Promise.all([
      load("action_instructions/structured_notes_v4_3.txt"), load("system_prompts/actor_prompt_v4_2.txt"),
      load("system_prompts/safety_guardian_raw_prompt_v0_3.txt"), load("system_prompts/safety_guardian_extra_prompt_v0_6.txt"),
      load("system_prompts/safety_guardian_policy_v0_2.txt"),
    ]);
    return new AppActions(bridge, auth, profiles, scheduler, { actorPromptTemplate, rawGuardianPrompt, extraGuardianPrompt, safetyPolicy }, actionInstructions);
  }

  async create(value: unknown) {
    const input = z.strictObject({ actionID: identity, materialID: identity, language: z.enum(["en", "zh-CN"]), draftSettings:draftSettingsSchema.optional() }).parse(value);
    if (this.#closed) throw new AppBridgeError("unavailable");
    const existing = await this.#documents.last(`meta/${input.actionID}`, actionSchema);
    if (existing) {
      if (existing.materialID !== input.materialID || existing.language !== input.language
        || JSON.stringify(existing.draftSettings) !== JSON.stringify(input.draftSettings)) throw new AppBridgeError("integrity_locked");
      return this.snapshot(existing.id);
    }
    this.#requireAuthorizationCheck();
    const material = await this.#documents.last(`material/${input.materialID}`, materialSchema);
    if (!material) throw new AppBridgeError("invalid_request");
    await this.#raw.requireAllowed(input.materialID);
    this.#requireAuthorizationCheck();
    const action: Action = { id: input.actionID, transcriptID: material.transcriptID, materialID: input.materialID, title: material.title,
      actionTypeID:"structured-notes",customTitle:null,
      language: input.language, createdAt: new Date().toISOString(), ...(input.draftSettings ? {draftSettings:input.draftSettings} : {}) };
    // Creating an entity is not execution. Keep this small atomic write separate
    // from the active workflow's pending-save/progress state.
    const {write,bytes}=prepareJournalWrite(`meta/${action.id}`,`transcript/${action.transcriptID}`,0,"document",action);
    await this.#journal.append(write,bytes);
    return this.snapshot(action.id);
  }

  async rename(value: unknown) {
    const input=z.strictObject({actionID:identity,title:z.string().max(256)}).parse(value);
    if(this.#closed)throw new AppBridgeError("unavailable");
    const stream=`meta/${input.actionID}`, record=await this.#journal.readLast(stream);
    if(!record)throw new AppBridgeError("invalid_request");
    const action=actionSchema.parse(record.value);
    if(action.id!==input.actionID)throw new AppBridgeError("integrity_locked");
    const customTitle=input.title.trim().replace(/\s+/gu," ")||null;
    if(action.customTitle!==customTitle) {
      // Display metadata only: never rewrite transcript title, prompts, proposals
      // or draft tokens, and never touch another running workflow's save state.
      const {write,bytes}=prepareJournalWrite(stream,`transcript/${action.transcriptID}`,record.version,"document",{...action,customTitle});
      try { await this.#journal.append(write,bytes); }
      catch(error) {
        // Resolve an uncertain ACK and cancel an incomplete metadata-only write.
        const status=z.strictObject({version:z.number().int().positive().nullable()})
          .parse(await this.bridge.call("store.cancel",{operationID:write.operationID}));
        if(status.version!==record.version+1)throw error;
      }
      this.#stateRevision++;
    }
    return this.snapshot(action.id);
  }

  async list(transcriptID: string, cursor: string | null) {
    identity.parse(transcriptID);
    let before = Number.MAX_SAFE_INTEGER;
    if (cursor !== null) {
      let value: { transcriptID: string; before: number };
      try { value = z.strictObject({ transcriptID: identity, before: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) })
        .parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); }
      catch { throw new AppBridgeError("invalid_request"); }
      if (value.transcriptID !== transcriptID) throw new AppBridgeError("invalid_request");
      before = value.before;
    }
    const streams = z.array(z.strictObject({ streamID: z.string(), position: z.number().int().positive() })).max(33)
      .parse(await this.bridge.call("store.actionStreams", { ownerID: `transcript/${transcriptID}`, before, limit: 33 }));
    const actions = [];
    for (const stream of streams.slice(0, 32)) {
      const action = await this.#documents.last(stream.streamID, actionSchema);
      if (!action || action.transcriptID !== transcriptID || stream.streamID !== `meta/${action.id}`) throw new AppBridgeError("integrity_locked");
      const op=await this.#documents.last(`operation/${action.id}`,operationSchema);
      const publications = op ? await this.#persistence.acceptedPublications(action.id) : [];
      const pending = (await this.#journal.pending()).find(write => write.streamID === `action/${action.id}`
        || write.streamID === `operation/${action.id}` || write.streamID.startsWith(`raw/${action.transcriptID}/`));
      const pendingComplete = pending ? z.boolean().parse(await this.bridge.call("store.pendingIsComplete", {operationID:pending.operationID})) : false;
      const phase = this.#active?.action.id === action.id ? this.#phase : !op ? "draft"
        : restoredActionPhase(op.phase, publications.some(item => item.cycleID === op.cycleID), pending ? pendingComplete ? "complete" : "partial" : "none");
      actions.push({...action,language:op?.actionLanguage??action.language,initialSettingsFrozen:op!==null,phase});
    }
    return { actions, nextCursor: streams.length <= 32 ? null : Buffer.from(JSON.stringify({ transcriptID, before: streams[31]!.position })).toString("base64url") };
  }

  async snapshot(actionID: string) { return stableSnapshot(() => this.#readSnapshot(actionID), () => this.#stateRevision); }
  async #readSnapshot(actionID: string) {
    const action = await this.#action(actionID);
    const publications = await this.#persistence.acceptedPublications(action.id);
    const storedOperation = await this.#documents.last(`operation/${action.id}`, operationSchema);
    const operation = this.#active?.action.id === action.id ? this.#activeOperation ?? storedOperation : storedOperation;
    const proposal = await this.#persistence.latestProposal(action.id);
    const consentProviderID = this.auth.snapshot().providerID;
    const consentProfile = this.profiles.find(profile => profile.id === consentProviderID);
    const contentConsent = consentProfile ? await this.#documents.last(`consent/${consentProfile.id}/${consentProfile.profileIdentity}/${CONSENT_VERSION}`, consentSchema) : null;
    const publishedCurrent = operation && publications.some(publication => publication.cycleID === operation.cycleID);
    const pending = (await this.#journal.pending()).find(write => write.streamID === `action/${action.id}` || write.streamID === `operation/${action.id}`
      || write.streamID.startsWith(`raw/${action.transcriptID}/`));
    const pendingComplete = this.#active?.action.id !== action.id && pending ? z.boolean().parse(await this.bridge.call("store.pendingIsComplete", { operationID: pending.operationID })) : false;
    const activeOperation = this.#active?.action.id === action.id ? this.#active : null;
    const active = activeOperation !== null;
    const phase = active ? this.#phase : restoredActionPhase(operation?.phase, Boolean(publishedCurrent), pending ? pendingComplete ? "complete" : "partial" : "none");
    const editorMode = active ? "running" : pending || phase === "integrity_locked" ? "locked"
      : !operation || publishedCurrent || operation.phase === "editing" ? "editing" : "needs_edit";
    const rawSafety=await this.#raw.status(action.materialID);
    const sourcePresentation=active?this.#presentation.snapshot():operation?.presentation??null;
    const presentation=sourcePresentation?publicPresentation(sourcePresentation,phase):null;
    if(activeOperation&&presentation?.workingLogSHA256) {
      const log=this.#presentation.workingLog();
      this.#workingReads.pin(action.id,activeOperation.operationID,log.sha256,log.text);
    }
    return { ...action, language:operation?.actionLanguage??activeOperation?.action.language??action.language, initialSettingsFrozen:operation!==null||active,
      draftSettings:operation ? {providerID:operation.providerID,modelID:operation.inference.modelID,reasoningEffortID:operation.inference.reasoningEffortID,
        contextWindowTokens:operation.inference.contextWindowTokens??null,webEnabled:operation.webEnabled} : action.draftSettings??null,
      phase:!operation&&!active?"draft":phase, rawSafety, webEnabled: proposal?.webEnabled ?? false, progressSourceID: this.#notificationSource, progressRevision: this.#notificationRevision,
      editorMode, editorToken: operation && !publishedCurrent ? `submission/${operation.cycleID}` : `published/${publications.at(-1)?.cycleID ?? "initial"}`,
      canReedit: editorMode === "needs_edit", reeditFromPhase: operation?.reeditFromPhase ?? null,
      safetyExplanations: operation?.safetyExplanations?.filter(value => value.subject === "extra" && value.decision === "BLOCK") ?? [],
      safetyReasonCodes: safetyReasonCodes(operation?.reeditFromPhase ?? phase, operation?.result, operation?.rawAssessment),
      interactionLanguage: operation?.interactionLanguage ?? "en",
      instructionRetryLanguage: null,
      contentConsentProviderID: consentProviderID, contentConsentGranted: contentConsent?.accepted === true && contentConsent.recordedAt !== undefined,
      operationID: activeOperation?.operationID ?? operation?.executionID ?? operation?.cycleID ?? null, providerID: operation?.providerID ?? this.auth.snapshot().providerID,
      revisionIndex: publications.length, latestSubmittedRevisionIndex:operation?.revisionIndex??null, error: operation?.error ?? null,
      errorCode: this.#errors.get(action.id) ?? (phase === "integrity_locked" && !operation?.error ? "execution_interrupted" : null),
      pendingSave: active ? this.#pendingSave : pendingComplete ? pending!.operationID : null, events: active ? presentation?.events??[] : [],
      presentation,
      canOmitInstructions: publications.length === 0,
      canRetry: false,
      revisions: publications.map(publication => ({ revisionIndex: publication.revisionIndex, providerID: publication.providerID,
        actorRounds: publication.actorRounds, commitID: `publication/${publication.cycleID}`,
        modelID: publication.actorAttempts.at(-1)!.inference.modelID, reasoningEffortID: publication.actorAttempts.at(-1)!.inference.reasoningEffortID,
        contextWindowTokens: publication.actorAttempts.at(-1)!.inference.contextWindowTokens ?? null })) };
  }

  async send(value: unknown) {
    const input = sendSchema.parse(value);
    if(input.expectedProviderID!==undefined&&input.expectedProviderID!==this.auth.snapshot().providerID)throw new AppBridgeError("invalid_request");
    const digest = submissionDigest(input);
    if (this.#active?.operationID === input.operationID) {
      if (this.#active.digest !== digest) throw new AppBridgeError("integrity_locked");
      return { started: true, actionID: input.actionID };
    }
    if (this.#active || this.#raw.busy || this.#reediting) throw new AppBridgeError("busy");
    const action = await this.#action(input.actionID);
    if (await submissionAlreadyRecorded(this.#journal, action.id, input.operationID, digest)) return { started: true, actionID: action.id };
    this.#requireAuthorizationCheck();
    if (this.#active) throw new AppBridgeError("busy");
    if (this.auth.snapshot().inspecting) throw new AppBridgeError("busy");
    const profile = this.profiles.find(item => item.id === this.auth.snapshot().providerID);
    if (!profile || !isAppModelAllowed(profile, input.inference.modelID)) throw new AppBridgeError("invalid_request");
    const current = await this.snapshot(action.id);
    if(current.initialSettingsFrozen&&input.initialLanguage!==undefined&&input.initialLanguage!==current.language)throw new AppBridgeError("invalid_request");
    const executionAction={...action,language:current.initialSettingsFrozen?current.language:input.initialLanguage??action.language};
    await this.#raw.requireAllowed(action.materialID);
    this.#requireAuthorizationCheck();
    if (current.editorMode !== "editing") throw new AppBridgeError("invalid_request");
    if (["integrity_locked", "persistence_pending"].includes(current.phase) || (!current.canOmitInstructions && !input.instructions.trim())) throw new AppBridgeError("invalid_request");
    if (this.#active || this.#raw.busy) throw new AppBridgeError("busy");
    const controller = new AbortController();
    const authIdentity = this.auth.identityVersion;
    const active = { action:executionAction, controller, task: Promise.resolve(), operationID: input.operationID, digest };
    this.#active = active; this.#stateRevision++; this.#presentation = new AppPresentationTracker(); this.#pendingSave = null; this.#errors.delete(action.id);
    this.#stage("preparing");
    active.task = this.#run(executionAction, input, controller.signal).catch(async () => {
      this.#errors.set(action.id, "operation_failed");
      this.#stage(controller.signal.aborted ? "cancelled" : "failed");
    }).finally(() => {
      if (this.#active === active) { this.#active = null; this.#activeOperation = null; this.#stateRevision++; this.#push(action.id, active.operationID); this.#refreshUsage(authIdentity); }
    });
    return { started: true, actionID: action.id };
  }

  async reedit(actionID: string, operationID: string) {
    if (this.#active || this.#reediting) throw new AppBridgeError("busy");
    this.#reediting = true;
    try {
      const action = await this.#action(actionID);
      const op = await this.#documents.last(`operation/${action.id}`, operationSchema);
      if (!op || op.cycleID !== identity.parse(operationID)) throw new AppBridgeError("invalid_request");
      if (op.phase === "editing") return this.snapshot(action.id);
      const state = await this.snapshot(action.id);
      if (!state.canReedit) throw new AppBridgeError("invalid_request");
      const proposal = await this.#persistence.latestProposal(action.id);
      if (proposal?.cycleID === op.cycleID) {
        await this.#persistence.releaseProposalReservation({cycleID: op.cycleID, actionInstanceID: action.id, revisionIndex: op.revisionIndex, proposalCommitID: `proposal/${op.cycleID}`});
      }
      // One durable record both hides the pending conversation and retains the
      // exact original text as the recovery seed. Native edited snapshots are
      // bound to this cycle so older drafts cannot resurrect after publication.
      op.reeditFromPhase = state.phase; op.phase = "editing";
      await this.#documents.save(`operation/${action.id}`, `transcript/${action.transcriptID}`, op);
      this.#stateRevision++;
      return this.snapshot(action.id);
    } finally { this.#reediting = false; }
  }
  async instructionText(actionID: string, operationID: string, offset: number) {
    await this.#action(actionID);
    const op = await this.#documents.last(`operation/${actionID}`, operationSchema);
    if (!op || op.cycleID !== operationID || op.phase !== "editing") throw new AppBridgeError("invalid_request");
    const bytes = Buffer.from(op.instructions);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) throw new AppBridgeError("invalid_request");
    return {data: bytes.subarray(offset, offset + 48 * 1024).toString("base64"), totalBytes: bytes.length};
  }

  async cancel() { const active = this.#active; if (active) { active.controller.abort(); await active.task; } }
  async rawSafetyStatus(materialID: string) { return {...await this.#raw.status(materialID), pendingSave: this.#raw.busy ? this.#pendingSave : null}; }
  async checkRawSafety(value: unknown) {
    const input = z.strictObject({materialID:identity,operationID:identity,consent:z.boolean(),interactionLanguage:z.enum(["en","zh-CN"])}).parse(value);
    return this.#raw.start(input);
  }
  async cancelRawSafety(operationID: string) { await this.#raw.cancel(identity.parse(operationID)); return {cancelled:true}; }
  async close() {
    this.#workingReads.clear();
    this.#closed = true; this.#notifications.close();
    // Healthy normal shutdown must record the confirmed cancellation before
    // closing its journal writers. The Service still owns the bounded shutdown
    // deadline; storage/cleanup uncertainty remains fail-closed on restart.
    try { await this.#raw.cancel(); await this.cancel(); }
    finally { this.#persistence.close(); this.#documents.close(); }
  }
  async retry(actionID: string, operationID: string) {
    identity.parse(operationID);
    if (this.#active?.operationID === operationID && this.#active.action.id === actionID) return { started: true };
    if (this.#active) throw new AppBridgeError("busy");
    const action = await this.#action(actionID);
    const operation = await this.#documents.last(`operation/${action.id}`, operationSchema);
    if (operation?.executionID === operationID && operation.submissionKind === "retry") return { started: true };
    this.#requireAuthorizationCheck();
    if (this.auth.snapshot().inspecting) throw new AppBridgeError("busy");
    const result = operation?.result as RevisionCycleResultV1 | null | undefined;
    const auth = this.auth.snapshot(), profile = this.profiles.find(value => value.id === auth.providerID);
    if (!operation || !result || !("infrastructureRetry" in result) || !result.infrastructureRetry
      || auth.state !== "valid" || !profile || profile.id !== operation.providerID || profile.profileIdentity !== operation.profileIdentity) throw new AppBridgeError("invalid_request");
    const current = await this.snapshot(action.id);
    const consent = await this.#documents.last(`consent/${profile.id}/${profile.profileIdentity}/${CONSENT_VERSION}`, consentSchema);
    if (!current.canRetry || !consent?.accepted || !consent.recordedAt || !isAppModelAllowed(profile, operation.inference.modelID)) throw new AppBridgeError("invalid_request");
    if (this.#active) throw new AppBridgeError("busy");
    const controller = new AbortController(), active = { action, controller, task: Promise.resolve(), operationID, digest: "retry" };
    const authIdentity = this.auth.identityVersion;
    this.#active = active; this.#stateRevision++; this.#presentation = new AppPresentationTracker(); this.#errors.delete(action.id); this.#stage("preparing");
    const receipt = result.infrastructureRetry;
    active.task = (async () => {
      // Persist retry-in-progress before consuming its lease or invoking a model.
      // A crash must not make an already claimed receipt appear reusable.
      operation.phase = "running";
      operation.submissionKind = "retry";
      operation.executionID = operationID;
      delete operation.presentation;
      await this.#documents.save(`operation/${action.id}`, `transcript/${action.transcriptID}`, operation, controller.signal);
      const result = await this.#workflow.retryInfrastructure({ receipt, actionInstanceID: action.id, signal: controller.signal,
        onEvent: (scope, event) => this.#event(scope, event) });
      operation.result = result; operation.phase = result.kind;
      this.#presentation.stage(result.kind); operation.presentation = this.#presentation.snapshot(true);
      operation.workingLog = this.#presentation.workingLog(true).text;
      await this.#documents.save(`operation/${action.id}`, `transcript/${action.transcriptID}`, operation, undefined, controller.signal);
      this.#stage(result.kind);
    })().catch(() => { this.#stage("integrity_locked"); this.#errors.set(action.id, "retry_restore_failed"); })
      .finally(() => { if (this.#active === active) { this.#active = null; this.#stateRevision++; this.#push(action.id, active.operationID); this.#refreshUsage(authIdentity); } });
    return { started: true };
  }
  async purge(transcriptID: string) {
    identity.parse(transcriptID);
    if (this.#raw.transcriptID === transcriptID) await this.#raw.cancel();
    if (this.#active?.action.transcriptID === transcriptID) await this.cancel();
    await this.bridge.call("store.deleteOwner", { ownerID: `transcript/${transcriptID}` });
    return { deleted: true };
  }
  async delete(actionID: string) {
    const action = await this.#action(actionID);
    if (this.#active?.action.id === action.id) await this.cancel();
    await this.bridge.call("store.deleteAction", { actionID: action.id, ownerID: `transcript/${action.transcriptID}` });
    this.#owners.delete(action.id); this.#errors.delete(action.id);
    return { deleted: true };
  }
  async revokeConsent(providerID: string) {
    const profile = this.profiles.find(value => value.id === providerID);
    if (!profile) throw new AppBridgeError("invalid_request");
    await this.#raw.cancel(); await this.cancel();
    await this.#documents.save(`consent/${profile.id}/${profile.profileIdentity}/${CONSENT_VERSION}`, "preferences", { accepted: false, recordedAt: new Date().toISOString() });
    return { revoked: true };
  }
  async retrySave(operationID: string) {
    if (this.#documents.retry(operationID)) return { retrying: true };
    if (this.#persistence.pendingSaves().some(save => save.operationID === operationID)) {
      this.#persistence.retrySave(operationID); return { retrying: true };
    }
    if (this.#active) throw new AppBridgeError("busy");
    const write = (await this.#journal.pending()).find(value => value.operationID === operationID);
    if (!write) throw new AppBridgeError("invalid_request");
    const bytes = await this.#journal.readPending(write);
    if (write.streamID.startsWith("action/")) await this.#persistence.recoverPending(write, bytes);
    else {
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (write.streamID.startsWith("raw/")) {
        const receipt = rawReceiptSchema.parse(value);
        if ((parseStoredRaw(receipt.assessment).decision === "ALLOW") !== receipt.allowed) throw new AppBridgeError("integrity_locked");
      } else if (write.streamID.startsWith("raw-check/")) rawCheckSchema.parse(value);
      else if (write.streamID.startsWith("operation/")) operationSchema.parse(value);
      else throw new AppBridgeError("invalid_request");
      await this.#journal.append(write, bytes);
    }
    return { retrying: false, saved: true };
  }
  async outcome(actionID: string, revisionIndex: number, path: string, offset: number) {
    await this.#action(actionID);
    if (!Number.isSafeInteger(offset) || offset < 0 || !["structured-notes.md", "suspicious-asr-terms.md"].includes(path)) throw new AppBridgeError("invalid_request");
    const publication = (await this.#persistence.acceptedPublications(actionID)).find(item => item.revisionIndex === revisionIndex);
    if (!publication) throw new AppBridgeError("invalid_request");
    const file = publication.outcome.entries.find(entry => entry.kind === "file" && entry.relativePath === path);
    if (!file || file.kind !== "file") throw new AppBridgeError("integrity_locked");
    const bytes = readCandidateOutcomeFileV1(file);
    return { data: Buffer.from(bytes.subarray(offset, offset + 48 * 1024)).toString("base64"), totalBytes: bytes.byteLength };
  }

  async conversation(actionID: string, cursor: string | null) {
    await this.#action(actionID);
    return conversationPage(this.#journal, actionID, cursor, await this.#visibleCycles(actionID));
  }
  async #visibleCycles(actionID: string) {
    const visible = new Set((await this.#persistence.acceptedPublications(actionID)).map(p => p.cycleID));
    const op = await this.#documents.last(`operation/${actionID}`, operationSchema);
    if (op && op.phase !== "editing") visible.add(op.cycleID);
    return visible;
  }
  async transcriptMaterial(actionID: string, offset: number) {
    const action = await this.#action(actionID);
    const material = await this.#documents.last(`material/${action.materialID}`, materialSchema);
    if (!material || material.transcriptID !== action.transcriptID) throw new AppBridgeError("integrity_locked");
    const bytes = Buffer.from(material.rawTranscript);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length) throw new AppBridgeError("invalid_request");
    return { data: bytes.subarray(offset, offset + 48 * 1024).toString("base64"), totalBytes: bytes.length };
  }
  async conversationText(actionID: string, position: number, offset: number) {
    await this.#action(actionID);
    const head = await this.#journal.head(`operation/${actionID}`);
    if (!Number.isSafeInteger(position) || position < 1 || position > head.version || !Number.isSafeInteger(offset) || offset < 0) throw new AppBridgeError("invalid_request");
    const record = (await this.#journal.readRange(`operation/${actionID}`, position - 1, position))[0]!;
    if (!(await this.#visibleCycles(actionID)).has(operationSchema.parse(record.value).cycleID)) throw new AppBridgeError("invalid_request");
    const bytes = Buffer.from(publicConversation(record).fullText);
    return { data: bytes.subarray(offset, offset + 48 * 1024).toString("base64"), totalBytes: bytes.length };
  }

  async workingText(actionID: string, position: number | null, sha256: string, offset: number) {
    await this.#action(actionID);
    if (!/^[a-f0-9]{64}$/u.test(sha256) || !Number.isSafeInteger(offset) || offset < 0) throw new AppBridgeError("invalid_request");
    let text: string | undefined, pinned:Buffer|undefined;
    if (position === null && this.#active?.action.id === actionID) {
      if (!canReadWorkingLog(this.#phase, this.#presentation.snapshot())) throw new AppBridgeError("unavailable");
      pinned=this.#workingReads.get(actionID,this.#active.operationID,sha256);
      text=this.#presentation.workingLog().text;
    } else if (position === null) {
      const operation=await this.#documents.last(`operation/${actionID}`,operationSchema);
      if (!operation || !canReadWorkingLog(operation.phase, operation.presentation)) throw new AppBridgeError("unavailable");
      if(operation)pinned=this.#workingReads.get(actionID,operation.executionID??operation.cycleID,sha256);
      text=operation?.workingLog;
    }
    else {
      const head = await this.#journal.head(`operation/${actionID}`);
      if (!Number.isSafeInteger(position) || position < 1 || position > head.version) throw new AppBridgeError("invalid_request");
      const record = (await this.#journal.readRange(`operation/${actionID}`, position - 1, position))[0];
      if (record) {
        const operation = operationSchema.parse(record.value);
        if (!canReadWorkingLog(operation.phase, operation.presentation)) throw new AppBridgeError("unavailable");
        text = operation.workingLog;
      }
    }
    if (text === undefined && pinned === undefined) throw new AppBridgeError("unavailable");
    const bytes = pinned??Buffer.from(text!);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) throw new AppBridgeError("busy");
    if (offset > bytes.length) throw new AppBridgeError("invalid_request");
    return {data: bytes.subarray(offset, offset + 48 * 1024).toString("base64"), totalBytes: bytes.length};
  }

  #refreshUsage(authIdentity: number) {
    // Do not await Auth's queue from the task being drained by auth replacement.
    queueMicrotask(() => {
      if (this.#closed || this.#active || this.#phase === "integrity_locked") return;
      void this.auth.inspectIfCurrent(authIdentity).catch(() => {});
    });
  }

  #requireAuthorizationCheck(): void {
    if (this.#closed || !authorizationCheckSucceeded(this.auth.snapshot())) throw new AppBridgeError("unavailable");
  }

  async #run(action: Action, input: z.infer<typeof sendSchema>, signal: AbortSignal) {
    const publications = await this.#persistence.acceptedPublications(action.id);
    const lastLedger = publications.at(-1)?.ledger ?? [];
    const selected = this.profiles.find(item => item.id === this.auth.snapshot().providerID);
    const op: Operation = { cycleID: input.operationID, executionID: input.operationID, submissionDigest: submissionDigest(input), submissionKind: "send",
      providerID: selected?.id ?? "unavailable", profileIdentity: selected?.profileIdentity ?? "unavailable", phase: "running", revisionIndex: publications.length,
      interactionLanguage: input.interactionLanguage, actionLanguage:action.language, inference: input.inference, webEnabled: input.grantWeb,
      instructions: input.instructions, previousLedger: lastLedger, result: null, error: null };
    this.#activeOperation = op;
    try {
    await this.#documents.save(`operation/${action.id}`, `transcript/${action.transcriptID}`, op, signal);
    this.#stage("preparing");
    const authIdentity = this.auth.identityVersion;
    const snapshot = this.auth.snapshot();
    this.#requireAuthorizationCheck();
    if (snapshot.state !== "valid" || snapshot.phase !== "idle" || snapshot.providerID === null) throw new AppBridgeError("unavailable");
    const profile = this.profiles.find(item => item.id === snapshot.providerID);
    if (!profile) throw new AppBridgeError("unavailable");
    if (signal.aborted || authIdentity !== this.auth.identityVersion
      || snapshot.state !== "valid" || snapshot.phase !== "idle" || snapshot.providerID !== profile.id) throw new AppBridgeError("cancelled");
    const model = snapshot.catalog?.models.find(item => item.handle === input.inference.modelID);
    if (!model || !isAppModelAllowed(profile, model.handle)
      || (input.inference.reasoningEffortID !== null && !model.efforts.some(item => item.handle === input.inference.reasoningEffortID))
      || (input.inference.contextWindowTokens !== undefined && !model.contextWindows?.availableTokens.includes(input.inference.contextWindowTokens))) throw new AppBridgeError("invalid_request");
    const guardian = snapshot.catalog?.models.find(item => item.handle === profile.guardianModel);
    if (!guardian?.efforts.some(item => item.handle === profile.guardianEffort)) throw new AppBridgeError("unavailable");
    const consentStream = `consent/${profile.id}/${profile.profileIdentity}/${CONSENT_VERSION}`;
    const consent = await this.#documents.last(consentStream, consentSchema);
    if (!consent?.accepted || !consent.recordedAt) {
      if (!input.consent) throw new AppBridgeError("invalid_request");
      await this.#documents.save(consentStream, "preferences", { accepted: true, recordedAt: new Date().toISOString() }, signal);
    }
    const material = await this.#documents.last(`material/${action.materialID}`, materialSchema);
    if (!material) throw new AppBridgeError("integrity_locked");
      this.#stage(input.instructions.trim() ? "extra_guardian" : "preparing");
      const result = await this.#workflow.runRevisionCycle({ cycleID: op.cycleID, actionInstanceID: action.id, providerID: profile.id,
        actionDefinition: createStructuredNotesActionDefinitionV1(this.actionInstructions), language: action.language,
        interactionLanguage: op.interactionLanguage,
        revisionIndex: publications.length, v0AlreadyAttempted: false, actorInference: input.inference,
        guardianInference: { modelID: profile.guardianModel, reasoningEffortID: profile.guardianEffort },
        rawTranscript: material.rawTranscript, instructionDelta: input.instructions, currentInstructions: lastLedger as UserInstructionLedgerV1,
        webEnabled: op.webEnabled, acceptedRevisions: publications.map(value => ({ revisionIndex: value.revisionIndex, publicationCommitID: `publication/${value.cycleID}`, outcome: value.outcome })),
        resources: this.resources, signal,
        onSafetyAssessment: assessment => {
          if (assessment.decision === "ALLOW") {
            op.safetyExplanations = [];
            this.#presentation.guardianPassed(assessment.explanation);
          } else op.safetyExplanations = [safetyExplanation("extra", assessment, input.interactionLanguage, new Date().toISOString())];
          this.#push(action.id);
        },
        onEvent: (scope, event) => this.#event(scope, event) });
      op.result = result; op.phase = result.kind;
      if ("terminal" in result && result.terminal?.kind === "failed") op.error = `${result.terminal.failure.code}: ${result.terminal.failure.message}`;
    } catch (error) {
      op.phase = error instanceof AppBridgeError && error.code === "integrity_locked" ? "integrity_locked" : signal.aborted ? "cancelled" : "failed";
    } finally {
      this.#presentation.stage(op.phase); op.presentation = this.#presentation.snapshot(true);
      op.workingLog = this.#presentation.workingLog(true).text;
      await this.#documents.save(`operation/${action.id}`, `transcript/${action.transcriptID}`, op, undefined, signal);
      this.#stage(op.phase);
    }
  }

  async #action(id: string) {
    const action = await this.#documents.last(`meta/${identity.parse(id)}`, actionSchema);
    if (!action) throw new AppBridgeError("invalid_request");
    if (action.id !== identity.parse(id)) throw new AppBridgeError("integrity_locked");
    this.#owners.set(action.id, `transcript/${action.transcriptID}`);
    return action;
  }
  #stage(phase: string) { this.#phase = phase; this.#presentation.stage(phase); this.#stateRevision++; if (this.#active) this.#push(this.#active.action.id); }
  #event(scope: TahAttemptScopeV1, event: NormalizedEventV1) {
    if (scope.role !== "actor") return;
    this.#presentation.event(scope, event);
    if (this.#active) this.#push(this.#active.action.id);
  }
  #push(actionID: string, operationID = this.#active?.operationID ?? null) {
    const presentation=publicPresentation(this.#presentation.snapshot(),this.#phase);
    this.#notifications.publish(actionID, { actionID, operationID, transcriptID: this.#owners.get(actionID)?.slice("transcript/".length) ?? null,
    sourceID: this.#notificationSource, sourceRevision: ++this.#notificationRevision,
    phase: this.#phase, safetyExplanations: this.#activeOperation?.safetyExplanations ?? [], pendingSave: this.#pendingSave, events: presentation.events, presentation }); }
}

function parseStoredRaw(value: unknown) {
  return (value !== null && typeof value === "object" && "explanation" in value ? parseRawGuardianAssessmentV2 : parseRawGuardianAssessmentV1)(JSON.stringify(value));
}
