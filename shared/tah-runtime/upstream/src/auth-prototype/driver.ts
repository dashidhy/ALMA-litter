/** Guest-only driver boundary. Credentials are never part of public UI snapshots. */
import type { AuthCatalog, AuthChallenge, AuthProviderID } from "./protocol.js";
import type { ProviderAccountUsageV1 } from "../contract/account-usage.js";
export { AuthOperationError, cancelled } from "./protocol.js";
export type { AuthCatalog, AuthChallenge } from "./protocol.js";

export interface AuthDriverContext {
  readonly providerID: AuthProviderID;
  readonly kind: "authenticate" | "inspect";
  readonly credential: Uint8Array | null;
  readonly signal: AbortSignal;
  challenge(challenge: AuthChallenge): Promise<Uint8Array | null>;
}

export interface AuthDriverResult {
  readonly state: "valid" | "invalid";
  readonly credential: Uint8Array | null;
  readonly account: string | null;
  readonly catalog: AuthCatalog | null;
  readonly catalogUnavailable: boolean;
  readonly accountUsage: ProviderAccountUsageV1 | null;
  readonly accountUsageUnavailable: boolean;
}

export type AuthDriver = (context: AuthDriverContext) => Promise<AuthDriverResult>;
