import type {
  NormalizedFailureV1,
} from "../../../../src/contract/index.js";
import {
  parseProviderControlTerminalV1,
  type ProviderControlResultV1,
  type ProviderControlTerminalV1,
  type ProviderInferenceCatalogV1,
  type ProviderModelCatalogEntryV1,
} from "../../../../src/provider-control/contract.js";
import type {
  GuestProviderControlAdapterV1,
  GuestProviderControlContextV1,
} from "../../../../src/provider-control/guest-adapter.js";
import {
  CODEX_CONTROLLER_HOME,
  CodexAuthMaterialError,
  CodexAuthMaterialGuardV1,
} from "./auth-material.js";
import {
  CodexAdapterFailureV1,
  codexAuthenticationFailure,
  codexFailure,
  isCodexAuthenticationRPCError,
} from "./failure.js";
import {
  CodexAppServerTransportErrorV1,
  CodexStdioAppServerFacadeV1,
  type CodexAppServerConnectionV1,
  type CodexAppServerFacadeV1,
} from "./process-facade.js";
import {
  CODEX_APP_SERVER_VERSION,
  assertAccountReceipt,
  assertInitializeReceipt,
  parseModelPage,
} from "./receipts.js";

const MAX_MODEL_PAGES = 16;
const MAX_MODELS = 64;

export interface CodexGuestControlAdapterOptionsV1 {
  readonly executablePath: string;
  readonly workspaceRoot: string;
  readonly controllerHome?: string;
  readonly appServer?: CodexAppServerFacadeV1;
}

/** Read-only Codex supporting operations inside one disposable SuperBox. */
export class CodexGuestControlAdapterV1 implements GuestProviderControlAdapterV1 {
  readonly #executablePath: string;
  readonly #workspaceRoot: string;
  readonly #appServer: CodexAppServerFacadeV1;
  readonly #auth: CodexAuthMaterialGuardV1;
  #connection: CodexAppServerConnectionV1 | undefined;
  #closePromise: Promise<void> | undefined;
  #running = false;
  #used = false;
  #cancelled = false;

  public constructor(options: CodexGuestControlAdapterOptionsV1) {
    assertFixedGuestPath(options.executablePath);
    assertFixedGuestPath(options.workspaceRoot);
    if (options.executablePath === options.workspaceRoot
      || options.executablePath.startsWith(`${options.workspaceRoot}/`)) {
      throw new TypeError("Codex control appliance paths are invalid");
    }
    this.#executablePath = options.executablePath;
    this.#workspaceRoot = options.workspaceRoot;
    this.#appServer = options.appServer ?? new CodexStdioAppServerFacadeV1();
    this.#auth = new CodexAuthMaterialGuardV1(
      options.controllerHome ?? CODEX_CONTROLLER_HOME,
      options.workspaceRoot,
    );
  }

  public async runControl(
    context: GuestProviderControlContextV1,
  ): Promise<ProviderControlTerminalV1> {
    if (this.#running || this.#used || context.request.providerID !== "codex") {
      return failed(codexFailure(
        "configuration",
        "codex_control_composition_invalid",
        false,
        "The Codex control operation is unavailable.",
      ).failure);
    }
    this.#used = true;
    this.#running = true;
    this.#cancelled = context.signal.aborted;
    const onAbort = (): void => { void this.cancelControl().catch(() => {}); };
    context.signal.addEventListener("abort", onAbort, { once: true });
    let result: ProviderControlResultV1 | undefined;
    let primary: unknown;

    try {
      if (this.#cancelled) {
        // Continue through the common cleanup and listener-release path.
      } else if (context.request.kind === "describe") {
        result = Object.freeze({
          controlVersion: 1,
          providerID: "codex",
          kind: "provider_description",
          displayName: "Codex",
          implementationName: "codex app-server",
          implementationVersion: CODEX_APP_SERVER_VERSION,
          capabilities: Object.freeze({
            authenticationInspection: true,
            inferenceCatalog: true,
            authenticationMutation: "not_implemented_v1",
          }),
        });
      } else if (context.credential === null) {
        if (context.request.kind === "inspect_authentication") {
          result = authSnapshot("invalid");
        } else {
          primary = codexAuthenticationFailure();
        }
      } else {
        this.#auth.install(context.credential);
        this.#connection = await this.#appServer.start({
          executablePath: this.#executablePath,
          controllerHome: this.#auth.home,
          workspaceRoot: this.#workspaceRoot,
        });
        if (this.#cancelled || context.signal.aborted) throw cancellationMarker();
        await this.#initialize();
        let authenticated = true;
        try {
          assertAccountReceipt(await this.#connection.request("account/read", { refreshToken: false }));
        } catch (cause) {
          if (!isCodexAuthenticationRPCError(cause)
            && !(cause instanceof CodexAdapterFailureV1
              && cause.failure.family === "authentication")) throw cause;
          authenticated = false;
        }
        if (context.request.kind === "inspect_authentication") {
          result = authSnapshot(authenticated ? "valid" : "invalid");
        } else if (!authenticated) {
          primary = codexAuthenticationFailure();
        } else {
          result = await this.#catalog();
        }
      }
    } catch (cause) {
      primary = cause;
    }

    let cleanup: unknown;
    try {
      await this.#close();
      this.#auth.removeAfterProcessExit();
    } catch (cause) {
      cleanup = cause;
    } finally {
      context.signal.removeEventListener("abort", onAbort);
      this.#running = false;
    }

    if (this.#cancelled || context.signal.aborted || primary instanceof CodexControlCancellation) {
      return { status: "cancelled" };
    }
    if (cleanup !== undefined) {
      return failed({
        family: "cleanup",
        code: "codex_control_cleanup_failed",
        retryable: true,
        message: "Codex control runtime did not close cleanly.",
      });
    }
    if (context.request.kind === "inspect_authentication"
      && isCodexControlAuthenticationInvalid(primary)) {
      return { status: "ok", result: authSnapshot("invalid") };
    }
    if (primary !== undefined) return failed(normalizeCodexControlFailure(primary));
    if (result === undefined) return failed(unavailableFailure());
    return parseProviderControlTerminalV1({ status: "ok", result });
  }

  public async cancelControl(): Promise<void> {
    this.#cancelled = true;
    await this.#close();
  }

  async #initialize(): Promise<void> {
    const connection = this.#connection;
    if (connection === undefined) throw new Error("Codex control connection unavailable");
    assertInitializeReceipt(await connection.request("initialize", {
      clientInfo: {
        name: "@alma/tah-codex-control",
        title: "ALMA TAH Codex Control",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: false,
        mcpServerOpenaiFormElicitation: false,
        requestAttestation: false,
      },
    }), this.#auth.home);
    await connection.notify("initialized");
  }

  async #catalog(): Promise<ProviderInferenceCatalogV1> {
    const connection = this.#connection;
    if (connection === undefined) throw new Error("Codex control connection unavailable");
    const models: Record<string, unknown>[] = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
      const parsed = parseModelPage(await connection.request("model/list", {
        includeHidden: false,
        limit: 100,
        ...(cursor === null ? {} : { cursor }),
      }));
      models.push(...parsed.models);
      if (models.length > MAX_MODELS) throw catalogFailure();
      if (parsed.nextCursor === null) return projectCatalog(models);
      if (cursors.has(parsed.nextCursor)) throw catalogFailure();
      cursors.add(parsed.nextCursor);
      cursor = parsed.nextCursor;
    }
    throw catalogFailure();
  }

  #close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    if (this.#connection === undefined) return Promise.resolve();
    this.#closePromise = this.#connection.close().then((receipt) => {
      if (receipt.code !== 0) throw new Error("Codex control app-server exited unsuccessfully");
    });
    return this.#closePromise;
  }
}

function projectCatalog(models: readonly Record<string, unknown>[]): ProviderInferenceCatalogV1 {
  const projected: ProviderModelCatalogEntryV1[] = [];
  let defaultModelHandle: string | null = null;
  const modelHandles = new Set<string>();
  for (const model of models) {
    const handle = opaque(model.id ?? model.model);
    if (handle === undefined || modelHandles.has(handle)) throw catalogFailure();
    modelHandles.add(handle);
    const efforts: Array<{ handle: string; displayName: string }> = [];
    const effortHandles = new Set<string>();
    if (Array.isArray(model.supportedReasoningEfforts)) {
      for (const entryValue of model.supportedReasoningEfforts) {
        const entry = record(entryValue);
        const effort = opaque(entry?.reasoningEffort);
        if (effort === undefined || effortHandles.has(effort) || efforts.length >= 16) {
          throw catalogFailure();
        }
        effortHandles.add(effort);
        efforts.push(Object.freeze({ handle: effort, displayName: effort }));
      }
    }
    const declaredDefault = opaque(model.defaultReasoningEffort);
    const defaultEffortHandle = declaredDefault !== undefined && effortHandles.has(declaredDefault)
      ? declaredDefault
      : null;
    if (model.isDefault === true) {
      if (defaultModelHandle !== null) throw catalogFailure();
      defaultModelHandle = handle;
    }
    const frozenEfforts = [...efforts];
    Object.freeze(frozenEfforts);
    const projectedModel: ProviderModelCatalogEntryV1 = {
      handle,
      displayName: display(model.displayName, handle),
      efforts: frozenEfforts,
      defaultEffortHandle,
    };
    Object.freeze(projectedModel);
    projected.push(projectedModel);
  }
  if (projected.length === 0) throw catalogFailure();
  Object.freeze(projected);
  const catalog: ProviderInferenceCatalogV1 = {
    controlVersion: 1,
    providerID: "codex",
    kind: "inference_catalog",
    models: projected,
    defaultModelHandle,
  };
  return Object.freeze(catalog);
}

function authSnapshot(state: "valid" | "invalid"): ProviderControlResultV1 {
  return Object.freeze({
    controlVersion: 1,
    providerID: "codex",
    kind: "authentication_snapshot",
    state,
  });
}

function failed(failure: NormalizedFailureV1): ProviderControlTerminalV1 {
  return Object.freeze({ status: "failed", failure: Object.freeze({ ...failure }) });
}

function normalizeCodexControlFailure(cause: unknown): NormalizedFailureV1 {
  if (cause instanceof CodexAdapterFailureV1) return cause.failure;
  if (cause instanceof CodexAuthMaterialError) return codexAuthenticationFailure().failure;
  if (isCodexAuthenticationRPCError(cause)) return codexAuthenticationFailure().failure;
  if (cause instanceof CodexAppServerTransportErrorV1) return unavailableFailure();
  return unavailableFailure();
}

function isCodexControlAuthenticationInvalid(cause: unknown): boolean {
  return isCodexAuthenticationRPCError(cause)
    || (cause instanceof CodexAdapterFailureV1 && cause.failure.family === "authentication")
    || (cause instanceof CodexAuthMaterialError
      && (cause.code === "credential_required" || cause.code === "credential_invalid"));
}

function unavailableFailure(): NormalizedFailureV1 {
  return Object.freeze({
    family: "provider_availability",
    code: "codex_control_unavailable",
    retryable: true,
    message: "Codex inspection could not finish.",
  });
}

function catalogFailure(): CodexAdapterFailureV1 {
  return codexFailure(
    "protocol",
    "codex_catalog_invalid",
    false,
    "Codex returned an invalid model catalog.",
  );
}

function opaque(value: unknown): string | undefined {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") > 0
    && Buffer.byteLength(value, "utf8") <= 256
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : undefined;
}

function display(value: unknown, fallback: string): string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") > 0
    && Buffer.byteLength(value, "utf8") <= 256
    && !/[\u0000-\u001f\u007f]/u.test(value)
    ? value
    : fallback;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function assertFixedGuestPath(value: string): void {
  if (!value.startsWith("/") || value === "/" || value.endsWith("/")
    || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)
    || value.split("/").some((part, index) =>
      index > 0 && (part.length === 0 || part === "." || part === "..")
    )) {
    throw new TypeError("Codex control appliance path is invalid");
  }
}

class CodexControlCancellation extends Error {}
function cancellationMarker(): CodexControlCancellation {
  return new CodexControlCancellation();
}
