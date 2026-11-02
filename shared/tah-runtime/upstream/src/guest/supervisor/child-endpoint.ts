import { attemptTerminalSchema, type FrozenAttemptV1 } from "../../contract/index.js";
import type {
  GuestLogicalWorkspaceV1,
  GuestNormalizedEventInputV1,
  GuestOpaqueCredentialHandleV1,
  GuestProviderAdapterV1,
} from "../runtime/adapter.js";
import { ExistingFilesystemGuestWorkspaceV1 } from "../runtime/existing-filesystem-workspace.js";
import {
  assertMatchingProviderControlTerminalV1,
  parseProviderControlTerminalV1,
  type ProviderControlRequestV1,
} from "../../provider-control/contract.js";
import type { GuestProviderControlAdapterV1 } from "../../provider-control/guest-adapter.js";
import { DedicatedProviderCredentialDecoderV1 } from "./credential-channel.js";
import {
  DEDICATED_PROVIDER_PROTOCOL_VERSION,
  DedicatedProviderFrameDecoderV1,
  encodeDedicatedProviderFrameV1,
  type DedicatedProviderFrameV1,
} from "./protocol.js";

export const DEDICATED_PROVIDER_RUNTIME_FACTORY_EXPORT =
  "createDedicatedProviderRuntimeV1" as const;
export const DEDICATED_PROVIDER_CONTROL_FACTORY_EXPORT =
  "createDedicatedProviderControlV1" as const;
/** Provider-specific appliance entry ABI, loaded only after containment release. */
export interface DedicatedProviderRuntimeModuleV1 {
  createDedicatedProviderRuntimeV1(
    attempt: FrozenAttemptV1,
  ): GuestProviderAdapterV1 | Promise<GuestProviderAdapterV1>;
  createDedicatedProviderControlV1(
    request: ProviderControlRequestV1,
  ): GuestProviderControlAdapterV1 | Promise<GuestProviderControlAdapterV1>;
}

export type DedicatedProviderModuleLoaderV1 = (
  fixedModuleSpecifier: string,
) => Promise<unknown>;

export type DedicatedProviderWorkspaceFactoryV1 = (
  attempt: FrozenAttemptV1,
) => GuestLogicalWorkspaceV1;

export type DedicatedProviderChildOutputV1 = (bytes: Uint8Array) => void;

export type DedicatedProviderChildEndpointPhaseV1 =
  | "awaiting_start"
  | "loading"
  | "running"
  | "cancelling"
  | "provisional_terminal"
  | "violated";

/**
 * Child-side endpoint for the closed supervisor protocol. Construction loads
 * no Provider code. The fixed appliance module is dynamically imported only
 * after an exact credential-pipe EOF and a valid `start` control frame, which
 * the parent emits only after cgroup placement verification.
 */
export class DedicatedProviderChildEndpointV1 {
  readonly #fixedModuleSpecifier: string;
  readonly #output: DedicatedProviderChildOutputV1;
  readonly #loadModule: DedicatedProviderModuleLoaderV1;
  readonly #workspaceFactory: DedicatedProviderWorkspaceFactoryV1;
  readonly #controlDecoder = new DedicatedProviderFrameDecoderV1();
  readonly #credentialDecoder = new DedicatedProviderCredentialDecoderV1();
  readonly #abortController = new AbortController();
  readonly #stopped: Promise<void>;
  #resolveStopped!: () => void;
  #rejectStopped!: (cause: unknown) => void;
  #phase: DedicatedProviderChildEndpointPhaseV1 = "awaiting_start";
  #credentialFinished = false;
  #inputsReadySent = false;
  #credentialHandle: ChildOpaqueCredentialHandleV1 | undefined;
  #adapter: GuestProviderAdapterV1 | undefined;
  #controlAdapter: GuestProviderControlAdapterV1 | undefined;
  #cancelPromise: Promise<void> | undefined;
  #terminalSent = false;

  public constructor(
    fixedModuleSpecifier: string,
    output: DedicatedProviderChildOutputV1,
    loadModule: DedicatedProviderModuleLoaderV1 = (specifier) => import(specifier),
    workspaceFactory: DedicatedProviderWorkspaceFactoryV1 = existingWorkspaceFromFixedCWD,
  ) {
    if (fixedModuleSpecifier.length === 0 || fixedModuleSpecifier.includes("\0")) {
      throw new DedicatedProviderChildError(
        "invalid_composition",
        "Dedicated Provider module specifier is invalid",
      );
    }
    this.#fixedModuleSpecifier = fixedModuleSpecifier;
    this.#output = output;
    this.#loadModule = loadModule;
    this.#workspaceFactory = workspaceFactory;
    this.#stopped = new Promise((resolve, reject) => {
      this.#resolveStopped = resolve;
      this.#rejectStopped = reject;
    });
    void this.#stopped.catch(() => {});
    this.#emit({
      type: "bootstrap_ready",
      protocolVersion: DEDICATED_PROVIDER_PROTOCOL_VERSION,
    });
  }

  public get phase(): DedicatedProviderChildEndpointPhaseV1 {
    return this.#phase;
  }

  public pushCredential(bytes: Uint8Array): void {
    if (this.#phase !== "awaiting_start" || this.#credentialFinished) {
      if (bytes instanceof Uint8Array) bytes.fill(0);
      this.#fail("protocol_violation", "Credential bytes arrived in the wrong phase");
    }
    try {
      this.#credentialDecoder.push(bytes);
    } catch (cause) {
      this.#fail("protocol_violation", "Credential pipe is invalid", cause);
    } finally {
      // The dedicated pipe hands ownership of each mutable input chunk to this
      // endpoint. The decoder keeps its own bounded copy, so retain no second
      // credential copy in Node stream storage after this call returns.
      if (bytes instanceof Uint8Array) bytes.fill(0);
    }
  }

  public finishCredential(): void {
    if (this.#phase !== "awaiting_start" || this.#credentialFinished) {
      this.#fail("protocol_violation", "Credential pipe EOF arrived in the wrong phase");
    }
    try {
      this.#credentialDecoder.finish();
      this.#credentialFinished = true;
      this.#maybeEmitInputsReady();
    } catch (cause) {
      this.#fail("protocol_violation", "Credential pipe ended incorrectly", cause);
    }
  }

  public pushControl(bytes: Uint8Array): void {
    if (this.#phase === "violated") {
      throw new DedicatedProviderChildError(
        "invalid_state",
        "Dedicated Provider child has already failed",
      );
    }
    let frames: readonly DedicatedProviderFrameV1[];
    try {
      frames = this.#controlDecoder.push(bytes);
    } catch (cause) {
      this.#fail("protocol_violation", "Supervisor control stream is invalid", cause);
    }
    for (const frame of frames) this.#acceptControl(frame);
  }

  public finishControl(): void {
    if (this.#phase === "violated") return;
    try {
      this.#controlDecoder.finish();
    } catch (cause) {
      this.#fail("protocol_violation", "Supervisor control stream ended inside a frame", cause);
    }
    if (!this.#terminalSent) {
      this.#fail("protocol_violation", "Supervisor control stream ended before child terminal");
    }
  }

  public waitUntilStopped(): Promise<void> {
    return this.#stopped;
  }

  #acceptControl(frame: DedicatedProviderFrameV1): void {
    if (frame.type === "start") {
      if (this.#phase !== "awaiting_start"
        || !this.#credentialFinished
        || !this.#inputsReadySent) {
        this.#fail("protocol_violation", "Start arrived before the bootstrap gate completed");
      }
      this.#phase = "loading";
      void this.#run(frame.attempt).catch(() => {});
      return;
    }
    if (frame.type === "start_control") {
      if (this.#phase !== "awaiting_start"
        || !this.#credentialFinished
        || !this.#inputsReadySent) {
        this.#fail("protocol_violation", "Control start arrived before the bootstrap gate completed");
      }
      this.#phase = "loading";
      void this.#runControl(frame.request).catch(() => {});
      return;
    }
    if (frame.type === "cancel") {
      if (this.#phase !== "loading" && this.#phase !== "running"
        && this.#phase !== "provisional_terminal" && this.#phase !== "cancelling") {
        this.#fail("protocol_violation", "Cancel arrived before start");
      }
      if (this.#phase !== "provisional_terminal") this.#phase = "cancelling";
      this.#abortController.abort();
      const adapter = this.#adapter;
      if (adapter !== undefined && this.#cancelPromise === undefined) {
        this.#cancelPromise = Promise.resolve().then(() => adapter.cancel());
        void this.#cancelPromise.catch(() => {});
      }
      const controlAdapter = this.#controlAdapter;
      if (controlAdapter !== undefined && this.#cancelPromise === undefined) {
        this.#cancelPromise = Promise.resolve().then(() => controlAdapter.cancelControl());
        void this.#cancelPromise.catch(() => {});
      }
      return;
    }
    this.#fail("protocol_violation", "Child received a frame in the wrong direction");
  }

  async #run(attempt: FrozenAttemptV1): Promise<void> {
    try {
      const credential = this.#credentialDecoder.consume();
      this.#credentialHandle = credential === null
        ? undefined
        : new ChildOpaqueCredentialHandleV1(credential);
      this.#credentialDecoder.clear();
      const workspace = this.#workspaceFactory(attempt);
      const loaded = await this.#loadModule(this.#fixedModuleSpecifier);
      const factory = requiredRuntimeFactory(loaded);
      const adapter = await factory(attempt);
      assertChildAdapter(adapter);
      this.#adapter = adapter;
      if (this.#phase === "cancelling") {
        await this.#adapter.cancel();
        this.#emitTerminal({ kind: "cancelled" });
        return;
      }
      this.#phase = "running";
      let terminal = await this.#adapter.run({
        attempt,
        workspace,
        credential: this.#credentialHandle ?? null,
        emit: (event) => this.#emitEvent(event),
        signal: this.#abortController.signal,
      });
      if (this.#abortController.signal.aborted) {
        if (this.#cancelPromise !== undefined) await this.#cancelPromise;
        terminal = { kind: "cancelled" };
      }
      this.#emitTerminal(attemptTerminalSchema.parse(terminal));
    } catch (cause) {
      this.#fail("runtime_failed", "Dedicated Provider child failed", cause);
    } finally {
      this.#credentialHandle?.clear();
      this.#credentialDecoder.clear();
    }
  }

  async #runControl(
    request: ProviderControlRequestV1,
  ): Promise<void> {
    try {
      const credential = this.#credentialDecoder.consume();
      this.#credentialHandle = credential === null
        ? undefined
        : new ChildOpaqueCredentialHandleV1(credential);
      this.#credentialDecoder.clear();
      const loaded = await this.#loadModule(this.#fixedModuleSpecifier);
      const factory = requiredControlFactory(loaded);
      const adapter = await factory(request);
      assertChildControlAdapter(adapter);
      this.#controlAdapter = adapter;
      if (this.#phase === "cancelling") {
        await adapter.cancelControl();
        this.#emitControlTerminal(request, { status: "cancelled" });
        return;
      }
      this.#phase = "running";
      let terminal = parseProviderControlTerminalV1(await adapter.runControl({
        request,
        credential: this.#credentialHandle ?? null,
        signal: this.#abortController.signal,
      }));
      assertMatchingProviderControlTerminalV1(request, terminal);
      if (this.#abortController.signal.aborted) {
        if (this.#cancelPromise !== undefined) await this.#cancelPromise;
        terminal = { status: "cancelled" };
      }
      this.#emitControlTerminal(request, terminal);
    } catch (cause) {
      this.#fail("runtime_failed", "Dedicated Provider control child failed", cause);
    } finally {
      this.#credentialHandle?.clear();
      this.#credentialDecoder.clear();
    }
  }

  #emitEvent(event: GuestNormalizedEventInputV1): void {
    if (this.#phase !== "running" && this.#phase !== "cancelling") {
      this.#fail("protocol_violation", "Provider emitted an event outside its active turn");
    }
    if (this.#phase === "cancelling"
      && event.kind !== "message_completed"
      && event.kind !== "tool_completed") {
      this.#fail(
        "protocol_violation",
        "Provider emitted a non-closing event after cancellation",
      );
    }
    this.#emit({ type: "event", event });
  }

  #maybeEmitInputsReady(): void {
    if (this.#inputsReadySent
      || !this.#credentialFinished
      || this.#phase !== "awaiting_start") return;
    this.#inputsReadySent = true;
    this.#emit({
      type: "bootstrap_inputs_ready",
      protocolVersion: DEDICATED_PROVIDER_PROTOCOL_VERSION,
    });
  }

  #emitTerminal(terminal: ReturnType<typeof attemptTerminalSchema.parse>): void {
    if (this.#terminalSent || (this.#phase !== "running" && this.#phase !== "cancelling")) {
      this.#fail("protocol_violation", "Provider attempted more than one terminal");
    }
    this.#terminalSent = true;
    this.#emit({ type: "provisional_terminal", terminal });
    this.#phase = "provisional_terminal";
    this.#resolveStopped();
  }

  #emitControlTerminal(
    request: ProviderControlRequestV1,
    terminal: ReturnType<typeof parseProviderControlTerminalV1>,
  ): void {
    if (this.#terminalSent || (this.#phase !== "running" && this.#phase !== "cancelling")) {
      this.#fail("protocol_violation", "Provider control attempted more than one terminal");
    }
    assertMatchingProviderControlTerminalV1(request, terminal);
    this.#terminalSent = true;
    this.#emit({ type: "provisional_control_result", terminal });
    this.#phase = "provisional_terminal";
    this.#resolveStopped();
  }

  #emit(frame: DedicatedProviderFrameV1): void {
    const encoded = encodeDedicatedProviderFrameV1(frame);
    try {
      this.#output(encoded);
    } catch (cause) {
      this.#fail("output_failed", "Dedicated Provider child output failed", cause);
    }
  }

  #fail(
    code: DedicatedProviderChildErrorCode,
    message: string,
    cause?: unknown,
  ): never {
    if (this.#phase !== "violated") {
      this.#phase = "violated";
      this.#abortController.abort();
      this.#credentialHandle?.clear();
      this.#credentialDecoder.clear();
      if (this.#adapter !== undefined && this.#cancelPromise === undefined) {
        this.#cancelPromise = Promise.resolve().then(() => this.#adapter!.cancel());
        void this.#cancelPromise.catch(() => {});
      }
      if (this.#controlAdapter !== undefined && this.#cancelPromise === undefined) {
        this.#cancelPromise = Promise.resolve().then(
          () => this.#controlAdapter!.cancelControl(),
        );
        void this.#cancelPromise.catch(() => {});
      }
      const error = new DedicatedProviderChildError(
        code,
        message,
        cause === undefined ? undefined : { cause },
      );
      this.#rejectStopped(error);
      throw error;
    }
    throw new DedicatedProviderChildError(code, message);
  }
}

class ChildOpaqueCredentialHandleV1 implements GuestOpaqueCredentialHandleV1 {
  readonly #byteLength: number;
  #bytes: Uint8Array | undefined;

  public constructor(bytes: Uint8Array) {
    this.#bytes = Uint8Array.from(bytes);
    this.#byteLength = bytes.byteLength;
    bytes.fill(0);
  }

  public get byteLength(): number {
    return this.#byteLength;
  }

  public consume(): Uint8Array {
    const bytes = this.#bytes;
    if (bytes === undefined) {
      throw new DedicatedProviderChildError(
        "protocol_violation",
        "Opaque credential was already consumed",
      );
    }
    const consumed = Uint8Array.from(bytes);
    bytes.fill(0);
    this.#bytes = undefined;
    return consumed;
  }

  public clear(): void {
    this.#bytes?.fill(0);
    this.#bytes = undefined;
  }
}

function requiredRuntimeFactory(
  loaded: unknown,
): DedicatedProviderRuntimeModuleV1["createDedicatedProviderRuntimeV1"] {
  if (typeof loaded !== "object" || loaded === null) {
    throw new DedicatedProviderChildError(
      "invalid_composition",
      "Dedicated Provider module namespace is invalid",
    );
  }
  const factory = Reflect.get(loaded, DEDICATED_PROVIDER_RUNTIME_FACTORY_EXPORT);
  if (typeof factory !== "function") {
    throw new DedicatedProviderChildError(
      "invalid_composition",
      "Dedicated Provider module omitted its fixed runtime factory",
    );
  }
  return factory as DedicatedProviderRuntimeModuleV1["createDedicatedProviderRuntimeV1"];
}

function requiredControlFactory(
  loaded: unknown,
): DedicatedProviderRuntimeModuleV1["createDedicatedProviderControlV1"] {
  if (typeof loaded !== "object" || loaded === null) {
    throw new DedicatedProviderChildError(
      "invalid_composition",
      "Dedicated Provider module namespace is invalid",
    );
  }
  const factory = Reflect.get(loaded, DEDICATED_PROVIDER_CONTROL_FACTORY_EXPORT);
  if (typeof factory !== "function") {
    throw new DedicatedProviderChildError(
      "invalid_composition",
      "Dedicated Provider module omitted its fixed control factory",
    );
  }
  return factory as DedicatedProviderRuntimeModuleV1["createDedicatedProviderControlV1"];
}

function assertChildAdapter(value: unknown): asserts value is GuestProviderAdapterV1 {
  if (typeof value !== "object" || value === null
    || typeof Reflect.get(value, "run") !== "function"
    || typeof Reflect.get(value, "cancel") !== "function") {
    throw new DedicatedProviderChildError(
      "invalid_composition",
      "Dedicated Provider module did not return the closed Adapter ABI",
    );
  }
}

function assertChildControlAdapter(value: unknown): asserts value is GuestProviderControlAdapterV1 {
  if (typeof value !== "object" || value === null
    || typeof Reflect.get(value, "runControl") !== "function"
    || typeof Reflect.get(value, "cancelControl") !== "function") {
    throw new DedicatedProviderChildError(
      "invalid_composition",
      "Dedicated Provider module did not return the closed control Adapter ABI",
    );
  }
}

function existingWorkspaceFromFixedCWD(attempt: FrozenAttemptV1): GuestLogicalWorkspaceV1 {
  const providerUID = process.getuid?.();
  const providerGID = process.getgid?.();
  if (providerUID === undefined || providerGID === undefined
    || providerUID <= 0 || providerGID <= 0) {
    throw new DedicatedProviderChildError(
      "invalid_composition",
      "Dedicated Provider child identity is unavailable",
    );
  }
  return new ExistingFilesystemGuestWorkspaceV1(process.cwd(), attempt, {
    controllerUID: 0,
    controllerGID: 0,
    providerUID,
    providerGID,
  });
}

export type DedicatedProviderChildErrorCode =
  | "invalid_composition"
  | "invalid_state"
  | "protocol_violation"
  | "runtime_failed"
  | "output_failed";

export class DedicatedProviderChildError extends Error {
  public constructor(
    public readonly code: DedicatedProviderChildErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DedicatedProviderChildError";
  }
}
