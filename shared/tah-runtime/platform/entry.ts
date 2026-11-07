import { createMobileRuntime } from './runtime.js';
import { nativeCall } from './bridge.js';
import type { MobileProviderAdapter } from './provider.js';

declare const AlmaLoadProvider: (id: string) => MobileProviderAdapter;
// Factories live in separately packaged provider chunks. Core evaluation does
// not register or evaluate provider modules. AuthService owns switch/drain order.
const adapters = new Map<string, MobileProviderAdapter>();
for (const id of ['codex', 'kimi', 'zcode']) {
  let prepared: Promise<MobileProviderAdapter> | undefined;
  const load = () => prepared ??= nativeCall('runtime.prepareProvider', { providerID: id })
    .then(() => AlmaLoadProvider(id))
    .catch(error => { prepared = undefined; throw error; });
  adapters.set(id, {
    id,
    prepare: async () => { await load(); },
    authenticate: async context => (await load()).authenticate(context),
    run: async (built, credential, event, signal) => (await load()).run(built, credential, event, signal),
  });
}
(globalThis as any).AlmaMobileRuntime = createMobileRuntime(adapters);
