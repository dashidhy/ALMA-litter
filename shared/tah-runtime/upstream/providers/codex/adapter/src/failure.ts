import type {
  AttemptTerminalV1,
  NormalizedFailureV1,
} from "../../../../src/contract/index.js";
import { CodexAppServerRPCErrorV1 } from "./process-facade.js";

export class CodexAdapterFailureV1 extends Error {
  public constructor(public readonly failure: NormalizedFailureV1) {
    super(failure.message);
    this.name = "CodexAdapterFailureV1";
  }
}

export function codexFailure(
  family: NormalizedFailureV1["family"],
  code: string,
  retryable: boolean,
  message: string,
): CodexAdapterFailureV1 {
  return new CodexAdapterFailureV1(Object.freeze({ family, code, retryable, message }));
}

export function codexFailureTerminal(error: unknown): AttemptTerminalV1 {
  if (error instanceof CodexAdapterFailureV1) {
    return { kind: "failed", failure: error.failure };
  }
  return {
    kind: "failed",
    failure: {
      family: "provider_availability",
      code: "codex_runtime_unavailable",
      retryable: true,
      message: "The Codex runtime could not complete this attempt.",
    },
  };
}

export function codexAuthenticationFailure() {
  return codexFailure(
    "authentication",
    "codex_authentication_invalid",
    false,
    "Codex authentication is no longer valid.",
  );
}

export function isCodexAuthenticationRPCError(error: unknown): boolean {
  if (!(error instanceof CodexAppServerRPCErrorV1)) return false;
  if (error.code !== -32000) return false;
  const data = readRecord(error.data);
  const type = typeof error.data === "string" ? error.data : data?.type ?? data?.code;
  return type === "auth_required"
    || type === "auth_invalid"
    || type === "authentication_required"
    || type === "unauthorized";
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
