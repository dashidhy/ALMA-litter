import { afterEach, expect, it, vi } from 'vitest';
import type { Call, Commands } from '../contract';
import { UIController } from '../controller';
import { fixtureWorking, makeFixture } from '../devFixture';

afterEach(() => vi.useRealTimers());
it('reads an open log only on change and never automatically calls refreshWorkingLog', async () => {
  vi.useFakeTimers(); const fixture = makeFixture();
  fixture.snapshot.presentation.currentActivity = fixtureWorking(2, true);
  const controller = new UIController(fixture.transport.call as Call, fixture.transport.subscribeChanges); const stop = controller.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(await controller.run('openWorkingLog', { actionID: 'qa-action', position: null })).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  const id = controller.getSnapshot().workingLogID!;
  fixture.snapshot.presentation.workingLog!.events[0].detail = 'async update'; fixture.changed();
  await vi.advanceTimersByTimeAsync(0);
  expect(controller.getSnapshot().snapshot?.presentation.workingLog?.events[0].detail).toBe('async update');
  const reads = fixture.calls.length; await vi.advanceTimersByTimeAsync(60000); expect(fixture.calls).toHaveLength(reads);
  expect(fixture.calls.filter(c => c.method === 'refreshWorkingLog')).toHaveLength(0);
  await controller.closeWorkingLog(id); stop();
});
it('closing during an in-flight refresh cannot reopen the sheet or keep refreshing the closed log', async () => {
  const fixture = makeFixture(); fixture.snapshot.presentation.currentActivity = fixtureWorking(2, true);
  let release!: () => void; let started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const refreshing = new Promise<void>(resolve => { started = resolve; });
  const call: Call = async (method, value) => {
    const response = await fixture.transport.call(method, value);
    if (method === 'snapshot' && fixture.snapshot.presentation.workingLog) { started(); await waiting; }
    return response;
  };
  const controller = new UIController(call); await controller.readSnapshot();
  await controller.run('openWorkingLog', { actionID: 'qa-action', position: null });
  const id = controller.getSnapshot().workingLogID!;
  const poll = controller.readSnapshot(); await refreshing;
  const closing = controller.closeWorkingLog(id);
  expect(controller.getSnapshot().workingLogID).toBeNull();
  release(); await poll; await closing;
  expect(controller.getSnapshot().workingLogID).toBeNull();
  expect(fixture.snapshot.presentation.workingLog).toBeNull();
});
it('bypasses a pending command to close during an event read, without rearming after stop', async () => {
  vi.useFakeTimers(); const fixture = makeFixture();
  fixture.snapshot.presentation.currentActivity = fixtureWorking(2, true);
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  const call: Call = async (method, value) => {
    const response = await fixture.transport.call(method, value);
    if (method === 'snapshot' && fixture.snapshot.presentation.workingLog) await waiting;
    return response;
  };
  const controller = new UIController(call, fixture.transport.subscribeChanges); const stop = controller.start();
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(await controller.run('openWorkingLog', { actionID: 'qa-action', position: null })).toBe(true);
    const id = controller.getSnapshot().workingLogID!;
    fixture.changed(); await vi.advanceTimersByTimeAsync(0);
    expect(fixture.calls.at(-1)?.method).toBe('snapshot');
    const command = controller.run('inspectAuthorization', {});
    const closing = controller.run('closeWorkingLog', { id });
    expect(controller.getSnapshot().pending).toBe('inspectAuthorization');
    expect(controller.getSnapshot().workingLogID).toBeNull();
    stop(); release();
    expect(await command).toBe(true); expect(await closing).toBe(true);
    expect(controller.getSnapshot().workingLogID).toBeNull();
    expect(fixture.snapshot.presentation.workingLog).toBeNull();
    expect(fixture.calls.at(-1)).toEqual({ method: 'closeWorkingLog', value: { id } });
    const calls = fixture.calls.length;
    await vi.advanceTimersByTimeAsync(20000);
    expect(fixture.calls).toHaveLength(calls); expect(vi.getTimerCount()).toBe(0);
  } finally { stop(); release(); }
});
it('a stale close cannot close a newer log identity', async () => {
  const fixture = makeFixture(); const controller = new UIController(fixture.transport.call as Call); await controller.readSnapshot();
  await controller.run('openWorkingLog', { actionID: 'qa-action', position: 1 });
  const old = controller.getSnapshot().workingLogID!;
  await controller.run('openWorkingLog', { actionID: 'qa-action', position: 2 });
  const current = controller.getSnapshot().workingLogID!;
  await controller.closeWorkingLog(old);
  expect(controller.getSnapshot().workingLogID).toBe(current);
  expect(controller.getSnapshot().snapshot?.presentation.workingLog?.id).toBe(current);
});
it.each(['unchanged', 'wrong-action', 'wrong-position'])('rejects %s log admission', async mismatch => {
  const fixture = makeFixture(); const call: Call = async (method, value) => {
    const previous = structuredClone(fixture.snapshot);
    const response = await fixture.transport.call(method, value);
    if (method === 'openWorkingLog') {
      if (mismatch === 'unchanged') return previous;
      if (mismatch === 'wrong-action') response.presentation.workingLog!.actionID = 'wrong';
      if (mismatch === 'wrong-position') response.presentation.workingLog!.position = 99;
    }
    return response;
  };
  const controller = new UIController(call); await controller.readSnapshot();
  expect(await controller.run('openWorkingLog', { actionID: 'qa-action', position: 1 })).toBe(false);
  expect(controller.getSnapshot().workingLogID).toBeNull();
  expect(controller.getSnapshot().commandError).toContain('working log did not open');
});
it('does not automatically retry failed or superseded logs, but uses their ID for explicit retry', async () => {
  const fixture = makeFixture(); const controller = new UIController(fixture.transport.call as Call); await controller.readSnapshot();
  await controller.run('openWorkingLog', { actionID: 'qa-action', position: 1 });
  const log = fixture.snapshot.presentation.workingLog!; log.failed = true; log.progressing = true;
  await controller.readSnapshot(); expect(fixture.calls.at(-1)?.method).toBe('snapshot');
  await controller.run('refreshWorkingLog', { id: log.id });
  expect((fixture.calls.at(-1)?.value as Commands['refreshWorkingLog']).id).toBe(log.id);
  log.failed = false; log.superseded = true; await controller.readSnapshot();
  expect(fixture.calls.at(-1)?.method).toBe('snapshot');
});
it('keeps a live log on same-action token changes and clears it when transcript or action selection changes', async () => {
  const fixture = makeFixture(); const controller = new UIController(fixture.transport.call as Call); await controller.readSnapshot();
  await controller.run('openWorkingLog', { actionID: 'qa-action', position: 1 });
  const id = controller.getSnapshot().workingLogID;
  fixture.snapshot.presentation.editor!.editorToken = 'completed-editor';
  await controller.readSnapshot(); expect(controller.getSnapshot().workingLogID).toBe(id);
  fixture.snapshot.presentation.editor!.actionID = 'another-action';
  await controller.readSnapshot(); expect(controller.getSnapshot().workingLogID).toBeNull();
  fixture.snapshot.presentation.editor!.actionID = 'qa-action';
  await controller.readSnapshot(); await controller.run('openWorkingLog', { actionID: 'qa-action', position: 2 });
  fixture.snapshot.presentation.transcriptID = 'another-transcript';
  await controller.readSnapshot(); expect(controller.getSnapshot().workingLogID).toBeNull();
});
