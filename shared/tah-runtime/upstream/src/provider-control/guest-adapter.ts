import type { GuestOpaqueCredentialHandleV1 } from "../guest/runtime/index.js";
import type {
  ProviderControlRequestV1,
  ProviderControlTerminalV1,
} from "./contract.js";

export interface GuestProviderControlContextV1 {
  readonly request: ProviderControlRequestV1;
  readonly credential: GuestOpaqueCredentialHandleV1 | null;
  readonly signal: AbortSignal;
}

/** One-shot, Provider-private implementation loaded only inside its appliance child cgroup. */
export interface GuestProviderControlAdapterV1 {
  runControl(context: GuestProviderControlContextV1): Promise<ProviderControlTerminalV1>;
  cancelControl(): Promise<void>;
}
