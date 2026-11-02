import { z } from "zod";

import { normalizedFailureSchema } from "./failure.js";

export const NORMALIZED_MESSAGE_ROLES = Object.freeze(["commentary", "final_answer"] as const);
export type NormalizedMessageRoleV1 = (typeof NORMALIZED_MESSAGE_ROLES)[number];

export const NORMALIZED_TOOL_OPERATIONS = Object.freeze([
  "workspace_list",
  "text_read",
  "text_search",
  "text_write",
  "text_edit",
  "web",
  "native_surplus",
] as const);
export type NormalizedToolOperationV1 = (typeof NORMALIZED_TOOL_OPERATIONS)[number];

const eventBase = {
  attemptID: z.string().min(1).max(128),
  sequence: z.number().int().positive(),
};

const lifecycleID = z.string().min(1).max(128);
const deltaText = z.string().max(64 * 1024);
const detailText = z.string().max(4_096);
const tokenCount = z.number().int().nonnegative();

export const normalizedEventSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...eventBase,
    kind: z.literal("message_started"),
    messageID: lifecycleID,
    role: z.enum(NORMALIZED_MESSAGE_ROLES),
  }),
  z.strictObject({ ...eventBase, kind: z.literal("message_delta"), messageID: lifecycleID, text: deltaText }),
  z.strictObject({ ...eventBase, kind: z.literal("message_completed"), messageID: lifecycleID }),
  z.strictObject({ ...eventBase, kind: z.literal("reasoning_summary_delta"), text: deltaText }),
  z.strictObject({
    ...eventBase,
    kind: z.literal("tool_started"),
    toolCallID: lifecycleID,
    operation: z.enum(NORMALIZED_TOOL_OPERATIONS),
    detail: detailText,
  }),
  z.strictObject({ ...eventBase, kind: z.literal("tool_updated"), toolCallID: lifecycleID, detail: detailText }),
  z.strictObject({
    ...eventBase,
    kind: z.literal("tool_completed"),
    toolCallID: lifecycleID,
    status: z.enum(["completed", "failed"]),
    detail: detailText,
  }),
  z.strictObject({ ...eventBase, kind: z.literal("plan_updated"), markdown: deltaText }),
  // Display-only Provider notice. It has no tool, final-answer or liveness authority.
  z.strictObject({ ...eventBase, kind: z.literal("warning"), text: detailText }),
  z.strictObject({
    ...eventBase,
    kind: z.literal("context_updated"),
    usedTokens: tokenCount,
    contextWindowTokens: z.number().int().positive(),
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal("usage_updated"),
    inputTokens: tokenCount,
    outputTokens: tokenCount,
    cachedInputTokens: tokenCount,
  }),
  z.strictObject({
    ...eventBase,
    kind: z.literal("activity"),
    phase: z.enum(["tool_arguments", "queued", "retrying", "compacting"]).optional(),
    detail: detailText.optional(),
  }),
]);

export type NormalizedEventV1 = z.infer<typeof normalizedEventSchema>;

export const attemptTerminalSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("end_turn"), finalMessageID: lifecycleID, finalText: z.string() }),
  z.strictObject({
    kind: z.literal("refused"),
    finalMessageID: lifecycleID.optional(),
    finalText: z.string().optional(),
  }),
  z.strictObject({ kind: z.literal("maximum_output_reached") }),
  z.strictObject({ kind: z.literal("cancelled") }),
  z.strictObject({ kind: z.literal("failed"), failure: normalizedFailureSchema }),
]);

export type AttemptTerminalV1 = z.infer<typeof attemptTerminalSchema>;

interface MessageState {
  readonly role: NormalizedMessageRoleV1;
  text: string;
  completed: boolean;
}

interface ToolState {
  completed: boolean;
}

export class NormalizedEventLedgerV1 {
  readonly #attemptID: string;
  readonly #maximumObservedUTF8Bytes: number;
  readonly #messages = new Map<string, MessageState>();
  readonly #tools = new Map<string, ToolState>();
  #nextSequence = 1;
  #finalMessageID: string | undefined;
  #observedUTF8Bytes = 0;
  #state: "active" | "terminal" | "violated" = "active";

  public constructor(attemptID: string, maximumObservedUTF8Bytes = 1024 * 1024) {
    if (attemptID.length === 0) throw new TypeError("attempt ID must not be empty");
    if (!Number.isSafeInteger(maximumObservedUTF8Bytes) || maximumObservedUTF8Bytes <= 0) {
      throw new TypeError("event text bound must be a positive safe integer");
    }
    this.#attemptID = attemptID;
    this.#maximumObservedUTF8Bytes = maximumObservedUTF8Bytes;
  }

  public get state(): "active" | "terminal" | "violated" {
    return this.#state;
  }

  public observe(value: unknown): void {
    this.#requireActive("event arrived after terminal or violation");
    let event: NormalizedEventV1;
    try {
      event = normalizedEventSchema.parse(value);
    } catch (cause) {
      this.#violation("event does not match the normalized schema", cause);
    }
    if (event.attemptID !== this.#attemptID) this.#violation("event belongs to another attempt");
    if (event.sequence !== this.#nextSequence) this.#violation("event sequence is not contiguous");

    switch (event.kind) {
      case "message_started": {
        if (this.#finalMessageID !== undefined) this.#violation("message started after final answer");
        if (this.#messages.has(event.messageID)) this.#violation("message ID was reused");
        this.#messages.set(event.messageID, { role: event.role, text: "", completed: false });
        break;
      }
      case "message_delta": {
        if (this.#finalMessageID !== undefined) this.#violation("message changed after final answer");
        const message = this.#activeMessage(event.messageID);
        this.#consumeText(event.text);
        message.text += event.text;
        break;
      }
      case "message_completed": {
        const message = this.#activeMessage(event.messageID);
        message.completed = true;
        if (message.role === "final_answer") {
          if (this.#finalMessageID !== undefined) this.#violation("multiple final answers completed");
          this.#finalMessageID = event.messageID;
        }
        break;
      }
      case "tool_started":
        if (this.#finalMessageID !== undefined) this.#violation("tool started after final answer");
        if (this.#tools.has(event.toolCallID)) this.#violation("tool call ID was reused");
        this.#tools.set(event.toolCallID, { completed: false });
        this.#consumeText(event.detail);
        break;
      case "tool_updated":
        this.#activeTool(event.toolCallID);
        this.#consumeText(event.detail);
        break;
      case "tool_completed":
        this.#activeTool(event.toolCallID).completed = true;
        this.#consumeText(event.detail);
        break;
      case "reasoning_summary_delta":
      case "plan_updated":
        if (this.#finalMessageID !== undefined) this.#violation("content event followed final answer");
        this.#consumeText(event.kind === "plan_updated" ? event.markdown : event.text);
        break;
      case "context_updated":
      case "usage_updated":
        break;
      case "warning":
        this.#consumeText(event.text);
        break;
      case "activity":
        if (event.detail !== undefined) this.#consumeText(event.detail);
        break;
    }
    this.#nextSequence += 1;
  }

  public assertTerminal(value: unknown): void {
    this.#requireActive("terminal arrived after terminal or violation");
    let terminal: AttemptTerminalV1;
    try {
      terminal = attemptTerminalSchema.parse(value);
    } catch (cause) {
      this.#violation("terminal does not match the normalized schema", cause);
    }
    const unfinishedMessage = [...this.#messages.values()].some((message) => !message.completed);
    const unfinishedTool = [...this.#tools.values()].some((tool) => !tool.completed);
    if (unfinishedMessage || unfinishedTool) this.#violation("terminal arrived with active lifecycle objects");

    if (terminal.kind === "end_turn") {
      const final = this.#requiredFinal();
      if (terminal.finalMessageID !== this.#finalMessageID || terminal.finalText !== final.text) {
        this.#violation("terminal final answer disagrees with the event stream");
      }
    } else if (terminal.kind === "refused") {
      const hasID = terminal.finalMessageID !== undefined;
      const hasText = terminal.finalText !== undefined;
      if (hasID !== hasText) this.#violation("refusal final answer is incomplete");
      if (hasID) {
        const final = this.#requiredFinal();
        if (terminal.finalMessageID !== this.#finalMessageID || terminal.finalText !== final.text) {
          this.#violation("refusal final answer disagrees with the event stream");
        }
      } else if (this.#finalMessageID !== undefined) {
        this.#violation("refusal omitted a completed final answer");
      }
    } else if (this.#finalMessageID !== undefined) {
      this.#violation("non-message terminal followed a completed final answer");
    }
    this.#state = "terminal";
  }

  public finalText(): string | undefined {
    if (this.#state !== "terminal") {
      throw new ProviderContractViolation("final text is unavailable before authoritative terminal");
    }
    return this.#finalMessageID === undefined
      ? undefined
      : this.#messages.get(this.#finalMessageID)?.text;
  }

  #activeMessage(messageID: string): MessageState {
    const message = this.#messages.get(messageID);
    if (message === undefined || message.completed) this.#violation("message lifecycle is invalid");
    return message;
  }

  #activeTool(toolCallID: string): ToolState {
    const tool = this.#tools.get(toolCallID);
    if (tool === undefined || tool.completed) this.#violation("tool lifecycle is invalid");
    return tool;
  }

  #requiredFinal(): MessageState {
    if (this.#finalMessageID === undefined) this.#violation("terminal has no final answer");
    return this.#messages.get(this.#finalMessageID)!;
  }

  #consumeText(value: string): void {
    const next = this.#observedUTF8Bytes + Buffer.byteLength(value, "utf8");
    if (next > this.#maximumObservedUTF8Bytes) {
      this.#violation("normalized event text exceeds its aggregate byte bound");
    }
    this.#observedUTF8Bytes = next;
  }

  #requireActive(message: string): void {
    if (this.#state !== "active") this.#violation(message);
  }

  #violation(message: string, cause?: unknown): never {
    this.#state = "violated";
    throw new ProviderContractViolation(message, cause);
  }
}

export class ProviderContractViolation extends Error {
  public constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ProviderContractViolation";
  }
}
