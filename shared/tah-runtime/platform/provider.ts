import type { AuthDriver, AuthDriverResult } from '../upstream/src/auth-prototype/driver.js';
import type { BuiltAttemptV1 } from '../upstream/src/framework/attempt-builders.js';
import type { NormalizedEventV1, TahAttemptResultV1 } from '../upstream/src/contract/index.js';

// This boundary is Provider-neutral. The Framework sees only the original
// AuthDriver and TahFrameworkAttemptPort shapes, never native RPC or paths.
export interface MobileProviderAdapter {
  readonly id: string;
  /** Optional App composition preparation; no task or model request is started. */
  prepare?(): Promise<void>;
  readonly authenticate: AuthDriver;
  run(built: BuiltAttemptV1, credential: Uint8Array,
    event: ((event: NormalizedEventV1) => void | Promise<void>) | undefined,
    signal: AbortSignal): Promise<TahAttemptResultV1>;
}
