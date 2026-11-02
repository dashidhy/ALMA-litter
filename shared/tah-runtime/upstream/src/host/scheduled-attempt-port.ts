import type { NormalizedEventV1, TahAttemptResultV1 } from "../contract/index.js";
import {
  TahAttemptExecutionErrorV1,
  type BuiltAttemptV1,
  type TahFrameworkAttemptPortV1,
} from "../framework/index.js";
import {
  BoundedTahHostOperationSchedulerV1,
  TahHostOperationSchedulerErrorV1,
} from "./operation-scheduler.js";

/**
 * Acquires the global VM slot before starting the wrapped liveness watchdog.
 * Compose as Scheduled(Liveness(SuperBox)).
 */
export class ScheduledTahAttemptPortV1 implements TahFrameworkAttemptPortV1 {
  public constructor(
    private readonly inner: TahFrameworkAttemptPortV1,
    private readonly scheduler: BoundedTahHostOperationSchedulerV1,
  ) {
    if (inner === null || typeof inner !== "object" || typeof inner.run !== "function"
      || !(scheduler instanceof BoundedTahHostOperationSchedulerV1)) {
      throw new TypeError("Scheduled TAH attempt port composition is invalid");
    }
  }

  public async run(
    attempt: BuiltAttemptV1,
    onEvent?: (event: NormalizedEventV1) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<TahAttemptResultV1> {
    try {
      return await this.scheduler.schedule({
        declaredInputBytes: declaredAttemptInputBytes(attempt),
        ...(signal === undefined ? {} : { signal }),
        run: (scheduledSignal) => this.inner.run(attempt, onEvent, scheduledSignal),
      });
    } catch (cause) {
      if (cause instanceof TahAttemptExecutionErrorV1) throw cause;
      if (cause instanceof TahHostOperationSchedulerErrorV1) {
        throw new TahAttemptExecutionErrorV1(
          cause.code === "cancelled" ? "cancelled" : "unavailable",
        );
      }
      throw cause;
    }
  }
}

function declaredAttemptInputBytes(built: BuiltAttemptV1): number {
  let total = built.attempt.prompt.reduce(
    (bytes, part) => bytes + Buffer.byteLength(part.text, "utf8"),
    0,
  );
  for (const bytes of built.inputBytes.values()) {
    total += bytes.byteLength;
    if (!Number.isSafeInteger(total)) throw new TahAttemptExecutionErrorV1("unavailable");
  }
  return total;
}
