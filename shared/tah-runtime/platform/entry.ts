import { createMobileRuntime } from './runtime.js';
import { mobileCodexProvider } from './codex/mobile-provider.js';
(globalThis as any).AlmaMobileRuntime=createMobileRuntime(new Map([[mobileCodexProvider.id,mobileCodexProvider]]));
