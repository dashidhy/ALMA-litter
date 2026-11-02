import { createHash } from "node:crypto";
import { CODEX_APP_SERVER_VERSION } from "./receipts.js";

// Diagnostics only, not an admission list. Never retain payloads, native error
// text, account information or an arbitrary provider-supplied method string.
const names = new Set([
  "serverRequest/resolved", "item/autoApprovalReview/started", "item/autoApprovalReview/completed",
  "item/mcpToolCall/progress", "mcpServer/oauthLogin/completed", "mcpServer/startupStatus/updated",
  "hook/started", "hook/completed", "skills/changed", "app/list/updated",
  "thread/settings/updated", "thread/goal/updated", "thread/goal/cleared",
  "thread/environment/connected", "thread/environment/disconnected",
  "model/rerouted", "model/verification", "model/safetyBuffering/updated", "turn/moderationMetadata",
  "guardianWarning", "configWarning", "deprecationNotice", "rawResponse/completed", "rawResponseItem/completed",
  "process/outputDelta", "process/exited", "remoteControl/status/changed",
  "externalAgentConfig/import/progress", "externalAgentConfig/import/completed", "fs/changed",
  "fuzzyFileSearch/sessionUpdated", "fuzzyFileSearch/sessionCompleted",
  "thread/realtime/started", "thread/realtime/itemAdded", "thread/realtime/transcript/delta",
  "thread/realtime/transcript/done", "thread/realtime/outputAudio/delta", "thread/realtime/sdp",
  "thread/realtime/error", "thread/realtime/closed",
]);

export function nativeEventDiagnostic(method: string, stage: "startup" | "active-turn" | "after-turn"): string {
  const name = names.has(method) ? method : `unknown-sha256:${createHash("sha256").update(method).digest("hex").slice(0, 16)}`;
  return `[Codex ${CODEX_APP_SERVER_VERSION}; event=${name}; stage=${stage}]`;
}
