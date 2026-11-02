import { afterEach, expect, it, vi } from 'vitest';
import type { Call, SubscribeChanges } from '../contract';
import { UIController } from '../controller';
import { makeFixture } from '../devFixture';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

it.each(['idle', 'busy', 'starting', 'material', 'log'])('has zero healthy periodic reads while %s', async mode => {
  vi.useFakeTimers(); const fixture = makeFixture();
  if (mode === 'busy') fixture.snapshot.presentation.isBusy = true;
  if (mode === 'starting') fixture.snapshot.ready = false;
  if (mode === 'material') fixture.snapshot.presentation.material = { id: 'loading', title: '', text: null, markdown: false, isLoading: true, error: null };
  if (mode === 'log') fixture.snapshot.presentation.workingLog = { id: 'log', actionID: 'qa-action', position: null, revisionIndex: 0, startedAt: null, endedAt: null, events: [], criticPassed: false, loading: true, failed: false, limited: false, superseded: false, progressing: true, error: null };
  const controller = new UIController(fixture.transport.call as Call, fixture.transport.subscribeChanges);
  const stop = controller.start();
  await vi.advanceTimersByTimeAsync(60000);
  expect(fixture.calls.map(c => c.method)).toEqual(['snapshot']);
  expect(vi.getTimerCount()).toBe(0); stop();
});

it('subscribes before reading and folds events during subscription into the first read', async () => {
  vi.useFakeTimers(); const fixture = makeFixture(), subscription = gate();
  const cleanup = vi.fn(); let changed!: () => void;
  const subscribe: SubscribeChanges = async listener => { changed = listener; await subscription.promise; return cleanup; };
  const controller = new UIController(fixture.transport.call as Call, subscribe); const stop = controller.start();
  changed(); await vi.advanceTimersByTimeAsync(1000); expect(fixture.calls).toHaveLength(0);
  subscription.release(); await vi.advanceTimersByTimeAsync(0);
  expect(fixture.calls).toHaveLength(1); stop(); expect(cleanup).toHaveBeenCalledTimes(1);
});

it('coalesces 500 queued events and one burst during an in-flight snapshot into one follow-up', async () => {
  vi.useFakeTimers(); const fixture = makeFixture(), readGate = gate(); let held = false;
  const call: Call = async (method, value) => {
    const result = await fixture.transport.call(method, value);
    if (method === 'snapshot' && held) { held = false; await readGate.promise; }
    return result;
  };
  const controller = new UIController(call, fixture.transport.subscribeChanges); const stop = controller.start();
  await vi.advanceTimersByTimeAsync(0); held = true;
  for (let i = 0; i < 500; i++) fixture.changed();
  await vi.advanceTimersByTimeAsync(0); expect(fixture.calls).toHaveLength(2);
  fixture.snapshot.presentation.status = 'completed';
  for (let i = 0; i < 500; i++) fixture.changed();
  await vi.advanceTimersByTimeAsync(30000); expect(fixture.calls).toHaveLength(2);
  readGate.release(); await vi.advanceTimersByTimeAsync(0);
  expect(fixture.calls).toHaveLength(3);
  expect(controller.getSnapshot().snapshot?.presentation.status).toBe('completed');
  expect(vi.getTimerCount()).toBe(0); stop();
});

it('serializes events behind a command without command-completion polling', async () => {
  vi.useFakeTimers(); const fixture = makeFixture(), commandGate = gate();
  const call: Call = async (method, value) => {
    if (method === 'inspectAuthorization') await commandGate.promise;
    return fixture.transport.call(method, value);
  };
  const controller = new UIController(call, fixture.transport.subscribeChanges); const stop = controller.start();
  await vi.advanceTimersByTimeAsync(0);
  const command = controller.run('inspectAuthorization', {});
  for (let i = 0; i < 500; i++) fixture.changed();
  await vi.advanceTimersByTimeAsync(10000); expect(fixture.calls).toHaveLength(1);
  commandGate.release(); expect(await command).toBe(true); await vi.advanceTimersByTimeAsync(60000);
  expect(fixture.calls.map(c => c.method)).toEqual(['snapshot', 'inspectAuthorization', 'snapshot']); stop();
});

it('stops queued work and old cleanup cannot stop a restarted subscription', async () => {
  vi.useFakeTimers(); const fixture = makeFixture(), commandGate = gate();
  const call: Call = async (method, value) => {
    if (method === 'inspectAuthorization') await commandGate.promise;
    return fixture.transport.call(method, value);
  };
  const controller = new UIController(call, fixture.transport.subscribeChanges); const stopOld = controller.start();
  await vi.advanceTimersByTimeAsync(0);
  const command = controller.run('inspectAuthorization', {}); fixture.changed(); stopOld();
  const stopNew = controller.start(); stopOld();
  commandGate.release(); expect(await command).toBe(true); await vi.advanceTimersByTimeAsync(0);
  expect(fixture.calls.map(c => c.method)).toEqual(['snapshot', 'inspectAuthorization', 'snapshot']);
  stopNew(); fixture.changed(); await vi.advanceTimersByTimeAsync(60000); expect(fixture.calls).toHaveLength(3);
});

it.each([false, true])('discards late snapshot success/error after stop (reject=%s)', async reject => {
  vi.useFakeTimers(); const fixture = makeFixture(), readGate = gate();
  const call = vi.fn<Call>(async (method, value) => {
    await readGate.promise;
    if (reject) throw new Error('Native unavailable');
    return fixture.transport.call(method, value);
  });
  const controller = new UIController(call, fixture.transport.subscribeChanges); const stop = controller.start();
  await vi.advanceTimersByTimeAsync(0); stop(); readGate.release(); await vi.advanceTimersByTimeAsync(60000);
  expect(call).toHaveBeenCalledTimes(1); expect(controller.getSnapshot().snapshot).toBeNull();
  expect(controller.getSnapshot().connectionError).toBeNull(); expect(vi.getTimerCount()).toBe(0);
});

it('cleans up a subscription resolved after stop and cancels a replaced lifecycle', async () => {
  vi.useFakeTimers(); const fixture = makeFixture(), subscribeGate = gate(); const cleanups = [vi.fn(), vi.fn()]; let count = 0;
  const subscribe: SubscribeChanges = async () => { const index = count++; if (!index) await subscribeGate.promise; return cleanups[index]; };
  const controller = new UIController(fixture.transport.call as Call, subscribe);
  const stopOld = controller.start(); const stopNew = controller.start();
  subscribeGate.release(); await vi.advanceTimersByTimeAsync(0); stopOld();
  expect(cleanups[0]).toHaveBeenCalledTimes(1); expect(cleanups[1]).not.toHaveBeenCalled();
  expect(fixture.calls).toHaveLength(1); stopNew(); expect(cleanups[1]).toHaveBeenCalledTimes(1);
});

it.each(['subscribe', 'read'])('bounds failed %s retries and explicit reconnect recovers', async stage => {
  vi.useFakeTimers(); const fixture = makeFixture(); let broken = true;
  const subscribe = vi.fn<SubscribeChanges>(async changed => {
    if (broken && stage === 'subscribe') throw new Error('Subscription unavailable');
    return fixture.transport.subscribeChanges(changed);
  });
  const call = vi.fn<Call>(async (method, value) => {
    if (broken && stage === 'read') throw new Error('Native unavailable');
    return fixture.transport.call(method, value);
  });
  const controller = new UIController(call, subscribe); const stop = controller.start();
  await vi.advanceTimersByTimeAsync(60000);
  expect(stage === 'subscribe' ? subscribe.mock.calls.length : call.mock.calls.length).toBe(4);
  expect(vi.getTimerCount()).toBe(0);
  broken = false; expect(await controller.run('refresh', {})).toBe(true); await vi.advanceTimersByTimeAsync(0);
  expect(controller.getSnapshot().connectionError).toBeNull();
  const count = call.mock.calls.length; await vi.advanceTimersByTimeAsync(60000); expect(call).toHaveBeenCalledTimes(count); stop();
});

it('accepts ready, auth, material and log changes solely from notifications while preserving local edits', async () => {
  vi.useFakeTimers(); const fixture = makeFixture(); fixture.snapshot.ready = false;
  const controller = new UIController(fixture.transport.call as Call, fixture.transport.subscribeChanges); const stop = controller.start();
  await vi.advanceTimersByTimeAsync(0);
  delete fixture.snapshot.ready; fixture.changed(); await vi.advanceTimersByTimeAsync(0);
  controller.edit({ ...controller.getSnapshot().draft!, instructions: 'unsaved' });
  fixture.snapshot.presentation.permissions.send = false;
  fixture.snapshot.presentation.material = { id: 'done', title: 'Read', text: 'Loaded', markdown: false, isLoading: false, error: null };
  fixture.changed(); await vi.advanceTimersByTimeAsync(0);
  expect(controller.getSnapshot().draft?.instructions).toBe('unsaved');
  expect(controller.getSnapshot().snapshot?.presentation.material?.text).toBe('Loaded');
  expect(controller.getSnapshot().snapshot?.presentation.permissions.send).toBe(false); stop();
});
