import { act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import App from '../App';
import { UIController } from '../controller';
import { makeFixture } from '../devFixture';
import type { Call } from '../contract';
import { readingThemeKey } from '../readingTheme';

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => { saved.set(key, value); },
    removeItem: (key: string) => { saved.delete(key); },
  });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); window.localStorage.removeItem(readingThemeKey); vi.unstubAllGlobals(); });
function button(name: string) {
  return Array.from(host.querySelectorAll('button')).find(b => b.getAttribute('aria-label') === name || b.textContent === name)!;
}
it('closes unchanged Settings without saving, inserting a row or disabling the workspace', async () => {
  const fixture = makeFixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const call: Call = async (method, value) => {
    if (method === 'checkpointDraft') await gate;
    return fixture.transport.call(method, value);
  };
  const controller = new UIController(call);
  await act(async () => root.render(<App controller={controller} />));
  const workspace = host.querySelector('.workspace-scroll')!;
  const input = host.querySelector<HTMLTextAreaElement>('#instructions')!;
  workspace.scrollTop = 160;
  await act(async () => button('Open settings').click());
  await act(async () => button('Close Settings').click());
  try {
    expect(host.querySelector('dialog')).toBeNull();
    expect(host.querySelector('.pending-command')).toBeNull();
    expect(input.disabled).toBe(false);
    expect(button('Refresh action').disabled).toBe(false);
    expect(host.querySelector('.workspace-scroll')).toBe(workspace);
    expect(workspace.scrollTop).toBe(160);
  } finally { await act(async () => { release(); await controller.readSnapshot(); }); }
  expect(fixture.calls.some(call => call.method === 'checkpointDraft')).toBe(false);
});
it('persists a changed setting before Settings closes and does not save again on dismissal', async () => {
  const fixture = makeFixture(); const controller = new UIController(fixture.transport.call as Call);
  await act(async () => root.render(<App controller={controller} />));
  await act(async () => button('Open settings').click());
  await act(async () => host.querySelector<HTMLInputElement>('[role="switch"]')!.click());
  await act(async () => { await controller.readSnapshot(); });
  expect(host.querySelector('dialog')).not.toBeNull();
  expect(fixture.snapshot.draft.settings.webEnabled).toBe(true);
  expect(fixture.calls.filter(call => call.method === 'checkpointDraft')).toHaveLength(1);
  await act(async () => button('Close Settings').click());
  await act(async () => { await controller.readSnapshot(); });
  expect(fixture.calls.filter(call => call.method === 'checkpointDraft')).toHaveLength(1);
});
it('saves appearance on selection and restores it after remount without closing Settings first', async () => {
  const fixture = makeFixture();
  await act(async () => root.render(<App controller={new UIController(fixture.transport.call as Call)} />));
  await act(async () => button('Open settings').click());
  await act(async () => button('Paper').click());
  expect(JSON.parse(window.localStorage.getItem(readingThemeKey)!)).toEqual({ version: 1, theme: 'paper' });
  await act(async () => root.unmount()); root = createRoot(host);
  await act(async () => root.render(<App controller={new UIController(fixture.transport.call as Call)} />));
  expect(document.documentElement.dataset.theme).toBe('paper');
  expect(fixture.calls.some(call => call.method === 'checkpointDraft')).toBe(false);
});
it.each([true, false])('retains text feedback when busy has no phase (ready=%s)', async ready => {
  const fixture = makeFixture(); fixture.snapshot.ready = ready;
  fixture.snapshot.presentation.isBusy = true; fixture.snapshot.presentation.status = '';
  await act(async () => root.render(<App controller={new UIController(fixture.transport.call as Call)} />));
  expect(host.querySelector('[role="status"]')?.textContent).toBe(ready ? 'Processing…' : 'Preparing…');
});
it('shows file-read activity until the selected file has finished loading', async () => {
  const fixture = makeFixture();
  await act(async () => root.render(<App controller={new UIController(fixture.transport.call as Call)} />));
  await act(async () => button('Open transcript library').click());
  await act(async () => button('Import full transcript').click());
  let finish!: (buffer: ArrayBuffer) => void;
  const file = new File(['Example'], 'example.txt');
  Object.defineProperty(file, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>(resolve => { finish = resolve; }) });
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  expect(host.querySelector('.import-form [role="status"]')?.textContent).toBe('Reading text file…');
  expect(button('Import transcript').disabled).toBe(true);
  await act(async () => finish(new TextEncoder().encode('Example').buffer));
  expect(host.textContent).not.toContain('Reading text file…');
  expect(host.querySelector<HTMLTextAreaElement>('.import-form textarea')?.value).toBe('Example');
  expect(button('Import transcript').disabled).toBe(false);
});
it('shows request waiting inside the open sheet before native busy acknowledgement', async () => {
  const fixture = makeFixture(); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const call: Call = async (method, value) => {
    if (method === 'selectInteractionLanguage') await gate;
    return fixture.transport.call(method, value);
  };
  const controller = new UIController(call);
  await act(async () => root.render(<App controller={controller} />));
  await act(async () => button('Open settings').click());
  let completion!: Promise<boolean>;
  await act(async () => { completion = controller.run('selectInteractionLanguage', { language: 'zh-CN' }); });
  expect(fixture.snapshot.presentation.isBusy).toBe(false);
  expect(host.querySelector('dialog .pending-command')?.textContent).toContain('Updating language…');
  await act(async () => { release(); await completion; });
  expect(host.querySelector('.pending-command')).toBeNull();
  expect(fixture.calls.some(call => call.method === 'checkpointDraft')).toBe(true);
});
it('shows native startup errors and offers sign in while the native projection is preparing', async () => {
  const fixture = makeFixture(); fixture.snapshot.ready = false; fixture.snapshot.error = 'Sign in with ChatGPT to continue.';
  fixture.snapshot.presentation.isBusy = true; fixture.snapshot.presentation.status = 'preparing';
  await act(async () => root.render(<App controller={new UIController(fixture.transport.call as Call)} />));
  expect(host.textContent).toContain('Sign in with ChatGPT to continue.');
  expect(button('Sign in with ChatGPT').disabled).toBe(false);
  await act(async () => button('Sign in with ChatGPT').click());
  expect(fixture.calls.some(c => c.method === 'signIn')).toBe(true);
});
it('uses native reasoning IDs, freezes output language and renders user instructions literally', async () => {
  const fixture = makeFixture();
  await act(async () => root.render(<App controller={new UIController(fixture.transport.call as Call)} />));
  expect(host.querySelector('.timeline-item .literal-text')?.textContent).toContain('<speaker>');
  expect(host.querySelector('.timeline-item speaker')).toBeNull();
  await act(async () => button('Open settings').click());
  expect(button('Sign in with ChatGPT')).toBeUndefined();
  expect(button('Inspect authorization')).toBeDefined();
  const labels = Array.from(host.querySelectorAll('label'));
  const language = labels.find(l => l.textContent?.startsWith('Notes language'))!.querySelector('select')!;
  const reasoning = labels.find(l => l.textContent?.startsWith('Reasoning'))!.querySelector('select')!;
  expect(language.disabled).toBe(true);
  expect(reasoning.value).toBe('xhigh');
  expect(reasoning.options[1].textContent).toBe('xhigh');
});
it('sends strict raw material payloads and uses subsequent native material snapshots', async () => {
  const fixture = makeFixture();
  const controller = new UIController(fixture.transport.call as Call);
  await act(async () => root.render(<App controller={controller} />));
  await act(async () => button('Read source').click());
  expect(fixture.calls.at(-1)?.value).toEqual({ kind: 'rawTranscript', actionID: 'qa-action', revisionIndex: null, file: null });
  expect(host.querySelector('.material-content .literal-text')?.textContent).toContain('# This is literal');
  await act(async () => button('Notes').click());
  expect(host.querySelector('.markdown h1')?.textContent).toBe('让重要的信息更容易被找到');
  fixture.snapshot.presentation.material!.isLoading = true;
  fixture.snapshot.presentation.material!.text = null;
  await act(async () => { await controller.readSnapshot(); });
  expect(host.textContent).toContain('Loading material');
  fixture.snapshot.presentation.material!.isLoading = false;
  fixture.snapshot.presentation.material!.text = '# Finished material';
  await act(async () => { await controller.readSnapshot(); });
  expect(host.querySelector('.markdown h1')?.textContent).toBe('Finished material');
});
it('hides the keyboard from the existing controls row without changing or sending the draft', async () => {
  const fixture = makeFixture();
  fixture.snapshot.draft.instructions = '  SAM v1：保留这段文字。\n';
  const controller = new UIController(fixture.transport.call as Call);
  await act(async () => root.render(<App controller={controller} />));
  const input = host.querySelector<HTMLTextAreaElement>('#instructions')!;
  const hide = button('Hide keyboard');
  expect(hide.closest('.composer-controls')).not.toBeNull();
  await act(async () => input.focus());
  const pointer = new Event('pointerdown', { bubbles: true, cancelable: true });
  await act(async () => { hide.dispatchEvent(pointer); });
  expect(pointer.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(input);
  await act(async () => hide.click());
  expect(document.activeElement).not.toBe(input);
  expect(host.querySelector('.composer-card')?.contains(document.activeElement)).toBe(false);
  expect(input.value).toBe('  SAM v1：保留这段文字。\n');
  expect(controller.getSnapshot().draft?.instructions).toBe(input.value);
  expect(fixture.calls.filter(call => call.method !== 'snapshot')).toEqual([]);
});

it('wires the default App to change events across StrictMode setup and cleanup', async () => {
  const fixture = makeFixture(); window.__TAH_UI_FIXTURE__ = fixture.transport;
  try {
    await act(async () => root.render(<StrictMode><App /></StrictMode>));
    expect(fixture.calls.filter(c => c.method === 'snapshot')).toHaveLength(1);
    await act(async () => {
      fixture.snapshot.presentation.error = 'Asynchronous authorization update';
      fixture.changed();
    });
    expect(host.textContent).toContain('Asynchronous authorization update');
    expect(fixture.calls.filter(c => c.method === 'snapshot')).toHaveLength(2);
    await act(async () => root.render(null));
    await act(async () => fixture.changed());
    expect(fixture.calls.filter(c => c.method === 'snapshot')).toHaveLength(2);
  } finally { delete window.__TAH_UI_FIXTURE__; }
});
