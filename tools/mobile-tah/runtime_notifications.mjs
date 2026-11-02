// Explicit mobile-only observation seams. Hash-locked owned sources are never
// edited. No role ordering, admission, persistence or publication changes.
import {createHash} from 'node:crypto';
import * as fs from 'node:fs';
export const runtimeNotificationChanges=[];
export function adaptRuntimeNotifications(id,source,root){
  if(!['/upstream/src/app-runtime/actions.ts','/upstream/src/app-runtime/presentation.ts'].includes(id))return source;
  const sha=s=>createHash('sha256').update(s).digest('hex');
  const expected=JSON.parse(fs.readFileSync(root+'/source-lock.json','utf8')).files[id.slice('/upstream/'.length)];
  if(sha(source)!==expected)throw new Error(`${id} adoption drift: review the observation seam`);
  const edits=id.endsWith('/actions.ts')?[
    ['    attemptPort?: TahFrameworkAttemptPortV1,\n',
     '    attemptPort?: TahFrameworkAttemptPortV1,\n    onRawSafetyChanged?: () => void,\n'],
    ['    this.#notifications = new LatestAppNotifications',
     '    const notifyRaw = () => { try { onRawSafetyChanged?.(); } catch { /* Observers cannot alter workflow completion. */ } };\n    this.#notifications = new LatestAppNotifications'],
    ['id => { this.#pendingSave = id; if (id) this.#stage("persistence_pending"); }',
     'id => { const changed = this.#pendingSave !== id; this.#pendingSave = id; if (id) this.#stage("persistence_pending"); if (changed) notifyRaw(); }'],
    ['() => this.#active !== null || this.#closed, () => { this.#stateRevision++; });',
     '() => this.#active !== null || this.#closed, () => { this.#stateRevision++; notifyRaw(); });'],
    ['  #presentation = new AppPresentationTracker();', `  #presentation = new AppPresentationTracker();
  // One owner for this exact in-memory tracker, never a restored journal scope.
  #workingOwner: {actionID: string; operationID: string; transcriptID: string;
    tracker: AppPresentationTracker; terminalPhase: string | null} | null = null;
  #ownWorkingPresentation() {
    const active = this.#active!;
    this.#workingOwner = {actionID: active.action.id, operationID: active.operationID.toLowerCase(),
      transcriptID: active.action.transcriptID, tracker: this.#presentation, terminalPhase: null};
  }
  #finishWorkingPresentation() {
    if (this.#workingOwner?.tracker === this.#presentation) this.#workingOwner.terminalPhase = this.#phase;
  }
  workingView(actionID: string, operationID: string) {
    const parsed = z.strictObject({actionID: identity, operationID: identity}).safeParse({actionID, operationID});
    if (!parsed.success) throw new AppBridgeError("invalid_request");
    const owner = this.#workingOwner;
    if (this.#closed || !owner || owner.tracker !== this.#presentation
      || owner.actionID !== parsed.data.actionID || owner.operationID !== parsed.data.operationID)
      throw new AppBridgeError("unavailable");
    const active = this.#active;
    if (active && (active.action.id !== owner.actionID || active.operationID.toLowerCase() !== owner.operationID))
      throw new AppBridgeError("unavailable");
    const phase = active ? this.#phase : owner.terminalPhase;
    if (phase === null) throw new AppBridgeError("unavailable");
    const view = this.#presentation.workingView(phase, active === null);
    if (!view) throw new AppBridgeError("unavailable");
    return {actionID: owner.actionID, operationID: owner.operationID, ...view};
  }`],
    ['this.#presentation = new AppPresentationTracker(); this.#pendingSave',
     'this.#presentation = new AppPresentationTracker(); this.#ownWorkingPresentation(); this.#pendingSave'],
    ['this.#presentation = new AppPresentationTracker(); this.#errors',
     'this.#presentation = new AppPresentationTracker(); this.#ownWorkingPresentation(); this.#errors'],
    ['this.#active = null; this.#activeOperation = null;',
     'this.#finishWorkingPresentation(); this.#active = null; this.#activeOperation = null;'],
    ['this.#active = null; this.#stateRevision++;',
     'this.#finishWorkingPresentation(); this.#active = null; this.#stateRevision++;'],
    ['auth.onIdentityInvalidated(async () => { await this.#raw.cancel(); await this.cancel(); });',
     'auth.onIdentityInvalidated(async () => { this.#workingOwner = null; await this.#raw.cancel(); await this.cancel(); });'],
    ['      op.reeditFromPhase = state.phase; op.phase = "editing";',
     '      if (this.#workingOwner?.actionID === action.id) this.#workingOwner = null;\n      op.reeditFromPhase = state.phase; op.phase = "editing";'],
    ['    this.#workingReads.clear();', '    this.#workingOwner = null;\n    this.#workingReads.clear();'],
    ['    await this.bridge.call("store.deleteOwner",',
     '    if (this.#workingOwner?.transcriptID === transcriptID) this.#workingOwner = null;\n    await this.bridge.call("store.deleteOwner",'],
    ['    await this.bridge.call("store.deleteAction",',
     '    if (this.#workingOwner?.actionID === action.id) this.#workingOwner = null;\n    await this.bridge.call("store.deleteAction",'],
  ]:[
    ['  workingLog(finished = false):', `  // Read the already-owned bounded events without snapshot/journal/log encoding.
  workingView(phase: string, finished = false) {
    if (!canReadWorkingLog(phase, {stages: this.#stages, events: this.#events.slice(-24)})) return null;
    // Progress normally populated cachedLog already. A direct read after an
    // event still enforces the exact JSON cap without materializing the log.
    if (!this.#cachedLog) {
      let textBytes = this.#events.reduce((sum, event) => sum + Buffer.byteLength(event.detail), 0);
      while (this.#events.length > MAX_RETAINED_EVENTS || textBytes > MAX_RETAINED_TEXT_BYTES) {
        textBytes -= Buffer.byteLength(this.#discardOldestEvent().detail); this.#limited = true;
      }
      const eventBytes = (event: Event) => Buffer.byteLength(JSON.stringify({...event, detail: ""})) + workingDetailJSONBytes(event.detail);
      const sizes = this.#events.map(eventBytes);
      let bytes = sizes.reduce((sum, size) => sum + size, 0);
      const envelopeBytes = () => Buffer.byteLength(JSON.stringify({schemaVersion: 1, limited: this.#limited, events: []}));
      while (bytes + Math.max(0, sizes.length - 1) + envelopeBytes() > MAX_WORKING_LOG_BYTES) {
        this.#limited = true;
        if (this.#events.length > 1) {
          const index = this.#events[0]?.titleCode === "safety_guardian" ? 1 : 0;
          this.#discardOldestEvent(); bytes -= sizes.splice(index, 1)[0]!;
        } else {
          this.#events[0]!.detail = clipText(this.#events[0]!.detail, MAX_RETAINED_TEXT_BYTES / 2);
          bytes = sizes[0] = eventBytes(this.#events[0]!);
        }
      }
    }
    return {events: this.#events.filter(event => event.role === "actor" || isGuardianOutcome(event))
      .map(event => ({...event, status: finished && event.status === "running" ? "stopped" as const : event.status})),
      limited: this.#limited, phase, finished};
  }
  workingLog(finished = false):`],
    ['/** Unicode-safe head/tail preview:', `// JSON string payload bytes, including escapes and well-formed lone-surrogate
// escaping. Count directly so a memory read never creates the full log string.
function workingDetailJSONBytes(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13) bytes += 2;
    else if (c < 32) bytes += 6;
    else if (c < 128) bytes++;
    else if (c < 2048) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { bytes += 4; i++; }
    else if (c >= 0xd800 && c <= 0xdfff) bytes += 6;
    else bytes += 3;
  }
  return bytes;
}

/** Unicode-safe head/tail preview:`],
  ];
  let result=source;
  for(const [before,after]of edits){
    if(result.split(before).length!==2)throw new Error(`Observation seam is no longer unique: ${id}: ${before}`);
    result=result.replace(before,after);
  }
  runtimeNotificationChanges.push({module:id,sourceSHA256:sha(source),adaptedSHA256:sha(result),
    purpose:'Raw observation and scoped bounded Working memory reads; original owned source unchanged',edits});
  return result;
}
