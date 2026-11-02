import type {
  AttemptTerminalV1,
  FrozenAttemptV1,
} from "../../../../src/contract/index.js";
import type {
  GuestProviderAdapterV1,
  GuestProviderAttemptContextV1,
} from "../../../../src/guest/runtime/adapter.js";
import {
  CODEX_CONTROLLER_HOME,
  CodexAuthMaterialError,
  CodexAuthMaterialGuardV1,
} from "./auth-material.js";
import { CodexEventNormalizerV1 } from "./event-normalizer.js";
import { nativeEventDiagnostic } from "./notification-diagnostics.js";
import { CodexWarningEmitterV1 } from "./warnings.js";
import {
  codexAuthenticationFailure,
  codexFailure,
  codexFailureTerminal,
  isCodexAuthenticationRPCError,
} from "./failure.js";
import {
  CodexProfileError,
  resolveCodexNativeProfile,
  type CodexNativeProfileV1,
} from "./native-profile.js";
import {
  CodexStdioAppServerFacadeV1,
  CodexAppServerRPCErrorV1,
  CodexAppServerTransportErrorV1,
  type CodexAppServerConnectionV1,
  type CodexAppServerFacadeV1,
  type CodexAppServerInboundV1,
} from "./process-facade.js";
import { projectCodexPrompt } from "./prompt.js";
import {
  assertAccountReceipt,
  assertInitializeReceipt,
  assertModelAvailable,
  assertThreadStartedNotification,
  assertThreadStartReceipt,
  assertTurnStartReceipt,
  parseModelPage,
} from "./receipts.js";
import {
  CODEX_SANDBOX_QUALIFICATION_INPUT_PATH,
  CODEX_SANDBOX_QUALIFICATION_RECEIPT_PATH,
  createCodexNativeSandboxQualificationObserverV1,
  encodeCodexNativeSandboxMachineReceiptV1,
  prepareCodexNativeSandboxFixtureV1,
  CodexSandboxQualificationError,
  type CodexNativeToolLifecycleObserverV1,
} from "./sandbox-qualification.js";

const MAX_MODEL_PAGES = 16;
const MAX_MODELS = 4_096;
const STARTUP_EVENT_TIMEOUT_MS = 60_000;

export interface CodexGuestAdapterOptionsV1 {
  readonly executablePath: string;
  readonly workspaceRoot: string;
  /** Provider-appliance construction data; never part of the Host contract. */
  readonly controllerHome?: string;
  readonly appServer?: CodexAppServerFacadeV1;
}

/** One-operation Codex Adapter intended to run inside a fresh SuperBox Guest. */
export class CodexGuestAdapterV1 implements GuestProviderAdapterV1 {
  readonly #executablePath: string;
  readonly #workspaceRoot: string;
  readonly #appServer: CodexAppServerFacadeV1;
  readonly #auth: CodexAuthMaterialGuardV1;
  #running = false;
  #cancelRequested = false;
  #connection: CodexAppServerConnectionV1 | undefined;
  #threadID: string | undefined;
  #turnID: string | undefined;
  #cancelPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;

  public constructor(options: CodexGuestAdapterOptionsV1) {
    assertAbsolutePath(options.executablePath, "executable");
    assertAbsolutePath(options.workspaceRoot, "workspace");
    this.#executablePath = options.executablePath;
    this.#workspaceRoot = options.workspaceRoot;
    this.#appServer = options.appServer ?? new CodexStdioAppServerFacadeV1();
    this.#auth = new CodexAuthMaterialGuardV1(
      options.controllerHome ?? CODEX_CONTROLLER_HOME,
      options.workspaceRoot,
    );
    if (
      options.executablePath.startsWith(`${options.workspaceRoot}/`)
      || options.executablePath.startsWith(`${this.#auth.home}/`)
    ) {
      throw new TypeError("Codex executable must be outside mutable and controller data roots");
    }
  }

  public async run(context: GuestProviderAttemptContextV1): Promise<AttemptTerminalV1> {
    if (this.#running) {
      return codexFailureTerminal(codexFailure(
        "configuration",
        "codex_adapter_busy",
        false,
        "The Codex Adapter already owns an active attempt.",
      ));
    }
    this.#beginRun();
    let normalizer: CodexEventNormalizerV1 | undefined;
    let signalListener: (() => void) | undefined;
    let primaryError: unknown;
    let eventIterator: AsyncIterator<CodexAppServerInboundV1> | undefined;
    let qualification: CodexNativeToolLifecycleObserverV1 | null = null;
    let verifyQualificationFixture: (() => void) | undefined;
    const warnings = new CodexWarningEmitterV1(context.emit);

    try {
      if (context.signal.aborted) {
        this.#cancelRequested = true;
        throw cancellationMarker();
      }
      const profile = resolveCodexNativeProfile(context.attempt, this.#workspaceRoot);
      const prompt = projectCodexPrompt(context.attempt.prompt);
      qualification = createCodexNativeSandboxQualificationObserverV1(
        context.attempt,
        this.#workspaceRoot,
      );
      this.#auth.install(context.credential);
      if (qualification !== null) verifyQualificationFixture = prepareCodexNativeSandboxFixtureV1(this.#auth.home);
      signalListener = () => { void this.cancel().catch(() => {}); };
      context.signal.addEventListener("abort", signalListener, { once: true });
      if (context.signal.aborted) {
        this.#cancelRequested = true;
        throw cancellationMarker();
      }

      this.#connection = await this.#appServer.start({
        executablePath: this.#executablePath,
        controllerHome: this.#auth.home,
        workspaceRoot: this.#workspaceRoot,
      });
      if (this.#cancelRequested || context.signal.aborted) throw cancellationMarker();
      eventIterator = this.#connection.events()[Symbol.asyncIterator]();

      const initialize = await this.#connection.request("initialize", {
        clientInfo: {
          name: "@alma/tah-codex-guest",
          title: "ALMA TAH Codex Guest",
          version: "1.0.0",
        },
        capabilities: {
          // Named native permission profiles are an experimental app-server field.
          experimentalApi: true,
          mcpServerOpenaiFormElicitation: false,
          requestAttestation: false,
        },
      });
      assertInitializeReceipt(initialize, this.#auth.home);
      await this.#connection.notify("initialized");

      let account: unknown;
      try {
        account = await this.#connection.request("account/read", { refreshToken: false });
      } catch (error) {
        if (isCodexAuthenticationRPCError(error)) throw codexAuthenticationFailure();
        throw error;
      }
      assertAccountReceipt(account);
      await this.#loadAndValidateModels(profile);

      const thread = assertThreadStartReceipt(
        await this.#connection.request("thread/start", {
          allowProviderModelFallback: false,
          approvalPolicy: profile.approvalPolicy,
          approvalsReviewer: "user",
          config: profile.threadConfig,
          cwd: this.#workspaceRoot,
          developerInstructions: prompt.developerInstructions,
          ephemeral: profile.ephemeral,
          model: profile.modelID,
          permissions: profile.permissionProfileID,
          runtimeWorkspaceRoots: profile.runtimeWorkspaceRoots,
        }),
        profile,
        this.#workspaceRoot,
      );
      this.#threadID = thread.threadID;
      await this.#waitForThreadStarted(eventIterator, thread.threadID, warnings);

      // account/read, model/list and thread/start have consumed the filesystem
      // credential needed to configure this ephemeral controller. Never release
      // the untrusted prompt while auth.json still exists in the Guest.
      this.#auth.verifyBeforeTurn();
      this.#auth.removeBeforeTurn();
      const turn = assertTurnStartReceipt(await this.#connection.request("turn/start", {
        threadId: thread.threadID,
        input: [{ type: "text", text: prompt.turnInputText }],
        clientUserMessageId: context.attempt.attemptID,
        approvalPolicy: profile.approvalPolicy,
        approvalsReviewer: "user",
        // This fresh thread already froze the profile and runtime roots.
        // Re-selecting a named profile at turn/start reloads config on 0.153.4
        // without the thread/start config overrides, losing the private profile.
        cwd: this.#workspaceRoot,
        model: profile.modelID,
        effort: profile.reasoningEffortID,
        summary: profile.reasoningSummary,
      }));
      this.#turnID = turn.turnID;
      normalizer = new CodexEventNormalizerV1({
        profile,
        workspaceRoot: this.#workspaceRoot,
        controllerHome: this.#auth.home,
        threadID: thread.threadID,
        turnID: turn.turnID,
        maximumFinalBytes: maximumFinalBytes(context.attempt),
        emit: context.emit,
        nativeToolObserver: qualification,
        warnings,
      });

      let completed = false;
      while (!completed) {
        const next = await eventIterator.next();
        if (next.done) {
          throw codexFailure(
            "protocol",
            "codex_missing_turn_completion",
            false,
            "Codex exited before an authoritative turn completion.",
          );
        }
        completed = normalizer.accept(next.value);
      }

      const closing = this.#closeActiveConnection();
      for (;;) {
        const next = await eventIterator.next();
        if (next.done) break;
        normalizer.acceptTail(next.value);
      }
      await closing;
      this.#auth.removeAfterProcessExit();

      if (qualification !== null) {
        const verifyFixture = verifyQualificationFixture;
        verifyQualificationFixture = undefined;
        verifyFixture?.();
        if (!normalizer.hasSuccessfulEndTurn()) {
          throw codexFailure(
            "policy",
            "codex_sandbox_qualification_incomplete",
            false,
            "Codex did not complete the machine-observed sandbox qualification.",
          );
        }
        const input = context.workspace.readMaterial(CODEX_SANDBOX_QUALIFICATION_INPUT_PATH);
        let encoded: Buffer | undefined;
        try {
          encoded = encodeCodexNativeSandboxMachineReceiptV1(qualification.finish(input));
          context.workspace.putCandidate(CODEX_SANDBOX_QUALIFICATION_RECEIPT_PATH, encoded);
        } finally {
          input.fill(0);
          encoded?.fill(0);
        }
      }
    } catch (error) {
      primaryError = error;
    }

    let cleanupError: unknown;
    try { verifyQualificationFixture?.(); }
    catch (error) { primaryError ??= error; }
    try {
      await this.#cleanup();
    } catch (error) {
      cleanupError = error;
    }

    try {
      if (this.#cancelRequested || context.signal.aborted || isAbortError(primaryError)) {
        safeStop(normalizer);
        return { kind: "cancelled" };
      }
      if (primaryError !== undefined) {
        safeStop(normalizer);
        return this.#terminalForError(primaryError);
      }
      if (cleanupError !== undefined) {
        safeStop(normalizer);
        return codexFailureTerminal(codexFailure(
          "cleanup",
          "codex_cleanup_failed",
          true,
          "Codex could not close its native runtime cleanly.",
        ));
      }
      if (normalizer === undefined) {
        return codexFailureTerminal(codexFailure(
          "protocol",
          "codex_normalizer_unavailable",
          false,
          "Codex did not establish a normalized event stream.",
        ));
      }
      return normalizer.finish();
    } catch (error) {
      safeStop(normalizer);
      return this.#terminalForError(error);
    } finally {
      if (signalListener !== undefined) {
        context.signal.removeEventListener("abort", signalListener);
      }
      this.#endRun();
    }
  }

  public cancel(): Promise<void> {
    if (!this.#running) return Promise.resolve();
    this.#cancelRequested = true;
    if (this.#cancelPromise !== undefined) return this.#cancelPromise;
    this.#cancelPromise = (async () => {
      let failed = false;
      if (this.#connection !== undefined && this.#threadID !== undefined && this.#turnID !== undefined) {
        try {
          await this.#connection.request("turn/interrupt", {
            threadId: this.#threadID,
            turnId: this.#turnID,
          });
        } catch {
          failed = true;
        }
      }
      try {
        await this.#closeActiveConnection();
      } catch {
        failed = true;
      }
      if (failed) {
        throw codexFailure(
          "cancellation",
          "codex_cancel_failed",
          true,
          "Codex cancellation did not complete cleanly.",
        );
      }
    })();
    return this.#cancelPromise;
  }

  async #loadAndValidateModels(profile: CodexNativeProfileV1): Promise<void> {
    if (this.#connection === undefined) throw new Error("Codex connection is unavailable");
    const models: Record<string, unknown>[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let pageIndex = 0; pageIndex < MAX_MODEL_PAGES; pageIndex += 1) {
      let response: unknown;
      try {
        response = await this.#connection.request("model/list", {
          includeHidden: false,
          limit: 100,
          ...(cursor === null ? {} : { cursor }),
        });
      } catch (error) {
        if (isCodexAuthenticationRPCError(error)) throw codexAuthenticationFailure();
        throw error;
      }
      const page = parseModelPage(response);
      models.push(...page.models);
      if (models.length > MAX_MODELS) {
        throw codexFailure(
          "resource",
          "codex_model_catalog_too_large",
          false,
          "Codex returned an oversized model catalog.",
        );
      }
      if (page.nextCursor === null) {
        assertModelAvailable(models, profile);
        return;
      }
      if (cursors.has(page.nextCursor)) {
        throw codexFailure(
          "protocol",
          "codex_model_cursor_cycle",
          false,
          "Codex returned a cyclic model catalog cursor.",
        );
      }
      cursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    throw codexFailure(
      "resource",
      "codex_model_catalog_page_limit",
      false,
      "Codex exceeded the bounded model catalog page count.",
    );
  }

  async #waitForThreadStarted(
    iterator: AsyncIterator<CodexAppServerInboundV1>,
    threadID: string,
    warnings: CodexWarningEmitterV1,
  ): Promise<void> {
    let remoteControlDisabled = false;
    let deadline = Date.now() + STARTUP_EVENT_TIMEOUT_MS;
    for (;;) {
      const next = await nextWithTimeout(iterator, Math.max(0, deadline - Date.now()));
      if (next.done) {
        throw codexFailure(
          "protocol",
          "codex_missing_thread_started",
          false,
          "Codex exited before the thread-start receipt completed.",
        );
      }
      const event = next.value;
      if (event.kind === "server_request") throw startupAmbientFailure();
      const params = readRecord(event.params);
      if (event.method === "warning") {
        warnings.accept(params, threadID);
        continue;
      }
      if (event.method === "deprecationNotice") {
        warnings.acceptDeprecation(params, threadID);
        continue;
      }
      deadline = Date.now() + STARTUP_EVENT_TIMEOUT_MS;
      if (event.method === "remoteControl/status/changed") {
        if (
          remoteControlDisabled
          || params.status !== "disabled"
          || (params.environmentId !== null && params.environmentId !== undefined)
          || typeof params.installationId !== "string"
          || params.installationId.length === 0
          || typeof params.serverName !== "string"
          || params.serverName.length === 0
        ) {
          throw startupRemoteControlFailure();
        }
        remoteControlDisabled = true;
        continue;
      }
      if (event.method === "thread/started") {
        if (!remoteControlDisabled) throw startupRemoteControlFailure();
        assertThreadStartedNotification(params, threadID, this.#workspaceRoot);
        return;
      }
      if (event.method === "account/updated") {
        if (params.authMode !== "chatgpt" && params.authMode !== "apikey") {
          throw codexAuthenticationFailure();
        }
        continue;
      }
      if (event.method === "account/rateLimits/updated") {
        continue;
      }
      if (event.method === "thread/status/changed" && params.threadId === threadID) {
        const status = readRecord(params.status);
        const type = status.type;
        const flags = status.activeFlags;
        if (
          (type === "idle" || type === "notLoaded")
          || (type === "active" && Array.isArray(flags) && flags.length === 0)
        ) {
          continue;
        }
      }
      throw startupNotificationFailure(event.method);
    }
  }

  async #cleanup(): Promise<void> {
    if (this.#cancelPromise !== undefined) {
      await this.#cancelPromise;
    } else {
      await this.#closeActiveConnection();
    }
    this.#auth.removeAfterProcessExit();
  }

  #closeActiveConnection(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    const connection = this.#connection;
    if (connection === undefined) return Promise.resolve();
    this.#closePromise = (async () => {
      const receipt = await connection.close();
      if (receipt.code !== 0) throw new Error("Codex app-server exited unsuccessfully");
    })();
    return this.#closePromise;
  }

  #terminalForError(error: unknown): AttemptTerminalV1 {
    if (error instanceof CodexAuthMaterialError) {
      return codexFailureTerminal(codexFailure(
        "authentication",
        "codex_auth_material_untrusted",
        false,
        "Codex authentication material is unavailable or untrusted.",
      ));
    }
    if (error instanceof CodexProfileError) {
      return codexFailureTerminal(codexFailure(
        "configuration",
        "codex_profile_unavailable",
        false,
        "The frozen attempt cannot be represented by the pinned Codex Adapter.",
      ));
    }
    if (isCodexAuthenticationRPCError(error)) return codexFailureTerminal(codexAuthenticationFailure());
    if (error instanceof CodexAppServerTransportErrorV1) {
      const resource = error.code === "outbound_frame_too_large"
        || error.code === "inbound_frame_too_large"
        || error.code === "event_queue_overflow"
        || error.code === "too_many_requests";
      const protocol = error.code === "invalid_json"
        || error.code === "invalid_message"
        || error.code === "invalid_error_response"
        || error.code === "unknown_response"
        || error.code === "truncated_frame";
      return codexFailureTerminal(codexFailure(
        resource ? "resource" : protocol ? "protocol" : "provider_availability",
        resource ? "codex_transport_bound_exceeded"
          : protocol ? "codex_transport_protocol_violation"
            : "codex_transport_unavailable",
        !resource && !protocol,
        resource ? "Codex exceeded a bounded app-server transport resource."
          : protocol ? "Codex violated the pinned app-server transport protocol."
            : "The Codex app-server transport became unavailable.",
      ));
    }
    if (error instanceof CodexAppServerRPCErrorV1) {
      const invalidRequest = error.code === -32600 || error.code === -32602;
      return codexFailureTerminal(codexFailure(
        invalidRequest ? "configuration" : "provider_availability",
        error.code === -32602 ? "codex_rpc_invalid_params"
          : error.code === -32600 ? "codex_rpc_invalid_request" : "codex_rpc_failed",
        !invalidRequest,
        invalidRequest
          ? "Codex rejected the frozen native request parameters."
          : `Codex could not complete an app-server request (${error.requestMethod ?? "unspecified"}; ${error.code}; ${error.diagnosticWords ?? "unspecified"}).`,
      ));
    }
    if (error instanceof CodexSandboxQualificationError) {
      // This class contains only Adapter-authored fixed diagnostics, never native error text.
      return codexFailureTerminal(codexFailure("policy", "codex_sandbox_qualification_failed", false, error.message));
    }
    return codexFailureTerminal(error);
  }

  #beginRun(): void {
    this.#running = true;
    this.#cancelRequested = false;
    this.#connection = undefined;
    this.#threadID = undefined;
    this.#turnID = undefined;
    this.#cancelPromise = undefined;
    this.#closePromise = undefined;
  }

  #endRun(): void {
    this.#running = false;
    this.#connection = undefined;
    this.#threadID = undefined;
    this.#turnID = undefined;
    this.#cancelPromise = undefined;
    this.#closePromise = undefined;
  }
}

function maximumFinalBytes(attempt: FrozenAttemptV1): number {
  return attempt.responseExpectation.kind === "workspace_outcome"
    ? attempt.responseExpectation.maximumFinalMessageUTF8Bytes
    : attempt.responseExpectation.maximumUTF8Bytes;
}

function safeStop(normalizer: CodexEventNormalizerV1 | undefined): void {
  try {
    normalizer?.stopOpenLifecycles();
  } catch {
    // The Guest endpoint owns the authoritative contract-violation response.
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function startupAmbientFailure() {
  return codexFailure(
    "policy",
    "codex_startup_ambient_feature",
    false,
    "Codex activated a disabled feature before the first turn.",
  );
}

function startupRemoteControlFailure() {
  return codexFailure(
    "policy",
    "codex_startup_remote_control_not_disabled",
    false,
    "Codex did not prove that remote control was disabled before the first turn.",
  );
}

function startupNotificationFailure(method: string) {
  const code = method === "mcpServer/startupStatus/updated"
    ? "codex_startup_mcp_activated"
    : method === "deprecationNotice"
      ? "codex_startup_deprecated_configuration"
      : method === "configWarning"
        ? "codex_startup_configuration_warning"
        : method === "warning"
          ? "codex_startup_warning"
          : "codex_startup_notification_unexpected";
  return codexFailure(
    "policy",
    code,
    false,
    `Codex emitted an unexpected startup notification before the first turn. ${nativeEventDiagnostic(method, "startup")}`,
  );
}

function cancellationMarker(): Error {
  const error = new Error("cancelled");
  error.name = "AbortError";
  return error;
}

function isAbortError(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

function assertAbsolutePath(value: string, label: string): void {
  if (!value.startsWith("/") || value === "/" || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Codex ${label} path is invalid`);
  }
}

async function nextWithTimeout<T>(
  iterator: AsyncIterator<T>,
  timeoutMs: number,
): Promise<IteratorResult<T>> {
  if (timeoutMs <= 0) {
    throw codexFailure("provider_availability", "codex_startup_timeout", true, "Codex did not complete native startup in time.");
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(codexFailure(
          "provider_availability",
          "codex_startup_timeout",
          true,
          "Codex did not complete native startup in time.",
        )), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
