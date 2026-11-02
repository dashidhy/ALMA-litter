import type { NormalizedEventV1, TahAttemptResultV1 } from "../contract/index.js";
import type { BuiltAttemptV1 } from "./attempt-builders.js";
import {
  TahAttemptExecutionErrorV1,
  type TahFrameworkAttemptPortV1,
} from "./workflow.js";

export const TAH_DEFAULT_NO_EVENT_TIMEOUT_MILLISECONDS = 60 * 60 * 1_000;

/** Provider-neutral liveness supervision based only on validated normalized events. */
export class LivenessTahAttemptPortV1 implements TahFrameworkAttemptPortV1 {
  readonly #inner: TahFrameworkAttemptPortV1;
  readonly #noEventTimeoutMilliseconds: number;

  public constructor(
    inner: TahFrameworkAttemptPortV1,
    noEventTimeoutMilliseconds = TAH_DEFAULT_NO_EVENT_TIMEOUT_MILLISECONDS,
  ) {
    if (inner === null || typeof inner !== "object" || typeof inner.run !== "function") {
      throw new TypeError("TAH liveness port requires an inner attempt port");
    }
    if (!Number.isSafeInteger(noEventTimeoutMilliseconds)
      || noEventTimeoutMilliseconds <= 0
      || noEventTimeoutMilliseconds > 24 * 60 * 60 * 1_000) {
      throw new TypeError("TAH no-event timeout must be between one millisecond and 24 hours");
    }
    this.#inner = inner;
    this.#noEventTimeoutMilliseconds = noEventTimeoutMilliseconds;
  }

  public async run(
    attempt: BuiltAttemptV1,
    onEvent?: (event: NormalizedEventV1) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<TahAttemptResultV1> {
    if (signal?.aborted) throw new TahAttemptExecutionErrorV1("cancelled");
    const operationAbort = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timedOut = true;
        operationAbort.abort();
      }, this.#noEventTimeoutMilliseconds);
      timer.unref();
    };
    const externalAbort = (): void => operationAbort.abort();
    signal?.addEventListener("abort", externalAbort, { once: true });
    arm();
    try {
      const result = await this.#inner.run(
        attempt,
        async (event) => {
          if (event.kind !== "warning") arm();
          await onEvent?.(event);
        },
        operationAbort.signal,
      );
      if (timedOut) {
        if (terminalHasCleanupUncertainty(result)) return result;
        throw new TahAttemptExecutionErrorV1("unavailable");
      }
      return result;
    } catch (cause) {
      if (cause instanceof TahAttemptExecutionErrorV1
        && cause.category === "cleanup_unconfirmed") {
        throw cause;
      }
      if (timedOut) throw new TahAttemptExecutionErrorV1("unavailable");
      if (signal?.aborted) throw new TahAttemptExecutionErrorV1("cancelled");
      throw cause;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", externalAbort);
    }
  }
}

function terminalHasCleanupUncertainty(result: TahAttemptResultV1): boolean {
  return result.terminal.kind === "failed" && result.terminal.failure.family === "cleanup";
}
