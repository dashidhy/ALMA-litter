import type { SubscribeWorking, WorkingEvent, WorkingLog, WorkingLogMetadata, WorkingStreamFrame, WorkingSubscription } from './contract';

export const MAX_WORKING_FRAME_BYTES = 8 * 1024 * 1024;
export const MAX_WORKING_EVENTS = 512;
export type WorkingFrameScheduler = (ready: () => void) => () => void;
const afterRenderOpportunity: WorkingFrameScheduler = ready => {
  const id = requestAnimationFrame(ready);
  return () => cancelAnimationFrame(id);
};

export function sameWorkingLog(a: WorkingLogMetadata | null | undefined, b: WorkingLogMetadata | null | undefined): boolean {
  return Boolean(a && b && a.id === b.id && a.actionID === b.actionID && a.position === b.position && a.revisionIndex === b.revisionIndex);
}
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const counter = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const nullableString = (value: unknown) => value === null || typeof value === 'string';
function metadata(value: unknown): value is WorkingLogMetadata {
  return record(value) && !('events' in value) && typeof value.id === 'string' && typeof value.actionID === 'string' &&
    (value.position === null || counter(value.position)) && counter(value.revisionIndex) &&
    nullableString(value.startedAt) && nullableString(value.endedAt) && nullableString(value.error) &&
    ['criticPassed', 'loading', 'failed', 'limited', 'superseded', 'progressing'].every(key => typeof value[key] === 'boolean');
}
function event(value: unknown): value is WorkingEvent {
  return record(value) && ['id', 'title', 'detail', 'role', 'kind'].every(key => typeof value[key] === 'string') &&
    nullableString(value.titleCode) && nullableString(value.status) && typeof value.detailTruncated === 'boolean' &&
    (value.round === null || counter(value.round));
}
function frameShape(value: unknown): value is WorkingStreamFrame {
  return record(value) && value.schemaVersion === 1 && counter(value.subscriptionID) && value.subscriptionID > 0 &&
    counter(value.sequence) && value.sequence > 0 && counter(value.baseSequence) && value.baseSequence < value.sequence &&
    typeof value.reset === 'boolean' && (value.log === null || metadata(value.log)) &&
    Array.isArray(value.events) && value.events.length <= MAX_WORKING_EVENTS && value.events.every(event) &&
    Array.isArray(value.removed) && value.removed.length <= MAX_WORKING_EVENTS && value.removed.every(id => typeof id === 'string') &&
    Array.isArray(value.order) && value.order.length <= MAX_WORKING_EVENTS && value.order.every(id => typeof id === 'string') &&
    new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_WORKING_FRAME_BYTES;
}

/** Render-only transport reconciliation. Sequence numbers can skip; bases cannot. */
export class WorkingStreamReducer {
  sequence = 0;
  log: WorkingLog | null = null;
  private discardedID: string | undefined;
  discard(id = this.log?.id) { this.discardedID = id; this.log = null; }
  apply(frame: WorkingStreamFrame): 'applied' | 'duplicate' | 'rejected' | 'gap' {
    if (frame.sequence <= this.sequence) return 'duplicate';
    if (!frameShape(frame) || (this.sequence === 0 && (!frame.reset || frame.baseSequence !== 0)) ||
      (!frame.reset && frame.baseSequence !== this.sequence)) return 'gap';
    // A closed route can still have one old frame in flight. Consume its
    // sequence without retaining its events or reopening that route.
    if (frame.log && frame.log.id === this.discardedID) {
      this.sequence = frame.sequence;
      return 'rejected';
    }
    if (frame.log === null) {
      if (frame.events.length || frame.order.length) return 'gap';
      this.log = null; this.sequence = frame.sequence;
      return 'applied';
    }
    if (!frame.reset && !sameWorkingLog(this.log, frame.log)) return 'gap';
    const events = new Map((frame.reset ? [] : this.log?.events ?? []).map(item => [item.id, item]));
    if (new Set(frame.order).size !== frame.order.length || new Set(frame.removed).size !== frame.removed.length ||
      new Set(frame.events.map(item => item.id)).size !== frame.events.length) return 'gap';
    const removed = new Set(frame.removed);
    for (const id of removed) events.delete(id);
    for (const item of frame.events) {
      if (removed.has(item.id)) return 'gap';
      events.set(item.id, item);
    }
    if (events.size !== frame.order.length || frame.order.some(id => !events.has(id))) return 'gap';
    this.log = { ...frame.log, events: frame.order.map(id => events.get(id)!) };
    this.sequence = frame.sequence;
    return 'applied';
  }
}

/** One subscription, one pending frame, and one ACK invocation at a time. */
export class WorkingStreamConsumer {
  private generation = 0;
  private running = true;
  private session: WorkingSubscription | null = null;
  private reducer = new WorkingStreamReducer();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private failures = 0;
  private connecting = false;
  private cancelFrame: (() => void) | null = null;
  private discardedID: string | undefined;
  constructor(private readonly subscribe: SubscribeWorking,
    private readonly applied: (log: WorkingLog | null | undefined) => void,
    private readonly failed: (error: string | null) => void,
    private readonly schedule: WorkingFrameScheduler = afterRenderOpportunity) {}
  get log() { return this.reducer.log; }
  discard(id = this.reducer.log?.id) { this.discardedID = id; this.reducer.discard(id); }
  start = () => this.connect();
  reconnect = () => {
    if (!this.running || this.session || this.connecting) return;
    this.failures = 0; clearTimeout(this.retryTimer); this.retryTimer = undefined;
    void this.connect();
  };
  stop = () => {
    this.running = false; ++this.generation;
    clearTimeout(this.retryTimer); this.retryTimer = undefined;
    this.cancelFrame?.(); this.cancelFrame = null;
    const session = this.session; this.session = null;
    void session?.unsubscribe().catch(() => {});
    this.reducer.discard();
  };
  private recover(error: unknown, generation: number) {
    if (!this.running || generation !== this.generation) return;
    ++this.generation;
    this.cancelFrame?.(); this.cancelFrame = null;
    const session = this.session; this.session = null;
    void session?.unsubscribe().catch(() => {});
    this.failed(error instanceof Error ? error.message : 'The working stream disconnected. Reconnect and retry.');
    const delays = [250, 1000, 4000];
    if (this.failures < delays.length) this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined; void this.connect();
    }, delays[this.failures++]);
  }
  private async connect() {
    if (!this.running || this.connecting || this.session) return;
    this.connecting = true;
    const generation = ++this.generation;
    const active = () => this.running && generation === this.generation;
    const reducer = new WorkingStreamReducer();
    reducer.discard(this.discardedID);
    this.reducer = reducer;
    let session: WorkingSubscription | null = null;
    let waiting: WorkingStreamFrame | undefined;
    let acknowledging = false;
    let ackSequence = 0;
    const consume = (frame: WorkingStreamFrame) => {
      if (!active()) return;
      // Validate before touching state; an error envelope from Rust follows
      // the same bounded recovery path as malformed JSON or an invalid base.
      if (!record(frame) || !counter(frame.sequence) || frame.sequence === 0) {
        this.recover(new Error('Invalid working stream frame. Reconnecting.'), generation); return;
      }
      if (session && frame.subscriptionID !== session.subscriptionID) return;
      if (frame.sequence <= ackSequence) return;
      if (!session || acknowledging) {
        if (waiting && waiting.sequence !== frame.sequence) {
          this.recover(new Error('Working stream exceeded its one-frame window.'), generation);
        } else waiting = frame;
        return;
      }
      const result = reducer.apply(frame);
      if (result === 'duplicate') return;
      if (result === 'applied') {
        this.reducer = reducer;
        // Synchronous external-store publication happens BEFORE consumer ACK.
        this.applied(reducer.log);
        this.failed(null);
      }
      ackSequence = frame.sequence;
      acknowledging = true;
      this.cancelFrame = this.schedule(() => {
        this.cancelFrame = null;
        if (!active()) return;
        void session!.ack(frame.sequence).then(() => {
          if (!active()) return;
          acknowledging = false;
          if (result === 'gap') {
            this.recover(new Error('Working stream base changed. Reconnecting.'), generation); return;
          }
          if (waiting) { const next = waiting; waiting = undefined; receive(next); }
        }).catch(error => this.recover(error, generation));
      });
    };
    const receive = (frame: WorkingStreamFrame) => {
      // Never let a publication/validation exception escape Channel.onmessage:
      // that would interrupt Tauri's own ordered callback bookkeeping.
      try { consume(frame); } catch (error) { this.recover(error, generation); }
    };
    try {
      const subscription = await this.subscribe(receive);
      if (!active()) { void subscription?.unsubscribe().catch(() => {}); return; }
      session = subscription; this.session = subscription;
      this.reducer = reducer;
      if (!session) { this.applied(undefined); return; }
      if (!counter(session.subscriptionID) || session.subscriptionID === 0) throw new Error('Invalid working subscription.');
      if (waiting) { const first = waiting; waiting = undefined; receive(first); }
    } catch (error) { this.recover(error, generation); }
    finally { this.connecting = false; }
  }
}
