import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Call, SubscribeWorking, WorkingLog, WorkingStreamFrame, WorkingSubscription } from '../contract';
import { UIController } from '../controller';
import { fixtureWorking, makeFixture } from '../devFixture';
import { MAX_WORKING_FRAME_BYTES, WorkingStreamConsumer, WorkingStreamReducer } from '../working-stream';
import type { WorkingFrameScheduler } from '../working-stream';

function log(id = 'pane'): WorkingLog {
  return { id, actionID: 'qa-action', position: 1, revisionIndex: 0, startedAt: null, endedAt: null,
    events: fixtureWorking(0).events.slice(0, 2), criticPassed: false, loading: false, failed: false,
    limited: false, superseded: false, progressing: true, error: null };
}
function frame(value: WorkingLog | null = log(), patch: Partial<WorkingStreamFrame> = {}): WorkingStreamFrame {
  const { events = [], ...metadata } = value ?? {};
  return { schemaVersion: 1, subscriptionID: 1, sequence: 1, baseSequence: 0, reset: true,
    log: value ? metadata as WorkingStreamFrame['log'] : null, events,
    removed: [], order: events.map(item => item.id), ...patch };
}
function paintScheduler() {
  let next = 0;
  const jobs = new Map<number, () => void>();
  const schedule: WorkingFrameScheduler = ready => { const id = ++next; jobs.set(id, ready); return () => { jobs.delete(id); }; };
  return { schedule, get size() { return jobs.size; }, paint() {
    const batch = [...jobs.values()]; jobs.clear(); batch.forEach(ready => ready());
  } };
}
function transport(initial?: (id: number) => WorkingStreamFrame) {
  const sessions: { subscription: WorkingSubscription; emit: (frame: WorkingStreamFrame) => void }[] = [];
  const subscribe = vi.fn<SubscribeWorking>(async emit => {
    const subscriptionID = sessions.length + 1;
    const subscription = { subscriptionID, ack: vi.fn(async (_sequence: number) => {}), unsubscribe: vi.fn(async () => {}) };
    sessions.push({ subscription, emit });
    if (initial) emit(initial(subscriptionID));
    return subscription;
  });
  return { subscribe, sessions };
}
const settle = () => vi.advanceTimersByTimeAsync(0);
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

it('applies reset and skipped-sequence delta with complete order, removals, and stable unchanged event objects', () => {
  const reducer = new WorkingStreamReducer(), original = log();
  expect(reducer.apply(frame(original))).toBe('applied');
  const retained = reducer.log!.events[1];
  const changed = { ...original.events[0], detail: 'latest text' };
  expect(reducer.apply(frame(original, { reset: false, sequence: 7, baseSequence: 1,
    events: [changed], order: [retained.id, changed.id] }))).toBe('applied');
  expect(reducer.log!.events).toEqual([retained, changed]);
  expect(reducer.log!.events[0]).toBe(retained);
  expect(reducer.apply(frame(original, { reset: false, sequence: 9, baseSequence: 7,
    events: [], removed: [changed.id], order: [retained.id] }))).toBe('applied');
  expect(reducer.log!.events).toEqual([retained]);
});
it('ignores duplicate/stale closes and rejects base gaps atomically', () => {
  const reducer = new WorkingStreamReducer(); reducer.apply(frame());
  expect(reducer.apply(frame(null))).toBe('duplicate'); expect(reducer.log?.id).toBe('pane');
  expect(reducer.apply(frame(log(), { reset: false, sequence: 5, baseSequence: 3 }))).toBe('gap');
  expect(reducer.sequence).toBe(1); expect(reducer.log?.id).toBe('pane');
  expect(reducer.apply(frame(null, { reset: false, sequence: 6, baseSequence: 1 }))).toBe('applied');
  expect(reducer.log).toBeNull();
});
it.each(['id', 'actionID', 'position', 'revisionIndex'] as const)('rejects a delta for a different %s', key => {
  const reducer = new WorkingStreamReducer(); reducer.apply(frame());
  const other = log(); Object.assign(other, { [key]: typeof other[key] === 'number' ? 9 : 'other' });
  expect(reducer.apply(frame(other, { sequence: 2, baseSequence: 1, reset: false }))).toBe('gap');
  expect(reducer.log).toEqual(log());
});
it('requires the first reset and a zero initial base, and resets replace all events', () => {
  const reducer = new WorkingStreamReducer();
  expect(reducer.apply(frame(log(), { reset: false }))).toBe('gap');
  expect(reducer.apply(frame(log(), { sequence: 2, baseSequence: 1 }))).toBe('gap');
  reducer.apply(frame());
  const newer = log('new'); newer.events = [];
  expect(reducer.apply(frame(newer, { sequence: 8, baseSequence: 1 }))).toBe('applied');
  expect(reducer.log).toEqual(newer);
});
it('rejects duplicate order IDs, unknown IDs, duplicate changed IDs, and metadata containing events', () => {
  const invalid = [frame(log(), { order: ['missing'] }), frame(log(), { order: ['same', 'same'] }),
    frame(log(), { events: [log().events[0], log().events[0]] }), frame(log(), { log: log() })];
  for (const value of invalid) expect(new WorkingStreamReducer().apply(value)).toBe('gap');
});
it('enforces exactly 8 MiB of UTF-8 JSON and at most 512 events', () => {
  const full = frame();
  const baseline = new TextEncoder().encode(JSON.stringify(full)).byteLength;
  full.events[0].detail += 'x'.repeat(MAX_WORKING_FRAME_BYTES - baseline);
  expect(new TextEncoder().encode(JSON.stringify(full)).byteLength).toBe(MAX_WORKING_FRAME_BYTES);
  expect(new WorkingStreamReducer().apply(full)).toBe('applied');
  full.events[0].detail += '界';
  expect(new WorkingStreamReducer().apply(full)).toBe('gap');
  const many = log(); many.events = Array.from({ length: 512 }, (_, index) => ({ ...log().events[0], id: String(index) }));
  expect(new WorkingStreamReducer().apply(frame(many))).toBe('applied');
  many.events.push({ ...many.events[0], id: 'overflow' });
  expect(new WorkingStreamReducer().apply(frame(many))).toBe('gap');
});

it('publishes before ACK and waits for a paint opportunity, with zero idle work while hidden', async () => {
  const t = transport(), scheduler = paintScheduler(), applied = vi.fn(), failed = vi.fn();
  const consumer = new WorkingStreamConsumer(t.subscribe, applied, failed, scheduler.schedule); await consumer.start();
  const { emit, subscription } = t.sessions[0]; emit(frame());
  expect(applied).toHaveBeenCalledWith(log()); expect(subscription.ack).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60000);
  expect(subscription.ack).not.toHaveBeenCalled(); expect(t.subscribe).toHaveBeenCalledTimes(1);
  expect(scheduler.size).toBe(1); expect(vi.getTimerCount()).toBe(0);
  scheduler.paint(); await settle(); expect(subscription.ack).toHaveBeenCalledExactlyOnceWith(1);
  consumer.stop(); expect(subscription.unsubscribe).toHaveBeenCalledTimes(1);
});
it('uses and cancels the real animation-frame scheduler on cleanup', async () => {
  const request = vi.fn(() => 27), cancel = vi.fn();
  vi.stubGlobal('requestAnimationFrame', request); vi.stubGlobal('cancelAnimationFrame', cancel);
  const t = transport(), consumer = new WorkingStreamConsumer(t.subscribe, () => {}, () => {});
  await consumer.start(); t.sessions[0].emit(frame());
  expect(request).toHaveBeenCalledTimes(1); consumer.stop();
  expect(cancel).toHaveBeenCalledWith(27); expect(t.sessions[0].subscription.ack).not.toHaveBeenCalled();
});
it('buffers the reset that arrives before subscribe resolves and ACKs it only once', async () => {
  const t = transport(id => frame(null, { subscriptionID: id })), scheduler = paintScheduler(), applied = vi.fn();
  const consumer = new WorkingStreamConsumer(t.subscribe, applied, () => {}, scheduler.schedule);
  await consumer.start(); expect(applied).toHaveBeenCalledExactlyOnceWith(null);
  t.sessions[0].emit(frame(null)); scheduler.paint(); await settle(); t.sessions[0].emit(frame(null));
  expect(t.sessions[0].subscription.ack).toHaveBeenCalledExactlyOnceWith(1);
  expect(applied).toHaveBeenCalledTimes(1); consumer.stop();
});
it('keeps only one successor while an ACK invoke is unresolved, including synchronous delivery from native ACK', async () => {
  const t = transport(), scheduler = paintScheduler(), applied = vi.fn();
  const consumer = new WorkingStreamConsumer(t.subscribe, applied, () => {}, scheduler.schedule); await consumer.start();
  const { subscription, emit } = t.sessions[0]; let finish!: () => void;
  vi.mocked(subscription.ack).mockImplementationOnce(async () => {
    emit(frame(log(), { sequence: 2, baseSequence: 1, reset: false }));
    await new Promise<void>(resolve => { finish = resolve; });
  });
  emit(frame()); scheduler.paint(); expect(applied).toHaveBeenCalledTimes(1);
  expect(scheduler.size).toBe(0); finish(); await settle();
  expect(applied).toHaveBeenCalledTimes(2); expect(scheduler.size).toBe(1);
  scheduler.paint(); await settle(); expect(subscription.ack).toHaveBeenCalledTimes(2); consumer.stop();
});
it('rejects excess frames without an unbounded queue and cancels pending paint', async () => {
  const t = transport(), scheduler = paintScheduler(), failed = vi.fn();
  const consumer = new WorkingStreamConsumer(t.subscribe, () => {}, failed, scheduler.schedule); await consumer.start();
  const { emit, subscription } = t.sessions[0]; emit(frame());
  emit(frame(log(), { sequence: 2, baseSequence: 1 })); emit(frame(log(), { sequence: 3, baseSequence: 2 }));
  expect(failed).toHaveBeenCalledWith(expect.stringContaining('one-frame'));
  expect(subscription.unsubscribe).toHaveBeenCalledTimes(1); expect(scheduler.size).toBe(0);
  expect(subscription.ack).not.toHaveBeenCalled(); consumer.stop(); expect(vi.getTimerCount()).toBe(0);
});
it('ACKs a rejected gap only to its old subscription then reconnects; stale closes cannot touch the new generation', async () => {
  const t = transport(), scheduler = paintScheduler(), applied = vi.fn();
  const consumer = new WorkingStreamConsumer(t.subscribe, applied, () => {}, scheduler.schedule); await consumer.start();
  t.sessions[0].emit(frame()); scheduler.paint(); await settle();
  t.sessions[0].emit(frame(log(), { sequence: 5, baseSequence: 3, reset: false }));
  scheduler.paint(); await settle(); expect(t.sessions[0].subscription.ack).toHaveBeenLastCalledWith(5);
  await vi.advanceTimersByTimeAsync(250); expect(t.sessions).toHaveLength(2);
  t.sessions[1].emit(frame(log('new'), { subscriptionID: 2 }));
  t.sessions[0].emit(frame(null, { sequence: 6, baseSequence: 5 }));
  expect(consumer.log?.id).toBe('new'); expect(applied).toHaveBeenCalledTimes(2);
  scheduler.paint(); await settle(); expect(t.sessions[1].subscription.ack).toHaveBeenCalledExactlyOnceWith(1); consumer.stop();
});
it('retains discarded pane identity through reconnect and never caches its new reset', async () => {
  const t = transport(), scheduler = paintScheduler(), applied = vi.fn();
  const consumer = new WorkingStreamConsumer(t.subscribe, applied, () => {}, scheduler.schedule); await consumer.start();
  t.sessions[0].emit(frame()); scheduler.paint(); await settle(); consumer.discard('pane');
  t.sessions[0].emit(frame(log(), { sequence: 2, baseSequence: 1 })); scheduler.paint(); await settle();
  expect(consumer.log).toBeNull(); expect(applied).toHaveBeenCalledTimes(1);
  t.sessions[0].emit({ subscriptionID: 1 } as WorkingStreamFrame); await vi.advanceTimersByTimeAsync(250);
  t.sessions[1].emit(frame(log(), { subscriptionID: 2 })); scheduler.paint(); await settle();
  expect(consumer.log).toBeNull(); expect(applied).toHaveBeenCalledTimes(1);
  expect(t.sessions[1].subscription.ack).toHaveBeenCalledExactlyOnceWith(1); consumer.stop();
});
it('bounds failed reconnects, explicit reconnect rearms them, and stop releases a late subscription', async () => {
  const subscribe = vi.fn<SubscribeWorking>(async () => { throw new Error('offline'); });
  const consumer = new WorkingStreamConsumer(subscribe, () => {}, () => {}); await consumer.start();
  await vi.advanceTimersByTimeAsync(60000); expect(subscribe).toHaveBeenCalledTimes(4); expect(vi.getTimerCount()).toBe(0);
  consumer.reconnect(); await settle(); expect(subscribe).toHaveBeenCalledTimes(5); consumer.stop();
  let resolve!: (value: WorkingSubscription) => void;
  const delayed = new WorkingStreamConsumer(() => new Promise(done => { resolve = done; }), () => {}, () => {});
  const started = delayed.start(); delayed.stop();
  const session = { subscriptionID: 1, ack: vi.fn(), unsubscribe: vi.fn(async () => {}) };
  resolve(session); await started; expect(session.unsubscribe).toHaveBeenCalledTimes(1);
});
it('ACK failure reconnects without advancing any newer subscription', async () => {
  const t = transport(), scheduler = paintScheduler();
  const consumer = new WorkingStreamConsumer(t.subscribe, () => {}, () => {}, scheduler.schedule); await consumer.start();
  vi.mocked(t.sessions[0].subscription.ack).mockRejectedValueOnce(new Error('closed'));
  t.sessions[0].emit(frame()); scheduler.paint(); await settle(); await vi.advanceTimersByTimeAsync(250);
  expect(t.sessions).toHaveLength(2); expect(t.sessions[0].subscription.unsubscribe).toHaveBeenCalledTimes(1);
  expect(t.sessions[1].subscription.ack).not.toHaveBeenCalled(); consumer.stop();
});

async function controllerHarness() {
  const fixture = makeFixture(), t = transport(id => frame(null, { subscriptionID: id })), scheduler = paintScheduler();
  const call: Call = async (method, value) => {
    const response = await fixture.transport.call(method, value);
    if (response.presentation.workingLog) response.presentation.workingLog.events = [];
    return response;
  };
  const controller = new UIController(call, fixture.transport.subscribeChanges, t.subscribe, scheduler.schedule);
  const stop = controller.start(); await settle(); scheduler.paint(); await settle();
  return { fixture, t, scheduler, controller, stop };
}
it('subscribes before snapshot; initial nil allows later opens and native snapshots never wipe newer stream data', async () => {
  const { fixture, t, scheduler, controller, stop } = await controllerHarness();
  expect(t.subscribe).toHaveBeenCalledTimes(1); expect(fixture.calls[0].method).toBe('snapshot');
  expect(await controller.run('openWorkingLog', { actionID: 'qa-action', position: 1 })).toBe(true);
  const current = structuredClone(fixture.snapshot.presentation.workingLog!);
  expect(controller.getSnapshot().workingLogID).toBe(current.id);
  t.sessions[0].emit(frame(current, { sequence: 2, baseSequence: 1 })); scheduler.paint(); await settle();
  const displayed = controller.getSnapshot().workingLog;
  fixture.snapshot.presentation.workingLog!.loading = true; fixture.snapshot.presentation.workingLog!.events = [];
  await controller.readSnapshot();
  expect(controller.getSnapshot().workingLog).toBe(displayed);
  expect(controller.getSnapshot().workingLog?.events.length).toBeGreaterThan(0);
  expect(controller.getSnapshot().workingLog?.loading).toBe(false);
  expect(controller.getSnapshot().snapshot?.presentation.workingLog?.loading).toBe(true); stop();
});
it('admits by normal metadata even when a stream reset arrives before the open response', async () => {
  const fixture = makeFixture(), t = transport(), scheduler = paintScheduler();
  const call: Call = async (method, value) => {
    const result = await fixture.transport.call(method, value);
    if (method === 'openWorkingLog') {
      t.sessions[0].emit(frame(result.presentation.workingLog!));
      result.presentation.workingLog!.events = [];
    }
    return result;
  };
  const controller = new UIController(call, fixture.transport.subscribeChanges, t.subscribe, scheduler.schedule);
  const stop = controller.start(); await settle();
  expect(await controller.run('openWorkingLog', { actionID: 'qa-action', position: 1 })).toBe(true);
  expect(controller.getSnapshot().workingLog?.events.length).toBeGreaterThan(0); stop();
});
it('clears on close, ignores late closed frames, preserves a newer pane against stale close, then accepts native nil', async () => {
  const { fixture, t, scheduler, controller, stop } = await controllerHarness();
  await controller.run('openWorkingLog', { actionID: 'qa-action', position: 1 });
  const old = structuredClone(fixture.snapshot.presentation.workingLog!);
  t.sessions[0].emit(frame(old, { sequence: 2, baseSequence: 1 })); scheduler.paint(); await settle();
  await controller.closeWorkingLog(old.id);
  t.sessions[0].emit(frame(old, { sequence: 3, baseSequence: 2 })); scheduler.paint(); await settle();
  expect(controller.getSnapshot().workingLog).toBeNull(); expect(controller.getSnapshot().workingLogID).toBeNull();
  await controller.run('openWorkingLog', { actionID: 'qa-action', position: 2 });
  const current = structuredClone(fixture.snapshot.presentation.workingLog!);
  t.sessions[0].emit(frame(current, { sequence: 4, baseSequence: 3 })); scheduler.paint(); await settle();
  await controller.closeWorkingLog(old.id);
  expect(controller.getSnapshot().workingLog?.id).toBe(current.id); expect(controller.getSnapshot().workingLogID).toBe(current.id);
  t.sessions[0].emit(frame(null, { sequence: 5, baseSequence: 4, reset: false })); scheduler.paint(); await settle();
  expect(controller.getSnapshot().workingLogID).toBeNull(); expect(controller.getSnapshot().workingLog).toBeNull(); stop();
});
it('selection changes clear stream state while same-action editor tokens preserve it, and stop cancels pending ACK', async () => {
  const { fixture, t, scheduler, controller, stop } = await controllerHarness();
  await controller.run('openWorkingLog', { actionID: 'qa-action', position: 1 });
  const current = structuredClone(fixture.snapshot.presentation.workingLog!);
  t.sessions[0].emit(frame(current, { sequence: 2, baseSequence: 1 })); scheduler.paint(); await settle();
  fixture.snapshot.presentation.editor!.editorToken = 'new-token'; await controller.readSnapshot();
  expect(controller.getSnapshot().workingLog?.id).toBe(current.id);
  fixture.snapshot.presentation.editor!.actionID = 'new-action'; await controller.readSnapshot();
  expect(controller.getSnapshot().workingLog).toBeNull(); expect(controller.getSnapshot().workingLogID).toBeNull();
  t.sessions[0].emit(frame(current, { sequence: 3, baseSequence: 2, reset: false }));
  stop(); expect(scheduler.size).toBe(0); expect(t.sessions[0].subscription.ack).toHaveBeenCalledTimes(2);
  expect(t.sessions[0].subscription.unsubscribe).toHaveBeenCalledTimes(1);
});

it('publication errors stay inside the channel callback and cancel the failed subscription without ACK', async () => {
  const t = transport(), scheduler = paintScheduler(), failed = vi.fn();
  const consumer = new WorkingStreamConsumer(t.subscribe, () => { throw new Error('state publication failed'); }, failed, scheduler.schedule);
  await consumer.start(); expect(() => t.sessions[0].emit(frame())).not.toThrow();
  expect(failed).toHaveBeenCalledWith('state publication failed');
  expect(t.sessions[0].subscription.ack).not.toHaveBeenCalled();
  expect(t.sessions[0].subscription.unsubscribe).toHaveBeenCalledTimes(1); consumer.stop();
});
it('an open admission from an old mount cannot reopen after teardown', async () => {
  const fixture = makeFixture(), t = transport(), scheduler = paintScheduler();
  let complete!: () => void;
  const call: Call = async (method, value) => {
    const result = await fixture.transport.call(method, value);
    if (method === 'openWorkingLog') await new Promise<void>(resolve => { complete = resolve; });
    return result;
  };
  const controller = new UIController(call, fixture.transport.subscribeChanges, t.subscribe, scheduler.schedule);
  const stop = controller.start(); await settle();
  const opening = controller.run('openWorkingLog', { actionID: 'qa-action', position: 1 }); await settle();
  stop(); complete(); await opening;
  expect(controller.getSnapshot().workingLogID).toBeNull(); expect(controller.getSnapshot().workingLog).toBeNull();
});
it('a rejected stale identity and its later nil cannot close a newer displayed pane', async () => {
  const { fixture, t, scheduler, controller, stop } = await controllerHarness();
  await controller.run('openWorkingLog', { actionID: 'qa-action', position: 1 });
  const current = structuredClone(fixture.snapshot.presentation.workingLog!);
  t.sessions[0].emit(frame(current, { sequence: 2, baseSequence: 1 })); scheduler.paint(); await settle();
  t.sessions[0].emit(frame(log('unselected'), { sequence: 3, baseSequence: 2 })); scheduler.paint(); await settle();
  expect(controller.getSnapshot().workingLog?.id).toBe(current.id);
  t.sessions[0].emit(frame(null, { sequence: 4, baseSequence: 3 })); scheduler.paint(); await settle();
  expect(controller.getSnapshot().workingLogID).toBe(current.id); expect(controller.getSnapshot().workingLog?.id).toBe(current.id); stop();
});
