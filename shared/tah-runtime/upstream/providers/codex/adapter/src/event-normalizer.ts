import type {
  AttemptTerminalV1,
  NormalizedToolOperationV1,
} from "../../../../src/contract/index.js";
import type { GuestNormalizedEventInputV1 } from "../../../../src/guest/runtime/adapter.js";
import { codexAuthenticationFailure, codexFailure } from "./failure.js";
import type { CodexNativeProfileV1 } from "./native-profile.js";
import type { CodexAppServerInboundV1 } from "./process-facade.js";
import type { CodexNativeToolLifecycleObserverV1 } from "./sandbox-qualification.js";
import { CodexWarningEmitterV1 } from "./warnings.js";
import { nativeEventDiagnostic } from "./notification-diagnostics.js";

const MAX_DELTA_BYTES = 64 * 1024;
const MAX_DETAIL_BYTES = 4_096;
const MAX_BUFFERED_MESSAGE_BYTES = 1024 * 1024;
const MAX_INTERACTION_DISPLAYS = 64;

type MessagePhase = "commentary" | "partial_answer" | "final_answer" | null;

interface AgentMessageState {
  readonly nativeID: string;
  readonly order: number;
  phase: MessagePhase;
  text: string;
  normalizedID?: string;
  completed: boolean;
  completionEmitted: boolean;
}

interface ToolState {
  readonly nativeID: string;
  readonly nativeType: "commandExecution" | "fileChange" | "webSearch";
  readonly normalizedID: string;
  readonly name: string;
  readonly detail: string;
  completed: boolean;
  updated: boolean;
  nativeProcessID: string | undefined;
  interactionCount: number;
  lastInteraction: string | undefined;
}

type TerminalDraft =
  | Readonly<{ kind: "end_turn"; finalText: string }>
  | Extract<AttemptTerminalV1, { kind: "refused" | "maximum_output_reached" | "failed" }>;

export class CodexEventNormalizerV1 {
  readonly #profile: CodexNativeProfileV1;
  readonly #workspaceRoot: string;
  readonly #controllerHome: string;
  readonly #threadID: string;
  readonly #turnID: string;
  readonly #maximumFinalBytes: number;
  readonly #emit: (event: GuestNormalizedEventInputV1) => void;
  readonly #nativeToolObserver: CodexNativeToolLifecycleObserverV1 | null;
  readonly #warnings: CodexWarningEmitterV1;
  readonly #messages = new Map<string, AgentMessageState>();
  readonly #tools = new Map<string, ToolState>();
  readonly #reasoningSummaries = new Set<string>();
  readonly #rawReasoningActivities = new Set<string>();
  #nextMessageID = 1;
  #nextToolID = 1;
  #nextMessageOrder = 1;
  #bufferedMessageBytes = 0;
  #interactionDisplays = 0;
  #terminal: TerminalDraft | undefined;

  public constructor(params: {
    readonly profile: CodexNativeProfileV1;
    readonly workspaceRoot: string;
    readonly controllerHome: string;
    readonly threadID: string;
    readonly turnID: string;
    readonly maximumFinalBytes: number;
    readonly emit: (event: GuestNormalizedEventInputV1) => void;
    readonly nativeToolObserver?: CodexNativeToolLifecycleObserverV1 | null;
    readonly warnings?: CodexWarningEmitterV1;
  }) {
    this.#profile = params.profile;
    this.#workspaceRoot = params.workspaceRoot;
    this.#controllerHome = params.controllerHome;
    this.#threadID = params.threadID;
    this.#turnID = params.turnID;
    this.#maximumFinalBytes = params.maximumFinalBytes;
    this.#emit = params.emit;
    this.#nativeToolObserver = params.nativeToolObserver ?? null;
    this.#warnings = params.warnings ?? new CodexWarningEmitterV1(params.emit);
  }

  /** Returns true only for the authoritative turn/completed notification. */
  public accept(event: CodexAppServerInboundV1): boolean {
    if (event.kind === "server_request") throw serverRequestFailure();
    if (this.#terminal !== undefined) {
      this.acceptTail(event);
      return false;
    }
    const params = requireRecord(event.params);
    switch (event.method) {
      case "turn/started":
        this.#assertThread(params);
        this.#assertTurnObject(params.turn, "inProgress");
        return false;
      case "item/started":
        this.#assertTurn(params);
        this.#acceptItemStarted(requireRecord(params.item));
        return false;
      case "item/completed":
        this.#assertTurn(params);
        this.#acceptItemCompleted(requireRecord(params.item));
        return false;
      case "item/agentMessage/delta":
        this.#assertTurn(params);
        this.#acceptAgentDelta(params);
        return false;
      case "item/reasoning/summaryTextDelta":
        this.#assertTurn(params);
        this.#acceptReasoningSummary(params);
        return false;
      case "item/reasoning/summaryPartAdded":
        this.#assertTurn(params);
        this.#emit({ kind: "activity" });
        return false;
      case "item/reasoning/textDelta":
        this.#assertTurn(params);
        this.#acceptRawReasoning(params);
        return false;
      case "thread/tokenUsage/updated":
        this.#assertTurn(params);
        this.#acceptUsage(params.tokenUsage);
        return false;
      case "turn/plan/updated":
        this.#assertTurn(params);
        this.#acceptPlan(params);
        return false;
      case "item/plan/delta":
        this.#assertTurn(params);
        this.#emit({ kind: "plan_updated", markdown: boundedText(readString(params.delta) ?? "") });
        return false;
      case "item/commandExecution/outputDelta":
      case "command/exec/outputDelta":
        this.#assertTurn(params);
        this.#acceptToolProgress(params.itemId, "Command produced output");
        return false;
      case "item/commandExecution/terminalInteraction":
        this.#assertTurn(params);
        this.#acceptTerminalInteraction(params);
        return false;
      case "item/fileChange/outputDelta":
      case "item/fileChange/patchUpdated":
        this.#assertTurn(params);
        this.#acceptToolProgress(params.itemId, "File update progressed");
        return false;
      case "turn/diff/updated":
        this.#assertTurn(params);
        this.#emit({ kind: "activity" });
        return false;
      case "thread/compacted":
        this.#assertThread(params);
        this.#emit({ kind: "activity" });
        return false;
      case "error":
        this.#assertTurn(params);
        this.#acceptErrorNotification(params);
        return false;
      case "warning":
        this.#warnings.accept(params, this.#threadID);
        return false;
      case "deprecationNotice":
        this.#warnings.acceptDeprecation(params, this.#threadID);
        return false;
      case "thread/status/changed":
        this.#acceptThreadStatus(params);
        return false;
      case "account/rateLimits/updated":
        return false;
      case "account/updated":
        this.#acceptAccountUpdated(params);
        return false;
      // Provider-side safety metadata does not grant tools, change the model or
      // authorize output. Only turn/completed can establish the final result.
      case "turn/moderationMetadata":
        this.#assertTurn(params);
        if (!("metadata" in params)) throw protocolFailure("Codex omitted moderation metadata.");
        return false;
      case "model/safetyBuffering/updated":
        this.#assertTurn(params);
        this.#acceptSafetyBuffering(params);
        return false;
      case "turn/completed":
        this.#assertThread(params);
        this.#acceptTurnCompleted(requireRecord(params.turn));
        return true;
      case "thread/closed":
        throw protocolFailure("Codex closed the thread before completing the turn.");
      case "serverRequest/resolved":
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed":
      case "item/mcpToolCall/progress":
      case "mcpServer/oauthLogin/completed":
      case "mcpServer/startupStatus/updated":
      case "hook/started":
      case "hook/completed":
      case "skills/changed":
      case "app/list/updated":
      case "thread/settings/updated":
      case "thread/goal/updated":
      case "thread/goal/cleared":
      case "thread/environment/connected":
      case "thread/environment/disconnected":
      case "model/rerouted":
      case "model/verification":
      case "guardianWarning":
      case "configWarning":
      case "rawResponse/completed":
      case "rawResponseItem/completed":
      case "process/outputDelta":
      case "process/exited":
      case "remoteControl/status/changed":
      case "externalAgentConfig/import/progress":
      case "externalAgentConfig/import/completed":
      case "fs/changed":
      case "fuzzyFileSearch/sessionUpdated":
      case "fuzzyFileSearch/sessionCompleted":
      case "thread/realtime/started":
      case "thread/realtime/itemAdded":
      case "thread/realtime/transcript/delta":
      case "thread/realtime/transcript/done":
      case "thread/realtime/outputAudio/delta":
      case "thread/realtime/sdp":
      case "thread/realtime/error":
      case "thread/realtime/closed":
        throw ambientFailure(event.method);
      default:
        throw protocolFailure(`Codex emitted an unsupported app-server notification. ${nativeEventDiagnostic(event.method, "active-turn")}`);
    }
  }

  public acceptTail(event: CodexAppServerInboundV1): void {
    if (event.kind === "server_request") throw serverRequestFailure();
    const params = requireRecord(event.params);
    if (event.method === "warning") {
      this.#warnings.accept(params, this.#threadID);
      return;
    }
    if (event.method === "deprecationNotice") {
      this.#warnings.acceptDeprecation(params, this.#threadID);
      return;
    }
    if (event.method === "thread/tokenUsage/updated") {
      this.#assertTurn(params);
      this.#acceptUsage(params.tokenUsage);
      return;
    }
    if (event.method === "thread/status/changed") {
      this.#acceptThreadStatus(params);
      return;
    }
    if (event.method === "account/rateLimits/updated") return;
    if (event.method === "account/updated") {
      this.#acceptAccountUpdated(params);
      return;
    }
    if (event.method === "thread/closed" && params.threadId === this.#threadID) return;
    throw protocolFailure(`Codex emitted semantic output after turn completion. ${nativeEventDiagnostic(event.method, "after-turn")}`);
  }

  #acceptSafetyBuffering(params: Record<string, unknown>): void {
    const strings = (value: unknown) => Array.isArray(value) && value.length <= 64
      && value.every(item => typeof item === "string" && item.length <= 4096);
    if (params.model !== this.#profile.modelID || typeof params.showBufferingUi !== "boolean"
      || !strings(params.reasons) || !strings(params.useCases)
      || (params.fasterModel != null && typeof params.fasterModel !== "string")) {
      throw protocolFailure(`Codex emitted malformed safety-buffering status. ${nativeEventDiagnostic("model/safetyBuffering/updated", "active-turn")}`);
    }
    // Do not publish the provider's moderation reasons or switch to its suggested model.
    this.#emit({ kind: "activity" });
  }

  /** Called after app-server exit and auth cleanup have both succeeded. */
  public finish(): AttemptTerminalV1 {
    if (this.#terminal === undefined) {
      throw protocolFailure("Codex ended without an authoritative turn completion.");
    }
    this.#completeOpenCommentary();
    if ([...this.#tools.values()].some((tool) => !tool.completed)) {
      throw protocolFailure("Codex completed the turn with an active tool lifecycle.");
    }
    if (this.#terminal.kind !== "end_turn") return this.#terminal;
    if (Buffer.byteLength(this.#terminal.finalText, "utf8") > this.#maximumFinalBytes) {
      return { kind: "maximum_output_reached" };
    }
    const finalMessageID = `codex-final-${this.#nextMessageID++}`;
    this.#emit({ kind: "message_started", messageID: finalMessageID, role: "final_answer" });
    this.#emitMessageText(finalMessageID, this.#terminal.finalText);
    this.#emit({ kind: "message_completed", messageID: finalMessageID });
    return { kind: "end_turn", finalMessageID, finalText: this.#terminal.finalText };
  }

  /** Qualification-only preflight; it does not publish or mutate lifecycle output. */
  public hasSuccessfulEndTurn(): boolean {
    return this.#terminal?.kind === "end_turn";
  }

  public stopOpenLifecycles(): void {
    for (const message of this.#messages.values()) {
      message.completed = true;
      if (message.normalizedID !== undefined && !message.completionEmitted) {
        this.#emit({ kind: "message_completed", messageID: message.normalizedID });
        message.completionEmitted = true;
      }
    }
    this.#bufferedMessageBytes = 0;
    for (const tool of this.#tools.values()) {
      if (tool.completed) continue;
      tool.completed = true;
      this.#emit({
        kind: "tool_completed",
        toolCallID: tool.normalizedID,
        status: "failed",
        detail: detailWithSuffix(tool.detail, ` — ${tool.name} stopped`),
      });
    }
  }

  #acceptItemStarted(item: Record<string, unknown>): void {
    const id = requireString(item.id);
    const type = requireString(item.type);
    if (this.#messages.has(id) || this.#tools.has(id)) {
      throw protocolFailure("Codex reused a native item identifier.");
    }
    if (type === "agentMessage") {
      assertTerminalBoundMessage(item);
      if ([...this.#messages.values()].some((message) => message.phase === "final_answer")) {
        throw protocolFailure("Codex emitted assistant output after declaring a final answer.");
      }
      const phase = parsePhase(item.phase);
      const text = requireText(item.text);
      const state: AgentMessageState = {
        nativeID: id,
        order: this.#nextMessageOrder++,
        phase,
        text: "",
        completed: false,
        completionEmitted: false,
      };
      this.#messages.set(id, state);
      if (phase === "commentary") this.#startCommentary(state);
      this.#appendMessage(state, text);
      return;
    }
    if (type === "commandExecution" || type === "fileChange" || type === "webSearch") {
      if ([...this.#messages.values()].some((message) =>
        message.phase === "final_answer"
      )) {
        throw protocolFailure("Codex started a tool after declaring a final answer.");
      }
      this.#nativeToolObserver?.acceptStarted(item);
      this.#startTool(type, id, item);
      return;
    }
    if (type === "userMessage") return;
    if (type === "reasoning") {
      this.#acceptCompletedReasoning(item, false);
      return;
    }
    if (type === "contextCompaction") {
      this.#emit({ kind: "activity" });
      return;
    }
    if (type === "plan") return;
    throw forbiddenItemFailure();
  }

  #acceptItemCompleted(item: Record<string, unknown>): void {
    const id = requireString(item.id);
    const type = requireString(item.type);
    if (type === "agentMessage") {
      assertTerminalBoundMessage(item);
      const state = this.#messages.get(id);
      if (state === undefined || state.completed) {
        throw protocolFailure("Codex completed an unknown agent message.");
      }
      const phase = parsePhase(item.phase);
      const text = requireText(item.text);
      if (state.text !== text) throw protocolFailure("Codex agent message deltas disagree with completion.");
      if (state.phase !== phase && state.phase !== null) {
        throw protocolFailure("Codex changed an already-known message phase.");
      }
      state.phase = phase;
      state.completed = true;
      if (phase !== "final_answer") this.#flushCommentary(state);
      else if (state.normalizedID !== undefined) {
        throw protocolFailure("Codex reclassified commentary as a final answer.");
      }
      return;
    }
    if (type === "commandExecution" || type === "fileChange" || type === "webSearch") {
      this.#nativeToolObserver?.acceptCompleted(item);
      this.#completeTool(type, id, item);
      return;
    }
    if (type === "userMessage" || type === "plan" || type === "contextCompaction") return;
    if (type === "reasoning") {
      this.#acceptCompletedReasoning(item, true);
      return;
    }
    throw forbiddenItemFailure();
  }

  #acceptAgentDelta(params: Record<string, unknown>): void {
    const id = requireString(params.itemId);
    const state = this.#messages.get(id);
    if (state === undefined || state.completed) {
      throw protocolFailure("Codex emitted a delta for an unknown agent message.");
    }
    this.#appendMessage(state, requireText(params.delta));
  }

  #appendMessage(state: AgentMessageState, text: string): void {
    if (state.phase === "commentary") {
      const messageID = this.#startCommentary(state);
      this.#emitMessageText(messageID, text);
    } else {
      const next = this.#bufferedMessageBytes + Buffer.byteLength(text, "utf8");
      if (!Number.isSafeInteger(next) || next > MAX_BUFFERED_MESSAGE_BYTES) {
        throw codexFailure(
          "resource",
          "codex_message_buffer_exceeded",
          false,
          "Codex exceeded the bounded pending-message buffer.",
        );
      }
      this.#bufferedMessageBytes = next;
    }
    state.text += text;
  }

  #startCommentary(state: AgentMessageState): string {
    if (state.normalizedID !== undefined) return state.normalizedID;
    const id = `codex-commentary-${this.#nextMessageID++}`;
    state.normalizedID = id;
    this.#emit({ kind: "message_started", messageID: id, role: "commentary" });
    return id;
  }

  #flushCommentary(state: AgentMessageState): void {
    if (state.phase === "final_answer") return;
    if (state.normalizedID === undefined) {
      const id = this.#startCommentary(state);
      this.#emitMessageText(id, state.text);
      this.#bufferedMessageBytes -= Buffer.byteLength(state.text, "utf8");
    }
    if (state.completed && state.normalizedID !== undefined && !state.completionEmitted) {
      this.#emit({ kind: "message_completed", messageID: state.normalizedID });
      state.completionEmitted = true;
    }
  }

  #completeOpenCommentary(): void {
    for (const state of this.#orderedMessages()) {
      if (state.phase === "final_answer") continue;
      if (state.normalizedID === undefined) this.#flushCommentary(state);
      if (state.normalizedID !== undefined && !state.completionEmitted) {
        this.#emit({ kind: "message_completed", messageID: state.normalizedID });
        state.completionEmitted = true;
      }
    }
  }

  #orderedMessages(): AgentMessageState[] {
    return [...this.#messages.values()].sort((left, right) => left.order - right.order);
  }

  #startTool(
    type: ToolState["nativeType"],
    id: string,
    item: Record<string, unknown>,
  ): void {
    if (type === "fileChange" && this.#profile.writableRoots.length === 0) {
      throw forbiddenToolFailure();
    }
    if (type === "webSearch" && !this.#profile.nativeMechanisms.includes("web_search")) {
      throw forbiddenToolFailure();
    }
    const projection = projectTool(
      type,
      item,
      this.#workspaceRoot,
      this.#controllerHome,
      this.#profile,
    );
    const state: ToolState = {
      nativeID: id,
      nativeType: type,
      normalizedID: `codex-tool-${this.#nextToolID++}`,
      name: projection.name,
      detail: projection.detail,
      completed: false,
      updated: false,
      nativeProcessID: undefined,
      interactionCount: 0,
      lastInteraction: undefined,
    };
    if (type === "commandExecution") this.#rememberProcessID(state, item.processId);
    this.#tools.set(id, state);
    this.#emit({
      kind: "tool_started",
      toolCallID: state.normalizedID,
      operation: projection.operation,
      detail: projection.detail,
    });
  }

  #completeTool(
    type: ToolState["nativeType"],
    id: string,
    item: Record<string, unknown>,
  ): void {
    const state = this.#tools.get(id);
    if (state === undefined || state.completed || state.nativeType !== type) {
      throw protocolFailure("Codex emitted an invalid native tool lifecycle.");
    }
    const status = type === "webSearch" ? "completed" : readString(item.status);
    if (status === "declined") throw approvalFailure();
    if (status !== "completed" && status !== "failed") {
      throw protocolFailure("Codex completed a tool with an invalid status.");
    }
    if (type === "commandExecution") this.#rememberProcessID(state, item.processId);
    state.completed = true;
    const exitCode = type === "commandExecution" && Number.isInteger(item.exitCode)
      ? ` (exit ${String(item.exitCode)})`
      : "";
    // Web requests can start with an empty query/action. The completed item is
    // authoritative; retain the initial detail only if it adds no usable data.
    const detail = type === "webSearch" ? webToolDetail(item) ?? state.detail : state.detail;
    this.#emit({
      kind: "tool_completed",
      toolCallID: state.normalizedID,
      status: status === "completed" ? "completed" : "failed",
      detail: detailWithSuffix(detail, ` — ${status}${exitCode}${state.lastInteraction === undefined
        ? "" : `; ${state.lastInteraction} (${state.interactionCount} interactions)`}`),
    });
  }

  #rememberProcessID(state: ToolState, value: unknown): void {
    // Native IDs stay inside the Adapter. A nullable startup/completion PID is
    // allowed; the first available receipt binds it to this known command.
    if (value === undefined || value === null) return;
    const id = requireString(value);
    if (Buffer.byteLength(id, "utf8") > 128
      || (state.nativeProcessID !== undefined && state.nativeProcessID !== id)) {
      throw protocolFailure("Codex changed the process identity of a native command.");
    }
    state.nativeProcessID = id;
  }

  #acceptTerminalInteraction(params: Record<string, unknown>): void {
    const state = this.#tools.get(requireString(params.itemId));
    if (state === undefined || state.nativeType !== "commandExecution") {
      throw protocolFailure("Codex terminal interaction belongs to an unknown native command.");
    }
    this.#rememberProcessID(state, requireString(params.processId));
    const input = requireText(params.stdin);
    // This is a post-execution receipt, not permission to send stdin. Neither
    // the input, native process identity nor any additional native fields leave
    // the Adapter. Empty polls and non-empty input use the same frozen grant.
    state.interactionCount += 1;
    state.lastInteraction = input.length === 0
      ? "Terminal output polled"
      : `Terminal input sent (${Buffer.byteLength(input, "utf8")} bytes)`;
    if (this.#interactionDisplays >= MAX_INTERACTION_DISPLAYS) {
      this.#emit({ kind: "activity" });
      return;
    }
    this.#interactionDisplays += 1;
    const suffix = ` — ${state.lastInteraction} (interaction ${state.interactionCount})`;
    if (!state.completed) {
      this.#emit({ kind: "tool_updated", toolCallID: state.normalizedID, detail: detailWithSuffix(state.detail, suffix) });
      return;
    }
    // A non-empty write can observe process exit, so its item/completed can
    // precede this receipt. Preserve that terminal status; never reopen a tool.
    const messageID = `codex-followup-${this.#nextMessageID++}`;
    this.#emit({ kind: "message_started", messageID, role: "commentary" });
    this.#emitMessageText(messageID, detailWithSuffix(`Command follow-up: ${state.detail}`, suffix));
    this.#emit({ kind: "message_completed", messageID });
  }

  #acceptToolProgress(itemID: unknown, detail: string): void {
    const id = requireString(itemID);
    const state = this.#tools.get(id);
    if (state === undefined || state.completed) {
      throw protocolFailure("Codex emitted output for an unknown native tool.");
    }
    if (state.updated) return;
    state.updated = true;
    this.#emit({
      kind: "tool_updated",
      toolCallID: state.normalizedID,
      detail: detailWithSuffix(state.detail, ` — ${detail}`),
    });
  }

  #acceptReasoningSummary(params: Record<string, unknown>): void {
    const itemID = requireString(params.itemId);
    this.#reasoningSummaries.add(itemID);
    for (const chunk of utf8Chunks(requireText(params.delta), MAX_DELTA_BYTES)) {
      this.#emit({ kind: "reasoning_summary_delta", text: chunk });
    }
  }

  #acceptRawReasoning(params: Record<string, unknown>): void {
    const itemID = requireString(params.itemId);
    requireText(params.delta);
    if (this.#rawReasoningActivities.has(itemID)) return;
    this.#rawReasoningActivities.add(itemID);
    this.#emit({ kind: "activity" });
  }

  #acceptCompletedReasoning(item: Record<string, unknown>, completed: boolean): void {
    const itemID = requireString(item.id);
    if (!completed || this.#reasoningSummaries.has(itemID)) return;
    if (!Array.isArray(item.summary)) throw protocolFailure("Codex reasoning summary is malformed.");
    for (const part of item.summary) {
      for (const chunk of utf8Chunks(requireText(part), MAX_DELTA_BYTES)) {
        this.#emit({ kind: "reasoning_summary_delta", text: chunk });
      }
    }
    this.#reasoningSummaries.add(itemID);
  }

  #acceptUsage(value: unknown): void {
    const usage = readRecord(value) ?? {};
    const total = readRecord(usage.total) ?? {};
    const inputTokens = tokenCount(total.inputTokens);
    const outputTokens = tokenCount(total.outputTokens);
    const cachedInputTokens = tokenCount(total.cachedInputTokens);
    if (inputTokens !== undefined && outputTokens !== undefined && cachedInputTokens !== undefined) {
      this.#emit({ kind: "usage_updated", inputTokens, outputTokens, cachedInputTokens });
    }
    const contextWindowTokens = tokenCount(usage.modelContextWindow);
    const usedTokens = tokenCount(total.totalTokens);
    if (contextWindowTokens === undefined || contextWindowTokens === 0 || usedTokens === undefined) return;
    this.#emit({
      kind: "context_updated",
      usedTokens: Math.min(contextWindowTokens, usedTokens),
      contextWindowTokens,
    });
  }

  #acceptPlan(params: Record<string, unknown>): void {
    if (!Array.isArray(params.plan)) return;
    const lines = params.plan.flatMap((value) => {
      const step = readRecord(value);
      if (!step || typeof step.step !== "string" || !["pending", "in_progress", "completed"].includes(String(step.status))) return [];
      return [`- [${String(step.status)}] ${step.step}`];
    });
    if (lines.length === 0) return;
    const explanation = readString(params.explanation);
    const markdown = explanation === undefined || explanation.length === 0
      ? lines.join("\n")
      : `${explanation}\n\n${lines.join("\n")}`;
    this.#emit({ kind: "plan_updated", markdown: boundedText(markdown) });
  }

  #acceptErrorNotification(params: Record<string, unknown>): void {
    const error = requireRecord(params.error);
    // Pinned 0.153.4 notify_stream_error projects reconnect/backoff (including
    // compaction retries) as willRetry + responseStreamDisconnected. This is
    // not a terminal error. Keep every message/tool identity and wait for the
    // native stream to continue; never retry the turn or replay effects here.
    // Unknown, policy, auth and quota classifications still fail closed.
    if (params.willRetry === true && isNativeStreamRetryInfo(error.codexErrorInfo)) {
      this.#emit({ kind: "activity", phase: "retrying", detail: "Codex is retrying the model request" });
      return;
    }
    const classification = classifyTurnError(error);
    if (classification !== undefined) throw classification;
    throw codexFailure(
      "provider_availability",
      "codex_turn_error",
      true,
      "Codex reported a non-retryable turn error.",
    );
  }

  #acceptThreadStatus(params: Record<string, unknown>): void {
    if (params.threadId !== this.#threadID) throw protocolFailure("Codex status belongs to another thread.");
    const status = requireRecord(params.status);
    const type = requireString(status.type);
    if (type === "systemError") {
      throw codexFailure(
        "provider_availability",
        "codex_thread_system_error",
        true,
        "Codex entered a system-error state.",
      );
    }
    if (type === "active") {
      if (!Array.isArray(status.activeFlags)) throw protocolFailure("Codex thread status is malformed.");
      if (status.activeFlags.length !== 0) throw approvalFailure();
      return;
    }
    if (type !== "idle" && type !== "notLoaded") {
      throw protocolFailure("Codex thread status is malformed.");
    }
  }

  #acceptAccountUpdated(params: Record<string, unknown>): void {
    if (params.authMode !== "chatgpt" && params.authMode !== "apikey") {
      throw codexAuthenticationFailure();
    }
  }

  #acceptTurnCompleted(turn: Record<string, unknown>): void {
    if (turn.id !== this.#turnID || !Array.isArray(turn.items)) {
      throw protocolFailure("Codex completed another or malformed turn.");
    }
    if (turn.status === "interrupted") {
      this.#terminal = {
        kind: "failed",
        failure: {
          family: "provider_availability",
          code: "codex_turn_interrupted",
          retryable: true,
          message: "Codex interrupted the turn before completion.",
        },
      };
      return;
    }
    if (turn.status === "failed") {
      const classified = classifyTurnError(readRecord(turn.error));
      this.#terminal = classified === undefined
        ? {
            kind: "failed",
            failure: {
              family: "provider_availability",
              code: "codex_turn_failed",
              retryable: true,
              message: "Codex could not complete this attempt.",
            },
          }
        : { kind: "failed", failure: classified.failure };
      return;
    }
    if (turn.status !== "completed") throw protocolFailure("Codex turn completion status is invalid.");

    const items = turn.items.map((item) => requireRecord(item));
    for (const item of items) {
      if (item.type === "agentMessage") assertTerminalBoundMessage(item);
      if (!["userMessage", "agentMessage", "commandExecution", "fileChange", "webSearch", "reasoning", "plan", "contextCompaction"].includes(requireString(item.type))) {
        throw forbiddenItemFailure();
      }
    }
    const explicitFinals = items
      .filter((item) => item.type === "agentMessage" && item.phase === "final_answer");
    if (explicitFinals.length !== 1) {
      throw protocolFailure("Codex completed without exactly one provider-designated final answer.");
    }
    const finalItem = explicitFinals[0]!;
    const nativeID = requireString(finalItem.id);
    const state = this.#messages.get(nativeID);
    const finalText = requireText(finalItem.text);
    if (
      state === undefined
      || !state.completed
      || state.phase !== "final_answer"
      || state.text !== finalText
    ) {
      throw protocolFailure("Codex final-answer receipt disagrees with the item stream.");
    }
    for (const message of this.#messages.values()) {
      if (message.nativeID !== nativeID && message.phase === "final_answer") {
        throw protocolFailure("Codex emitted multiple provider-designated final answers.");
      }
      if (message.phase !== "final_answer") this.#flushCommentary(message);
    }
    this.#bufferedMessageBytes -= Buffer.byteLength(finalText, "utf8");
    this.#terminal = { kind: "end_turn", finalText };
  }

  #assertThread(params: Record<string, unknown>): void {
    if (params.threadId !== this.#threadID) {
      throw protocolFailure("Codex notification belongs to another thread.");
    }
  }

  #assertTurn(params: Record<string, unknown>): void {
    this.#assertThread(params);
    if (params.turnId !== this.#turnID) {
      throw protocolFailure("Codex notification belongs to another turn.");
    }
  }

  #assertTurnObject(value: unknown, expectedStatus: string): void {
    const turn = requireRecord(value);
    if (turn.id !== this.#turnID || turn.status !== expectedStatus) {
      throw protocolFailure("Codex turn-start notification is malformed.");
    }
  }

  #emitMessageText(messageID: string, text: string): void {
    for (const chunk of utf8Chunks(text, MAX_DELTA_BYTES)) {
      this.#emit({ kind: "message_delta", messageID, text: chunk });
    }
  }
}

interface ToolProjection {
  readonly name: string;
  readonly operation: NormalizedToolOperationV1;
  readonly detail: string;
}

function assertTerminalBoundMessage(item: Record<string, unknown>): void {
  // 0.153 can express request_user_input_async as agentMessage metadata.
  // TAH has no mid-turn question/continuation contract; never admit it as a final answer.
  if (item.delivery !== undefined && item.delivery !== null
    || item.questions !== undefined && item.questions !== null) {
    throw codexFailure("policy", "codex_async_input_unsupported", false,
      "Codex requested an unsupported mid-turn interaction.");
  }
}

function projectTool(
  type: ToolState["nativeType"],
  item: Record<string, unknown>,
  workspaceRoot: string,
  controllerHome: string,
  profile: CodexNativeProfileV1,
): ToolProjection {
  if (type === "commandExecution") {
    const command = requireText(item.command);
    if (command.includes(controllerHome)) throw controllerAccessFailure();
    const actions = Array.isArray(item.commandActions)
      ? item.commandActions.map((value) => requireRecord(value))
      : [];
    const operation = commandOperation(actions);
    return Object.freeze({
      name: "Command",
      operation,
      detail: boundedDetail(`Command: ${command}`),
    });
  }
  if (type === "fileChange") {
    if (!Array.isArray(item.changes) || profile.writableRoots.length === 0) {
      throw forbiddenToolFailure();
    }
    const paths = item.changes.map((value) => {
      const change = requireRecord(value);
      return logicalPath(change.path, workspaceRoot, true, profile);
    });
    return Object.freeze({
      name: "File update",
      operation: "text_edit",
      detail: boundedDetail(`Edit files: ${paths.join(", ")}`),
    });
  }
  return Object.freeze({ name: "Web", operation: "web", detail: webToolDetail(item) ?? "Web search" });
}

function webToolDetail(item: Record<string, unknown>): string | undefined {
  const action = readRecord(item.action);
  const text = (value: unknown): string | undefined => {
    const result = readString(value)?.trim();
    return result ? boundedDetail(result) : undefined;
  };
  if (action?.type === "openPage" || action?.type === "findInPage") {
    const url = publicURL(action.url);
    if (action.type === "findInPage") {
      const pattern = text(action.pattern);
      if (url || pattern) return boundedDetail(`Find in page: ${[url, pattern].filter(Boolean).join(" · ")}`);
    } else if (url) return boundedDetail(`Open page: ${url}`);
  }
  const queries = action?.type === "search" && Array.isArray(action.queries)
    ? [...new Set(action.queries.slice(0, 16).map(text).filter((value): value is string => value !== undefined))]
    : [];
  const query = queries.length ? queries.join("; ") : text(action?.type === "search" ? action.query : undefined) ?? text(item.query);
  return query === undefined ? undefined : boundedDetail(`Web search: ${query}`);
}

function commandOperation(actions: readonly Record<string, unknown>[]): NormalizedToolOperationV1 {
  const types = new Set(actions.map((action) => action.type));
  if (types.size === 1 && types.has("read")) return "text_read";
  if (types.size === 1 && types.has("listFiles")) return "workspace_list";
  if (types.size === 1 && types.has("search")) return "text_search";
  return "native_surplus";
}

function logicalPath(
  value: unknown,
  workspaceRoot: string,
  writable: boolean,
  profile: CodexNativeProfileV1,
): string {
  if (typeof value !== "string" || value.length === 0) throw forbiddenToolFailure();
  let relative: string;
  if (value.startsWith(`${workspaceRoot}/`)) relative = value.slice(workspaceRoot.length + 1);
  else if (value.startsWith("/")) throw forbiddenToolFailure();
  else relative = value.startsWith("./") ? value.slice(2) : value;
  if (
    relative.length === 0
    || relative.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(relative)
    || relative.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    throw forbiddenToolFailure();
  }
  if (writable) {
    const roots = profile.writableRoots.map((root) => root.slice(workspaceRoot.length + 1));
    if (!roots.some((root) => relative.startsWith(`${root}/`))) throw forbiddenToolFailure();
  }
  return relative;
}

function publicURL(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return undefined;
  }
}

function isNativeStreamRetryInfo(value: unknown): boolean {
  // The protocol also permits an omitted/null optional error classification.
  if (value === undefined || value === null) return true;
  const info = readRecord(value);
  if (info === undefined || Object.keys(info).length !== 1) return false;
  const disconnected = readRecord(info.responseStreamDisconnected);
  if (disconnected === undefined || Object.keys(disconnected).some((key) => key !== "httpStatusCode")) return false;
  const status = disconnected.httpStatusCode;
  return status === undefined || status === null
    || (Number.isSafeInteger(status) && (status as number) >= 0 && (status as number) <= 65_535);
}

function classifyTurnError(error: Record<string, unknown> | undefined):
  | ReturnType<typeof codexFailure>
  | undefined {
  const info = error?.codexErrorInfo;
  if (info === "unauthorized") return codexAuthenticationFailure();
  if (info === "usageLimitExceeded" || info === "sessionBudgetExceeded") {
    return codexFailure(
      "rate_or_quota",
      "codex_rate_or_quota",
      false,
      "Codex could not continue because of an account quota limit.",
    );
  }
  if (info === "contextWindowExceeded") {
    return codexFailure(
      "resource",
      "codex_context_window_exceeded",
      false,
      "Codex could not fit this attempt in the selected model context window.",
    );
  }
  if (info === "cyberPolicy") {
    return codexFailure(
      "policy",
      "codex_provider_policy_block",
      false,
      "Codex blocked this attempt under Provider policy.",
    );
  }
  if (info === "badRequest") {
    return codexFailure(
      "configuration",
      "codex_bad_request",
      false,
      "Codex rejected the frozen native request configuration.",
    );
  }
  if (info === "sandboxError") {
    return codexFailure(
      "policy",
      "codex_native_sandbox_failed",
      false,
      "Codex could not enforce its native sandbox policy.",
    );
  }
  if (info !== undefined) {
    return codexFailure(
      "provider_availability",
      "codex_provider_error",
      true,
      "Codex reported a Provider runtime failure.",
    );
  }
  return undefined;
}

function parsePhase(value: unknown): MessagePhase {
  if (value === null || value === undefined) return null;
  if (value === "commentary" || value === "partial_answer" || value === "final_answer") return value;
  throw protocolFailure("Codex emitted an unknown agent-message phase.");
}

function tokenCount(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function requireRecord(value: unknown): Record<string, unknown> {
  const record = readRecord(value);
  if (record === undefined) throw protocolFailure("Codex app-server payload is malformed.");
  return record;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw protocolFailure("Codex app-server identifier is malformed.");
  }
  return value;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function requireText(value: unknown): string {
  if (typeof value !== "string") throw protocolFailure("Codex text payload is malformed.");
  return value;
}

function boundedText(value: string): string {
  return [...utf8Chunks(value, MAX_DELTA_BYTES)][0] ?? "";
}

function boundedDetail(value: string): string {
  const sanitized = value.replace(/[\u0000-\u001f\u007f]+/gu, " ");
  return [...utf8Chunks(sanitized, MAX_DETAIL_BYTES)][0] ?? "Codex tool";
}

function detailWithSuffix(detail: string, suffix: string): string {
  const safeSuffix = boundedDetail(suffix);
  const suffixBytes = Buffer.byteLength(safeSuffix, "utf8");
  const prefixBudget = Math.max(1, MAX_DETAIL_BYTES - suffixBytes);
  const prefix = [...utf8Chunks(detail, prefixBudget)][0] ?? "Codex tool";
  return boundedDetail(`${prefix}${safeSuffix}`);
}

function* utf8Chunks(value: string, maximumBytes: number): Generator<string> {
  let chunk = "";
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, "utf8");
    if (bytes + size > maximumBytes && chunk.length > 0) {
      yield chunk;
      chunk = "";
      bytes = 0;
    }
    chunk += character;
    bytes += size;
  }
  if (chunk.length > 0) yield chunk;
}

function protocolFailure(message: string) {
  return codexFailure("protocol", "codex_protocol_violation", false, message);
}

function serverRequestFailure() {
  return codexFailure(
    "policy",
    "codex_server_request_forbidden",
    false,
    "Codex requested an approval, elicitation, dynamic tool, or other disabled Host action.",
  );
}

function approvalFailure() {
  return codexFailure(
    "policy",
    "codex_approval_forbidden",
    false,
    "Codex entered a user or approval wait despite the frozen never-ask policy.",
  );
}

function ambientFailure(method: string) {
  return codexFailure(
    "policy",
    "codex_ambient_feature_drift",
    false,
    `Codex emitted a notification disabled for this attempt. ${nativeEventDiagnostic(method, "active-turn")}`,
  );
}

function forbiddenItemFailure() {
  return codexFailure(
    "policy",
    "codex_forbidden_item",
    false,
    "Codex emitted a native item outside the frozen ability grant.",
  );
}

function forbiddenToolFailure() {
  return codexFailure(
    "policy",
    "codex_tool_scope_violation",
    false,
    "Codex attempted a native tool operation outside the frozen scope.",
  );
}

function controllerAccessFailure() {
  return codexFailure(
    "policy",
    "codex_controller_access_attempted",
    false,
    "Codex attempted to access its controller-only state.",
  );
}
