import {
  SuperBoxFrameDecoder,
  SUPERBOX_MAX_CREDENTIAL_DECODED_BYTES,
  SUPERBOX_WIRE_VERSION,
  encodeSuperBoxFrame,
  type SuperBoxFrameV1,
} from "../superbox/wire.js";
import {
  SuperBoxProcessClientError,
  type SuperBoxDuplexChildTransportV1,
  type SuperBoxProcessExitReceiptV1,
} from "../superbox/process-client.js";
import {
  parseProviderControlRequestV1,
  type ProviderControlRequestV1,
  type ProviderControlTerminalV1,
} from "./contract.js";
import { ProviderControlSuperBoxTranscriptV1 } from "./superbox-transcript.js";

export interface RunSuperBoxProviderControlProcessV1 {
  readonly operationID: string;
  readonly request: ProviderControlRequestV1;
  readonly credentialEnvelope?: Uint8Array;
  readonly transport: SuperBoxDuplexChildTransportV1;
  readonly timeoutMilliseconds?: number;
  readonly exitTimeoutMilliseconds?: number;
  readonly cancelGraceMilliseconds?: number;
  readonly signal?: AbortSignal;
}

const DEFAULT_EXIT_TIMEOUT_MILLISECONDS = 30_000;
const DEFAULT_CONTROL_TIMEOUT_MILLISECONDS = 5 * 60_000;
const MAXIMUM_CONTROL_TIMEOUT_MILLISECONDS = 5 * 60_000;

/**
 * Runs one read-only Provider control operation. A terminal is returned only
 * after the complete VM transport reports authoritative destruction.
 */
export async function runSuperBoxProviderControlProcessV1(
  input: RunSuperBoxProviderControlProcessV1,
): Promise<ProviderControlTerminalV1> {
  assertTransport(input.transport);
  const exitPromise = Promise.resolve().then(() => input.transport.waitForExit());
  void exitPromise.catch(() => {});

  let request!: ProviderControlRequestV1;
  let transcript!: ProviderControlSuperBoxTranscriptV1;
  let decoder!: SuperBoxFrameDecoder;
  let exitTimeout!: number;
  let cancelGrace!: number;
  let interruption: ControlInterruption | undefined;
  let credential: Buffer | undefined;
  try {
    request = parseProviderControlRequestV1(input.request);
    if (request.operationID !== input.operationID) throw invalidRequest();
    const credentialPresent = input.credentialEnvelope !== undefined;
    if (request.kind === "describe" && credentialPresent) {
      throw invalidRequest();
    }
    credential = copyCredential(input.credentialEnvelope);
    transcript = new ProviderControlSuperBoxTranscriptV1(input.operationID, request.providerID);
    decoder = new SuperBoxFrameDecoder();
    exitTimeout = positiveTimeout(
      input.exitTimeoutMilliseconds,
      DEFAULT_EXIT_TIMEOUT_MILLISECONDS,
    );
    cancelGrace = boundedCancelGrace(input.cancelGraceMilliseconds);
    interruption = new ControlInterruption(
      input.signal,
      boundedControlTimeout(input.timeoutMilliseconds),
    );
  } catch (cause) {
    credential?.fill(0);
    interruption?.close();
    try {
      await destroyAndConfirm(input.transport, exitPromise, DEFAULT_EXIT_TIMEOUT_MILLISECONDS);
    } catch (cleanupCause) {
      throw cleanupFailure(cause, cleanupCause);
    }
    throw normalizeFailure(cause);
  }

  let destroyed = false;
  const iterator = input.transport.stdout[Symbol.asyncIterator]();
  try {
    await interruption.race(sendFrame(input.transport, transcript, {
      type: "host_hello",
      wireVersion: SUPERBOX_WIRE_VERSION,
      operationID: input.operationID,
      providerID: request.providerID,
      operationKind: "control",
    }));

    let payloadSent = false;
    let stopping = false;
    for (;;) {
      const next = await interruption.race(iterator.next());
      if (next.done) {
        decoder.finish();
        if (!stopping) throw prematureEOF();
        break;
      }
      if (stopping && next.value.byteLength > 0) {
        next.value.fill(0);
        throw protocolFailure();
      }
      let frames: readonly SuperBoxFrameV1[];
      try {
        frames = decoder.push(next.value);
      } finally {
        next.value.fill(0);
      }
      try {
        for (let index = 0; index < frames.length; index += 1) {
          const frame = frames[index]!;
          transcript.accept("guest_to_host", frame);
          if (frame.type === "guest_hello") {
            if (payloadSent) throw protocolFailure();
            payloadSent = true;
            await sendPayload(input, request, credential, transcript, interruption);
            credential = undefined;
          } else if (frame.type === "stopping") {
            if (index !== frames.length - 1) throw protocolFailure();
            stopping = true;
          }
        }
      } finally {
        clearCredentialFrames(frames);
      }
    }

    const receipt = await interruption.race(withTimeout(
      exitPromise,
      exitTimeout,
      "Timed out waiting for Provider control VM destruction",
    ));
    validateExitReceipt(receipt);
    destroyed = receipt.destroyed;
    if (!receipt.destroyed) throw destructionFailure();
    if (receipt.exitCode !== 0) {
      throw new SuperBoxProcessClientError(
        "exit_failed",
        "Provider control VM did not exit successfully",
      );
    }
    transcript.confirmDestroyed();
    bestEffortCloseInput(input.transport);
    if (transcript.fatalCode !== undefined) {
      throw new SuperBoxProcessClientError(
        "guest_fatal",
        "Provider control Guest reported a closed fatal result",
        { guestFatalCode: transcript.fatalCode },
      );
    }
    if (!transcript.completionReady || transcript.terminal === undefined) {
      throw protocolFailure();
    }
    return transcript.terminal;
  } catch (cause) {
    const primary = normalizeFailure(cause);
    if (!destroyed) {
      try {
        await forceControlDestruction(
          input.transport,
          transcript,
          input.operationID,
          exitPromise,
          exitTimeout,
          cancelGrace,
        );
      } catch (cleanupCause) {
        throw cleanupFailure(primary, cleanupCause);
      }
    } else {
      bestEffortCloseInput(input.transport);
    }
    throw primary;
  } finally {
    credential?.fill(0);
    interruption.close();
  }
}

async function sendPayload(
  input: RunSuperBoxProviderControlProcessV1,
  request: ProviderControlRequestV1,
  credential: Buffer | undefined,
  transcript: ProviderControlSuperBoxTranscriptV1,
  interruption: ControlInterruption,
): Promise<void> {
  if (credential !== undefined) {
    try {
      await interruption.race(sendFrame(input.transport, transcript, {
        type: "credential",
        operationID: input.operationID,
        data: credential,
      }, true));
    } finally {
      credential.fill(0);
    }
  }
  await interruption.race(sendFrame(input.transport, transcript, {
    type: "control_request",
    operationID: input.operationID,
    request,
  }));
  await interruption.race(sendFrame(input.transport, transcript, {
    type: "start",
    operationID: input.operationID,
  }));
}

async function sendFrame(
  transport: SuperBoxDuplexChildTransportV1,
  transcript: ProviderControlSuperBoxTranscriptV1,
  frame: SuperBoxFrameV1,
  clear = false,
): Promise<void> {
  transcript.accept("host_to_guest", frame);
  const encoded = encodeSuperBoxFrame(frame);
  try {
    await transport.write(encoded);
  } catch (cause) {
    throw new SuperBoxProcessClientError(
      "transport_failed",
      "Could not write Provider control frame",
      { cause },
    );
  } finally {
    if (clear) encoded.fill(0);
  }
}

async function forceControlDestruction(
  transport: SuperBoxDuplexChildTransportV1,
  transcript: ProviderControlSuperBoxTranscriptV1,
  operationID: string,
  exitPromise: Promise<SuperBoxProcessExitReceiptV1>,
  timeout: number,
  cancelGrace: number,
): Promise<void> {
  let cancelSent = false;
  if ((transcript.phase === "awaiting_ready" || transcript.phase === "running")
    && !transcript.cancelRequested) {
    try {
      await sendFrame(transport, transcript, { type: "cancel", operationID });
      cancelSent = true;
    } catch {
      // Authoritative VM destruction is the containment boundary.
    }
  }
  if (cancelSent) {
    const gracefulReceipt = await settlesWithin(exitPromise, cancelGrace);
    if (gracefulReceipt !== undefined) {
      validateExitReceipt(gracefulReceipt);
      if (!gracefulReceipt.destroyed) throw destructionFailure();
      bestEffortCloseInput(transport);
      return;
    }
  }
  await withTimeout(
    Promise.resolve(transport.destroy()),
    timeout,
    "Timed out forcing Provider control VM destruction",
  );
  const receipt = await withTimeout(
    exitPromise,
    timeout,
    "Timed out confirming forced Provider control VM destruction",
  );
  validateExitReceipt(receipt);
  if (!receipt.destroyed) throw destructionFailure();
  bestEffortCloseInput(transport);
}

async function destroyAndConfirm(
  transport: SuperBoxDuplexChildTransportV1,
  exitPromise: Promise<SuperBoxProcessExitReceiptV1>,
  timeout: number,
): Promise<void> {
  await withTimeout(
    Promise.resolve(transport.destroy()),
    timeout,
    "Timed out destroying rejected Provider control VM",
  );
  const receipt = await withTimeout(
    exitPromise,
    timeout,
    "Timed out confirming rejected Provider control VM destruction",
  );
  validateExitReceipt(receipt);
  if (!receipt.destroyed) throw destructionFailure();
  bestEffortCloseInput(transport);
}

class ControlInterruptionError extends Error {
  public constructor(public readonly reason: "cancelled" | "timed_out") {
    super("Provider control operation was interrupted");
    this.name = "ControlInterruptionError";
  }
}

class ControlInterruption {
  readonly #promise: Promise<never>;
  readonly #signal: AbortSignal | undefined;
  readonly #listener: (() => void) | undefined;
  readonly #timer: ReturnType<typeof setTimeout> | undefined;
  #reject!: (cause: ControlInterruptionError) => void;

  public constructor(signal: AbortSignal | undefined, timeout: number | undefined) {
    if (timeout !== undefined && (!Number.isSafeInteger(timeout) || timeout <= 0)) {
      throw invalidRequest();
    }
    this.#signal = signal;
    this.#promise = new Promise((_, reject) => { this.#reject = reject; });
    this.#listener = signal === undefined
      ? undefined
      : () => this.#reject(new ControlInterruptionError("cancelled"));
    if (signal?.aborted) this.#listener?.();
    else if (this.#listener !== undefined) signal!.addEventListener("abort", this.#listener, { once: true });
    this.#timer = timeout === undefined
      ? undefined
      : setTimeout(() => this.#reject(new ControlInterruptionError("timed_out")), timeout);
    this.#timer?.unref();
  }

  public race<T>(value: PromiseLike<T>): Promise<T> {
    return Promise.race([Promise.resolve(value), this.#promise]);
  }

  public close(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    if (this.#signal !== undefined && this.#listener !== undefined) {
      this.#signal.removeEventListener("abort", this.#listener);
    }
  }
}

function assertTransport(value: SuperBoxDuplexChildTransportV1): void {
  if (value === null || typeof value !== "object"
    || value.stdout === null || typeof value.stdout !== "object"
    || typeof value.write !== "function"
    || typeof value.closeInput !== "function"
    || typeof value.destroy !== "function"
    || typeof value.waitForExit !== "function") {
    throw invalidRequest();
  }
}

function copyCredential(value: Uint8Array | undefined): Buffer | undefined {
  if (value === undefined) return undefined;
  if (!(value instanceof Uint8Array)
    || value.byteLength === 0
    || value.byteLength > SUPERBOX_MAX_CREDENTIAL_DECODED_BYTES) {
    throw invalidRequest();
  }
  return Buffer.from(value);
}

function validateExitReceipt(value: SuperBoxProcessExitReceiptV1): void {
  if (value === null || typeof value !== "object"
    || typeof value.destroyed !== "boolean"
    || (value.exitCode !== null && !Number.isSafeInteger(value.exitCode))) {
    throw new SuperBoxProcessClientError("exit_failed", "Provider control exit receipt is invalid");
  }
}

function positiveTimeout(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > 24 * 60 * 60 * 1_000) {
    throw invalidRequest();
  }
  return selected;
}

function boundedControlTimeout(value: number | undefined): number {
  const selected = value ?? DEFAULT_CONTROL_TIMEOUT_MILLISECONDS;
  if (!Number.isSafeInteger(selected)
    || selected <= 0
    || selected > MAXIMUM_CONTROL_TIMEOUT_MILLISECONDS) {
    throw invalidRequest();
  }
  return selected;
}

function boundedCancelGrace(value: number | undefined): number {
  const selected = value ?? 500;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > 5_000) {
    throw invalidRequest();
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

async function withTimeout<T>(promise: Promise<T>, timeout: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new SuperBoxProcessClientError(
          "destruction_unconfirmed",
          message,
        )), timeout);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function normalizeFailure(cause: unknown): SuperBoxProcessClientError {
  if (cause instanceof SuperBoxProcessClientError) return cause;
  if (cause instanceof ControlInterruptionError) {
    return new SuperBoxProcessClientError(
      cause.reason === "cancelled" ? "cancelled" : "timed_out",
      "Provider control operation was interrupted",
      { cause },
    );
  }
  return protocolFailure(cause);
}

function bestEffortCloseInput(transport: SuperBoxDuplexChildTransportV1): void {
  try { void Promise.resolve(transport.closeInput()).catch(() => {}); } catch { /* destroyed */ }
}

function clearCredentialFrames(frames: readonly SuperBoxFrameV1[]): void {
  for (const frame of frames) {
    if (frame.type === "credential") frame.data.fill(0);
  }
}

function invalidRequest(): SuperBoxProcessClientError {
  return new SuperBoxProcessClientError("invalid_request", "Provider control request is invalid");
}

function prematureEOF(): SuperBoxProcessClientError {
  return new SuperBoxProcessClientError("premature_eof", "Provider control Guest stopped early");
}

function protocolFailure(cause?: unknown): SuperBoxProcessClientError {
  return new SuperBoxProcessClientError(
    "protocol_violation",
    "Provider control wire violated its closed protocol",
    cause === undefined ? undefined : { cause },
  );
}

function destructionFailure(): SuperBoxProcessClientError {
  return new SuperBoxProcessClientError(
    "destruction_unconfirmed",
    "Provider control VM destruction is unconfirmed",
  );
}

function cleanupFailure(primary: unknown, cleanup: unknown): SuperBoxProcessClientError {
  return new SuperBoxProcessClientError(
    "cleanup_failed",
    "Provider control operation cleanup could not be confirmed",
    { cause: new AggregateError([primary, cleanup]) },
  );
}
