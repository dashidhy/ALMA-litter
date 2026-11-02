import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../App';
import { chatStyleKey, loadChatStyle, saveChatStyle } from '../chatStyle';
import type { Call } from '../contract';
import { UIController } from '../controller';
import { fixtureWorking, makeFixture } from '../devFixture';
import { workingDuration } from '../working';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); },
    removeItem: (key: string) => { saved.delete(key); },
    clear: () => saved.clear(), key: (index: number) => [...saved.keys()][index] ?? null,
    get length() { return saved.size; },
  });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); });
const buttons = (name: string) => Array.from(host.querySelectorAll('button')).filter(b => b.getAttribute('aria-label') === name || b.textContent === name);
const button = (name: string) => buttons(name)[0]!;
const labelSelect = (name: string) => Array.from(host.querySelectorAll('label')).find(l => l.textContent?.startsWith(name))!.querySelector('select')!;

it('defaults to double bubbles and persists the lightweight selection across app remounts', async () => {
  const fixture = makeFixture(); const controller = new UIController(fixture.transport.call as Call);
  await act(async () => root.render(<App controller={controller} />));
  expect(host.querySelector('.conversation')?.getAttribute('data-chat-style')).toBe('bubbles');
  await act(async () => button('Open settings').click());
  await act(async () => button('Lightweight').click());
  expect(button('Lightweight').getAttribute('aria-pressed')).toBe('true');
  expect(window.localStorage.getItem(chatStyleKey)).toBe(JSON.stringify({ version: 1, style: 'light' }));
  await act(async () => root.unmount()); root = createRoot(host);
  await act(async () => root.render(<App controller={new UIController(fixture.transport.call as Call)} />));
  expect(host.querySelector('.conversation')?.getAttribute('data-chat-style')).toBe('light');
  await act(async () => button('Open settings').click());
  await act(async () => button('Double bubbles').click());
  expect(loadChatStyle()).toBe('bubbles');
  expect(labelSelect('Notes language').disabled).toBe(true);
});
it('keeps preference failures local and defaults unknown versions to double bubbles', () => {
  window.localStorage.setItem(chatStyleKey, '{bad json'); expect(loadChatStyle()).toBe('bubbles');
  window.localStorage.setItem(chatStyleKey, JSON.stringify({ version: 2, style: 'light' })); expect(loadChatStyle()).toBe('bubbles');
  const get = vi.spyOn(window.localStorage, 'getItem').mockImplementation(() => { throw new Error('Unavailable'); });
  expect(loadChatStyle()).toBe('bubbles'); get.mockRestore();
  const set = vi.spyOn(window.localStorage, 'setItem').mockImplementation(() => { throw new Error('Unavailable'); });
  expect(() => saveChatStyle('light')).not.toThrow(); set.mockRestore();
});
it('uses explicit roles, never title parsing, and renders user text literally even if flagged Markdown', async () => {
  const fixture = makeFixture();
  fixture.snapshot.presentation.timeline = [
    { id: 'misleading', title: 'Alma · v0', role: 'user', text: '# Literal <b>input</b>', markdown: true, detail: null, canExpand: false },
    { id: 'legacy', title: 'You · v1', text: 'Legacy entry', markdown: false, detail: null, canExpand: false },
  ];
  await act(async () => root.render(<App controller={new UIController(fixture.transport.call as Call)} />));
  const rows = host.querySelectorAll('.chat-message');
  expect(rows[0].getAttribute('data-role')).toBe('user');
  expect(rows[0].querySelector('h1,b')).toBeNull();
  expect(rows[0].textContent).toContain('# Literal <b>input</b>');
  expect(rows[1].getAttribute('data-role')).toBe('system');
});
it('shows only a direct full-log link for completed messages and retains both materials for every revision', async () => {
  const fixture = makeFixture(); const controller = new UIController(fixture.transport.call as Call);
  await act(async () => root.render(<App controller={controller} />));
  expect(host.querySelector('.working-disclosure')).toBeNull();
  expect(host.querySelectorAll('.completion-label')).toHaveLength(2);
  expect(host.textContent).toContain('Completed in 38s');
  expect(buttons('View full working events')).toHaveLength(2);
  expect(host.querySelectorAll('.working-event')).toHaveLength(0);
  for (const revision of [0, 1]) {
    expect(button(`Read notes v${revision}`)).toBeDefined();
    expect(button(`Read ASR terms v${revision}`)).toBeDefined();
  }
  await act(async () => button('Read ASR terms v0').click());
  expect(fixture.calls.at(-1)?.value).toEqual({ kind: 'outcome', actionID: 'qa-action', revisionIndex: 0, file: 'suspicious-asr-terms.md' });
  expect(host.querySelector('.material-heading h2')?.textContent).toBe('v0 · ASR terms');
});
it('opens the latest three public live events by default, collapses on request, then removes the disclosure on completion', async () => {
  const fixture = makeFixture(); const live = fixtureWorking(2, true);
  live.events.push({ ...live.events[0], id: 'private-guardian', role: 'raw_guardian', detail: 'NEVER_SHOW_GUARDIAN_REASONING' });
  fixture.snapshot.presentation.currentActivity = live;
  const controller = new UIController(fixture.transport.call as Call);
  await act(async () => root.render(<App controller={controller} />));
  const details = host.querySelector<HTMLDetailsElement>('.working-disclosure')!;
  expect(details.open).toBe(true);
  expect(details.querySelectorAll('.working-event')).toHaveLength(3);
  expect(details.textContent).not.toContain(live.events[0].title);
  expect(host.textContent).not.toContain('NEVER_SHOW_GUARDIAN_REASONING');
  expect(details.querySelector('[role="status"]')?.textContent).toContain('Progressing');
  await act(async () => { details.open = false; details.dispatchEvent(new Event('toggle')); });
  await act(async () => { await controller.readSnapshot(); });
  expect(details.open).toBe(false);
  fixture.snapshot.presentation.currentActivity = { ...live, phase: 'completed', live: false, progressing: false, endedAt: '2026-11-01T10:01:12Z' };
  await act(async () => { await controller.readSnapshot(); });
  expect(host.querySelector('.working-disclosure')).toBeNull();
  expect(host.querySelector('.current-working')?.textContent).toContain('Completed in 1m 12s');
  expect(host.querySelector('.current-working .working-event')).toBeNull();
});
it('shows literal full-log detail, native failure and bounds notices, and retries the selected log identity', async () => {
  const fixture = makeFixture();
  const working = fixture.snapshot.presentation.timeline[1].working!;
  working.events[0].detail = '<img src="https://private.example"> **literal**';
  working.events.push({ ...working.events[0], id: 'guardian-private', role: 'extra_guardian', detail: 'PRIVATE_GUARDIAN' });
  const controller = new UIController(fixture.transport.call as Call);
  await act(async () => root.render(<App controller={controller} />));
  await act(async () => button('View full working events').click());
  const log = fixture.snapshot.presentation.workingLog!;
  const panel = host.querySelector('.working-log-panel')!;
  expect(panel.querySelectorAll('.working-event')).toHaveLength(4);
  expect(panel.textContent).toContain('<img src="https://private.example"> **literal**');
  expect(panel.querySelector('img,strong strong')).toBeNull();
  expect(panel.textContent).not.toContain('PRIVATE_GUARDIAN');
  log.failed = true; log.error = 'Could not read the saved log.'; log.limited = true; log.superseded = true;
  await act(async () => { await controller.readSnapshot(); });
  expect(panel.textContent).toContain('Earlier activity was omitted');
  expect(panel.textContent).toContain('earlier revision');
  expect(panel.textContent).toContain('Could not read the saved log.');
  expect(panel.querySelectorAll('.working-event')).toHaveLength(4);
  await act(async () => button('Retry working log').click());
  expect(fixture.calls.at(-1)).toEqual({ method: 'refreshWorkingLog', value: { id: log.id } });
  await act(async () => { await controller.closeWorkingLog(log.id); });
  expect(host.querySelector('.working-log-panel')).toBeNull();
});
it('does not display a replacement log under an older selected sheet identity', async () => {
  const fixture = makeFixture(); const controller = new UIController(fixture.transport.call as Call);
  await act(async () => root.render(<App controller={controller} />));
  await act(async () => button('View full working events').click());
  fixture.snapshot.presentation.workingLog!.id = 'another-log';
  fixture.snapshot.presentation.workingLog!.events[0].detail = 'WRONG_LOG_BODY';
  await act(async () => { await controller.readSnapshot(); });
  expect(host.querySelector('.working-log-panel')?.textContent).toContain('no longer selected');
  expect(host.querySelector('.working-log-panel')?.textContent).not.toContain('WRONG_LOG_BODY');
});
it('does not invent a duration when completed timestamps are missing or invalid', () => {
  expect(workingDuration(null, null)).toBeNull();
  expect(workingDuration('invalid', '2026-11-01T10:00:00Z')).toBeNull();
  expect(workingDuration('2026-11-01T10:00:38Z', '2026-11-01T10:00:00Z')).toBeNull();
});
it('keeps the log reader mounted through completion, retains manual history position, and has a stable Latest footer', async () => {
  const fixture = makeFixture(); fixture.snapshot.presentation.currentActivity = fixtureWorking(2, true);
  const controller = new UIController(fixture.transport.call as Call);
  await act(async () => root.render(<App controller={controller} />));
  await act(async () => { await controller.run('openWorkingLog', { actionID: 'qa-action', position: null }); });
  const log = fixture.snapshot.presentation.workingLog!;
  const scroller = host.querySelector<HTMLElement>('.working-log-events')!;
  let contentHeight = 1000;
  Object.defineProperties(scroller, { clientHeight: { value: 200 }, scrollHeight: { get: () => contentHeight } });
  await act(async () => { await controller.readSnapshot(); });
  expect(scroller.scrollTop).toBe(800);
  const footer = host.querySelector('.working-log-footer');
  expect(button('Latest events').style.visibility).toBe('hidden');
  await act(async () => {
    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: -100 }));
    scroller.scrollTop = 500; scroller.dispatchEvent(new Event('scroll'));
  });
  expect(button('Latest events').style.visibility).toBe('visible');
  contentHeight = 1200; log.loading = true;
  await act(async () => { await controller.readSnapshot(); });
  expect(scroller.scrollTop).toBe(500);
  expect(host.querySelector('.working-log-panel')?.textContent).not.toContain('Loading working events');
  fixture.snapshot.presentation.editor!.editorToken = 'published-token';
  log.loading = false; log.progressing = false; log.endedAt = '2026-11-01T10:01:00Z';
  log.events.push({ ...log.events[0], id: 'final-event', title: 'Final published event' });
  await act(async () => { await controller.readSnapshot(); });
  expect(controller.getSnapshot().workingLogID).toBe(log.id);
  expect(host.querySelector('.working-log-events')).toBe(scroller);
  expect(host.querySelector('.working-log-footer')).toBe(footer);
  expect(scroller.scrollTop).toBe(500);
  expect(host.querySelector('.working-log-panel')?.textContent).toContain('Final published event');
  await act(async () => button('Latest events').click());
  expect(scroller.scrollTop).toBe(1000);
  expect(button('Latest events').style.visibility).toBe('hidden');
  expect(host.querySelector('.working-log-footer')).toBe(footer);
});
it('keeps native Progressing visible after a read failure, but removes it when superseded', async () => {
  const fixture = makeFixture(); fixture.snapshot.presentation.currentActivity = fixtureWorking(2, true);
  const controller = new UIController(fixture.transport.call as Call);
  await act(async () => root.render(<App controller={controller} />));
  await act(async () => { await controller.run('openWorkingLog', { actionID: 'qa-action', position: null }); });
  const log = fixture.snapshot.presentation.workingLog!; log.failed = true; log.loading = true;
  await act(async () => { await controller.readSnapshot(); });
  expect(host.querySelector('.working-log-panel .working-progress')).not.toBeNull();
  expect(host.querySelector('.working-log-panel .loading-line')).toBeNull();
  log.superseded = true;
  await act(async () => { await controller.readSnapshot(); });
  expect(host.querySelector('.working-log-panel .working-progress')).toBeNull();
});
it('does not render a Guardian phase as an Actor working preview', async () => {
  const fixture = makeFixture(); fixture.snapshot.presentation.currentActivity = { ...fixtureWorking(2, true), phase: 'extra_guardian', canOpen: false, progressing: false };
  await act(async () => root.render(<App controller={new UIController(fixture.transport.call as Call)} />));
  expect(host.querySelector('.current-working')).toBeNull();
});
it.each(['mouse', 'pen', 'touch'])('preserves earlier log events after a %s content drag and resumes via Latest', async pointerType => {
  const fixture = makeFixture(); const controller = new UIController(fixture.transport.call as Call);
  await act(async () => root.render(<App controller={controller} />));
  await act(async () => button('View full working events').click());
  const scroller = host.querySelector<HTMLElement>('.working-log-events')!;
  Object.defineProperties(scroller, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 } });
  scroller.style.overflowY = 'auto';
  await act(async () => { await controller.readSnapshot(); });
  expect(scroller.scrollTop).toBe(800);
  const content = scroller.querySelector('.event-detail')!;
  const pointer = (type: string, y: number) => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: 100, clientY: y, button: 0 });
    Object.defineProperties(event, { pointerId: { value: 17 }, pointerType: { value: pointerType } });
    content.dispatchEvent(event); return event;
  };
  await act(async () => {
    expect(pointer('pointerdown', 100).defaultPrevented).toBe(false);
    expect(pointer('pointermove', 160).defaultPrevented).toBe(false);
    pointer('pointermove', 160); // Stationary coalesced event, not a downward return.
    pointer('pointerup', 160); // WK may deliver end before main-thread scrollTop updates.
  });
  await act(async () => { scroller.scrollTop = 500; scroller.dispatchEvent(new Event('scroll')); });
  await act(async () => { await controller.readSnapshot(); });
  expect(scroller.scrollTop).toBe(500);
  expect(button('Latest events').style.visibility).toBe('visible');
  await act(async () => button('Latest events').click());
  expect(scroller.scrollTop).toBe(800);
  expect(button('Latest events').style.visibility).toBe('hidden');
});
it('keeps native touch scrolling of log text unimpeded and protects history from snapshot reconciliation', async () => {
  const fixture = makeFixture(); const controller = new UIController(fixture.transport.call as Call);
  await act(async () => root.render(<App controller={controller} />));
  await act(async () => button('View full working events').click());
  const scroller = host.querySelector<HTMLElement>('.working-log-events')!;
  Object.defineProperties(scroller, { clientHeight: { value: 200 }, scrollHeight: { value: 1000 } });
  scroller.style.overflowY = 'auto';
  await act(async () => { await controller.readSnapshot(); });
  const content = scroller.querySelector('.event-detail')!;
  const touch = (type: string, y: number) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    const point = { identifier: 4, clientX: 100, clientY: y };
    Object.defineProperties(event, { touches: { value: type === 'touchend' ? [] : [point] }, changedTouches: { value: [point] } });
    content.dispatchEvent(event); return event;
  };
  await act(async () => {
    expect(touch('touchstart', 100).defaultPrevented).toBe(false);
    expect(touch('touchmove', 160).defaultPrevented).toBe(false);
    touch('touchmove', 160); touch('touchend', 160);
    scroller.scrollTop = 500; scroller.dispatchEvent(new Event('scroll'));
  });
  await act(async () => { await controller.readSnapshot(); });
  expect(scroller.scrollTop).toBe(500);
  expect(button('Latest events').style.visibility).toBe('visible');
  expect(host.querySelector<HTMLDialogElement>('dialog')?.open).toBe(true);
  // Only an actual downward return to the end resumes following.
  await act(async () => { scroller.scrollTop = 800; scroller.dispatchEvent(new Event('scroll')); });
  expect(button('Latest events').style.visibility).toBe('hidden');
});
