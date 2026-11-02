import type { GuestNormalizedEventInputV1 } from "../../../../src/guest/runtime/adapter.js";
import { codexFailure } from "./failure.js";

const MAX_NATIVE_WARNING_BYTES = 64 * 1024;
const MAX_WARNING_TEXT_BYTES = 4_096;
const MAX_DISPLAYED_WARNINGS = 64;

/** Plain-text display projection only. Never classify whether a task may continue from its text. */
export class CodexWarningEmitterV1 {
  readonly #emit: (event: GuestNormalizedEventInputV1) => void;
  #count = 0;

  public constructor(emit: (event: GuestNormalizedEventInputV1) => void) {
    this.#emit = emit;
  }

  public accept(params: Record<string, unknown>, threadID: string): void {
    if (params.threadId !== undefined && params.threadId !== null && params.threadId !== threadID) {
      throw codexFailure("protocol", "codex_protocol_violation", false, "Codex warning belongs to another thread.");
    }
    if (this.#count > MAX_DISPLAYED_WARNINGS) return;
    const text = this.#count === MAX_DISPLAYED_WARNINGS
      ? "Further Provider warnings omitted from display; task policy is unchanged."
      : projectCodexWarningText(params.message);
    this.#count += 1;
    this.#emit({ kind: "warning", text });
  }

  public acceptDeprecation(params: Record<string, unknown>, threadID: string): void {
    if (typeof params.summary !== "string" || Buffer.byteLength(params.summary, "utf8") > MAX_NATIVE_WARNING_BYTES
      || (params.details != null && typeof params.details !== "string")) {
      throw codexFailure("protocol", "codex_protocol_violation", false, "Codex emitted a malformed deprecationNotice.");
    }
    // The event is advisory; its text is never an admission condition. Project
    // only a closed option vocabulary, not native details, paths or account data.
    const knownOption = ["memory_tool", "codex_hooks", "shell_zsh_fork", "unified_exec_zsh_fork", "web_search_request", "web_search_cached", "transcript_v2"]
      .find(key => params.summary!.toString().includes(`[features].${key}`));
    this.accept({ threadId: params.threadId,
      message: `Codex reported deprecationNotice${knownOption ? ` for ${knownOption}` : ""}. The task's permissions are unchanged.` }, threadID);
  }
}

export function projectCodexWarningText(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) return "Provider emitted a warning without displayable text.";
  if (Buffer.byteLength(value, "utf8") > MAX_NATIVE_WARNING_BYTES) return "Provider emitted a warning; oversized native details were omitted.";
  // Best-effort presentation redaction, not a security classifier. Do not expose
  // structured error bodies, quoted values, physical paths or credential-shaped text.
  let text = value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gu, "[private key omitted]")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, "")
    .replace(/\b(?:response[ _-]?body|body|headers|additionalDetails)\s*[:=][\s\S]*/giu, "[native details omitted]")
    .replace(/\{[\s\S]*\}|\[[\s\S]*\]/gu, "[structured details omitted]")
    .replace(/([`"'])([^\r\n]*?)\1/gu, "[quoted value]")
    .replace(/\b(?:bearer|basic)\s+[^\s,;]+/giu, "[credential omitted]")
    .replace(/\b(?:[a-z_]*token|[a-z_]*secret|password|authorization|cookie|(?:openai_)?api[_-]?key)\s*[:=][^\r\n]*/giu, "[credential details omitted]")
    .replace(/\bhttps?:\/\/[^\s<>"'`]+/giu, "[URL]")
    .replace(/(?<![\w:])(?:[A-Za-z]:[\\/]|\/)[^\s<>"'`,;)]*/gu, "[path]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[account]")
    .replace(/\b[A-Za-z0-9_+=/.\-]{24,}\b/gu, "[opaque value]")
    .trim();
  if (text.length === 0) return "Provider emitted a warning; native details were omitted.";
  const suffix = " … [truncated]";
  if (Buffer.byteLength(text, "utf8") <= MAX_WARNING_TEXT_BYTES) return text;
  let bytes = 0;
  let end = 0;
  for (const character of text) {
    const next = bytes + Buffer.byteLength(character, "utf8");
    if (next > MAX_WARNING_TEXT_BYTES - Buffer.byteLength(suffix, "utf8")) break;
    bytes = next;
    end += character.length;
  }
  text = text.slice(0, end);
  return text + suffix;
}
