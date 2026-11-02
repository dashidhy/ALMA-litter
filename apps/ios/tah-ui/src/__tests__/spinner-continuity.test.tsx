import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../App';
import type { Call } from '../contract';
import { UIController } from '../controller';
import { fixtureWorking, makeFixture } from '../devFixture';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-01T10:00:00Z'));
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); },
    removeItem: (key: string) => { saved.delete(key); },
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); vi.useRealTimers(); vi.unstubAllGlobals();
});

function liveFixture() {
  const fixture = makeFixture();
  const p = fixture.snapshot.presentation;
  const working = fixtureWorking(2, true);
  // Native currentSummary uses actionID/operationID and sends at most three events.
  working.id = `${p.editor!.actionID}/spinner-operation`;
  working.events = working.events.slice(-3);
  p.currentActivity = working;
  p.status = 'actor'; p.isBusy = true;
  p.permissions.edit = false; p.permissions.send = false;
  return fixture;
}
function spinner() {
  const nodes = host.querySelectorAll('.current-working .working-progress .spinner');
  expect(nodes).toHaveLength(1);
  return nodes[0];
}
function expectSameSpinner(original: Element) {
  expect(original.isConnected).toBe(true);
  expect(spinner()).toBe(original);
}

it('preserves the Progressing spinner across fresh snapshots of the same native operation', async () => {
  const fixture = liveFixture();
  const controller = new UIController(fixture.transport.call as Call);
  await act(async () => root.render(<App controller={controller} />));
  const original = spinner();
  const disclosure = host.querySelector('.current-working .working-disclosure');

  for (let index = 0; index < 6; index++) {
    const previous = controller.getSnapshot().snapshot!;
    await act(async () => { await controller.readSnapshot(); });
    const next = controller.getSnapshot().snapshot!;
    // makeFixture clones each response, as decoding a new native envelope would.
    expect(next).not.toBe(previous);
    expect(next.presentation.currentActivity).not.toBe(previous.presentation.currentActivity);
    expect(next.presentation.currentActivity).toEqual(previous.presentation.currentActivity);
    expect(host.querySelector('.current-working .working-disclosure')).toBe(disclosure);
    expectSameSpinner(original);
  }
  expect(fixture.calls.every(call => call.method === 'snapshot')).toBe(true);
});

it('preserves the spinner as the native latest-three preview grows, updates, and rolls over', async () => {
  const fixture = liveFixture();
  const working = fixture.snapshot.presentation.currentActivity!;
  const template = working.events[0];
  working.events = [];
  const controller = new UIController(fixture.transport.call as Call);
  await act(async () => root.render(<App controller={controller} />));
  const original = spinner();

  for (let index = 0; index < 7; index++) {
    working.events = [...working.events, { ...template, id: `native-event-${index}`, title: `Public event ${index}` }].slice(-3);
    await act(async () => { await controller.readSnapshot(); });
    const rows = [...host.querySelectorAll('.current-working .working-event')];
    expect(rows.map(row => row.getAttribute('data-event-id'))).toEqual(working.events.map(event => event.id));
    expect(rows.at(-1)?.textContent).toContain(`Public event ${index}`);
    expectSameSpinner(original);
  }

  working.events.at(-1)!.detail = 'New detail for the same public event';
  await act(async () => { await controller.readSnapshot(); });
  expect(host.querySelector('.current-working')?.textContent).toContain('New detail for the same public event');
  expectSameSpinner(original);
  expect(fixture.calls.every(call => call.method === 'snapshot')).toBe(true);
});

it('preserves the spinner on Elapsed ticks independently of snapshot polling', async () => {
  const fixture = liveFixture();
  const controller = new UIController(fixture.transport.call as Call);
  // Load once, then isolate the actual Elapsed interval from controller polling.
  await controller.readSnapshot();
  vi.spyOn(controller, 'start').mockReturnValue(() => {});
  await act(async () => root.render(<App controller={controller} />));
  const original = spinner();
  const elapsed = host.querySelector('.current-working .working-disclosure > summary > span')!;
  expect(elapsed.textContent).toBe('Elapsed 0s');

  for (const [milliseconds, label] of [[1000, 'Elapsed 1s'], [1000, 'Elapsed 2s'], [58000, 'Elapsed 1m 0s'], [1000, 'Elapsed 1m 1s']] as const) {
    await act(async () => { await vi.advanceTimersByTimeAsync(milliseconds); });
    expect(elapsed.textContent).toBe(label);
    expectSameSpinner(original);
  }
  expect(fixture.calls.map(call => call.method)).toEqual(['snapshot']);
});
