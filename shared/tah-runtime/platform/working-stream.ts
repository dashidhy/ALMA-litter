import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppBridgeError } from '../upstream/src/app-runtime/bridge.js';
import type { AppPresentationTracker } from '../upstream/src/app-runtime/presentation.js';

export type WorkingEvent = ReturnType<AppPresentationTracker['snapshot']>['events'][number];
export type WorkingView = {
  actionID: string; operationID: string; events: WorkingEvent[];
  limited: boolean; phase: string; finished: boolean;
};
export type WorkingViewSource = {workingView(actionID: string, operationID: string): WorkingView};
export type WorkingFrame = WorkingView & {
  schemaVersion: 1; streamID: string; baseRevision: number; revision: number;
  reset: boolean; removed: string[]; order: string[];
};
const identity = z.uuid().transform(value => value.toLowerCase());
const openSchema = z.strictObject({actionID: identity, operationID: identity});
const nextSchema = z.strictObject({streamID: identity, afterRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER)});
const closeSchema = z.strictObject({streamID: identity});
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppBridgeError('invalid_request');
  return result.data;
}
function equalEvent(a: WorkingEvent, b: WorkingEvent): boolean {
  const keys = Object.keys(a) as (keyof WorkingEvent)[];
  return keys.length === Object.keys(b).length && keys.every(key => a[key] === b[key]);
}
const copy = (view: WorkingView): WorkingView => ({...view, events: view.events.map(event => ({...event}))});

/** One ACK-driven read session per runtime; no timer, journal, or update queue.
 * afterRevision must equal the latest delivered revision. Duplicate reads are
 * safe while unchanged; once a frame advances, an old ACK is invalid_request.
 * A new valid Open invalidates the old session even if its source is unavailable.
 */
export class WorkingStream {
  #session: {streamID: string; revision: number; baseline: WorkingView} | undefined;
  constructor(private readonly source: () => WorkingViewSource) {}
  #read(actionID: string, operationID: string): WorkingView {
    const view = this.source().workingView(actionID, operationID);
    // The accessor must prove ownership. Never accept a different scope or
    // fabricate completion after it disappears (including process restart).
    if (view.actionID !== actionID || view.operationID !== operationID) throw new AppBridgeError('unavailable');
    return view;
  }
  open(value: unknown): WorkingFrame {
    const {actionID, operationID} = parse(openSchema, value);
    this.clear();
    const view = this.#read(actionID, operationID), streamID = randomUUID();
    this.#session = {streamID, revision: 1, baseline: copy(view)};
    return {...view, schemaVersion: 1, streamID, baseRevision: 0, revision: 1,
      reset: true, removed: [], order: view.events.map(event => event.id)};
  }
  next(value: unknown): WorkingFrame | {unchanged: true; streamID: string; revision: number} {
    const {streamID, afterRevision} = parse(nextSchema, value), session = this.#session;
    if (!session || streamID !== session.streamID) throw new AppBridgeError('unavailable');
    if (afterRevision !== session.revision) throw new AppBridgeError('invalid_request');
    const previous = session.baseline;
    let view: WorkingView;
    try { view = this.#read(previous.actionID, previous.operationID); }
    catch (error) { this.clear(); throw error; }
    const old = new Map(previous.events.map(event => [event.id, event]));
    const current = new Set(view.events.map(event => event.id));
    const events = view.events.filter(event => !old.has(event.id) || !equalEvent(old.get(event.id)!, event));
    const removed = previous.events.filter(event => !current.has(event.id)).map(event => event.id);
    const order = view.events.map(event => event.id);
    const sameOrder = order.length === previous.events.length && order.every((id, i) => id === previous.events[i]!.id);
    if (!events.length && !removed.length && sameOrder && view.limited === previous.limited
      && view.phase === previous.phase && view.finished === previous.finished)
      return {unchanged: true, streamID, revision: session.revision};
    if (session.revision === Number.MAX_SAFE_INTEGER) { this.clear(); throw new AppBridgeError('unavailable'); }
    const baseRevision = session.revision;
    session.baseline = copy(view); session.revision++;
    return {...view, schemaVersion: 1, streamID, baseRevision, revision: session.revision,
      reset: false, events, removed, order};
  }
  close(value: unknown): {closed: true; streamID: string} {
    const {streamID} = parse(closeSchema, value);
    if (!this.#session || this.#session.streamID !== streamID) throw new AppBridgeError('unavailable');
    this.clear();
    return {closed: true, streamID};
  }
  clear(): void { this.#session = undefined; }
}
