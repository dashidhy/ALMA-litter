import type { Call, Command, Commands, Draft, Snapshot, SubscribeChanges, SubscribeWorking, WorkingLog, WorkingLogMetadata } from './contract';
import { editorIdentity } from './contract';
import { materialMatchesRequest } from './material';
import { sameWorkingLog, WorkingStreamConsumer } from './working-stream';
import type { WorkingFrameScheduler } from './working-stream';

export interface UIState {
  snapshot: Snapshot | null;
  draft: Draft | null;
  dirty: boolean;
  pending: Command | null;
  connectionError: string | null;
  commandError: string | null;
  workingLogID: string | null;
  workingLog: WorkingLog | null | undefined;
  workingStreamError: string | null;
}
const permission: Partial<Record<Command, keyof Snapshot['presentation']['permissions']>> = {
  selectTranscript: 'selectTranscript', selectAction: 'selectAction', importTranscript: 'importTranscript',
  selectInteractionLanguage: 'editInteractionLanguage', checkRawSafety: 'checkRaw',
  createStructuredNotesAction: 'createAction', sendAction: 'send', readMaterial: 'readMaterial',
  loadMoreConversation: 'loadHistory', expandConversation: 'loadHistory',
};
const message = (error: unknown) => error instanceof Error ? error.message : 'The request failed. Please retry.';
export function selectionIdentity(snapshot: Snapshot): string {
  return JSON.stringify([snapshot.presentation.transcriptID, snapshot.presentation.editor?.actionID]);
}

function changedFields<T extends object>(sent: T, current: T): Partial<T> {
  const changed: Partial<T> = {};
  for (const key of Object.keys(sent) as (keyof T)[]) {
    if (current[key] !== sent[key]) changed[key] = current[key];
  }
  return changed;
}
function rebaseDraft(native: Draft, sent: Draft, current: Draft): Draft {
  const { settings: sentSettings, ...sentFields } = sent;
  const { settings: currentSettings, ...currentFields } = current;
  return { ...native, ...changedFields(sentFields, currentFields),
    settings: { ...native.settings, ...changedFields(sentSettings, currentSettings) } };
}

/** Transport ordering and unsaved editor text only. Never projects business state. */
export class UIController {
  private state: UIState = { snapshot: null, draft: null, dirty: false, pending: null, connectionError: null, commandError: null, workingLogID: null, workingLog: undefined, workingStreamError: null };
  private listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private editVersion = 0;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;
  private stopChanges: (() => void) | null = null;
  private reconnectChanges: (() => void) | null = null;
  private workingStream: WorkingStreamConsumer | null = null;
  private streamActive = false;
  private expectedWorkingLog: WorkingLogMetadata | null = null;
  private displayedStreamLogID: string | null = null;
  constructor(private readonly call: Call, private readonly subscribeChanges: SubscribeChanges = async () => () => {},
    private readonly subscribeWorking?: SubscribeWorking, private readonly workingScheduler?: WorkingFrameScheduler) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<UIState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach(listener => listener());
  }
  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
  private accept(snapshot: Snapshot, ack?: { version: number; sent: Draft }) {
    if (!snapshot?.presentation?.permissions || !snapshot.draft) throw new Error('The native snapshot is incomplete. Reconnect and retry.');
    const changed = !this.state.snapshot || editorIdentity(this.state.snapshot) !== editorIdentity(snapshot);
    const selectionChanged = !this.state.snapshot || selectionIdentity(this.state.snapshot) !== selectionIdentity(snapshot);
    let draft = this.state.draft;
    let dirty = this.state.dirty;
    if (changed || !dirty || ack?.version === this.editVersion) {
      draft = snapshot.draft; dirty = false;
    } else if (ack && draft) {
      // Preserve only edits made after this request, not stale model defaults
      // carried along in the local form while native normalized the model.
      draft = rebaseDraft(snapshot.draft, ack.sent, draft);
      dirty = JSON.stringify(draft) !== JSON.stringify(snapshot.draft);
    }
    if (changed) { ++this.editVersion; clearTimeout(this.saveTimer); }
    if (selectionChanged && this.state.snapshot) {
      this.workingStream?.discard(this.expectedWorkingLog?.id);
      this.expectedWorkingLog = null; this.displayedStreamLogID = null;
      this.publish({ workingLog: this.streamActive ? null : undefined });
    }
    this.publish({ snapshot, draft, dirty, connectionError: snapshot.error || null, ...(selectionChanged ? { workingLogID: null } : {}) });
    return snapshot;
  }
  private async read(active: () => boolean = () => true) {
    try {
      const snapshot = await this.call('snapshot', {});
      if (active()) this.accept(snapshot);
      return snapshot;
    } catch (error) {
      if (active()) this.publish({ connectionError: message(error) });
      throw error;
    }
  }
  // Explicit one-shot projection read; never refreshes Core or the log reader.
  readSnapshot = () => this.enqueue(() => this.read());
  start() {
    this.stopChanges?.();
    const generation = ++this.generation;
    const active = () => generation === this.generation;
    this.streamActive = Boolean(this.subscribeWorking);
    this.publish({ workingLog: this.streamActive ? null : undefined, workingStreamError: null });
    const working = this.subscribeWorking ? new WorkingStreamConsumer(this.subscribeWorking, log => {
      if (!active()) return;
      if (log === undefined) {
        this.streamActive = false; this.publish({ workingLog: undefined });
      } else if (log === null) {
        const closed = this.displayedStreamLogID !== null && this.displayedStreamLogID === this.state.workingLogID;
        this.displayedStreamLogID = null;
        if (closed) this.expectedWorkingLog = null;
        this.publish({ workingLog: closed || !this.expectedWorkingLog ? null : this.state.workingLog,
          ...(closed ? { workingLogID: null } : {}) });
      } else if (sameWorkingLog(log, this.expectedWorkingLog)) {
        this.displayedStreamLogID = log.id;
        this.publish({ workingLog: log });
      } else {
        // A later nil for this rejected identity must not close our newer pane.
        this.displayedStreamLogID = null;
      }
    }, error => { if (active()) this.publish({ workingStreamError: error }); }, this.workingScheduler) : null;
    this.workingStream = working;
    // A reset may arrive before subscription returns. Install its consumer
    // before any normal snapshot (which omits events while streaming).
    const workingReady = working?.start();
    let unlisten: (() => void) | undefined;
    let connecting = false;
    let queued = false;
    let invalidated = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const retryDelays = [250, 1000, 4000];
    const retry = () => {
      if (!active() || retryTimer !== undefined || failures >= retryDelays.length) return;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        if (unlisten) requestRead(); else void connect();
      }, retryDelays[failures++]);
    };
    const requestRead = () => {
      if (!active()) return;
      invalidated = true;
      if (!unlisten || queued || retryTimer !== undefined) return;
      queued = true;
      void this.enqueue(async () => {
        if (!active()) return;
        // Consume all notifications received while waiting behind commands.
        invalidated = false;
        await this.read(active);
        failures = 0;
      }).catch(() => { retry(); }).finally(() => {
        queued = false;
        // A change during encoding/FFI needs exactly one latest-state follow-up.
        if (active() && invalidated && retryTimer === undefined) requestRead();
      });
    };
    const connect = async () => {
      if (!active() || connecting || unlisten) return;
      connecting = true;
      try {
        if (workingReady) await workingReady;
        if (!active()) return;
        const cleanup = await this.subscribeChanges(requestRead);
        if (!active()) { cleanup(); return; }
        unlisten = cleanup;
        // Subscribe first so startup and async completion cannot fall in a gap.
        requestRead();
      } catch (error) {
        if (active()) { this.publish({ connectionError: message(error) }); retry(); }
      } finally { connecting = false; }
    };
    this.reconnectChanges = () => {
      if (!active()) return;
      working?.reconnect();
      failures = 0;
      clearTimeout(retryTimer); retryTimer = undefined;
      // The explicit refresh command returns its own projection. Only repair
      // a failed subscription here; do not insert a read ahead of that command.
      if (!unlisten) void connect();
    };
    const stop = () => {
      if (!active()) return;
      ++this.generation;
      this.stopChanges = null; this.reconnectChanges = null;
      clearTimeout(retryTimer); clearTimeout(this.saveTimer);
      unlisten?.(); unlisten = undefined;
      working?.stop(); this.workingStream = null;
      this.expectedWorkingLog = null; this.displayedStreamLogID = null;
      this.publish({ workingLogID: null, workingLog: null, workingStreamError: null });
    };
    this.stopChanges = stop;
    void connect();
    return stop;
  }
  edit = (draft: Draft): boolean => {
    if (!this.state.snapshot || this.state.pending || this.state.connectionError) return false;
    ++this.editVersion;
    this.publish({ draft, dirty: true, commandError: null });
    clearTimeout(this.saveTimer);
    const identity = editorIdentity(this.state.snapshot);
    this.saveTimer = setTimeout(() => {
      void this.enqueue(() => this.flush(identity)).catch(error => this.publish({ commandError: message(error) }));
    }, 250);
    return true;
  };
  editSettings = (draft: Draft) => { if (this.edit(draft)) void this.checkpoint(); };
  private assertIdentity(identity: string) {
    if (!this.state.snapshot || editorIdentity(this.state.snapshot) !== identity) {
      throw new Error('The selected action changed. Review the current draft before continuing.');
    }
  }
  private async flush(identity: string) {
    this.assertIdentity(identity);
    if (!this.state.dirty || !this.state.draft || !this.state.snapshot) return;
    const version = this.editVersion;
    const sent = structuredClone(this.state.draft);
    this.accept(await this.call('updateDraft', { draft: sent, context: this.state.snapshot.presentation.editor }), { version, sent });
    this.assertIdentity(identity);
  }
  run = async <M extends Command>(method: M, value: Commands[M] | ((snapshot: Snapshot, draft: Draft) => Commands[M])): Promise<boolean> => {
    if (method === 'checkpointDraft') return this.checkpoint();
    if (method === 'closeWorkingLog' && typeof value !== 'function') return this.closeWorkingLog((value as Commands['closeWorkingLog']).id);
    if (this.state.pending) return false;
    if (method === 'refresh') this.reconnectChanges?.();
    const workingGeneration = this.generation;
    const identity = this.state.snapshot ? editorIdentity(this.state.snapshot) : null;
    this.publish({ pending: method, commandError: null });
    clearTimeout(this.saveTimer);
    try {
      await this.enqueue(async () => {
        if (identity) await this.flush(identity);
        const { snapshot, draft } = this.state;
        const gate = permission[method];
        if (gate && !snapshot?.presentation.permissions[gate]) {
          throw new Error(snapshot?.presentation.disabledReason || 'This action is not available in the current state.');
        }
        if (typeof value === 'function' && (!snapshot || !draft)) throw new Error('The native connection is not ready.');
        const payload = typeof value === 'function' ? value(snapshot!, draft!) : value;
        const previousMaterialID = snapshot?.presentation.material?.id;
        const previousLogID = snapshot?.presentation.workingLog?.id;
        if (method === 'refreshWorkingLog' && (payload as Commands['refreshWorkingLog']).id !== this.state.workingLogID) throw new Error('This working log is no longer selected.');
        // This snapshot acknowledges admission, not completion. Native owns busy/results.
        const response = this.accept(await this.call(method, payload));
        if (method === 'selectInteractionLanguage') await this.persistDraft();
        if (method === 'readMaterial') {
          const request = payload as Commands['readMaterial'];
          const material = response.presentation.material;
          if (!material || material.id === previousMaterialID ||
            response.presentation.editor?.actionID !== request.actionID || !materialMatchesRequest(material, request)) {
            throw new Error('The requested material did not open. Try again when the current operation has finished.');
          }
        }
        if (method === 'openWorkingLog') {
          const request = payload as Commands['openWorkingLog'];
          const log = response.presentation.workingLog;
          if (!log || log.id === previousLogID || log.actionID !== request.actionID || log.position !== request.position || response.presentation.editor?.actionID !== request.actionID) {
            throw new Error('The requested working log did not open. Please try again.');
          }
          if (workingGeneration !== this.generation) return;
          this.expectedWorkingLog = log;
          const streamed = this.workingStream?.log;
          const matches = sameWorkingLog(streamed, log);
          this.displayedStreamLogID = matches ? log.id : null;
          this.publish({ workingLogID: log.id,
            workingLog: this.streamActive ? (matches ? streamed! : { ...log, events: [], loading: true }) : undefined });
        }
      });
      return true;
    } catch (error) {
      this.publish({ commandError: message(error) });
      return false;
    } finally {
      this.publish({ pending: null });
    }
  };
  closeWorkingLog = async (id: string): Promise<boolean> => {
    // Dismiss the UI immediately, even if a refresh is in flight. A late native
    // snapshot can update data but cannot restore the explicitly closed route.
    if (this.state.workingLogID === id) {
      this.workingStream?.discard(id);
      this.expectedWorkingLog = null; this.displayedStreamLogID = null;
      this.publish({ workingLogID: null, workingLog: this.streamActive ? null : undefined });
    }
    try {
      await this.enqueue(async () => { this.accept(await this.call('closeWorkingLog', { id })); });
      return true;
    } catch (error) { this.publish({ commandError: message(error) }); return false; }
  };
  send = () => this.run('sendAction', (snapshot, draft) => {
    const p = snapshot.presentation;
    if (!p.editor) throw new Error('Choose an action before sending.');
    if (!p.canOmitInstructions && !draft.instructions.trim()) throw new Error('Add instructions for this revision.');
    return { context: p.editor, instructions: draft.instructions, settings: draft.settings,
      initialLanguage: p.initialSettingsFrozen ? null : draft.outputLanguage,
      interactionLanguage: p.interactionLanguage, consent: draft.consent };
  });
  checkpoint = async (): Promise<boolean> => {
    // Settings changes and lifecycle saves share the transport queue without
    // turning the workspace into a temporary loading/disabled screen.
    clearTimeout(this.saveTimer);
    try {
      await this.enqueue(async () => {
        if (this.state.snapshot) await this.flush(editorIdentity(this.state.snapshot));
        await this.persistDraft();
        // Persistence has no presentation payload to apply. The next native
        // change notification owns updates; newer local edits must survive this acknowledgement.
      });
      return true;
    } catch (error) {
      this.publish({ commandError: message(error) });
      return false;
    }
  };
  private async persistDraft() {
    const response = await this.call('checkpointDraft', {});
    if (response.error) throw new Error(response.error);
  }
}
