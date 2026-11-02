import type { FrozenAttemptV1 } from "../../../../src/contract/index.js";
import type { GuestProviderAdapterV1 } from "../../../../src/guest/runtime/index.js";
import type { ProviderControlRequestV1 } from "../../../../src/provider-control/contract.js";
import type { GuestProviderControlAdapterV1 } from "../../../../src/provider-control/guest-adapter.js";
import { CodexGuestAdapterV1 } from "./guest-adapter.js";

export const CODEX_GUEST_WORKSPACE_ROOT = "/workspace/attempt" as const;
export const CODEX_APP_SERVER_EXECUTABLE = "/opt/alma/provider/codex/bin/codex" as const;

/** Fixed Codex appliance factory, dynamically loaded only inside the child cgroup. */
export function createDedicatedProviderRuntimeV1(
  attempt: FrozenAttemptV1,
): GuestProviderAdapterV1 {
  if (attempt.providerID !== "codex") {
    throw new Error("Codex appliance received another Provider route");
  }
  return new CodexGuestAdapterV1({
    executablePath: CODEX_APP_SERVER_EXECUTABLE,
    workspaceRoot: CODEX_GUEST_WORKSPACE_ROOT,
  });
}

/** Read-only control factory; auth mutation is intentionally absent from v1. */
export async function createDedicatedProviderControlV1(
  request: ProviderControlRequestV1,
): Promise<GuestProviderControlAdapterV1> {
  if (request.providerID !== "codex") {
    throw new Error("Codex appliance received another Provider control route");
  }
  const { CodexGuestControlAdapterV1 } = await import("./control-adapter.js");
  return new CodexGuestControlAdapterV1({
    executablePath: CODEX_APP_SERVER_EXECUTABLE,
    workspaceRoot: CODEX_GUEST_WORKSPACE_ROOT,
  });
}
