import {
  NormalizedEventLedgerV1,
  attemptTerminalSchema,
  normalizedEventSchema,
  parseFrozenAttempt,
  type AttemptTerminalV1,
  type FrozenAttemptV1,
  type NormalizedEventV1,
} from "../../contract/index.js";
import { SuperBoxMaterialReceiverV1 } from "../../superbox/materials.js";
import {
  SUPERBOX_MAX_CHUNK_DECODED_BYTES,
  SUPERBOX_MAX_CREDENTIAL_DECODED_BYTES,
  SUPERBOX_WIRE_VERSION,
  SuperBoxFrameDecoder,
  encodeSuperBoxFrame,
  type SuperBoxFrameV1,
} from "../../superbox/wire.js";
import type {
  GuestLogicalWorkspaceV1,
  GuestNormalizedEventInputV1,
  GuestOpaqueCredentialHandleV1,
  GuestProviderAdapterV1,
} from "./adapter.js";
import type {
  GuestEndpointWorkspaceBackendV1,
  GuestEndpointWorkspaceFactoryV1,
} from "./filesystem-workspace.js";
import {
  assertMatchingProviderControlTerminalV1,
  parseProviderControlRequestV1,
  parseProviderControlTerminalV1,
  type ProviderControlRequestV1,
  type ProviderControlTerminalV1,
} from "../../provider-control/contract.js";
import type { GuestProviderControlAdapterV1 } from "../../provider-control/guest-adapter.js";
import type { DedicatedGuestProviderExecutorV1 } from "../supervisor/supervisor.js";
import {
  InMemoryGuestLogicalWorkspaceV1,
  type GuestCandidateSnapshotV1,
} from "./workspace.js";

export type GuestSuperBoxEndpointPhaseV1 =
  | "awaiting_host_hello"
  | "awaiting_attempt"
  | "receiving_materials"
  | "running"
  | "cancelling"
  | "stopped"
  | "violated";

export type GuestSuperBoxOutputV1 = (bytes: Uint8Array) => void;

/**
 * Transport-agnostic Guest-side endpoint. The embedding transport supplies
 * framed bytes and receives framed bytes through `output`; this class never
 * itself opens a path, socket, process, or Provider registry. An injected
 * endpoint-private workspace factory may materialize the logical workspace.
 * Direct Adapter injection in this constructor is retained only for semantic
 * fixtures; production composition must inject a dedicated-cgroup executor.
 */
export class GuestSuperBoxEndpointV1 {
  readonly #providerID: string;
  #operationKind: "attempt" | "control" | undefined;
  readonly #adapter: GuestProviderAdapterV1;
  readonly #output: GuestSuperBoxOutputV1;
  readonly #workspaceFactory: GuestEndpointWorkspaceFactoryV1;
  readonly #decoder = new SuperBoxFrameDecoder();
  readonly #abortController = new AbortController();
  readonly #stopped: Promise<void>;
  #resolveStopped!: () => void;
  #operationID: string | undefined;
  #phase: GuestSuperBoxEndpointPhaseV1 = "awaiting_host_hello";
  #attempt: FrozenAttemptV1 | undefined;
  #controlRequest: ProviderControlRequestV1 | undefined;
  #materials: SuperBoxMaterialReceiverV1 | undefined;
  #workspace: GuestEndpointWorkspaceBackendV1 | undefined;
  #events: NormalizedEventLedgerV1 | undefined;
  #credentialBytes: Buffer | undefined;
  #credentialHandle: OneShotGuestOpaqueCredentialV1 | undefined;
  #credentialReceived = false;
  #nextEventSequence = 1;
  #cancelPromise: Promise<void> | undefined;
  #terminalEmitted = false;

  public constructor(
    providerID: string,
    adapter: GuestProviderAdapterV1,
    output: GuestSuperBoxOutputV1,
    workspaceFactory: GuestEndpointWorkspaceFactoryV1 = inMemoryWorkspaceFactory,
  ) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(providerID)) {
      throw new GuestRuntimeError("invalid_identity", "Guest Provider identity is invalid");
    }
    this.#providerID = providerID;
    this.#adapter = adapter;
    this.#output = output;
    this.#workspaceFactory = workspaceFactory;
    this.#stopped = new Promise((resolve) => {
      this.#resolveStopped = resolve;
    });
  }

  /**
   * Production construction seam. It rejects an in-process Adapter even when a
   * caller circumvents the TypeScript type, while the public constructor above
   * remains available only to existing semantic fixtures.
   */
  public static forProduction(
    providerID: string,
    executor: DedicatedGuestProviderExecutorV1,
    output: GuestSuperBoxOutputV1,
    workspaceFactory: GuestEndpointWorkspaceFactoryV1,
  ): GuestSuperBoxEndpointV1 {
    if (executor.executionIsolation !== "dedicated_child_cgroup_v1") {
      throw new GuestRuntimeError(
        "invalid_identity",
        "Production Guest execution requires a dedicated-child cgroup executor",
      );
    }
    return new GuestSuperBoxEndpointV1(providerID, executor, output, workspaceFactory);
  }

  public get phase(): GuestSuperBoxEndpointPhaseV1 {
    return this.#phase;
  }

  public push(bytes: Uint8Array): void {
    if (this.#phase === "stopped" || this.#phase === "violated") {
      if (bytes instanceof Uint8Array) bytes.fill(0);
      throw new GuestRuntimeError("invalid_state", "Guest endpoint no longer accepts input");
    }
    let frames: readonly SuperBoxFrameV1[];
    try {
      frames = this.#decoder.push(bytes);
    } catch (cause) {
      this.#protocolFailure("Host wire stream is invalid", cause);
    } finally {
      if (bytes instanceof Uint8Array) bytes.fill(0);
    }
    try {
      for (const frame of frames) {
        this.#acceptHostFrame(frame);
      }
    } finally {
      clearCredentialFrames(frames);
    }
  }

  public finishInput(): void {
    if (this.#phase === "stopped" || this.#phase === "violated") return;
    try {
      this.#decoder.finish();
    } catch (cause) {
      this.#protocolFailure("Host wire stream ended inside a frame", cause);
    }
  }

  public waitUntilStopped(): Promise<void> {
    return this.#stopped;
  }

  #acceptHostFrame(frame: SuperBoxFrameV1): void {
    if (this.#phase === "awaiting_host_hello") {
      if (frame.type !== "host_hello") {
        this.#protocolFailure("The first Host frame must be host_hello");
      }
      this.#acceptHostHello(frame);
      return;
    }
    if (frame.operationID !== this.#requiredOperationID()) {
      this.#protocolFailure("Host frame belongs to another operation");
    }
    switch (frame.type) {
      case "host_hello":
        this.#protocolFailure("Host hello is out of order");
      case "credential":
        this.#acceptCredential(frame);
        return;
      case "attempt":
        this.#acceptAttempt(frame);
        return;
      case "control_request":
        this.#acceptControlRequest(frame);
        return;
      case "material_chunk":
        this.#acceptMaterial(frame);
        return;
      case "start":
        this.#acceptStart();
        return;
      case "cancel":
        this.#acceptCancel();
        return;
      case "guest_hello":
      case "ready":
      case "event":
      case "candidate_entry":
      case "candidate_chunk":
      case "terminal":
      case "control_result":
      case "stopping":
      case "fatal":
        this.#protocolFailure(`${frame.type} is not a Host-to-Guest frame`);
    }
  }

  #acceptHostHello(frame: Extract<SuperBoxFrameV1, { type: "host_hello" }>): void {
    this.#requirePhase("awaiting_host_hello", "Host hello is out of order");
    if (frame.providerID !== this.#providerID) {
      this.#protocolFailure("Host hello Provider identity is incorrect");
    }
    this.#operationID = frame.operationID;
    this.#operationKind = frame.operationKind;
    this.#emitFrame({
      type: "guest_hello",
      wireVersion: SUPERBOX_WIRE_VERSION,
      operationID: this.#requiredOperationID(),
      providerID: this.#providerID,
      operationKind: frame.operationKind,
    });
    this.#phase = "awaiting_attempt";
  }

  #acceptAttempt(frame: Extract<SuperBoxFrameV1, { type: "attempt" }>): void {
    this.#requirePhase("awaiting_attempt", "Attempt is out of order");
    let attempt: FrozenAttemptV1;
    try {
      attempt = parseFrozenAttempt(frame.attempt);
    } catch (cause) {
      this.#protocolFailure("Attempt is not a valid frozen Provider Contract input", cause);
    }
    if (this.#operationKind !== "attempt" || attempt.providerID !== this.#providerID) this.#protocolFailure("Attempt routing mismatch");
    this.#attempt = attempt;
    try {
      this.#materials = new SuperBoxMaterialReceiverV1(this.#requiredOperationID(), attempt);
    } catch (cause) {
      this.#protocolFailure("Frozen material declaration is invalid", cause);
    }
    this.#phase = "receiving_materials";
  }

  #acceptControlRequest(
    frame: Extract<SuperBoxFrameV1, { type: "control_request" }>,
  ): void {
    this.#requirePhase("awaiting_attempt", "Provider control request is out of order");
    if (!isDedicatedControlExecutor(this.#adapter)) {
      this.#protocolFailure("Provider control requires a production dedicated executor");
    }
    let request: ProviderControlRequestV1;
    try {
      request = parseProviderControlRequestV1(frame.request);
    } catch (cause) {
      this.#protocolFailure("Provider control request is invalid", cause);
    }
    if (request.operationID !== this.#requiredOperationID()) {
      this.#protocolFailure("Provider control request identity is invalid");
    }
    if (this.#operationKind !== "control" || request.providerID !== this.#providerID) this.#protocolFailure("Control routing mismatch");
    this.#controlRequest = request;
    this.#phase = "receiving_materials";
  }

  #acceptCredential(frame: Extract<SuperBoxFrameV1, { type: "credential" }>): void {
    this.#requirePhase("awaiting_attempt", "Credential is out of order");
    if (this.#credentialReceived) this.#protocolFailure("Credential was already supplied");
    let bytes: Buffer | undefined;
    try {
      bytes = Buffer.from(frame.data);
      if (bytes.byteLength === 0 || bytes.byteLength > SUPERBOX_MAX_CREDENTIAL_DECODED_BYTES) {
        bytes.fill(0);
        this.#protocolFailure("Credential exceeds its wire bound");
      }
      this.#credentialBytes = bytes;
      bytes = undefined;
      this.#credentialReceived = true;
    } finally {
      bytes?.fill(0);
      frame.data.fill(0);
    }
  }

  #acceptMaterial(frame: Extract<SuperBoxFrameV1, { type: "material_chunk" }>): void {
    this.#requirePhase("receiving_materials", "Material chunk is out of order");
    if (this.#controlRequest !== undefined) {
      this.#protocolFailure("Provider control operations accept no workspace materials");
    }
    try {
      this.#requiredMaterials().accept(frame);
    } catch (cause) {
      this.#protocolFailure("Input material transcript is invalid", cause);
    }
  }

  #acceptStart(): void {
    this.#requirePhase("receiving_materials", "Start is out of order");
    try {
      if (this.#controlRequest === undefined) {
        this.#requiredMaterials().finish();
        const attempt = this.#requiredAttempt();
        this.#workspace = this.#workspaceFactory(
          attempt,
          (relativePath) => this.#requiredMaterials().read(relativePath),
        );
        this.#events = new NormalizedEventLedgerV1(attempt.attemptID);
      }
      const credentialBytes = this.#credentialBytes;
      this.#credentialBytes = undefined;
      this.#credentialHandle = credentialBytes === undefined
        ? undefined
        : new OneShotGuestOpaqueCredentialV1(
            credentialBytes,
            () => this.#credentialViolation(),
          );
    } catch (cause) {
      this.#protocolFailure("Start arrived before a complete logical workspace", cause);
    }
    this.#phase = "running";
    this.#emitFrame({ type: "ready", operationID: this.#requiredOperationID() });
    if (this.#controlRequest === undefined) void this.#runAdapter();
    else void this.#runControl();
  }

  #acceptCancel(): void {
    if (this.#phase !== "running") this.#protocolFailure("Cancel is out of order");
    this.#phase = "cancelling";
    this.#abortController.abort();
    this.#cancelPromise = this.#cancelActive();
  }

  async #runAdapter(): Promise<void> {
    let terminal: AttemptTerminalV1;
    try {
      terminal = await this.#adapter.run({
        attempt: this.#requiredAttempt(),
        workspace: this.#adapterWorkspace(),
        credential: this.#credentialHandle ?? null,
        emit: (event) => this.#emitEvent(event),
        signal: this.#abortController.signal,
      });
      terminal = attemptTerminalSchema.parse(terminal);
    } catch (cause) {
      if (isDedicatedExecutor(this.#adapter)) {
        this.#runtimeFailure(isContainmentFailure(cause) ? "cleanup_failed" : "runtime_failed");
        return;
      }
      terminal = this.#phase === "cancelling"
        ? { kind: "cancelled" }
        : providerFailureTerminal();
    }

    if (this.#phase === "violated" || this.#phase === "stopped") return;
    if (this.#phase === "cancelling") {
      try {
        await this.#cancelPromise;
        terminal = { kind: "cancelled" };
      } catch {
        if (isDedicatedExecutor(this.#adapter)) {
          this.#runtimeFailure("cleanup_failed");
          return;
        }
        terminal = {
          kind: "failed",
          failure: {
            family: "cancellation",
            code: "provider_cancel_failed",
            retryable: true,
            message: "Provider cancellation failed.",
          },
        };
      }
    }
    this.#finishOperation(terminal);
  }

  async #runControl(): Promise<void> {
    const adapter = this.#requiredControlAdapter();
    const request = this.#requiredControlRequest();
    let terminal: ProviderControlTerminalV1;
    try {
      terminal = parseProviderControlTerminalV1(await adapter.runControl({
        request,
        credential: this.#credentialHandle ?? null,
        signal: this.#abortController.signal,
      }));
      assertMatchingProviderControlTerminalV1(request, terminal);
    } catch (cause) {
      if (isContainmentFailure(cause)) {
        this.#runtimeFailure("cleanup_failed");
        return;
      }
      this.#runtimeFailure("runtime_failed");
      return;
    }
    if (this.#phase === "violated" || this.#phase === "stopped") return;
    if (this.#phase === "cancelling") {
      try {
        await this.#cancelPromise;
        terminal = { status: "cancelled" };
      } catch {
        this.#runtimeFailure("cleanup_failed");
        return;
      }
    }
    this.#finishControl(terminal);
  }

  #emitEvent(input: GuestNormalizedEventInputV1): void {
    if (this.#phase !== "running" && this.#phase !== "cancelling") {
      throw new GuestRuntimeError("invalid_state", "Adapter emitted an event outside its active turn");
    }
    if (this.#phase === "cancelling"
      && input.kind !== "message_completed"
      && input.kind !== "tool_completed") {
      throw new GuestRuntimeError(
        "invalid_state",
        "Adapter emitted a non-closing event after cancellation",
      );
    }
    const value: unknown = {
      ...input,
      attemptID: this.#requiredAttempt().attemptID,
      sequence: this.#nextEventSequence,
    };
    let event: NormalizedEventV1;
    try {
      event = normalizedEventSchema.parse(value);
      this.#requiredEvents().observe(event);
    } catch (cause) {
      this.#runtimeFailure();
      throw new GuestRuntimeError(
        "adapter_contract_violation",
        "Adapter emitted an invalid normalized event",
        { cause },
      );
    }
    this.#nextEventSequence += 1;
    this.#emitFrame({ type: "event", operationID: this.#requiredOperationID(), event });
  }

  #finishOperation(terminal: AttemptTerminalV1): void {
    if (this.#terminalEmitted || (this.#phase !== "running" && this.#phase !== "cancelling")) {
      this.#protocolFailure("Adapter attempted to finish more than once");
    }

    this.#clearCredential();

    try {
      this.#requiredWorkspace().verifyFrozenMaterials();
    } catch {
      this.#runtimeFailure();
      return;
    }

    try {
      this.#requiredEvents().assertTerminal(terminal);
    } catch {
      this.#runtimeFailure();
      return;
    }

    if (terminal.kind === "end_turn"
      && this.#requiredAttempt().responseExpectation.kind === "workspace_outcome") {
      try {
        this.#emitCandidates(this.#requiredWorkspace().candidateSnapshot());
      } catch {
        this.#runtimeFailure();
        return;
      }
    }

    this.#terminalEmitted = true;
    this.#emitFrame({ type: "terminal", operationID: this.#requiredOperationID(), terminal });
    this.#emitFrame({ type: "stopping", operationID: this.#requiredOperationID() });
    this.#phase = "stopped";
    this.#resolveStopped();
  }

  #finishControl(terminal: ProviderControlTerminalV1): void {
    if (this.#terminalEmitted || (this.#phase !== "running" && this.#phase !== "cancelling")) {
      this.#protocolFailure("Provider control Adapter attempted to finish more than once");
    }
    this.#clearCredential();
    this.#terminalEmitted = true;
    this.#emitFrame({
      type: "control_result",
      operationID: this.#requiredOperationID(),
      terminal,
    });
    this.#emitFrame({ type: "stopping", operationID: this.#requiredOperationID() });
    this.#phase = "stopped";
    this.#resolveStopped();
  }

  #runtimeFailure(
    code: Extract<SuperBoxFrameV1, { type: "fatal" }>["code"] = "runtime_failed",
  ): void {
    if (this.#phase === "stopped" || this.#phase === "violated") return;
    this.#phase = "violated";
    this.#abortController.abort();
    this.#clearCredential();
    if (this.#cancelPromise === undefined) {
      this.#cancelPromise = this.#cancelActive();
      void this.#cancelPromise.catch(() => {});
    }
    this.#emitFrame({
      type: "fatal",
      operationID: this.#requiredOperationID(),
      code,
    });
    this.#emitFrame({ type: "stopping", operationID: this.#requiredOperationID() });
    this.#resolveStopped();
  }

  #emitCandidates(
    candidates: readonly GuestCandidateSnapshotV1[],
  ): void {
    for (const candidate of candidates) {
      this.#emitFrame({
        type: "candidate_entry",
        operationID: this.#requiredOperationID(),
        relativePath: candidate.relativePath,
        entryKind: candidate.kind,
        byteLength: candidate.kind === "file" ? candidate.bytes.byteLength : null,
      });
      if (candidate.kind === "directory") continue;
      try {
        if (candidate.bytes.byteLength === 0) {
          this.#emitFrame({
            type: "candidate_chunk",
            operationID: this.#requiredOperationID(),
            relativePath: candidate.relativePath,
            offset: 0,
            dataBase64: "",
            final: true,
          });
          continue;
        }
        for (let offset = 0; offset < candidate.bytes.byteLength; offset += SUPERBOX_MAX_CHUNK_DECODED_BYTES) {
          const bytes = candidate.bytes.subarray(
            offset,
            Math.min(offset + SUPERBOX_MAX_CHUNK_DECODED_BYTES, candidate.bytes.byteLength),
          );
          this.#emitFrame({
            type: "candidate_chunk",
            operationID: this.#requiredOperationID(),
            relativePath: candidate.relativePath,
            offset,
            dataBase64: Buffer.from(bytes).toString("base64"),
            final: offset + bytes.byteLength === candidate.bytes.byteLength,
          });
        }
      } finally {
        candidate.bytes.fill(0);
      }
    }
  }

  #protocolFailure(message: string, cause?: unknown): never {
    if (this.#phase !== "violated" && this.#phase !== "stopped") {
      this.#phase = "violated";
      this.#abortController.abort();
      this.#clearCredential();
      if (this.#events !== undefined || isDedicatedExecutor(this.#adapter)) {
        void this.#cancelActive().catch(() => {});
      }
      const operationID = this.#operationID;
      if (operationID !== undefined) {
        this.#emitFrame({
          type: "fatal",
          operationID,
          code: "protocol_violation",
        });
        this.#emitFrame({ type: "stopping", operationID });
      }
      this.#resolveStopped();
    }
    throw new GuestRuntimeError(
      "protocol_violation",
      message,
      cause === undefined ? undefined : { cause },
    );
  }

  #emitFrame(frame: SuperBoxFrameV1): void {
    const encoded = encodeSuperBoxFrame(frame);
    try {
      this.#output(encoded);
    } catch (cause) {
      this.#phase = "violated";
      this.#abortController.abort();
      this.#clearCredential();
      if (isDedicatedExecutor(this.#adapter)) {
        void this.#cancelActive().catch(() => {});
      }
      this.#resolveStopped();
      throw new GuestRuntimeError(
        "output_failed",
        "Guest could not deliver a SuperBox frame",
        { cause },
      );
    }
  }

  #requirePhase(expected: GuestSuperBoxEndpointPhaseV1, message: string): void {
    if (this.#phase !== expected) this.#protocolFailure(message);
  }

  #requiredAttempt(): FrozenAttemptV1 {
    if (this.#attempt === undefined) this.#protocolFailure("Guest has no frozen attempt");
    return this.#attempt;
  }

  #requiredControlRequest(): ProviderControlRequestV1 {
    if (this.#controlRequest === undefined) {
      this.#protocolFailure("Guest has no Provider control request");
    }
    return this.#controlRequest;
  }

  #requiredControlAdapter(): GuestProviderControlAdapterV1 {
    if (!isDedicatedControlExecutor(this.#adapter)) {
      this.#protocolFailure("Guest has no dedicated Provider control Adapter");
    }
    return this.#adapter;
  }

  #cancelActive(): Promise<void> {
    return this.#controlRequest === undefined
      ? Promise.resolve().then(() => this.#adapter.cancel())
      : Promise.resolve().then(() => this.#requiredControlAdapter().cancelControl());
  }

  #requiredOperationID(): string {
    if (this.#operationID === undefined) {
      this.#protocolFailure("Guest has not authenticated a Host operation");
    }
    return this.#operationID;
  }

  #requiredMaterials(): SuperBoxMaterialReceiverV1 {
    if (this.#materials === undefined) this.#protocolFailure("Guest has no material receiver");
    return this.#materials;
  }

  #requiredWorkspace(): GuestEndpointWorkspaceBackendV1 {
    if (this.#workspace === undefined) this.#protocolFailure("Guest has no logical workspace");
    return this.#workspace;
  }

  #adapterWorkspace(): GuestLogicalWorkspaceV1 {
    const workspace = this.#requiredWorkspace();
    return Object.freeze({
      listMaterials: () => this.#guardWorkspaceCall(() => workspace.listMaterials()),
      readMaterial: (relativePath: string) => this.#guardWorkspaceCall(
        () => workspace.readMaterial(relativePath),
      ),
      putCandidate: (relativePath: string, bytes: Uint8Array) => this.#guardWorkspaceCall(
        () => workspace.putCandidate(relativePath, bytes),
      ),
    });
  }

  #guardWorkspaceCall<T>(operation: () => T): T {
    try {
      return operation();
    } catch (cause) {
      this.#runtimeFailure();
      throw new GuestRuntimeError(
        "adapter_contract_violation",
        "Adapter used the logical workspace outside its contract",
        { cause },
      );
    }
  }

  #credentialViolation(): never {
    this.#runtimeFailure();
    throw new GuestRuntimeError(
      "adapter_contract_violation",
      "The one-shot credential is no longer available",
    );
  }

  #clearCredential(): void {
    this.#credentialBytes?.fill(0);
    this.#credentialBytes = undefined;
    this.#credentialHandle?.clear();
  }

  #requiredEvents(): NormalizedEventLedgerV1 {
    if (this.#events === undefined) this.#protocolFailure("Guest has no normalized event ledger");
    return this.#events;
  }
}

class OneShotGuestOpaqueCredentialV1 implements GuestOpaqueCredentialHandleV1 {
  readonly #byteLength: number;
  readonly #onViolation: () => never;
  #bytes: Buffer | undefined;

  public constructor(bytes: Buffer, onViolation: () => never) {
    this.#bytes = bytes;
    this.#byteLength = bytes.byteLength;
    this.#onViolation = onViolation;
  }

  public get byteLength(): number {
    return this.#byteLength;
  }

  public consume(): Uint8Array {
    const bytes = this.#bytes;
    if (bytes === undefined) return this.#onViolation();
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

function inMemoryWorkspaceFactory(
  attempt: FrozenAttemptV1,
  readMaterial: (relativePath: string) => Uint8Array,
): GuestEndpointWorkspaceBackendV1 {
  const workspace = new InMemoryGuestLogicalWorkspaceV1(attempt, readMaterial);
  return Object.freeze({
    listMaterials: () => workspace.listMaterials(),
    readMaterial: (relativePath: string) => workspace.readMaterial(relativePath),
    putCandidate: (relativePath: string, bytes: Uint8Array) =>
      workspace.putCandidate(relativePath, bytes),
    verifyFrozenMaterials: () => {},
    candidateSnapshot: () => workspace.candidateSnapshot(),
  });
}

function providerFailureTerminal(): AttemptTerminalV1 {
  return {
    kind: "failed",
    failure: {
      family: "unknown_provider",
      code: "provider_operation_failed",
      retryable: true,
      message: "Provider operation failed.",
    },
  };
}

function isDedicatedExecutor(
  adapter: GuestProviderAdapterV1,
): adapter is DedicatedGuestProviderExecutorV1 {
  const candidate = adapter as Partial<DedicatedGuestProviderExecutorV1>;
  return candidate.executionIsolation === "dedicated_child_cgroup_v1";
}

function isDedicatedControlExecutor(
  adapter: GuestProviderAdapterV1,
): adapter is DedicatedGuestProviderExecutorV1 & GuestProviderControlAdapterV1 {
  const candidate = adapter as Partial<
    DedicatedGuestProviderExecutorV1 & GuestProviderControlAdapterV1
  >;
  return isDedicatedExecutor(adapter)
    && typeof candidate.runControl === "function"
    && typeof candidate.cancelControl === "function";
}

function isContainmentFailure(cause: unknown): boolean {
  return typeof cause === "object"
    && cause !== null
    && Reflect.get(cause, "code") === "containment_failed";
}

function clearCredentialFrames(frames: readonly SuperBoxFrameV1[]): void {
  for (const frame of frames) {
    if (frame.type === "credential") frame.data.fill(0);
  }
}

export type GuestRuntimeErrorCode =
  | "invalid_identity"
  | "invalid_state"
  | "protocol_violation"
  | "adapter_contract_violation"
  | "output_failed";

export class GuestRuntimeError extends Error {
  public constructor(
    public readonly code: GuestRuntimeErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "GuestRuntimeError";
  }
}
