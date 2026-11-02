import { Channel, invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Call, Commands, Method, Snapshot, SubscribeChanges, SubscribeWorking, WorkingStreamFrame } from './contract';

export interface Transport {
  call(method: Method, value: Commands[Method]): Promise<Snapshot>;
  subscribeChanges: SubscribeChanges;
  subscribeWorking?: SubscribeWorking;
}
declare global {
  interface Window {
    /** Explicit browser QA injection; completely ignored in production builds. */
    __TAH_UI_FIXTURE__?: Transport;
  }
}

export function decodeEnvelope(value: unknown): Snapshot {
  const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : value;
  if (!parsed || typeof parsed !== 'object' || !('presentation' in parsed) || !('draft' in parsed)) {
    throw new Error('Invalid snapshot from the native TAH bridge.');
  }
  return parsed as Snapshot;
}

export const call: Call = async <M extends Method>(method: M, value: Commands[M]) => {
  const fixture = import.meta.env.DEV ? window.__TAH_UI_FIXTURE__ : undefined;
  const transport = fixture;
  if (!transport && !isTauri()) {
    throw new Error('The native TAH connection is unavailable. Open this screen inside the Alma iOS app, or reconnect and retry.');
  }
  const response = transport ? await transport.call(method, value) : await invoke('tah_ui', { method, value });
  return decodeEnvelope(response);
};

export const subscribeChanges: SubscribeChanges = async changed => {
  const fixture = import.meta.env.DEV ? window.__TAH_UI_FIXTURE__ : undefined;
  if (fixture) return fixture.subscribeChanges(changed);
  if (!isTauri()) throw new Error('The native TAH connection is unavailable. Open this screen inside the Alma iOS app, or reconnect and retry.');
  return listen<null>('tah:changed', () => changed());
};

export const subscribeWorking: SubscribeWorking = async onFrame => {
  const fixture = import.meta.env.DEV ? window.__TAH_UI_FIXTURE__ : undefined;
  if (fixture) return fixture.subscribeWorking ? fixture.subscribeWorking(onFrame) : null;
  if (!isTauri()) throw new Error('The native TAH connection is unavailable. Open this screen inside the Alma iOS app, or reconnect and retry.');
  // Install the handler before invoke: Swift may emit its reset before the
  // command response. The consumer keeps at most that one unacknowledged frame.
  const onEvent = new Channel<WorkingStreamFrame>(onFrame);
  const subscriptionID = await invoke<number>('tah_working_stream', { onEvent });
  return {
    subscriptionID,
    ack: sequence => invoke<void>('tah_working_ack', { subscriptionID, sequence }),
    unsubscribe: () => invoke<void>('tah_working_unsubscribe', { subscriptionID }),
  };
};

export async function setNativeTheme(dark: boolean): Promise<void> {
  if (import.meta.env.DEV && window.__TAH_UI_FIXTURE__) return;
  if (isTauri()) await invoke('tah_theme', { dark });
}
