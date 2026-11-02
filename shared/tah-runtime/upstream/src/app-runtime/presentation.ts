import { createHash } from "node:crypto";
import { z } from "zod";
import type { NormalizedEventV1 } from "../contract/events.js";
import type { TahAttemptScopeV1 } from "../framework/workflow.js";

export const MAX_WORKING_LOG_BYTES = 4 * 1024 * 1024;
const MAX_RETAINED_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_RETAINED_EVENTS = 512;
export const appPresentationSchema = z.strictObject({
  startedAt: z.iso.datetime().optional(), endedAt: z.iso.datetime().optional(),
  workingLogSHA256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  workingLogBytes: z.number().int().nonnegative().max(MAX_WORKING_LOG_BYTES).optional(),
  workingLogLimited: z.boolean().optional(),
  stages: z.array(z.strictObject({ id: z.string().max(64), phase: z.string().max(64), at: z.iso.datetime() })).max(32),
  events: z.array(z.strictObject({ id: z.string().max(512), title: z.string().max(128), detail: z.string().max(1024),
    detailTruncated: z.boolean().optional(),
    titleCode: z.enum(["safety_guardian", "actor_update", "reasoning_summary", "plan", "provider_notice", "tool.workspace_list", "tool.text_read", "tool.text_search", "tool.text_write", "tool.text_edit", "tool.web", "tool.native_surplus", "activity.queued", "activity.retrying", "activity.compacting"]).optional(),
    role: z.enum(["raw_guardian", "extra_guardian", "actor"]), round: z.number().int().min(0).max(1).nullable(),
    kind: z.enum(["tool", "notice", "activity"]), status: z.enum(["pass", "running", "completed", "failed", "stopped"]) })).max(24),
});
type Presentation = z.infer<typeof appPresentationSchema>;
type Event = Presentation["events"][number];

/** Only this Host-created final verdict may cross the Guardian/Actor boundary. */
export function isGuardianOutcome(event: Event): boolean {
  return event.id === "extra-safety-pass" && event.titleCode === "safety_guardian"
    && event.role === "extra_guardian" && event.kind === "activity" && event.status === "pass";
}
export function canReadWorkingLog(phase: string, presentation?: Presentation | null): boolean {
  if (["raw_guardian", "extra_guardian", "saving_safety", "raw_blocked", "extra_blocked", "preparing", "running", "editing", "draft"].includes(phase)) return false;
  return ["actor", "critic", "completed", "published", "needs_user_revision"].includes(phase)
    || !!presentation?.stages.some(stage => stage.phase === "actor" || stage.phase === "critic")
    || !!presentation?.events.some(event => event.role === "actor");
}
export function publicPresentation(presentation: Presentation, phase: string): Presentation {
  const { workingLogSHA256, workingLogBytes, workingLogLimited, ...metadata } = presentation;
  return { ...metadata, events: presentation.events.filter(event => event.role === "actor" || isGuardianOutcome(event)),
    ...(canReadWorkingLog(phase, presentation) ? { workingLogSHA256, workingLogBytes, workingLogLimited } : {}) };
}

/** Only normalized public events. Raw reasoning is discarded by the Adapter.
 * Keep bounded full activity separate from the small XPC preview; never place
 * native payloads, telemetry, or an uncommitted final reply into either surface. */
export class AppPresentationTracker {
  #stageSequence = 0;
  #startedAt: string | undefined;
  #stages: Presentation["stages"] = [];
  #events: Event[] = [];
  #commentary = new Set<string>();
  #limited = false;
  #cachedLog: {finished: boolean; text: string; sha256: string; bytes: number} | undefined;
  guardianPassed(explanation: string): void {
    // Host-owned display event, never an admission source. Discard transient
    // Guardian tool chatter; keep its explanation only as the first Actor event.
    this.#events = [{id:"extra-safety-pass", title:"Safety Guardian", titleCode:"safety_guardian", detail:explanation,
      role:"extra_guardian", round:null, kind:"activity", status:"pass"}];
    this.#commentary.clear(); this.#limited = false; this.#cachedLog = undefined;
  }
  #discardOldestEvent() {
    return this.#events.splice(this.#events[0]?.titleCode === "safety_guardian" && this.#events.length > 1 ? 1 : 0, 1)[0]!;
  }
  stage(phase: string): void {
    if (this.#stages.at(-1)?.phase === phase) return;
    this.#startedAt ??= new Date().toISOString();
    this.#stages.push({ id: String(++this.#stageSequence), phase, at: new Date().toISOString() });
    this.#stages = this.#stages.slice(-32);
  }
  event(scope: TahAttemptScopeV1, event: NormalizedEventV1): void {
    // Reject at collection time, before any public snapshot/log can expose a
    // Guardian tool, warning, plan, commentary or progress detail.
    if (scope.role !== "actor") return;
    const base = { role: scope.role, round: scope.round };
    if (event.kind === "message_started" && event.role === "commentary") {
      if (this.#commentary.size < MAX_RETAINED_EVENTS) this.#commentary.add(`${event.attemptID}:${event.messageID}`);
    } else if (event.kind === "message_delta" && this.#commentary.has(`${event.attemptID}:${event.messageID}`)) {
      const id = `${event.attemptID}:${event.messageID}`, existing = this.#events.find(item => item.id === id);
      if (existing) existing.detail = this.#text(existing.detail + event.text);
      else this.#events.push({ ...base, id, title: "Actor update", titleCode: "actor_update", detail: this.#text(event.text), kind: "activity", status: "running" });
    } else if (event.kind === "message_completed") {
      const id = `${event.attemptID}:${event.messageID}`;
      if (this.#commentary.delete(id)) {
        const existing = this.#events.find(item => item.id === id);
        if (existing) existing.status = "completed";
      }
    } else if (event.kind === "reasoning_summary_delta" || event.kind === "plan_updated") {
      const reasoning = event.kind === "reasoning_summary_delta";
      const id = `${event.attemptID}:${reasoning ? "reasoning-summary" : "plan"}`;
      const existing = this.#events.find(item => item.id === id);
      const detail = this.#text(reasoning ? (existing?.detail ?? "") + event.text : event.markdown);
      if (existing) existing.detail = detail;
      else this.#events.push({...base, id, title: reasoning ? "Reasoning summary" : "Plan",
        titleCode: reasoning ? "reasoning_summary" : "plan", detail, kind: "activity", status: "completed"});
    } else if (event.kind === "tool_started" || event.kind === "tool_updated" || event.kind === "tool_completed") {
      const id = `${event.attemptID}:${event.toolCallID}`, existing = this.#events.find(item => item.id === id);
      const title = event.kind === "tool_started" ? ({ workspace_list: "List files", text_read: "Read", text_search: "Search files",
        text_write: "Write", text_edit: "Edit", web: "Web access", native_surplus: "Tool activity" } as const)[event.operation] : existing?.title ?? "Tool activity";
      const update: Event = { ...base, id, title, detail: this.#text(event.detail), kind: "tool",
        titleCode: event.kind === "tool_started" ? `tool.${event.operation}` : existing?.titleCode ?? "tool.native_surplus",
        status: event.kind === "tool_completed" ? event.status : "running" };
      if (existing) Object.assign(existing, update); else this.#events.push(update);
    } else if (event.kind === "warning") {
      this.#events.push({ ...base, id: `${event.attemptID}:notice:${event.sequence}`, title: "Provider notice",
        titleCode: "provider_notice", detail: this.#text(event.text), kind: "notice", status: "completed" });
    } else if (event.kind === "activity" && event.phase && event.phase !== "tool_arguments") {
      const title = { queued: "Waiting for Provider", retrying: "Retrying", compacting: "Compacting context" }[event.phase];
      const id = `${event.attemptID}:activity:${event.phase}`, existing = this.#events.find(item => item.id === id);
      if (existing) existing.detail = this.#text(event.detail ?? "");
      else this.#events.push({ ...base, id, title, titleCode: `activity.${event.phase}`, detail: this.#text(event.detail ?? ""), kind: "activity", status: "completed" });
    }
    let bytes = this.#events.reduce((sum, item) => sum + Buffer.byteLength(item.detail), 0);
    while (this.#events.length > MAX_RETAINED_EVENTS || bytes > MAX_RETAINED_TEXT_BYTES) {
      bytes -= Buffer.byteLength(this.#discardOldestEvent().detail); this.#limited = true;
    }
    this.#cachedLog = undefined;
  }
  #text(value: string): string {
    const clean = value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
    const bounded = clipText(clean, MAX_RETAINED_TEXT_BYTES);
    if (bounded !== clean) this.#limited = true;
    return bounded;
  }
  workingLog(finished = false): {text: string; sha256: string; bytes: number} {
    if (this.#cachedLog?.finished === finished) return this.#cachedLog;
    const serialize = () => JSON.stringify({schemaVersion: 1, limited: this.#limited,
      events: this.#events.map(event => ({...event, status: finished && event.status === "running" ? "stopped" : event.status}))});
    let text = serialize();
    while (Buffer.byteLength(text) > MAX_WORKING_LOG_BYTES) {
      this.#limited = true;
      if (this.#events.length > 1) this.#discardOldestEvent();
      else this.#events[0]!.detail = clipText(this.#events[0]!.detail, MAX_RETAINED_TEXT_BYTES / 2);
      text = serialize();
    }
    this.#cachedLog = {finished, text, bytes: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex")};
    return this.#cachedLog;
  }
  snapshot(finished = false): Presentation {
    const log = this.workingLog(finished);
    const result: Presentation = { startedAt: this.#startedAt, ...(finished ? { endedAt: new Date().toISOString() } : {}),
      workingLogSHA256: log.sha256, workingLogBytes: log.bytes, workingLogLimited: this.#limited,
      stages: this.#stages.map(stage => ({ ...stage })), events: this.#events.slice(-24).map(event => {
        const detail = event.titleCode === "safety_guardian" ? event.detail : clipText(event.detail, 256);
        return {...event, detail, ...(detail !== event.detail ? {detailTruncated: true} : {}),
          status: finished && event.status === "running" ? "stopped" as const : event.status};
      }) };
    // Progress carries this preview and a legacy duplicate events field. Budget
    // encoded JSON (including escapes), not just visible character counts.
    while (result.events.length && Buffer.byteLength(JSON.stringify(result)) > 32 * 1024) result.events.shift();
    return result;
  }
}

/** Unicode-safe head/tail preview: new stream deltas remain visible after the cap. */
function clipText(value: string, maximumBytes: number): string {
  const bytes = Buffer.from(value);
  if (bytes.length <= maximumBytes) return value;
  const half = Math.floor((maximumBytes - Buffer.byteLength(" … ")) / 2);
  let head = half, tail = bytes.length - half;
  while ((bytes[head]! & 0xc0) === 0x80) head--;
  while ((bytes[tail]! & 0xc0) === 0x80) tail++;
  return bytes.subarray(0, head).toString("utf8") + " … " + bytes.subarray(tail).toString("utf8");
}
