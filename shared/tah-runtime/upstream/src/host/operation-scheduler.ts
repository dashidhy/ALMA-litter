export const TAH_HOST_MAX_OUTSTANDING_OPERATIONS = 8;
export const TAH_HOST_MAX_OUTSTANDING_INPUT_BYTES = 128 * 1024 * 1024;

export interface ScheduleTahHostOperationV1<T> {
  readonly declaredInputBytes: number;
  readonly signal?: AbortSignal;
  readonly run: (signal: AbortSignal) => Promise<T>;
}

export class TahHostOperationSchedulerErrorV1 extends Error {
  public constructor(public readonly code: "cancelled" | "capacity" | "closed") {
    super("TAH Host operation could not be scheduled");
    this.name = "TahHostOperationSchedulerErrorV1";
  }
}

interface QueuedOperationV1 {
  readonly declaredInputBytes: number;
  readonly signal: AbortSignal | undefined;
  readonly run: (signal: AbortSignal) => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (cause: unknown) => void;
  abortListener?: () => void;
}

/**
 * One provider-neutral admission queue shared by every whole-runtime VM use.
 * The prototype deliberately permits only one 2 GiB SuperBox at a time.
 */
export class BoundedTahHostOperationSchedulerV1 {
  readonly #maximumOutstandingOperations: number;
  readonly #maximumOutstandingInputBytes: number;
  readonly #queue: QueuedOperationV1[] = [];
  #outstandingInputBytes = 0;
  #active: QueuedOperationV1 | undefined;
  #activeAbort: AbortController | undefined;
  #activeSettled: Promise<void> | undefined;
  #closed = false;

  public constructor(
    maximumOutstandingOperations = TAH_HOST_MAX_OUTSTANDING_OPERATIONS,
    maximumOutstandingInputBytes = TAH_HOST_MAX_OUTSTANDING_INPUT_BYTES,
  ) {
    if (!Number.isSafeInteger(maximumOutstandingOperations)
      || maximumOutstandingOperations <= 0
      || maximumOutstandingOperations > 64
      || !Number.isSafeInteger(maximumOutstandingInputBytes)
      || maximumOutstandingInputBytes <= 0
      || maximumOutstandingInputBytes > 1024 * 1024 * 1024) {
      throw new TypeError("TAH Host scheduler bounds are invalid");
    }
    this.#maximumOutstandingOperations = maximumOutstandingOperations;
    this.#maximumOutstandingInputBytes = maximumOutstandingInputBytes;
  }

  public schedule<T>(request: ScheduleTahHostOperationV1<T>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(new TahHostOperationSchedulerErrorV1("closed"));
    }
    if (!Number.isSafeInteger(request.declaredInputBytes)
      || request.declaredInputBytes < 0
      || typeof request.run !== "function") {
      return Promise.reject(new TypeError("TAH Host scheduled operation is invalid"));
    }
    if (request.signal?.aborted) {
      return Promise.reject(new TahHostOperationSchedulerErrorV1("cancelled"));
    }
    const outstandingCount = this.#queue.length + (this.#active === undefined ? 0 : 1);
    const nextBytes = this.#outstandingInputBytes + request.declaredInputBytes;
    if (outstandingCount >= this.#maximumOutstandingOperations
      || !Number.isSafeInteger(nextBytes)
      || nextBytes > this.#maximumOutstandingInputBytes) {
      return Promise.reject(new TahHostOperationSchedulerErrorV1("capacity"));
    }

    return new Promise<T>((resolve, reject) => {
      const operation: QueuedOperationV1 = {
        declaredInputBytes: request.declaredInputBytes,
        signal: request.signal,
        run: request.run,
        resolve: (value) => resolve(value as T),
        reject,
      };
      if (request.signal !== undefined) {
        operation.abortListener = () => this.#cancelQueued(operation);
        request.signal.addEventListener("abort", operation.abortListener, { once: true });
      }
      this.#queue.push(operation);
      this.#outstandingInputBytes = nextBytes;
      this.#startNext();
    });
  }

  public close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      const queued = this.#queue.splice(0);
      for (const operation of queued) {
        this.#removeAbortListener(operation);
        this.#outstandingInputBytes -= operation.declaredInputBytes;
        operation.reject(new TahHostOperationSchedulerErrorV1("closed"));
      }
      this.#activeAbort?.abort();
    }
    return this.#activeSettled ?? Promise.resolve();
  }

  #startNext(): void {
    if (this.#closed || this.#active !== undefined) return;
    const operation = this.#queue.shift();
    if (operation === undefined) return;
    this.#removeAbortListener(operation);
    if (operation.signal?.aborted) {
      this.#outstandingInputBytes -= operation.declaredInputBytes;
      operation.reject(new TahHostOperationSchedulerErrorV1("cancelled"));
      this.#startNext();
      return;
    }

    this.#active = operation;
    const abort = new AbortController();
    this.#activeAbort = abort;
    const externalAbort = (): void => abort.abort();
    operation.signal?.addEventListener("abort", externalAbort, { once: true });
    const settled = Promise.resolve()
      .then(() => operation.run(abort.signal))
      .then(operation.resolve, operation.reject)
      .finally(() => {
        operation.signal?.removeEventListener("abort", externalAbort);
        this.#outstandingInputBytes -= operation.declaredInputBytes;
        this.#active = undefined;
        this.#activeAbort = undefined;
        this.#activeSettled = undefined;
        this.#startNext();
      });
    this.#activeSettled = settled;
    void settled.catch(() => {});
  }

  #cancelQueued(operation: QueuedOperationV1): void {
    const index = this.#queue.indexOf(operation);
    if (index < 0) return;
    this.#queue.splice(index, 1);
    this.#removeAbortListener(operation);
    this.#outstandingInputBytes -= operation.declaredInputBytes;
    operation.reject(new TahHostOperationSchedulerErrorV1("cancelled"));
  }

  #removeAbortListener(operation: QueuedOperationV1): void {
    if (operation.signal !== undefined && operation.abortListener !== undefined) {
      operation.signal.removeEventListener("abort", operation.abortListener);
      delete operation.abortListener;
    }
  }
}
