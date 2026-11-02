import { afterEach, describe, expect, it, vi } from 'vitest';
import { UIController } from '../controller';
import type { Call, Commands } from '../contract';
import { makeFixture } from '../devFixture';

afterEach(() => vi.useRealTimers());
describe('authoritative bridge and editor ordering', () => {
  it('serializes quiet saves before Send, preserves new edits and ignores transient save snapshots', async () => {
    vi.useFakeTimers(); const fixture = makeFixture();
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const call: Call = async (method, value) => {
      const response = await fixture.transport.call(method, value);
      if (method === 'checkpointDraft') {
        entered(); await gate;
        response.presentation.isBusy = true; // Native may start a deferred refresh.
        response.draft.instructions = 'stale saved text';
      }
      return response;
    };
    const controller = new UIController(call); await controller.readSnapshot();
    controller.edit({ ...controller.getSnapshot().draft!, instructions: 'first saved text' });
    const saved = controller.checkpoint(); await started;
    expect(controller.getSnapshot().pending).toBeNull();
    controller.edit({ ...controller.getSnapshot().draft!, instructions: 'newer user edit' });
    release(); expect(await saved).toBe(true);
    expect(controller.getSnapshot().snapshot?.presentation.isBusy).toBe(false);
    expect(controller.getSnapshot().draft?.instructions).toBe('newer user edit');
    expect(await controller.send()).toBe(true);
    expect(fixture.calls.map(call => call.method)).toEqual(['snapshot', 'updateDraft', 'checkpointDraft', 'updateDraft', 'sendAction']);
    expect((fixture.calls.at(-1)!.value as Commands['sendAction']).instructions).toBe('newer user edit');
  });
  it('queues a foreground action during a quiet save instead of dropping the click', async () => {
    const fixture = makeFixture(); let release!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const started = new Promise<void>(resolve => { entered = resolve; });
    const call: Call = async (method, value) => {
      if (method === 'checkpointDraft') { entered(); await gate; }
      return fixture.transport.call(method, value);
    };
    const controller = new UIController(call); await controller.readSnapshot();
    const save = controller.checkpoint(); await started;
    const next = controller.run('inspectAuthorization', {});
    expect(controller.getSnapshot().pending).toBe('inspectAuthorization');
    expect(fixture.calls.some(call => call.method === 'inspectAuthorization')).toBe(false);
    release(); expect(await save).toBe(true); expect(await next).toBe(true);
    expect(fixture.calls.map(call => call.method)).toEqual(['snapshot', 'checkpointDraft', 'inspectAuthorization']);
  });
  it('reports quiet-save failure without leaving the UI busy', async () => {
    const fixture = makeFixture();
    const call: Call = async (method, value) => {
      if (method === 'checkpointDraft') throw new Error('Could not save draft');
      return fixture.transport.call(method, value);
    };
    const controller = new UIController(call); await controller.readSnapshot();
    expect(await controller.run('checkpointDraft', {})).toBe(false);
    expect(controller.getSnapshot().commandError).toBe('Could not save draft');
    expect(controller.getSnapshot().pending).toBeNull();
  });
  it('saves the latest literal draft before Send and retains exact model/reasoning IDs', async () => {
    const fixture = makeFixture(); const controller = new UIController(fixture.transport.call as Call);
    await controller.readSnapshot();
    controller.edit({ ...controller.getSnapshot().draft!, instructions: '  # literal <instruction>  ' });
    expect(await controller.send()).toBe(true);
    expect(fixture.calls.map(c => c.method)).toEqual(['snapshot', 'updateDraft', 'sendAction']);
    const sent = fixture.calls.at(-1)!.value as Commands['sendAction'];
    expect(sent.instructions).toBe('  # literal <instruction>  ');
    expect(sent.settings.reasoningEffortID).toBe('xhigh');
    expect(sent.settings.modelID).toBe('gpt-6-astra');
    expect(sent.initialLanguage).toBeNull();
    expect(controller.getSnapshot().snapshot?.presentation.isBusy).toBe(true);
    expect(controller.getSnapshot().snapshot?.presentation.status).toBe('preparing');
    expect(controller.getSnapshot().snapshot?.presentation.revisions).toHaveLength(2);
  });
  it('rejects Send after an editor identity changes during draft acknowledgement', async () => {
    const fixture = makeFixture();
    const call: Call = async (method, value) => {
      const result = await fixture.transport.call(method, value);
      if (method === 'updateDraft') result.presentation.editor!.editorToken = 'newer-editor';
      return result;
    };
    const controller = new UIController(call); await controller.readSnapshot();
    controller.edit({ ...controller.getSnapshot().draft!, instructions: 'old editor instruction' });
    expect(await controller.send()).toBe(false);
    expect(fixture.calls.some(c => c.method === 'sendAction')).toBe(false);
    expect(controller.getSnapshot().commandError).toContain('selected action changed');
  });
  it('flushes the previous editor before selecting another transcript', async () => {
    const fixture = makeFixture(); const controller = new UIController(fixture.transport.call as Call);
    await controller.readSnapshot(); controller.edit({ ...controller.getSnapshot().draft!, instructions: 'Keep my edits' });
    await controller.run('selectTranscript', { id: 'qa-other' });
    expect(fixture.calls.map(c => c.method)).toEqual(['snapshot', 'updateDraft', 'selectTranscript']);
    expect((fixture.calls[1].value as Commands['updateDraft']).context?.editorToken).toBe('qa-editor-1');
  });
  it('does not overwrite a newer local edit with an older draft acknowledgement', async () => {
    vi.useFakeTimers(); const fixture = makeFixture(); let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const call: Call = async (method, value) => { const result = await fixture.transport.call(method, value); if (method === 'updateDraft') await waiting; return result; };
    const controller = new UIController(call); await controller.readSnapshot();
    controller.edit({ ...controller.getSnapshot().draft!, instructions: 'first edit' });
    await vi.advanceTimersByTimeAsync(250);
    controller.edit({ ...controller.getSnapshot().draft!, instructions: 'newer edit' });
    release(); await Promise.resolve(); await Promise.resolve();
    expect(controller.getSnapshot().draft?.instructions).toBe('newer edit');
    expect(controller.getSnapshot().dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(controller.getSnapshot().draft?.instructions).toBe('newer edit');
    expect(controller.getSnapshot().dirty).toBe(false);
  });
  it('allows native-authorized empty v0 but rejects empty later revisions', async () => {
    const fixture = makeFixture(); const controller = new UIController(fixture.transport.call as Call); await controller.readSnapshot();
    expect(await controller.send()).toBe(false);
    fixture.snapshot.presentation.canOmitInstructions = true;
    fixture.snapshot.presentation.initialSettingsFrozen = false;
    fixture.snapshot.presentation.permissions.send = true;
    await controller.readSnapshot(); expect(await controller.send()).toBe(true);
    expect((fixture.calls.at(-1)!.value as Commands['sendAction']).initialLanguage).toBe('en');
  });
  it('passes explicit consent unchanged and never infers it from a check request', async () => {
    const fixture = makeFixture(); fixture.snapshot.presentation.consentGranted = false;
    fixture.snapshot.presentation.permissions.checkRaw = false;
    const controller = new UIController(fixture.transport.call as Call); await controller.readSnapshot();
    expect(await controller.run('checkRawSafety', { transcriptID: 'qa-transcript', consent: false, interactionLanguage: 'en' })).toBe(false);
    controller.edit({ ...controller.getSnapshot().draft!, consent: true });
    expect(await controller.run('checkRawSafety', (s,d) => ({ transcriptID: s.presentation.transcriptID!, consent: d.consent, interactionLanguage: s.presentation.interactionLanguage }))).toBe(true);
    expect((fixture.calls.at(-1)!.value as Commands['checkRawSafety']).consent).toBe(true);
  });
  it('accepts ready:false startup errors, then omitted-ready native snapshots', async () => {
    const fixture = makeFixture(); fixture.snapshot.ready = false; fixture.snapshot.error = 'Sign in with ChatGPT';
    const controller = new UIController(fixture.transport.call as Call); await controller.readSnapshot();
    expect(controller.getSnapshot().connectionError).toContain('Sign in');
    await controller.run('signIn', {});
    expect(controller.getSnapshot().snapshot?.ready).toBeUndefined();
    expect(controller.getSnapshot().connectionError).toBeNull();
  });
  it('retains a practical bridge error without fabricating a snapshot', async () => {
    const controller = new UIController(async () => { throw new Error('Native unavailable'); });
    await expect(controller.readSnapshot()).rejects.toThrow('Native unavailable');
    expect(controller.getSnapshot().snapshot).toBeNull();
    expect(controller.getSnapshot().connectionError).toBe('Native unavailable');
  });
  it.each(['unchanged-id', 'wrong-file', 'wrong-revision', 'wrong-action'] as const)('rejects a material response with %s', async mismatch => {
    const fixture = makeFixture();
    await fixture.transport.call('readMaterial', { kind: 'outcome', actionID: 'qa-action', revisionIndex: 1, file: 'structured-notes.md' });
    const previousID = fixture.snapshot.presentation.material!.id;
    const call: Call = async (method, value) => {
      const response = await fixture.transport.call(method, value);
      if (method === 'readMaterial') {
        if (mismatch === 'unchanged-id') response.presentation.material!.id = previousID;
        if (mismatch === 'wrong-file') response.presentation.material!.title = 'v1 · Notes';
        if (mismatch === 'wrong-revision') response.presentation.material!.title = 'v0 · ASR terms';
        if (mismatch === 'wrong-action') response.presentation.editor!.actionID = 'other-action';
      }
      return response;
    };
    const controller = new UIController(call); await controller.readSnapshot();
    expect(await controller.run('readMaterial', { kind: 'outcome', actionID: 'qa-action', revisionIndex: 1, file: 'suspicious-asr-terms.md' })).toBe(false);
    expect(controller.getSnapshot().commandError).toContain('requested material did not open');
  });
  it('rebases explicit newer effort and instruction edits without restoring an untouched stale context window', async () => {
    vi.useFakeTimers(); const fixture = makeFixture(); let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    let normalize = true;
    const call: Call = async (method, value) => {
      const response = await fixture.transport.call(method, value);
      if (method === 'updateDraft' && normalize) {
        normalize = false;
        response.draft.settings.reasoningEffortID = 'medium';
        response.draft.settings.contextWindowTokens = 64000;
        fixture.setSnapshot(response);
        await waiting;
      }
      return response;
    };
    const controller = new UIController(call, fixture.transport.subscribeChanges); const stop = controller.start();
    await vi.advanceTimersByTimeAsync(0);
    controller.edit({ ...controller.getSnapshot().draft!, settings: { ...controller.getSnapshot().draft!.settings, modelID: 'new-model' } });
    await vi.advanceTimersByTimeAsync(250);
    controller.edit({ ...controller.getSnapshot().draft!, instructions: 'Keep this newer instruction', settings: { ...controller.getSnapshot().draft!.settings, reasoningEffortID: 'high', webEnabled: true } });
    release(); await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().draft).toMatchObject({ instructions: 'Keep this newer instruction', settings: { modelID: 'new-model', reasoningEffortID: 'high', contextWindowTokens: 64000, webEnabled: true } });
    await vi.advanceTimersByTimeAsync(250);
    expect((fixture.calls.filter(c => c.method === 'updateDraft').at(-1)!.value as Commands['updateDraft']).draft.settings.contextWindowTokens).toBe(64000);
    expect(controller.getSnapshot().dirty).toBe(false); stop();
  });
});
