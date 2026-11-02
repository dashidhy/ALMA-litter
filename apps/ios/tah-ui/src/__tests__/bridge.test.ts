import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks';
import { Channel } from '@tauri-apps/api/core';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, decodeEnvelope, subscribeChanges, subscribeWorking } from '../bridge';
import type { WorkingStreamFrame } from '../contract';
import { makeFixture } from '../devFixture';
afterEach(() => { delete window.__TAH_UI_FIXTURE__; clearMocks(); vi.unstubAllGlobals(); });
it('registers the channel commands and authorizes them only in the main webview', () => {
  const native = resolve(dirname(fileURLToPath(import.meta.url)), '../../src-tauri');
  const build = readFileSync(resolve(native, 'build.rs'), 'utf8');
  const handlers = readFileSync(resolve(native, 'src/lib.rs'), 'utf8');
  const capability = JSON.parse(readFileSync(resolve(native, 'capabilities/tah.json'), 'utf8'));
  expect(capability.windows).toEqual(['main']);
  for (const command of ['tah_working_stream', 'tah_working_ack', 'tah_working_unsubscribe']) {
    expect(build).toContain(`"${command}"`);
    expect(handlers).toMatch(new RegExp(`generate_handler!\\[[^\\]]*\\b${command}\\b`));
    expect(capability.permissions).toContain(`allow-${command.replaceAll('_', '-')}`);
  }
});
describe('native snapshot gateway', () => {
  it('accepts direct native snapshots with explicit nulls and no ready key', () => {
    const fixture = makeFixture(); expect(decodeEnvelope(fixture.snapshot)).toEqual(fixture.snapshot);
    expect(decodeEnvelope(JSON.stringify(fixture.snapshot)).presentation.material).toBeNull();
  });
  it('rejects malformed responses', () => expect(() => decodeEnvelope({ ok: true, value: {} })).toThrow('Invalid snapshot'));
  it('fails clearly in a browser without an explicitly injected fixture', async () => {
    await expect(call('snapshot', {})).rejects.toThrow('native TAH connection is unavailable');
  });
  it('uses only an explicitly injected development fixture', async () => {
    const fixture = makeFixture(); window.__TAH_UI_FIXTURE__ = fixture.transport;
    expect(await call('snapshot', {})).toEqual(fixture.snapshot);
  });
});

it('subscribes to fixture invalidations and releases the listener', async () => {
  const fixture = makeFixture(); window.__TAH_UI_FIXTURE__ = fixture.transport;
  const changed = vi.fn(); const stop = await subscribeChanges(changed);
  fixture.changed(); expect(changed).toHaveBeenCalledTimes(1);
  stop(); fixture.changed(); expect(changed).toHaveBeenCalledTimes(1);
});
it('reports subscription unavailability without falling back to polling', async () => {
  await expect(subscribeChanges(() => {})).rejects.toThrow('native TAH connection is unavailable');
});

it('uses official Channel with onEvent and exact subscriptionID keys for ACK and unsubscribe', async () => {
  vi.stubGlobal('isTauri', true);
  const calls: { command: string; payload: unknown }[] = [];
  const initial: WorkingStreamFrame = { schemaVersion: 1, subscriptionID: 12, sequence: 1, baseSequence: 0,
    reset: true, log: null, events: [], removed: [], order: [] };
  mockIPC((command, payload) => {
    calls.push({ command, payload });
    if (command === 'tah_working_stream') {
      const { onEvent } = payload as { onEvent: Channel<WorkingStreamFrame> };
      expect(onEvent).toBeInstanceOf(Channel);
      onEvent.onmessage(initial);
      return 12;
    }
  });
  const received = vi.fn(); const session = await subscribeWorking(received);
  expect(received).toHaveBeenCalledWith(initial); expect(session?.subscriptionID).toBe(12);
  await session!.ack(1); await session!.unsubscribe();
  expect(calls.slice(1)).toEqual([
    { command: 'tah_working_ack', payload: { subscriptionID: 12, sequence: 1 } },
    { command: 'tah_working_unsubscribe', payload: { subscriptionID: 12 } },
  ]);
});
it('permits an explicit legacy fixture without a stream and fails without native or fixture', async () => {
  await expect(subscribeWorking(() => {})).rejects.toThrow('native TAH connection is unavailable');
  window.__TAH_UI_FIXTURE__ = makeFixture().transport;
  expect(await subscribeWorking(() => {})).toBeNull();
});
