import {
  compareCanonicalUTF8V1,
  NormalizedEventLedgerV1,
  parseFrozenAttempt,
  TAH_MAX_CANDIDATE_DEPTH,
  TAH_MAX_CANDIDATE_ENTRIES,
  TAH_MAX_CANDIDATE_FILES,
  TAH_MAX_TOTAL_CANDIDATE_BYTES,
  type AttemptTerminalV1,
  type FrozenAttemptV1,
  type TahCandidateManifestEntryV1,
} from "../contract/index.js";
import { SuperBoxMaterialReceiverV1 } from "./materials.js";
import {
  parseSuperBoxFrame,
  SUPERBOX_WIRE_VERSION,
  type SuperBoxFrameV1,
} from "./wire.js";

export type SuperBoxFrameDirectionV1 = "host_to_guest" | "guest_to_host";

export type SuperBoxOperationPhaseV1 =
  | "awaiting_host_hello"
  | "awaiting_guest_hello"
  | "awaiting_attempt"
  | "receiving_materials"
  | "awaiting_ready"
  | "running"
  | "awaiting_stopping"
  | "stopping"
  | "violated";

export const SUPERBOX_MAX_CANDIDATE_FILES = TAH_MAX_CANDIDATE_FILES;
export const SUPERBOX_MAX_CANDIDATE_ENTRIES = TAH_MAX_CANDIDATE_ENTRIES;
export const SUPERBOX_MAX_CANDIDATE_DEPTH = TAH_MAX_CANDIDATE_DEPTH;
export const SUPERBOX_MAX_TOTAL_CANDIDATE_BYTES = TAH_MAX_TOTAL_CANDIDATE_BYTES;

interface CandidateState {
  readonly kind: "directory" | "file";
  readonly declaredBytes: number | null;
  receivedBytes: number;
  completed: boolean;
}

export type SuperBoxCandidateManifestEntryV1 = TahCandidateManifestEntryV1;

const HOST_TO_GUEST_FRAME_TYPES = new Set<SuperBoxFrameV1["type"]>([
  "host_hello",
  "credential",
  "attempt",
  "control_request",
  "material_chunk",
  "start",
  "cancel",
]);

const GUEST_TO_HOST_FRAME_TYPES = new Set<SuperBoxFrameV1["type"]>([
  "guest_hello",
  "ready",
  "event",
  "candidate_entry",
  "candidate_chunk",
  "terminal",
  "control_result",
  "stopping",
  "fatal",
]);

/**
 * Pure transcript validator for one SuperBox operation.
 *
 * It deliberately performs no transport, filesystem, VM, or admission work.
 * The Host feeds already-received wire values and separately confirms the
 * authoritative destruction of the VM.
 */
export class SuperBoxOperationTranscriptV1 {
  readonly #operationID: string;
  readonly #providerID: string;
  readonly #candidates = new Map<string, CandidateState>();
  #phase: SuperBoxOperationPhaseV1 = "awaiting_host_hello";
  #attempt: FrozenAttemptV1 | undefined;
  #materials: SuperBoxMaterialReceiverV1 | undefined;
  #events: NormalizedEventLedgerV1 | undefined;
  #terminal: AttemptTerminalV1 | undefined;
  #fatalCode: Extract<SuperBoxFrameV1, { type: "fatal" }>["code"] | undefined;
  #credentialObserved = false;
  #cancelRequested = false;
  #candidateBytes = 0;
  #candidateFileCount = 0;
  #lastCandidateEntryPath: string | undefined;
  #candidateReconciled = false;
  #stoppingObserved = false;
  #destroyConfirmed = false;

  public constructor(operationID: string, providerID: string) {
    try {
      const identity = parseSuperBoxFrame({
        type: "host_hello",
        wireVersion: SUPERBOX_WIRE_VERSION,
        operationID,
        providerID,
        operationKind: "attempt",
      });
      this.#operationID = identity.operationID;
      this.#providerID = providerID;
    } catch (cause) {
      throw new SuperBoxOperationError("invalid_identity", "operation identity is invalid", { cause });
    }
  }

  public get phase(): SuperBoxOperationPhaseV1 {
    return this.#phase;
  }

  public get terminal(): AttemptTerminalV1 | undefined {
    return this.#terminal;
  }

  public get fatalCode(): Extract<SuperBoxFrameV1, { type: "fatal" }>["code"] | undefined {
    return this.#fatalCode;
  }

  public get cancelRequested(): boolean {
    return this.#cancelRequested;
  }

  public get stoppingObserved(): boolean {
    return this.#stoppingObserved;
  }

  public get destroyConfirmed(): boolean {
    return this.#destroyConfirmed;
  }

  /** True only after a successful result, Guest stopping, and authoritative VM destruction. */
  public get admissionReady(): boolean {
    return this.#phase !== "violated"
      && this.#terminal?.kind === "end_turn"
      && this.#candidateReconciled
      && this.#stoppingObserved
      && this.#destroyConfirmed;
  }

  /** Completed candidate paths are observational; Host admission still validates their bytes. */
  public get candidatePaths(): readonly string[] {
    return Object.freeze(
      [...this.#candidates.entries()]
        .filter(([, candidate]) => candidate.completed)
        .map(([relativePath]) => relativePath)
        .sort(compareCanonicalUTF8V1),
    );
  }

  public get candidateFilePaths(): readonly string[] {
    return Object.freeze(
      [...this.#candidates.entries()]
        .filter(([, candidate]) => candidate.kind === "file" && candidate.completed)
        .map(([relativePath]) => relativePath)
        .sort(compareCanonicalUTF8V1),
    );
  }

  public get candidateManifest(): readonly SuperBoxCandidateManifestEntryV1[] {
    return Object.freeze(
      [...this.#candidates.entries()]
        .filter(([, candidate]) => candidate.completed)
        .map(([relativePath, candidate]) => Object.freeze({
          relativePath,
          kind: candidate.kind,
          byteLength: candidate.declaredBytes,
        }))
        .sort((left, right) =>
          compareCanonicalUTF8V1(left.relativePath, right.relativePath)
        ),
    );
  }

  public accept(direction: SuperBoxFrameDirectionV1, value: unknown): void {
    if (this.#destroyConfirmed) this.#violation("frame arrived after VM destruction");
    this.#requireUsable();

    let frame: SuperBoxFrameV1;
    try {
      frame = parseSuperBoxFrame(value);
    } catch (cause) {
      this.#violation("frame does not match the closed SuperBox wire schema", cause);
    }
    if (frame.operationID !== this.#operationID) {
      this.#violation("frame belongs to another operation");
    }
    this.#assertDirection(direction, frame.type);

    switch (frame.type) {
      case "host_hello":
        this.#acceptHostHello(frame);
        return;
      case "guest_hello":
        this.#acceptGuestHello(frame);
        return;
      case "credential":
        this.#acceptCredential();
        return;
      case "attempt":
        this.#acceptAttempt(frame);
        return;
      case "control_request":
        this.#violation("Provider control frame is forbidden in an attempt transcript");
      case "material_chunk":
        this.#acceptMaterial(frame);
        return;
      case "start":
        this.#acceptStart();
        return;
      case "cancel":
        this.#acceptCancel();
        return;
      case "ready":
        this.#acceptReady();
        return;
      case "event":
        this.#acceptEvent(frame);
        return;
      case "candidate_entry":
        this.#acceptCandidateEntry(frame);
        return;
      case "candidate_chunk":
        this.#acceptCandidate(frame);
        return;
      case "terminal":
        this.#acceptTerminal(frame);
        return;
      case "control_result":
        this.#violation("Provider control result is forbidden in an attempt transcript");
      case "fatal":
        this.#acceptFatal(frame);
        return;
      case "stopping":
        this.#acceptStopping();
        return;
    }
  }

  /**
   * Records the trusted Host VM-destruction fact. This is intentionally not a
   * wire frame. Forced destruction may confirm cleanup even after a violation,
   * but can never make such an operation admission-ready.
   */
  public confirmDestroyed(): void {
    if (this.#destroyConfirmed) return;
    this.#destroyConfirmed = true;
  }

  #acceptHostHello(frame: Extract<SuperBoxFrameV1, { type: "host_hello" }>): void {
    this.#requirePhase("awaiting_host_hello", "host hello is out of order");
    if (frame.providerID !== this.#providerID || frame.operationKind !== "attempt") this.#violation("operation routing mismatch");
    this.#phase = "awaiting_guest_hello";
  }

  #acceptGuestHello(frame: Extract<SuperBoxFrameV1, { type: "guest_hello" }>): void {
    this.#requirePhase("awaiting_guest_hello", "guest hello is out of order");
    if (frame.providerID !== this.#providerID || frame.operationKind !== "attempt") this.#violation("operation routing mismatch");
    this.#phase = "awaiting_attempt";
  }

  #acceptCredential(): void {
    this.#requirePhase("awaiting_attempt", "credential is out of order");
    if (this.#credentialObserved) this.#violation("credential was already supplied");
    // The Host transcript validates only presence and ordering. Secret bytes
    // deliberately remain inside the transient wire value and are not retained.
    this.#credentialObserved = true;
  }

  #acceptAttempt(frame: Extract<SuperBoxFrameV1, { type: "attempt" }>): void {
    this.#requirePhase("awaiting_attempt", "attempt is out of order");
    let attempt: FrozenAttemptV1;
    try {
      attempt = parseFrozenAttempt(frame.attempt);
    } catch (cause) {
      this.#violation("attempt is not a valid frozen Provider Contract input", cause);
    }
    if (attempt.providerID !== this.#providerID) this.#violation("attempt Provider mismatch");
    this.#attempt = attempt;
    this.#materials = new SuperBoxMaterialReceiverV1(this.#operationID, attempt);
    this.#events = new NormalizedEventLedgerV1(attempt.attemptID);
    this.#phase = "receiving_materials";
  }

  #acceptMaterial(frame: Extract<SuperBoxFrameV1, { type: "material_chunk" }>): void {
    this.#requirePhase("receiving_materials", "material chunk is out of order");
    try {
      this.#requiredMaterials().accept(frame);
    } catch (cause) {
      this.#violation("input material transcript is invalid", cause);
    }
  }

  #acceptStart(): void {
    this.#requirePhase("receiving_materials", "start is out of order");
    try {
      this.#requiredMaterials().finish();
    } catch (cause) {
      this.#violation("start arrived before frozen materials completed", cause);
    }
    this.#phase = "awaiting_ready";
  }

  #acceptCancel(): void {
    if (this.#phase !== "awaiting_ready" && this.#phase !== "running") {
      this.#violation("cancel is out of order");
    }
    if (this.#cancelRequested) this.#violation("cancel was already requested");
    this.#cancelRequested = true;
  }

  #acceptReady(): void {
    this.#requirePhase("awaiting_ready", "ready is out of order");
    this.#phase = "running";
  }

  #acceptEvent(frame: Extract<SuperBoxFrameV1, { type: "event" }>): void {
    this.#requirePhase("running", "event is out of order");
    if (this.#cancelRequested
      && frame.event.kind !== "message_completed"
      && frame.event.kind !== "tool_completed") {
      this.#violation("non-closing event arrived after cancellation was requested");
    }
    try {
      this.#requiredEvents().observe(frame.event);
    } catch (cause) {
      this.#violation("normalized event transcript is invalid", cause);
    }
  }

  #acceptCandidateEntry(
    frame: Extract<SuperBoxFrameV1, { type: "candidate_entry" }>,
  ): void {
    this.#requirePhase("running", "candidate entry is out of order");
    if (this.#cancelRequested) this.#violation("candidate arrived after cancellation was requested");
    if (this.#requiredAttempt().responseExpectation.kind !== "workspace_outcome") {
      this.#violation("candidate is forbidden for this response expectation");
    }
    const candidateDepth = depthWithinWritableScope(
      frame.relativePath,
      this.#requiredAttempt().workspace.writableRoots,
    );
    if (candidateDepth === undefined) {
      this.#violation("candidate path is outside the frozen writable scope");
    }
    if (candidateDepth === 0 || candidateDepth > SUPERBOX_MAX_CANDIDATE_DEPTH) {
      this.#violation("candidate path exceeds the operation depth bound");
    }
    if (this.#candidates.size >= SUPERBOX_MAX_CANDIDATE_ENTRIES) {
      this.#violation("candidate entry count exceeds the operation bound");
    }
    if (this.#candidates.has(frame.relativePath)) {
      this.#violation("candidate entry path was declared more than once");
    }
    if (this.#lastCandidateEntryPath !== undefined
      && compareCanonicalUTF8V1(this.#lastCandidateEntryPath, frame.relativePath) >= 0) {
      this.#violation("candidate entries are not in canonical path order");
    }
    if ([...this.#candidates.values()].some((candidate) => !candidate.completed)) {
      this.#violation("candidate entry arrived before the preceding file completed");
    }
    if (frame.entryKind === "file") {
      this.#candidateFileCount += 1;
      if (this.#candidateFileCount > SUPERBOX_MAX_CANDIDATE_FILES) {
        this.#violation("candidate file count exceeds the operation bound");
      }
    }
    this.#candidates.set(frame.relativePath, {
      kind: frame.entryKind,
      declaredBytes: frame.byteLength,
      receivedBytes: 0,
      completed: frame.entryKind === "directory",
    });
    this.#lastCandidateEntryPath = frame.relativePath;
  }

  #acceptCandidate(frame: Extract<SuperBoxFrameV1, { type: "candidate_chunk" }>): void {
    this.#requirePhase("running", "candidate chunk is out of order");
    if (this.#cancelRequested) this.#violation("candidate arrived after cancellation was requested");
    if (this.#requiredAttempt().responseExpectation.kind !== "workspace_outcome") {
      this.#violation("candidate is forbidden for this response expectation");
    }
    if (!isWithinWritableScope(
      frame.relativePath,
      this.#requiredAttempt().workspace.writableRoots,
    )) {
      this.#violation("candidate path is outside the frozen writable scope");
    }

    const candidate = this.#candidates.get(frame.relativePath);
    if (candidate === undefined || candidate.kind !== "file" || candidate.declaredBytes === null) {
      this.#violation("candidate bytes arrived without a declared file entry");
    }
    if (candidate.completed) this.#violation("candidate received data after its final chunk");
    if (frame.offset !== candidate.receivedBytes) {
      this.#violation("candidate chunk offset is not contiguous");
    }
    const decodedBytes = Buffer.from(frame.dataBase64, "base64").byteLength;
    const receivedBytes = candidate.receivedBytes + decodedBytes;
    if (!Number.isSafeInteger(receivedBytes)) this.#violation("candidate byte count is invalid");
    if (receivedBytes > candidate.declaredBytes) {
      this.#violation("candidate bytes exceed the declared file length");
    }
    const aggregateBytes = this.#candidateBytes + decodedBytes;
    if (!Number.isSafeInteger(aggregateBytes)
      || aggregateBytes > SUPERBOX_MAX_TOTAL_CANDIDATE_BYTES) {
      this.#violation("candidate bytes exceed the operation bound");
    }
    candidate.receivedBytes = receivedBytes;
    if (frame.final && receivedBytes !== candidate.declaredBytes) {
      this.#violation("candidate final chunk disagrees with the declared file length");
    }
    if (!frame.final && receivedBytes === candidate.declaredBytes) {
      this.#violation("candidate reached its declared file length before the final chunk");
    }
    candidate.completed = frame.final;
    this.#candidateBytes = aggregateBytes;
  }

  #acceptTerminal(frame: Extract<SuperBoxFrameV1, { type: "terminal" }>): void {
    this.#requirePhase("running", "terminal is out of order");
    if (this.#cancelRequested
      && frame.terminal.kind !== "cancelled"
      && frame.terminal.kind !== "failed") {
      this.#violation("successful terminal cannot win after cancellation was requested");
    }
    try {
      this.#requiredEvents().assertTerminal(frame.terminal);
    } catch (cause) {
      this.#violation("terminal disagrees with the normalized event transcript", cause);
    }
    this.#assertFinalTextBound(frame.terminal);

    if (frame.terminal.kind === "end_turn") {
      const incompleteCandidate = [...this.#candidates.values()]
        .some((candidate) => !candidate.completed);
      if (incompleteCandidate) {
        this.#violation("successful terminal arrived with an incomplete candidate");
      }
      this.#candidateReconciled = true;
    }

    this.#terminal = Object.freeze(frame.terminal);
    this.#phase = "awaiting_stopping";
  }

  #acceptFatal(frame: Extract<SuperBoxFrameV1, { type: "fatal" }>): void {
    if (this.#phase !== "awaiting_attempt"
      && this.#phase !== "receiving_materials"
      && this.#phase !== "awaiting_ready"
      && this.#phase !== "running") {
      this.#violation("fatal is out of order");
    }
    this.#fatalCode = frame.code;
    this.#phase = "awaiting_stopping";
  }

  #acceptStopping(): void {
    this.#requirePhase("awaiting_stopping", "stopping is out of order");
    this.#stoppingObserved = true;
    this.#phase = "stopping";
  }

  #assertFinalTextBound(terminal: AttemptTerminalV1): void {
    const finalText = terminal.kind === "end_turn" || terminal.kind === "refused"
      ? terminal.finalText
      : undefined;
    if (finalText === undefined) return;
    const expectation = this.#requiredAttempt().responseExpectation;
    const maximumBytes = expectation.kind === "workspace_outcome"
      ? expectation.maximumFinalMessageUTF8Bytes
      : expectation.maximumUTF8Bytes;
    if (Buffer.byteLength(finalText, "utf8") > maximumBytes) {
      this.#violation("terminal final answer exceeds the frozen response bound");
    }
  }

  #assertDirection(direction: SuperBoxFrameDirectionV1, type: SuperBoxFrameV1["type"]): void {
    const allowed = direction === "host_to_guest"
      ? HOST_TO_GUEST_FRAME_TYPES
      : GUEST_TO_HOST_FRAME_TYPES;
    if (!allowed.has(type)) this.#violation(`${type} arrived in the wrong direction`);
  }

  #requiredAttempt(): FrozenAttemptV1 {
    if (this.#attempt === undefined) this.#violation("operation has no frozen attempt");
    return this.#attempt;
  }

  #requiredMaterials(): SuperBoxMaterialReceiverV1 {
    if (this.#materials === undefined) this.#violation("operation has no material receiver");
    return this.#materials;
  }

  #requiredEvents(): NormalizedEventLedgerV1 {
    if (this.#events === undefined) this.#violation("operation has no event ledger");
    return this.#events;
  }

  #requirePhase(expected: SuperBoxOperationPhaseV1, message: string): void {
    if (this.#phase !== expected) this.#violation(message);
  }

  #requireUsable(): void {
    if (this.#phase === "violated") {
      throw new SuperBoxOperationError("protocol_violation", "operation transcript is already violated");
    }
  }

  #violation(message: string, cause?: unknown): never {
    this.#phase = "violated";
    throw new SuperBoxOperationError(
      "protocol_violation",
      message,
      cause === undefined ? undefined : { cause },
    );
  }
}

function isWithinWritableScope(
  relativePath: string,
  writableRoots: readonly string[],
): boolean {
  return writableRoots.some((root) =>
    relativePath === root || relativePath.startsWith(`${root}/`)
  );
}

function depthWithinWritableScope(
  relativePath: string,
  writableRoots: readonly string[],
): number | undefined {
  const root = writableRoots.find((candidate) =>
    relativePath === candidate || relativePath.startsWith(`${candidate}/`)
  );
  if (root === undefined) return undefined;
  return relativePath.split("/").length - root.split("/").length;
}

export type SuperBoxOperationErrorCode = "invalid_identity" | "protocol_violation";

export class SuperBoxOperationError extends Error {
  public constructor(
    public readonly code: SuperBoxOperationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SuperBoxOperationError";
  }
}
