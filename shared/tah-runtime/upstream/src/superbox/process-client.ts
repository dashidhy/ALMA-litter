import { createHash } from "node:crypto";

import {
  compareCanonicalUTF8V1,
  parseFrozenAttempt,
  type AttemptTerminalV1,
  type FrozenAttemptV1,
  type NormalizedEventV1,
} from "../contract/index.js";
import { SUPERBOX_MAX_TOTAL_MATERIAL_BYTES } from "./materials.js";
import {
  SUPERBOX_MAX_CANDIDATE_ENTRIES,
  SUPERBOX_MAX_CANDIDATE_FILES,
  SUPERBOX_MAX_TOTAL_CANDIDATE_BYTES,
  SuperBoxOperationError,
  SuperBoxOperationTranscriptV1,
  type SuperBoxCandidateManifestEntryV1,
} from "./operation.js";
import {
  encodeSuperBoxFrame,
  SUPERBOX_MAX_CHUNK_DECODED_BYTES,
  SUPERBOX_MAX_CREDENTIAL_DECODED_BYTES,
  SUPERBOX_WIRE_VERSION,
  SuperBoxFrameDecoder,
  SuperBoxWireError,
  type SuperBoxFrameV1,
} from "./wire.js";

export interface SuperBoxProcessExitReceiptV1 {
  /** Null is valid for a force-destroyed child, but never for a successful operation. */
  readonly exitCode: number | null;
  /** Authoritative transport statement that the complete child/VM can no longer execute. */
  readonly destroyed: boolean;
}

/**
 * Opaque process/VM byte transport injected below the semantic SuperBox client.
 *
 * Implementations own process paths, manifests, spawn details and kill mechanics.
 * `waitForExit` must be idempotent and resolve only with its final destruction
 * receipt; it must not resolve merely because stdout closed.
 */
export interface SuperBoxDuplexChildTransportV1 {
  /** Ends only at the real child stdout EOF; `stopping` does not end this iterable. */
  readonly stdout: AsyncIterable<Uint8Array>;
  write(bytes: Uint8Array): void | Promise<void>;
  /** Post-exit pipe cleanup only. The client never uses stdin EOF as normal shutdown. */
  closeInput(): void | Promise<void>;
  destroy(): void | Promise<void>;
  waitForExit(): Promise<SuperBoxProcessExitReceiptV1>;
}

export interface RunSuperBoxProcessOperationV1 {
  readonly operationID: string;
  readonly attempt: FrozenAttemptV1;
  /** Exact bytes for all immutable materials and file-valued candidate seeds. */
  readonly materialBytes: ReadonlyMap<string, Uint8Array>;
  /** Opaque selected-Provider credential bytes; never retained in the result. */
  readonly credentialEnvelope?: Uint8Array;
  readonly transport: SuperBoxDuplexChildTransportV1;
  readonly onEvent?: (event: NormalizedEventV1) => void | Promise<void>;
  /** Optional whole-operation deadline. Normal liveness supervision may instead abort `signal`. */
  readonly timeoutMilliseconds?: number;
  /** Bound for the authoritative exit receipt after stopping or forced destruction. */
  readonly exitTimeoutMilliseconds?: number;
  /** Bounded cooperative cancellation window before authoritative VM destruction. */
  readonly cancelGraceMilliseconds?: number;
  readonly signal?: AbortSignal;
}

export interface SuperBoxTransportReadyResultV1 {
  readonly terminal: AttemptTerminalV1;
  /** Complete untrusted file/directory inventory observed before VM destruction. */
  readonly quarantinedCandidateManifest: readonly SuperBoxCandidateManifestEntryV1[];
  /** Untrusted bytes ready for later Host admission; never canonical outcomes. */
  readonly quarantinedCandidates: ReadonlyMap<string, Uint8Array>;
}

export type SuperBoxProcessClientErrorCode =
  | "invalid_request"
  | "protocol_violation"
  | "transport_failed"
  | "event_callback_failed"
  | "guest_fatal"
  | "premature_eof"
  | "cancelled"
  | "timed_out"
  | "exit_failed"
  | "destruction_unconfirmed"
  | "cleanup_failed";

export class SuperBoxProcessClientError extends Error {
  public readonly guestFatalCode: Extract<
    SuperBoxFrameV1,
    { type: "fatal" }
  >["code"] | undefined;

  public constructor(
    public readonly code: SuperBoxProcessClientErrorCode,
    message: string,
    options?: ErrorOptions & Readonly<{
      guestFatalCode?: Extract<SuperBoxFrameV1, { type: "fatal" }>["code"];
    }>,
  ) {
    super(message, options);
    this.name = "SuperBoxProcessClientError";
    this.guestFatalCode = options?.guestFatalCode;
  }
}

const DEFAULT_EXIT_TIMEOUT_MILLISECONDS = 30_000;

/**
 * Runs one Provider-neutral SuperBox operation over an injected byte transport.
 * Candidate bytes remain quarantined until the transcript, stopping frame and
 * authoritative zero-exit destruction receipt all agree.
 */
export async function runSuperBoxProcessOperationV1(
  request: RunSuperBoxProcessOperationV1,
): Promise<SuperBoxTransportReadyResultV1> {
  assertTransport(request.transport);
  const exitPromise = Promise.resolve().then(() => request.transport.waitForExit());
  // Observe an early rejection even while stdout is still being consumed.
  void exitPromise.catch(() => {});

  let attempt!: FrozenAttemptV1;
  let materials!: ReadonlyMap<string, Buffer>;
  let exitTimeout!: number;
  let transcript!: SuperBoxOperationTranscriptV1;
  let decoder!: SuperBoxFrameDecoder;
  let quarantine!: CandidateQuarantineV1;
  let interruption: InterruptionMonitor | undefined;
  let iterator!: AsyncIterator<Uint8Array>;
  let credential: Buffer | undefined;
  let cancelGrace!: number;
  try {
    attempt = parseAttemptRequest(request.attempt);
    materials = copyAndVerifyMaterials(attempt, request.materialBytes);
    exitTimeout = positiveTimeout(
      request.exitTimeoutMilliseconds,
      DEFAULT_EXIT_TIMEOUT_MILLISECONDS,
      "exit timeout",
    );
    const operationTimeout = optionalPositiveTimeout(request.timeoutMilliseconds);
    transcript = createOperationTranscript(request.operationID, attempt.providerID);
    decoder = new SuperBoxFrameDecoder();
    quarantine = new CandidateQuarantineV1();
    interruption = new InterruptionMonitor(request.signal, operationTimeout);
    iterator = request.transport.stdout[Symbol.asyncIterator]();
    credential = copyCredentialEnvelope(request.credentialEnvelope);
    cancelGrace = boundedCancelGrace(request.cancelGraceMilliseconds);
  } catch (cause) {
    credential?.fill(0);
    interruption?.close();
    const primary = normalizeClientFailure(cause);
    try {
      await destroyRejectedRequestTransport(request.transport, exitPromise);
    } catch (cleanupCause) {
      throw new SuperBoxProcessClientError(
        "cleanup_failed",
        "SuperBox request validation failed and authoritative cleanup also failed",
        { cause: new AggregateError([primary, cleanupCause]) },
      );
    }
    throw primary;
  }
  let authoritativeDestructionObserved = false;

  try {
    await interruption.race(Promise.resolve());
    await interruption.race(sendHostFrame(request.transport, transcript, {
      type: "host_hello",
      wireVersion: SUPERBOX_WIRE_VERSION,
      operationID: request.operationID,
      providerID: attempt.providerID,
      operationKind: "attempt",
    }));

    let payloadSent = false;
    let stoppingObserved = false;
    for (;;) {
      const next = await interruption.race(iterator.next());
      if (next.done) {
        try {
          decoder.finish();
        } catch (cause) {
          throw protocolError("Guest stdout ended inside a frame", cause);
        }
        if (!stoppingObserved) {
          throw new SuperBoxProcessClientError(
            "premature_eof",
            "Guest stdout ended before the stopping frame",
          );
        }
        break;
      }

      if (stoppingObserved && next.value.byteLength !== 0) {
        next.value.fill(0);
        throw protocolError("Guest emitted bytes after the stopping frame");
      }

      let frames: readonly SuperBoxFrameV1[];
      try {
        frames = decoder.push(next.value);
      } catch (cause) {
        throw protocolError("Guest stdout is not a valid SuperBox stream", cause);
      } finally {
        next.value.fill(0);
      }

      try {
        for (const frame of frames) {
          try {
            transcript.accept("guest_to_host", frame);
          } catch (cause) {
            throw protocolError("Guest frame violated the SuperBox operation transcript", cause);
          }
          switch (frame.type) {
          case "guest_hello":
            if (payloadSent) throw protocolError("Guest hello was repeated");
            payloadSent = true;
            await sendFrozenPayload(
              request.transport,
              transcript,
              request.operationID,
              attempt,
              materials,
              credential,
              interruption,
            );
            break;
          case "event":
            if (request.onEvent !== undefined) {
              try {
                await interruption.race(Promise.resolve(request.onEvent(frame.event)));
              } catch (cause) {
                if (cause instanceof InterruptionError) throw cause;
                throw new SuperBoxProcessClientError(
                  "event_callback_failed",
                  "Normalized event callback failed",
                  { cause },
                );
              }
            }
            break;
          case "candidate_chunk":
            quarantine.accept(frame);
            break;
          case "candidate_entry":
            quarantine.declare(frame);
            break;
          case "stopping":
            stoppingObserved = true;
            break;
          case "ready":
          case "terminal":
          case "fatal":
            break;
          case "control_result":
            throw protocolError("Provider control result appeared in an attempt operation");
          case "host_hello":
          case "credential":
          case "attempt":
          case "control_request":
          case "material_chunk":
          case "start":
          case "cancel":
            throw protocolError("Host frame appeared on Guest stdout");
          }
        }
      } finally {
        clearCredentialFrames(frames);
      }
    }

    const receipt = await interruption.race(withTimeout(
      exitPromise,
      exitTimeout,
      "destruction_unconfirmed",
      "Timed out waiting for the authoritative child exit receipt",
    ));
    validateExitReceipt(receipt);
    authoritativeDestructionObserved = receipt.destroyed;
    if (!receipt.destroyed) {
      throw new SuperBoxProcessClientError(
        "destruction_unconfirmed",
        "Transport did not confirm authoritative child destruction",
      );
    }
    if (receipt.exitCode !== 0) {
      throw new SuperBoxProcessClientError(
        "exit_failed",
        "SuperBox child did not exit successfully",
      );
    }

    transcript.confirmDestroyed();
    bestEffortCloseInput(request.transport);
    if (transcript.fatalCode !== undefined) {
      throw new SuperBoxProcessClientError(
        "guest_fatal",
        `Guest reported ${transcript.fatalCode}`,
        { guestFatalCode: transcript.fatalCode },
      );
    }
    const terminal = transcript.terminal;
    if (terminal === undefined) {
      throw protocolError("Guest stopped without an authoritative terminal");
    }

    const candidates = transcript.admissionReady
      ? quarantine.release(transcript.candidateManifest)
      : quarantine.discardAndReleaseEmpty();
    return Object.freeze({
      terminal,
      quarantinedCandidateManifest: candidates.manifest,
      quarantinedCandidates: candidates.files,
    });
  } catch (cause) {
    credential?.fill(0);
    quarantine.discard();
    const primary = normalizeClientFailure(cause);
    if (!authoritativeDestructionObserved) {
      try {
        await forceDestroy(
          request.transport,
          transcript,
          request.operationID,
          exitPromise,
          exitTimeout,
          cancelGrace,
        );
      } catch (cleanupCause) {
        throw new SuperBoxProcessClientError(
          "cleanup_failed",
          "SuperBox operation failed and authoritative cleanup also failed",
          { cause: new AggregateError([primary, cleanupCause]) },
        );
      }
    } else {
      bestEffortCloseInput(request.transport);
    }
    throw primary;
  } finally {
    credential?.fill(0);
    interruption.close();
  }
}

async function sendFrozenPayload(
  transport: SuperBoxDuplexChildTransportV1,
  transcript: SuperBoxOperationTranscriptV1,
  operationID: string,
  attempt: FrozenAttemptV1,
  materials: ReadonlyMap<string, Buffer>,
  credential: Buffer | undefined,
  interruption: InterruptionMonitor,
): Promise<void> {
  if (credential !== undefined) {
    try {
      await interruption.race(sendHostFrame(
        transport,
        transcript,
        {
          type: "credential",
          operationID,
          data: credential,
        },
        true,
      ));
    } finally {
      credential.fill(0);
    }
  }
  await interruption.race(sendHostFrame(
    transport,
    transcript,
    { type: "attempt", operationID, attempt },
  ));
  for (const declaration of workspaceInputDeclarations(attempt)) {
    const bytes = materials.get(declaration.relativePath)!;
    if (bytes.byteLength === 0) {
      await interruption.race(sendHostFrame(transport, transcript, {
        type: "material_chunk",
        operationID,
        relativePath: declaration.relativePath,
        offset: 0,
        dataBase64: "",
        final: true,
      }));
      continue;
    }
    for (let offset = 0; offset < bytes.byteLength; offset += SUPERBOX_MAX_CHUNK_DECODED_BYTES) {
      const chunk = bytes.subarray(
        offset,
        Math.min(offset + SUPERBOX_MAX_CHUNK_DECODED_BYTES, bytes.byteLength),
      );
      await interruption.race(sendHostFrame(transport, transcript, {
        type: "material_chunk",
        operationID,
        relativePath: declaration.relativePath,
        offset,
        dataBase64: chunk.toString("base64"),
        final: offset + chunk.byteLength === bytes.byteLength,
      }));
    }
  }
  await interruption.race(sendHostFrame(
    transport,
    transcript,
    { type: "start", operationID },
  ));
}

async function sendHostFrame(
  transport: SuperBoxDuplexChildTransportV1,
  transcript: SuperBoxOperationTranscriptV1,
  frame: SuperBoxFrameV1,
  clearEncodedAfterWrite = false,
): Promise<void> {
  try {
    transcript.accept("host_to_guest", frame);
  } catch (cause) {
    throw protocolError("Host attempted an invalid SuperBox transition", cause);
  }
  const encoded = encodeSuperBoxFrame(frame);
  try {
    await transport.write(encoded);
  } catch (cause) {
    throw new SuperBoxProcessClientError(
      "transport_failed",
      "Could not write to the SuperBox child",
      { cause },
    );
  } finally {
    if (clearEncodedAfterWrite) encoded.fill(0);
  }
}

async function forceDestroy(
  transport: SuperBoxDuplexChildTransportV1,
  transcript: SuperBoxOperationTranscriptV1,
  operationID: string,
  exitPromise: Promise<SuperBoxProcessExitReceiptV1>,
  exitTimeoutMilliseconds: number,
  cancelGraceMilliseconds: number,
): Promise<void> {
  let cancelSent = false;
  if (
    (transcript.phase === "awaiting_ready" || transcript.phase === "running")
    && !transcript.cancelRequested
  ) {
    try {
      await sendHostFrame(transport, transcript, { type: "cancel", operationID });
      cancelSent = true;
    } catch {
      // Forced destruction remains authoritative when graceful cancel cannot be sent.
    }
  }
  if (cancelSent) {
    const gracefulReceipt = await settlesWithin(exitPromise, cancelGraceMilliseconds);
    if (gracefulReceipt !== undefined) {
      validateExitReceipt(gracefulReceipt);
      if (!gracefulReceipt.destroyed) {
        throw new SuperBoxProcessClientError(
          "destruction_unconfirmed",
          "Cooperative cancellation did not confirm SuperBox destruction",
        );
      }
      bestEffortCloseInput(transport);
      return;
    }
  }
  await withTimeout(
    Promise.resolve(transport.destroy()),
    exitTimeoutMilliseconds,
    "destruction_unconfirmed",
    "Timed out while forcing SuperBox destruction",
  );
  const receipt = await withTimeout(
    exitPromise,
    exitTimeoutMilliseconds,
    "destruction_unconfirmed",
    "Timed out waiting for forced SuperBox destruction",
  );
  validateExitReceipt(receipt);
  if (!receipt.destroyed) {
    throw new SuperBoxProcessClientError(
      "destruction_unconfirmed",
      "Forced destruction did not produce an authoritative receipt",
    );
  }
  bestEffortCloseInput(transport);
}

function boundedCancelGrace(value: number | undefined): number {
  const selected = value ?? 500;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > 5_000) {
    throw new SuperBoxProcessClientError(
      "invalid_request",
      "Cancel grace must be a positive bounded integer",
    );
  }
  return selected;
}

async function settlesWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), milliseconds);
        timer.unref();
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function destroyRejectedRequestTransport(
  transport: SuperBoxDuplexChildTransportV1,
  exitPromise: Promise<SuperBoxProcessExitReceiptV1>,
): Promise<void> {
  await withTimeout(
    Promise.resolve(transport.destroy()),
    DEFAULT_EXIT_TIMEOUT_MILLISECONDS,
    "destruction_unconfirmed",
    "Timed out while destroying a child for an invalid request",
  );
  const receipt = await withTimeout(
    exitPromise,
    DEFAULT_EXIT_TIMEOUT_MILLISECONDS,
    "destruction_unconfirmed",
    "Timed out waiting for invalid-request child destruction",
  );
  validateExitReceipt(receipt);
  if (!receipt.destroyed) {
    throw new SuperBoxProcessClientError(
      "destruction_unconfirmed",
      "Invalid-request child destruction was not confirmed",
    );
  }
  bestEffortCloseInput(transport);
}

function bestEffortCloseInput(transport: SuperBoxDuplexChildTransportV1): void {
  try {
    void Promise.resolve(transport.closeInput()).catch(() => {});
  } catch {
    // The child is already authoritatively destroyed; pipe cleanup cannot change the result.
  }
}

function clearCredentialFrames(frames: readonly SuperBoxFrameV1[]): void {
  for (const frame of frames) {
    if (frame.type === "credential") frame.data.fill(0);
  }
}

function parseAttemptRequest(value: FrozenAttemptV1): FrozenAttemptV1 {
  try {
    return parseFrozenAttempt(value);
  } catch (cause) {
    throw new SuperBoxProcessClientError(
      "invalid_request",
      "Frozen attempt is invalid",
      { cause },
    );
  }
}

function createOperationTranscript(
  operationID: string,
  providerID: string,
): SuperBoxOperationTranscriptV1 {
  try {
    return new SuperBoxOperationTranscriptV1(operationID, providerID);
  } catch (cause) {
    throw new SuperBoxProcessClientError(
      "invalid_request",
      "SuperBox operation identity is invalid",
      { cause },
    );
  }
}

function copyAndVerifyMaterials(
  attempt: FrozenAttemptV1,
  values: ReadonlyMap<string, Uint8Array>,
): ReadonlyMap<string, Buffer> {
  if (
    values === null
    || typeof values !== "object"
    || typeof values.get !== "function"
    || typeof values.keys !== "function"
    || !Number.isSafeInteger(values.size)
  ) {
    throw new SuperBoxProcessClientError("invalid_request", "Material bytes must be a ReadonlyMap");
  }
  const declarations = workspaceInputDeclarations(attempt);
  const declared = new Set(declarations.map(({ relativePath }) => relativePath));
  if (values.size !== declared.size) {
    throw new SuperBoxProcessClientError(
      "invalid_request",
      "Material byte map does not exactly match the frozen declarations",
    );
  }
  for (const path of values.keys()) {
    if (!declared.has(path)) {
      throw new SuperBoxProcessClientError("invalid_request", "Material byte map has an undeclared path");
    }
  }

  const copied = new Map<string, Buffer>();
  let aggregateBytes = 0;
  for (const declaration of declarations) {
    const value = values.get(declaration.relativePath);
    if (!(value instanceof Uint8Array)) {
      throw new SuperBoxProcessClientError("invalid_request", "Declared material bytes are missing");
    }
    const bytes = Buffer.from(value);
    aggregateBytes += bytes.byteLength;
    if (!Number.isSafeInteger(aggregateBytes) || aggregateBytes > SUPERBOX_MAX_TOTAL_MATERIAL_BYTES) {
      throw new SuperBoxProcessClientError("invalid_request", "Material bytes exceed the operation bound");
    }
    if (
      bytes.byteLength !== declaration.byteLength
      || createHash("sha256").update(bytes).digest("hex") !== declaration.sha256
    ) {
      throw new SuperBoxProcessClientError(
        "invalid_request",
        "Material bytes disagree with the frozen declaration",
      );
    }
    copied.set(declaration.relativePath, bytes);
  }
  return copied;
}

function workspaceInputDeclarations(attempt: FrozenAttemptV1) {
  return [
    ...attempt.workspace.materials,
    ...attempt.workspace.candidateSeeds.filter((seed) => seed.kind === "file"),
  ];
}

function copyCredentialEnvelope(value: Uint8Array | undefined): Buffer | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof Uint8Array)) {
    throw new SuperBoxProcessClientError(
      "invalid_request",
      "Credential envelope must be opaque bytes",
    );
  }
  if (value.byteLength === 0 || value.byteLength > SUPERBOX_MAX_CREDENTIAL_DECODED_BYTES) {
    throw new SuperBoxProcessClientError(
      "invalid_request",
      "Credential envelope must contain between 1 byte and the operation bound",
    );
  }
  return Buffer.from(value);
}

interface CandidateQuarantineState {
  readonly kind: "directory" | "file";
  readonly declaredBytes: number | null;
  readonly chunks: Buffer[];
  receivedBytes: number;
  completed: boolean;
}

class CandidateQuarantineV1 {
  readonly #entries = new Map<string, CandidateQuarantineState>();
  #aggregateBytes = 0;
  #fileCount = 0;

  public declare(frame: Extract<SuperBoxFrameV1, { type: "candidate_entry" }>): void {
    if (this.#entries.size >= SUPERBOX_MAX_CANDIDATE_ENTRIES) {
      throw protocolError("Candidate quarantine exceeded its entry-count bound");
    }
    if (this.#entries.has(frame.relativePath)) {
      throw protocolError("Candidate quarantine received a duplicate entry");
    }
    if (frame.entryKind === "file") {
      this.#fileCount += 1;
      if (this.#fileCount > SUPERBOX_MAX_CANDIDATE_FILES) {
        throw protocolError("Candidate quarantine exceeded its file-count bound");
      }
    }
    this.#entries.set(frame.relativePath, {
      kind: frame.entryKind,
      declaredBytes: frame.byteLength,
      chunks: [],
      receivedBytes: 0,
      completed: frame.entryKind === "directory",
    });
  }

  public accept(frame: Extract<SuperBoxFrameV1, { type: "candidate_chunk" }>): void {
    const candidate = this.#entries.get(frame.relativePath);
    if (candidate === undefined || candidate.kind !== "file" || candidate.declaredBytes === null) {
      throw protocolError("Candidate quarantine received bytes for an undeclared file");
    }
    if (candidate.completed || frame.offset !== candidate.receivedBytes) {
      throw protocolError("Candidate quarantine received a non-contiguous chunk");
    }
    const bytes = Buffer.from(frame.dataBase64, "base64");
    const nextFileBytes = candidate.receivedBytes + bytes.byteLength;
    const nextAggregateBytes = this.#aggregateBytes + bytes.byteLength;
    if (
      !Number.isSafeInteger(nextFileBytes)
      || !Number.isSafeInteger(nextAggregateBytes)
      || nextFileBytes > candidate.declaredBytes
      || nextAggregateBytes > SUPERBOX_MAX_TOTAL_CANDIDATE_BYTES
    ) {
      throw protocolError("Candidate quarantine exceeded its byte bound");
    }
    candidate.chunks.push(bytes);
    candidate.receivedBytes = nextFileBytes;
    if (frame.final !== (nextFileBytes === candidate.declaredBytes)) {
      throw protocolError("Candidate quarantine length disagrees with its final chunk");
    }
    candidate.completed = frame.final;
    this.#aggregateBytes = nextAggregateBytes;
  }

  public release(
    expectedManifest: readonly SuperBoxCandidateManifestEntryV1[],
  ): Readonly<{
    manifest: readonly SuperBoxCandidateManifestEntryV1[];
    files: ReadonlyMap<string, Uint8Array>;
  }> {
    const observedManifest = [...this.#entries.entries()]
      .map(([relativePath, candidate]) => ({
        relativePath,
        kind: candidate.kind,
        byteLength: candidate.declaredBytes,
      }))
      .sort((left, right) =>
        compareCanonicalUTF8V1(left.relativePath, right.relativePath)
      );
    if (JSON.stringify(observedManifest) !== JSON.stringify(expectedManifest)
      || [...this.#entries.values()].some((candidate) => !candidate.completed)) {
      throw protocolError("Candidate quarantine disagrees with the validated transcript");
    }
    const released = new Map<string, Uint8Array>();
    for (const entry of expectedManifest) {
      if (entry.kind !== "file") continue;
      const candidate = this.#entries.get(entry.relativePath)!;
      released.set(
        entry.relativePath,
        Buffer.concat(candidate.chunks, candidate.receivedBytes),
      );
    }
    this.discard();
    return Object.freeze({
      manifest: Object.freeze(expectedManifest.map((entry) => Object.freeze({ ...entry }))),
      files: released,
    });
  }

  public discardAndReleaseEmpty(): Readonly<{
    manifest: readonly SuperBoxCandidateManifestEntryV1[];
    files: ReadonlyMap<string, Uint8Array>;
  }> {
    this.discard();
    return Object.freeze({ manifest: Object.freeze([]), files: new Map() });
  }

  public discard(): void {
    for (const candidate of this.#entries.values()) {
      for (const chunk of candidate.chunks) chunk.fill(0);
      candidate.chunks.length = 0;
    }
    this.#entries.clear();
    this.#aggregateBytes = 0;
    this.#fileCount = 0;
  }
}

class InterruptionError extends Error {
  public constructor(public readonly reason: "cancelled" | "timed_out") {
    super(reason === "cancelled" ? "SuperBox operation was cancelled" : "SuperBox operation timed out");
    this.name = "InterruptionError";
  }
}

class InterruptionMonitor {
  readonly #promise: Promise<never>;
  readonly #signal: AbortSignal | undefined;
  readonly #abortListener: (() => void) | undefined;
  readonly #timer: ReturnType<typeof setTimeout> | undefined;
  #reject!: (cause: InterruptionError) => void;

  public constructor(signal: AbortSignal | undefined, timeoutMilliseconds: number | undefined) {
    this.#signal = signal;
    this.#promise = new Promise((_, reject) => {
      this.#reject = reject;
    });
    this.#abortListener = signal === undefined
      ? undefined
      : () => this.#reject(new InterruptionError("cancelled"));
    if (signal?.aborted) {
      this.#abortListener?.();
    } else if (this.#abortListener !== undefined) {
      signal!.addEventListener("abort", this.#abortListener, { once: true });
    }
    if (timeoutMilliseconds === undefined) {
      this.#timer = undefined;
    } else {
      this.#timer = setTimeout(() => {
        this.#reject(new InterruptionError("timed_out"));
      }, timeoutMilliseconds);
      this.#timer.unref();
    }
  }

  public race<T>(operation: PromiseLike<T>): Promise<T> {
    return Promise.race([Promise.resolve(operation), this.#promise]);
  }

  public close(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#signal !== undefined && this.#abortListener !== undefined) {
      this.#signal.removeEventListener("abort", this.#abortListener);
    }
  }
}

function validateExitReceipt(value: SuperBoxProcessExitReceiptV1): void {
  if (
    value === null
    || typeof value !== "object"
    || (value.exitCode !== null && !Number.isInteger(value.exitCode))
    || typeof value.destroyed !== "boolean"
  ) {
    throw new SuperBoxProcessClientError(
      "destruction_unconfirmed",
      "Transport returned an invalid child exit receipt",
    );
  }
}

function assertTransport(value: SuperBoxDuplexChildTransportV1): void {
  if (
    value === null
    || typeof value !== "object"
    || value.stdout === null
    || typeof value.stdout !== "object"
    || typeof value.stdout[Symbol.asyncIterator] !== "function"
    || typeof value.write !== "function"
    || typeof value.closeInput !== "function"
    || typeof value.destroy !== "function"
    || typeof value.waitForExit !== "function"
  ) {
    throw new SuperBoxProcessClientError("invalid_request", "Child transport is invalid");
  }
}

function positiveTimeout(value: number | undefined, fallback: number, label: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0) {
    throw new SuperBoxProcessClientError("invalid_request", `${label} must be a positive integer`);
  }
  return selected;
}

function optionalPositiveTimeout(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return positiveTimeout(value, value, "operation timeout");
}

function withTimeout<T>(
  operation: PromiseLike<T>,
  timeoutMilliseconds: number,
  code: SuperBoxProcessClientErrorCode,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SuperBoxProcessClientError(code, message)), timeoutMilliseconds);
    timer.unref();
  });
  return Promise.race([Promise.resolve(operation), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function protocolError(message: string, cause?: unknown): SuperBoxProcessClientError {
  return new SuperBoxProcessClientError(
    "protocol_violation",
    message,
    cause === undefined ? undefined : { cause },
  );
}

function normalizeClientFailure(cause: unknown): SuperBoxProcessClientError {
  if (cause instanceof SuperBoxProcessClientError) return cause;
  if (cause instanceof InterruptionError) {
    return new SuperBoxProcessClientError(cause.reason, cause.message, { cause });
  }
  if (cause instanceof SuperBoxOperationError || cause instanceof SuperBoxWireError) {
    return protocolError("SuperBox protocol validation failed", cause);
  }
  return new SuperBoxProcessClientError(
    "transport_failed",
    "SuperBox child transport failed",
    { cause },
  );
}
