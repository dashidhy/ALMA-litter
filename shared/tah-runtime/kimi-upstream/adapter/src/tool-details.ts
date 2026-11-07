import { posix } from "node:path";
import type { NativeEvent } from "./native-sdk.js";

// Same public display grammar as Codex/Qoder: the UI already localizes these
// wrappers. Native file bodies, edit contents and raw credential-bearing errors
// are not public event details. Rendering never grants execution permission.
const MAX_DETAIL_BYTES = 4096;
const MAX_FIELD_CHARS = 1600;
export interface ToolDetailContext { readonly workspaceRoot: string; readonly credential: string }

export function kimiToolStartDetail(event: NativeEvent, context: ToolDetailContext): string {
  const args = record(event.args), display = record(event.display);
  const nativePath = (display.kind === "file_io" || display.kind === "diff") ? display.path : undefined;
  const path = logicalPath(nativePath ?? args.path, context.workspaceRoot);
  const parts: string[] = [];
  let label: string;
  switch (event.name) {
    case "Read":
      label = "Read"; parts.push(path);
      if (integer(args.line_offset) && args.line_offset !== 0) {
        if (args.line_offset < 0) parts.push(`start ${-args.line_offset} lines from end`);
        else if (positive(args.n_lines) && Number.isSafeInteger(args.line_offset + args.n_lines - 1)) {
          parts.push(`lines ${args.line_offset}–${args.line_offset + args.n_lines - 1}`);
        } else parts.push(`from line ${args.line_offset}`);
      } else if (positive(args.n_lines)) parts.push(`up to ${args.n_lines} lines`);
      if (integer(args.column_offset) && args.column_offset >= 0) parts.push(`column offset ${args.column_offset}`);
      if (positive(args.max_chars)) parts.push(`max ${args.max_chars} characters`);
      break;
    case "Glob":
      label = "List"; parts.push(optionalPath(nativePath ?? args.path, context.workspaceRoot));
      addField(parts, "pattern", args.pattern);
      if (args.include_ignored === true) parts.push("include ignored files");
      break;
    case "Grep":
      label = "Search"; parts.push(optionalPath(nativePath ?? args.path, context.workspaceRoot));
      addField(parts, "pattern", args.pattern); addField(parts, "glob", args.glob); addField(parts, "type", args.type);
      if (["content", "files_with_matches", "count_matches"].includes(String(args.output_mode))) parts.push(String(args.output_mode));
      if (args["-i"] === true) parts.push("case-insensitive");
      break;
    case "Write":
      label = "Write"; parts.push(path, args.mode === "append" ? "append" : "overwrite");
      if (typeof args.content === "string") parts.push(`${Buffer.byteLength(args.content)} bytes requested`);
      break;
    case "Edit":
      label = "Edit"; parts.push(path, args.replace_all === true ? "replace all occurrences" : "replace first occurrence");
      // Size is useful; old_string/new_string and diff bodies may contain user text.
      if (typeof args.old_string === "string" && typeof args.new_string === "string") {
        parts.push(`${args.old_string.length} → ${args.new_string.length} characters`);
      }
      break;
    case "WebSearch":
      label = "Web search"; parts.push(field(args.query ?? display.query) || "[query unavailable]"); break;
    case "FetchURL":
      label = "Web fetch"; parts.push(publicURL(args.url ?? display.url) ?? "[URL unavailable]"); break;
    default: throw new TypeError("Unsupported Kimi native tool detail");
  }
  return publicDetail(`${label}: ${parts.join(" · ")}`, context);
}

export function kimiToolProgressDetail(detail: string, value: unknown, context: ToolDetailContext): string | undefined {
  const update = record(value);
  // stdout/stderr/custom can carry tool bodies or authentication payloads; they
  // are not status messages. Do not promote them into a public working log.
  if (update.kind !== "progress" && update.kind !== "status") return undefined;
  const parts: string[] = [];
  if (typeof update.percent === "number" && Number.isFinite(update.percent) && update.percent >= 0 && update.percent <= 100) {
    parts.push(`${Math.round(update.percent)}%`);
  }
  const text = field(update.text);
  if (text) parts.push(text);
  return parts.length ? withSuffix(detail, parts.join(" · "), context) : undefined;
}

export function kimiToolCompletionDetail(name: string, detail: string, output: unknown, failed: boolean,
  context: ToolDetailContext): string {
  const prefix = failed ? "Failed" : "Completed";
  const text = outputText(output);
  const summary = failed ? failureSummary(name, text) : resultSummary(name, text, output);
  return withSuffix(`${prefix}: ${detail}`, summary, context);
}

export function kimiToolStoppedDetail(detail: string, context: ToolDetailContext): string {
  return withSuffix(`Stopped: ${detail}`, "cancelled or interrupted before a native result", context);
}

function resultSummary(name: string, text: string, output: unknown): string | undefined {
  if (name === "Read") {
    // Pinned SDK appends this status separately from numbered file contents.
    const read = /(?:^|\n)(\d{1,9}) lines? read from file starting from line (\d{1,9})\./u.exec(text);
    const total = /(?:^|\n)Total lines in file: (\d{1,9})\./u.exec(text);
    const parts = read ? [`${read[1]} lines read from line ${read[2]}`]
      : /(?:^|\n)No lines read from file\./u.test(text) ? ["no lines read"] : [];
    if (total) parts.push(`${total[1]} total lines`);
    if (/(?:^|\n)Character limit reached\./u.test(text)) parts.push("character limit reached");
    if (parts.length) return parts.join(" · ");
    if (typeof output === "string") {
      const numbered = output.length <= 16384 ? [...output.matchAll(/^(\d{1,9})\t/gmu)] : [];
      if (numbered.length) return `${numbered.length} numbered ${numbered.length === 1 ? "line" : "lines"} returned from line ${numbered[0]![1]}`;
      return `${output.length} characters returned`;
    }
    return undefined;
  }
  if (name === "Write") {
    const match = /^(Wrote|Appended) (\d{1,12}) bytes to /u.exec(text);
    return match ? `${match[2]} bytes ${match[1] === "Appended" ? "appended" : "written"}` : undefined;
  }
  if (name === "Edit") {
    const match = /^Replaced (\d{1,9}) occurrences? in /u.exec(text);
    return match ? `${match[1]} ${match[1] === "1" ? "replacement" : "replacements"} applied` : undefined;
  }
  if ((name === "Glob" || name === "Grep") && /^No (?:search )?matches found[.\n]?$/u.test(text.trim())) return "no matches";
  if (name === "WebSearch" && /^No search results found[.\n]?$/u.test(text.trim())) return "no search results";
  return undefined;
}

function failureSummary(name: string, text: string): string {
  // Match known diagnostics, not arbitrary file contents or echoed arguments.
  const errno = /\b(EACCES|EPERM|EROFS|ENOENT|ENOSPC|EISDIR|ENOTDIR|EFBIG)\b/u.exec(text)?.[1];
  const http = /\b(?:HTTP|Status:?)\s*(\d{3})\b/iu.exec(text)?.[1];
  const parts: string[] = [];
  if (errno) parts.push(errno);
  if (http && Number(http) >= 400 && Number(http) <= 599) parts.push(`HTTP ${http}`);
  if (/permission|denied|not allowed|rejected|blocked by/iu.test(text)) parts.push("permission denied");
  else if (/old_string and new_string are exactly the same/iu.test(text)) parts.push("no changes requested");
  else if (name === "Edit" && /old_string|not found in|no match|could not find|cannot find|not unique|multiple matches/iu.test(text)) parts.push("edit target text missing or ambiguous");
  else if (/does not exist|no such file|file (?:was )?not found/iu.test(text)) parts.push("file or directory not found");
  else if (/invalid args|validation|invalid.*(argument|input)|required.*(argument|field)|missing.*(argument|field)/iu.test(text)) parts.push("invalid tool arguments");
  else if (/not a file|not a directory/iu.test(text)) parts.push("unexpected file type");
  else if (/too small|too large|exceed|limit/iu.test(text)) parts.push("tool size or output limit");
  else if (/timed? ?out|timeout/iu.test(text)) parts.push("request timed out");
  else if (/network|fetch failed|connection|ECONN/iu.test(text)) parts.push("network request failed");
  else if (/cancel|abort|interrupt/iu.test(text)) parts.push("cancelled or interrupted");
  return parts.length ? parts.join(" · ") : "native tool reported an error";
}

function outputText(value: unknown): string {
  const bounded = (text: string) => text.length <= 16384 ? text : `${text.slice(0, 4096)}\n${text.slice(-12288)}`;
  if (typeof value === "string") return bounded(value);
  if (!Array.isArray(value)) return "";
  return value.slice(0, 8).flatMap(part => {
    const block = record(part); return block.type === "text" && typeof block.text === "string" ? [bounded(block.text)] : [];
  }).join("\n");
}

function logicalPath(value: unknown, workspace: string): string {
  if (typeof value !== "string" || !value || value.length > 8192 || /[\\\u0000-\u001f\u007f]/u.test(value)) return "[path unavailable]";
  const absolute = posix.resolve(workspace, value);
  if (absolute === workspace) return ".";
  return absolute.startsWith(`${workspace}/`) ? absolute.slice(workspace.length + 1) : "[outside task workspace]";
}
function optionalPath(value: unknown, workspace: string): string { return value == null || value === "" ? "." : logicalPath(value, workspace); }
function publicURL(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 8192) return undefined;
  try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? `${url.protocol}//${url.host}${url.pathname}` : undefined; }
  catch { return undefined; }
}
function withSuffix(detail: string, suffix: string | undefined, context: ToolDetailContext): string {
  const safeSuffix = suffix ? publicDetail(suffix, context, 1024) : "";
  const separator = safeSuffix ? " · " : "";
  return publicDetail(detail, context, MAX_DETAIL_BYTES - Buffer.byteLength(separator + safeSuffix)) + separator + safeSuffix;
}
function publicDetail(value: string, context: ToolDetailContext, maximumBytes = MAX_DETAIL_BYTES): string {
  let safe = context.credential ? value.split(context.credential).join("[redacted]") : value;
  safe = safe.replace(/\b(?:sk-|pt-)[A-Za-z0-9_-]{12,}/gu, "[redacted]")
    .replace(/\bBearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/giu, "$1[redacted]")
    .replace(/https?:\/\/[^\s<>"']+/gu, url => publicURL(url) ?? "[URL unavailable]")
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, " ").trim();
  if (Buffer.byteLength(safe) <= maximumBytes) return safe;
  let length = 0; let result = "";
  for (const character of safe) { const bytes = Buffer.byteLength(character); if (length + bytes > maximumBytes - 3) break; result += character; length += bytes; }
  return result + "…";
}
function field(value: unknown): string {
  if (typeof value !== "string") return "";
  if (value.length <= MAX_FIELD_CHARS) return Buffer.from(value).toString("utf8");
  let end = MAX_FIELD_CHARS;
  if (/[\uD800-\uDBFF]/u.test(value[end - 1]!)) end--;
  return Buffer.from(value.slice(0, end)).toString("utf8") + "…";
}
function addField(parts: string[], name: string, value: unknown): void { const text = field(value); if (text) parts.push(`${name}=${text}`); }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value); }
function positive(value: unknown): value is number { return integer(value) && value > 0; }
