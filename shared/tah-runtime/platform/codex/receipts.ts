import type { CodexNativeProfileV1 } from "../../upstream/providers/codex/adapter/src/native-profile.js";
import { codexFailure } from "../../upstream/providers/codex/adapter/src/failure.js";

export const CODEX_APP_SERVER_VERSION = "0.166.0" as const;

export interface CodexModelPageV1 {
  readonly models: readonly Record<string, unknown>[];
  readonly nextCursor: string | null;
}

export interface CodexThreadReceiptV1 {
  readonly threadID: string;
}

export interface CodexTurnReceiptV1 {
  readonly turnID: string;
}

export function assertInitializeReceipt(value: unknown, controllerHome: string): void {
  const receipt = requireRecord(value, "Codex initialize receipt is malformed.");
  if (
    receipt.codexHome !== controllerHome
    || receipt.platformFamily !== "unix"
    || receipt.platformOs !== "ios"
    || typeof receipt.userAgent !== "string"
    || !new RegExp(`(?:^|[/ ])${escapeRegex(CODEX_APP_SERVER_VERSION)}(?:$|[ (;])`, "u")
      .test(receipt.userAgent)
  ) {
    throw codexFailure(
      "configuration",
      "codex_runtime_identity_mismatch",
      false,
      "The running Codex app-server does not match the pinned iOS runtime.",
    );
  }
}

export function assertAccountReceipt(value: unknown): void {
  const receipt = requireRecord(value, "Codex account receipt is malformed.");
  const account = readRecord(receipt.account);
  if (account === undefined || receipt.requiresOpenaiAuth !== true) {
    throw codexFailure(
      "authentication",
      "codex_authentication_invalid",
      false,
      "Codex authentication is no longer valid.",
    );
  }
  if (account.type !== "chatgpt" && account.type !== "apiKey") {
    throw codexFailure(
      "configuration",
      "codex_account_type_unavailable",
      false,
      "The supplied Codex account type is not enabled for this appliance.",
    );
  }
}

export function parseModelPage(value: unknown): CodexModelPageV1 {
  const receipt = requireRecord(value, "Codex model catalog receipt is malformed.");
  if (!Array.isArray(receipt.data) || receipt.data.length > 512) {
    throw protocolFailure("Codex model catalog page is malformed.");
  }
  const models = receipt.data.map((model) =>
    requireRecord(model, "Codex model catalog item is malformed.")
  );
  for (const model of models) {
    if (model.hidden !== false) {
      throw codexFailure(
        "policy",
        "codex_hidden_model_returned",
        false,
        "Codex returned a hidden model to the selectable catalog request.",
      );
    }
  }
  const nextCursor = receipt.nextCursor;
  if (nextCursor !== null && nextCursor !== undefined && typeof nextCursor !== "string") {
    throw protocolFailure("Codex model catalog cursor is malformed.");
  }
  return Object.freeze({
    models: Object.freeze(models),
    nextCursor: typeof nextCursor === "string" ? nextCursor : null,
  });
}

export function assertModelAvailable(
  models: readonly Record<string, unknown>[],
  profile: CodexNativeProfileV1,
): void {
  const model = models.find((candidate) =>
    candidate.id === profile.modelID || candidate.model === profile.modelID
  );
  if (model === undefined) {
    throw codexFailure(
      "configuration",
      "codex_model_unavailable",
      false,
      "The frozen Codex model is unavailable for this account.",
    );
  }
  if (profile.reasoningEffortID === null) return;
  if (!Array.isArray(model.supportedReasoningEfforts)
    || !model.supportedReasoningEfforts.some((entry) =>
      readRecord(entry)?.reasoningEffort === profile.reasoningEffortID
    )) {
    throw codexFailure(
      "configuration",
      "codex_effort_unavailable",
      false,
      "The frozen Codex reasoning effort is unavailable for this model.",
    );
  }
}

export function assertThreadStartReceipt(
  value: unknown,
  profile: CodexNativeProfileV1,
  workspaceRoot: string,
): CodexThreadReceiptV1 {
  const receipt = requireRecord(value, "Codex thread receipt is malformed.");
  const activeProfile = readRecord(receipt.activePermissionProfile);
  if (
    receipt.approvalPolicy !== profile.approvalPolicy
    || receipt.approvalsReviewer !== "user"
    || receipt.cwd !== workspaceRoot
    || receipt.model !== profile.modelID
    || receipt.modelProvider !== "openai"
    || activeProfile?.id !== profile.permissionProfileID
    || (activeProfile.extends !== null && activeProfile.extends !== undefined)
    || !sameLegacyProjection(receipt.sandbox, (profile as CodexNativeProfileV1 & { runtimeWritableRoots?: readonly string[] }).runtimeWritableRoots ?? profile.writableRoots)
    || !Array.isArray(receipt.instructionSources)
    || receipt.instructionSources.length !== 0
    || !sameExactStringArray(receipt.runtimeWorkspaceRoots, profile.runtimeWorkspaceRoots)
    || (profile.reasoningEffortID !== null
      && receipt.reasoningEffort !== profile.reasoningEffortID)
  ) {
    throw nativeProfileDrift();
  }
  const thread = requireRecord(receipt.thread, "Codex thread identity is malformed.");
  const threadID = readNonemptyString(thread.id);
  if (
    threadID === undefined
    || thread.cliVersion !== CODEX_APP_SERVER_VERSION
    || thread.cwd !== workspaceRoot
    || thread.ephemeral !== true
    || thread.modelProvider !== "openai"
    || (thread.parentThreadId !== null && thread.parentThreadId !== undefined)
    || (thread.agentRole !== null && thread.agentRole !== undefined)
    || (thread.agentNickname !== null && thread.agentNickname !== undefined)
    || (thread.path !== null && thread.path !== undefined)
    || !Array.isArray(thread.turns)
    || thread.turns.length !== 0
  ) {
    throw nativeProfileDrift();
  }
  return Object.freeze({ threadID });
}

function sameExactStringArray(value: unknown, expected: readonly string[]): boolean {
  return Array.isArray(value)
    && value.length === expected.length
    && new Set(value).size === value.length
    && value.every((entry, index) => entry === expected[index]);
}

export function assertThreadStartedNotification(
  value: unknown,
  expectedThreadID: string,
  workspaceRoot: string,
): void {
  const params = requireRecord(value, "Codex thread-start notification is malformed.");
  const thread = requireRecord(params.thread, "Codex thread-start notification is malformed.");
  if (
    thread.id !== expectedThreadID
    || thread.cliVersion !== CODEX_APP_SERVER_VERSION
    || thread.cwd !== workspaceRoot
    || thread.ephemeral !== true
    || thread.modelProvider !== "openai"
    || (thread.parentThreadId !== null && thread.parentThreadId !== undefined)
    || (thread.agentRole !== null && thread.agentRole !== undefined)
  ) {
    throw nativeProfileDrift();
  }
}

export function assertTurnStartReceipt(value: unknown): CodexTurnReceiptV1 {
  const receipt = requireRecord(value, "Codex turn receipt is malformed.");
  const turn = requireRecord(receipt.turn, "Codex turn receipt is malformed.");
  const turnID = readNonemptyString(turn.id);
  if (turnID === undefined || turn.status !== "inProgress" || !Array.isArray(turn.items)) {
    throw protocolFailure("Codex turn receipt is malformed.");
  }
  return Object.freeze({ turnID });
}

export function nativeProfileDrift() {
  return codexFailure(
    "policy",
    "codex_native_profile_drift",
    false,
    "Codex initialized with a native profile that differs from the frozen attempt.",
  );
}

function protocolFailure(message: string) {
  return codexFailure("protocol", "codex_protocol_violation", false, message);
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  const record = readRecord(value);
  if (record === undefined) throw protocolFailure(message);
  return record;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function readNonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

// The named profile carries read restrictions that this legacy projection
// cannot express. Still reject any reported extra write/network authority.
function sameLegacyProjection(value: unknown, writableRoots: readonly string[]): boolean {
  const sandbox = readRecord(value);
  if (sandbox?.networkAccess !== false) return false;
  if (writableRoots.length === 0) return sandbox.type === "readOnly";
  return sandbox.type === "workspaceWrite"
    && sandbox.excludeTmpdirEnvVar === true && sandbox.excludeSlashTmp === true
    && sameExactStringArray(sandbox.writableRoots, writableRoots);
}
