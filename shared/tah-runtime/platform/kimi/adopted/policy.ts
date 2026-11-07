import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { FrozenAttemptV1, NormalizedToolOperationV1 } from "../../../upstream/src/contract/index.js";
import { resolveNativeGrant, type NativeAbilityMapping } from "../../../upstream/src/guest/adapter-kit/index.js";
import { KIMI_MODELS, isKimiModelID, type KimiModelID } from "./models.js";

const MAPPING: NativeAbilityMapping = {
  "prompt.inline_text": { settings: { "input.channel": "native_harness_prompt" } },
  "workspace.entries.list": { tools: ["Glob"] },
  "workspace.text.read": { tools: ["Read"] },
  "workspace.text.search": { tools: ["Grep"] },
  "workspace.text.write": { tools: ["Write"] },
  "workspace.text.edit": { tools: ["Edit"] },
  web: { tools: ["FetchURL", "WebSearch"] },
};
export const KIMI_OPERATIONS: Readonly<Record<string, NormalizedToolOperationV1>> = Object.freeze({
  Glob: "workspace_list", Read: "text_read", Grep: "text_search", Write: "text_write", Edit: "text_edit",
  FetchURL: "web", WebSearch: "web",
});
export interface KimiProfile { readonly model: KimiModelID; readonly effort: string; readonly tools: readonly string[] }
export function kimiProfile(attempt: FrozenAttemptV1): KimiProfile {
  const model = attempt.inference.modelID;
  if (attempt.providerID !== "kimi" || !isKimiModelID(model)) throw new Error("kimi_model_not_supported");
  const effort = attempt.inference.reasoningEffortID;
  if (effort === null || !KIMI_MODELS[model].efforts.includes(effort)) throw new Error("kimi_effort_not_supported");
  if (attempt.inference.contextWindowTokens !== undefined) throw new Error("kimi_context_override_not_supported");
  const tools = resolveNativeGrant(attempt.requiredAbilities, MAPPING).tools;
  if (!tools.length) throw new Error("kimi_empty_tools_not_supported");
  return { model, effort, tools };
}
export interface NativeApproval { readonly toolName: string; readonly toolCallId: string; readonly display: Record<string, unknown> }

/** Approval only. Kimi's own tools execute the work; no Host tool forwarding. */
export async function approveKimiTool(request: NativeApproval, profile: KimiProfile,
  workspace: string, writableRoots: readonly string[]): Promise<{ decision: "approved" | "rejected" }> {
  const deny = { decision: "rejected" } as const;
  if (!profile.tools.includes(request.toolName)) return deny;
  const display = request.display;
  if (!display || typeof display !== "object") return deny;
  if (request.toolName === "WebSearch") {
    return display.kind === "search" && typeof display.query === "string" && display.query.length <= 8192
      ? { decision: "approved" } : deny;
  }
  if (request.toolName === "FetchURL") {
    try {
      if (display.kind !== "url_fetch" || typeof display.url !== "string" || display.url.length > 8192) return deny;
      const url = new URL(display.url);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return deny;
      return { decision: "approved" };
    } catch { return deny; }
  }
  const expected = { Read: "read", Write: "write", Edit: "edit", Glob: "glob", Grep: "grep" }[request.toolName];
  if (!expected || !(display.kind === "file_io" && display.operation === expected
    || display.kind === "diff" && (request.toolName === "Write" || request.toolName === "Edit"))
    || typeof display.path !== "string" || !isAbsolute(display.path) || display.path.includes("\0")) return deny;
  const target = resolve(display.path);
  if (target !== workspace && !target.startsWith(`${workspace}/`)) return deny;
  const writing = request.toolName === "Write" || request.toolName === "Edit";
  if (writing && !writableRoots.some(root => target.startsWith(`${workspace}/${root}/`))) return deny;
  try {
    // Neither links nor special files may redirect native access into private runtime/configuration.
    let ancestor = target;
    for (;;) {
      try {
        const st = await lstat(ancestor);
        if (st.isSymbolicLink() || await realpath(ancestor) !== ancestor) return deny;
        if (ancestor === target) {
          if (st.isFile() && st.nlink !== 1 || !st.isFile() && !st.isDirectory()) return deny;
          if ((request.toolName === "Read" || writing) && !st.isFile()) return deny;
          if (request.toolName === "Glob" && !st.isDirectory()) return deny;
        } else if (!st.isDirectory()) return deny;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !(["Read", "Write", "Edit", "Glob", "Grep"].includes(request.toolName)) || ancestor === workspace) return deny;
        ancestor = dirname(ancestor);
      }
    }
    return { decision: "approved" };
  } catch { return deny; }
}
