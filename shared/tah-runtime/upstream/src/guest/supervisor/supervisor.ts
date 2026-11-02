import {
  NormalizedEventLedgerV1,
  type AttemptTerminalV1,
} from "../../contract/index.js";
import type {
  GuestProviderAdapterV1,
  GuestProviderAttemptContextV1,
} from "../runtime/adapter.js";
import {
  assertMatchingProviderControlTerminalV1,
  type ProviderControlTerminalV1,
} from "../../provider-control/contract.js";
import type {
  GuestProviderControlAdapterV1,
  GuestProviderControlContextV1,
} from "../../provider-control/guest-adapter.js";
import {
  DEDICATED_PROVIDER_PROTOCOL_VERSION,
  DedicatedProviderFrameDecoderV1,
  encodeDedicatedProviderFrameV1,
  type DedicatedProviderFrameV1,
} from "./protocol.js";
import {
  DEDICATED_PROVIDER_MAX_CREDENTIAL_BYTES,
  DedicatedProviderCredentialEncodingV1,
} from "./credential-channel.js";
import {
  systemDedicatedProviderTimePortV1,
  type DedicatedProviderCgroupLeaseV1,
  type DedicatedProviderCgroupPortV1,
  type DedicatedProviderChildV1,
  type DedicatedProviderSpawnPortV1,
  type DedicatedProviderTimePortV1,
} from "./ports.js";

export interface DedicatedProviderSupervisorOptionsV1 {
  readonly spawn: DedicatedProviderSpawnPortV1;
  readonly cgroups: DedicatedProviderCgroupPortV1;
  readonly time?: DedicatedProviderTimePortV1;
  readonly terminateGraceMilliseconds?: number;
  readonly cgroupEmptyTimeoutMilliseconds?: number;
  readonly cgroupPollMilliseconds?: number;
  readonly reapTimeoutMilliseconds?: number;
  readonly outputDrainTimeoutMilliseconds?: number;
}

export interface DedicatedGuestProviderExecutorV1 extends GuestProviderAdapterV1 {
  readonly executionIsolation: "dedicated_child_cgroup_v1";
}

export type DedicatedProviderSupervisorStateV1 =
  | "idle"
  | "boot"
  | "running"
  | "quiescing"
  | "complete"
  | "failed";

const DEFAULT_TERMINATE_GRACE_MILLISECONDS = 500;
const DEFAULT_CGROUP_EMPTY_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_CGROUP_POLL_MILLISECONDS = 25;
const DEFAULT_REAP_TIMEOUT_MILLISECONDS = 5_000;
const DEFAULT_OUTPUT_DRAIN_TIMEOUT_MILLISECONDS = 5_000;

/**
 * Provider-neutral controller for one trusted bootstrap child. A provisional
 * terminal is withheld until authority revocation, cgroup kill/empty, and
 * leader reap all succeed.
 */
export class DedicatedProviderSupervisorV1
  implements DedicatedGuestProviderExecutorV1, GuestProviderControlAdapterV1 {
  public readonly executionIsolation = "dedicated_child_cgroup_v1" as const;

  readonly #spawn: DedicatedProviderSpawnPortV1;
  readonly #cgroups: DedicatedProviderCgroupPortV1;
  readonly #time: DedicatedProviderTimePortV1;
  readonly #terminateGraceMilliseconds: number;
  readonly #cgroupEmptyTimeoutMilliseconds: number;
  readonly #cgroupPollMilliseconds: number;
  readonly #reapTimeoutMilliseconds: number;
  readonly #outputDrainTimeoutMilliseconds: number;
  #state: DedicatedProviderSupervisorStateV1 = "idle";
  #child: DedicatedProviderChildV1 | undefined;
  #cgroup: DedicatedProviderCgroupLeaseV1 | undefined;
  #startReleased = false;
  #cancelRequested = false;
  #teardownPromise: Promise<void> | undefined;
  #runCompletion: Promise<void> | undefined;
  #resolveRun!: () => void;
  #rejectRun!: (cause: unknown) => void;
  #outputIterator: AsyncIterator<Uint8Array> | undefined;
  #outputDecoder: DedicatedProviderFrameDecoderV1 | undefined;
  #provisionalTerminalObserved = false;
  #protocolSettled: Promise<void> | undefined;
  #cancelWrite: Promise<void> | undefined;
  #acquisitionSettled: Promise<void> | undefined;

  public constructor(options: DedicatedProviderSupervisorOptionsV1) {
    this.#spawn = options.spawn;
    this.#cgroups = options.cgroups;
    this.#time = options.time ?? systemDedicatedProviderTimePortV1;
    this.#terminateGraceMilliseconds = positiveBound(
      options.terminateGraceMilliseconds,
      DEFAULT_TERMINATE_GRACE_MILLISECONDS,
      "terminate grace",
    );
    this.#cgroupEmptyTimeoutMilliseconds = positiveBound(
      options.cgroupEmptyTimeoutMilliseconds,
      DEFAULT_CGROUP_EMPTY_TIMEOUT_MILLISECONDS,
      "cgroup empty timeout",
    );
    this.#cgroupPollMilliseconds = positiveBound(
      options.cgroupPollMilliseconds,
      DEFAULT_CGROUP_POLL_MILLISECONDS,
      "cgroup poll interval",
    );
    this.#reapTimeoutMilliseconds = positiveBound(
      options.reapTimeoutMilliseconds,
      DEFAULT_REAP_TIMEOUT_MILLISECONDS,
      "child reap timeout",
    );
    this.#outputDrainTimeoutMilliseconds = positiveBound(
      options.outputDrainTimeoutMilliseconds,
      DEFAULT_OUTPUT_DRAIN_TIMEOUT_MILLISECONDS,
      "output drain timeout",
    );
  }

  public get state(): DedicatedProviderSupervisorStateV1 {
    return this.#state;
  }

  public async run(context: GuestProviderAttemptContextV1): Promise<AttemptTerminalV1> {
    if (this.#state !== "idle") {
      throw new DedicatedProviderSupervisorError(
        "invalid_state",
        "Dedicated Provider supervisor is one-shot",
      );
    }
    this.#state = "boot";
    this.#runCompletion = new Promise((resolve, reject) => {
      this.#resolveRun = resolve;
      this.#rejectRun = reject;
    });
    void this.#runCompletion.catch(() => {});
    const signalListener = (): void => {
      void this.cancel().catch(() => {});
    };
    context.signal.addEventListener("abort", signalListener, { once: true });
    let provisional: AttemptTerminalV1 | undefined;
    let primaryError: unknown;

    try {
      if (context.signal.aborted) {
        this.#cancelRequested = true;
      } else {
        await this.#acquireResources(context.attempt.attemptID);
        if (!this.#cancelRequested) {
          const protocol = this.#runChildProtocol(context);
          this.#protocolSettled = protocol.then(() => {}, () => {});
          provisional = await protocol;
        }
      }
    } catch (cause) {
      primaryError = cause;
    }

    let containmentFailed = false;
    try {
      await this.#ensureTeardown();
    } catch (cause) {
      containmentFailed = true;
      primaryError = new DedicatedProviderSupervisorError(
        "containment_failed",
        "Dedicated Provider containment could not be proven",
        primaryError === undefined
          ? { cause }
          : { cause: new AggregateError([primaryError, cause]) },
      );
    } finally {
      context.signal.removeEventListener("abort", signalListener);
    }

    if (this.#cancelRequested && !containmentFailed
      && (primaryError === undefined || isCancellationMarker(primaryError))) {
      this.#state = "complete";
      this.#resolveRun();
      return { kind: "cancelled" };
    }
    if (primaryError !== undefined) {
      this.#state = "failed";
      this.#rejectRun(primaryError);
      throw normalizeSupervisorError(primaryError);
    }
    if (provisional === undefined) {
      const cause = new DedicatedProviderSupervisorError(
        "protocol_violation",
        "Provider child stopped without a provisional terminal",
      );
      this.#state = "failed";
      this.#rejectRun(cause);
      throw cause;
    }
    this.#state = "complete";
    this.#resolveRun();
    return provisional;
  }

  public async runControl(
    context: GuestProviderControlContextV1,
  ): Promise<ProviderControlTerminalV1> {
    if (this.#state !== "idle") {
      throw new DedicatedProviderSupervisorError(
        "invalid_state",
        "Dedicated Provider supervisor is one-shot",
      );
    }
    this.#state = "boot";
    this.#runCompletion = new Promise((resolve, reject) => {
      this.#resolveRun = resolve;
      this.#rejectRun = reject;
    });
    void this.#runCompletion.catch(() => {});
    const signalListener = (): void => { void this.cancelControl().catch(() => {}); };
    context.signal.addEventListener("abort", signalListener, { once: true });
    let provisional: ProviderControlTerminalV1 | undefined;
    let primaryError: unknown;

    try {
      if (context.signal.aborted) {
        this.#cancelRequested = true;
      } else {
        await this.#acquireResources(context.request.operationID);
        if (!this.#cancelRequested) {
          const protocol = this.#runChildControlProtocol(context);
          this.#protocolSettled = protocol.then(() => {}, () => {});
          provisional = await protocol;
        }
      }
    } catch (cause) {
      primaryError = cause;
    }

    let containmentFailed = false;
    try {
      await this.#ensureTeardown();
    } catch (cause) {
      containmentFailed = true;
      primaryError = new DedicatedProviderSupervisorError(
        "containment_failed",
        "Dedicated Provider control containment could not be proven",
        primaryError === undefined
          ? { cause }
          : { cause: new AggregateError([primaryError, cause]) },
      );
    } finally {
      context.signal.removeEventListener("abort", signalListener);
    }

    if (this.#cancelRequested && !containmentFailed
      && (primaryError === undefined || isCancellationMarker(primaryError))) {
      this.#state = "complete";
      this.#resolveRun();
      return { status: "cancelled" };
    }
    if (primaryError !== undefined) {
      this.#state = "failed";
      this.#rejectRun(primaryError);
      throw normalizeSupervisorError(primaryError);
    }
    if (provisional === undefined) {
      const cause = new DedicatedProviderSupervisorError(
        "protocol_violation",
        "Provider control child stopped without a provisional result",
      );
      this.#state = "failed";
      this.#rejectRun(cause);
      throw cause;
    }
    this.#state = "complete";
    this.#resolveRun();
    return provisional;
  }

  public cancelControl(): Promise<void> {
    return this.cancel();
  }

  public cancel(): Promise<void> {
    this.#cancelRequested = true;
    const child = this.#child;
    if (child !== undefined && this.#startReleased && this.#state === "running") {
      this.#cancelWrite ??= this.#writeFrame(child, { type: "cancel" });
      void this.#cancelWrite.catch(() => {});
    }
    const teardown = this.#ensureTeardown();
    void teardown.catch(() => {});
    if (this.#runCompletion !== undefined) return this.#runCompletion;
    return teardown.then(
      () => {
        this.#state = "complete";
      },
      (cause: unknown) => {
        this.#state = "failed";
        throw normalizeSupervisorError(cause);
      },
    );
  }

  async #runChildProtocol(context: GuestProviderAttemptContextV1): Promise<AttemptTerminalV1> {
    const child = this.#requiredChild();
    const cgroup = this.#requiredCgroup();
    const decoder = new DedicatedProviderFrameDecoderV1();
    const events = new NormalizedEventLedgerV1(context.attempt.attemptID);
    const iterator = child.output[Symbol.asyncIterator]();
    this.#outputDecoder = decoder;
    this.#outputIterator = iterator;
    let phase: "awaiting_bootstrap" | "awaiting_inputs_ready" | "running" =
      "awaiting_bootstrap";
    let nextEventSequence = 1;

    for (;;) {
      if (this.#cancelRequested && phase !== "running") throw cancellationMarker();
      const next = await iterator.next();
      if (next.done) {
        decoder.finish();
        if (this.#cancelRequested) throw cancellationMarker();
        throw new DedicatedProviderSupervisorError(
          "protocol_violation",
          "Provider child output ended before its provisional terminal",
        );
      }
      const frames = decoder.push(next.value);
      for (let index = 0; index < frames.length; index += 1) {
        const frame = frames[index]!;
        if (phase === "awaiting_bootstrap") {
          if (frame.type !== "bootstrap_ready" || frames.length !== 1) {
            throw new DedicatedProviderSupervisorError(
              "bootstrap_failed",
              "Provider bootstrap emitted data before its containment gate",
            );
          }
          await cgroup.attachBootstrapPID(child.pid);
          await cgroup.verifyBootstrapPlacement(child.pid);
          if (this.#cancelRequested) throw cancellationMarker();
          if (this.#cancelRequested) throw cancellationMarker();
          await this.#sendCredential(child, context);
          phase = "awaiting_inputs_ready";
          continue;
        }

        if (phase === "awaiting_inputs_ready") {
          if (frame.type !== "bootstrap_inputs_ready") {
            throw new DedicatedProviderSupervisorError(
              "bootstrap_failed",
              "Provider bootstrap did not acknowledge its private input pipes",
            );
          }
          await this.#writeFrame(child, {
            type: "start",
            protocolVersion: DEDICATED_PROVIDER_PROTOCOL_VERSION,
            attempt: context.attempt,
          });
          this.#startReleased = true;
          this.#state = "running";
          phase = "running";
          continue;
        }

        if (frame.type === "event") {
          if (this.#cancelRequested
            && frame.event.kind !== "message_completed"
            && frame.event.kind !== "tool_completed") {
            throw new DedicatedProviderSupervisorError(
              "protocol_violation",
              "Provider emitted a non-closing event after cancellation",
            );
          }
          events.observe({
            ...frame.event,
            attemptID: context.attempt.attemptID,
            sequence: nextEventSequence,
          });
          nextEventSequence += 1;
          context.emit(frame.event);
          continue;
        }
        if (frame.type === "provisional_terminal") {
          if (index !== frames.length - 1) {
            throw new DedicatedProviderSupervisorError(
              "protocol_violation",
              "Provider emitted data after its provisional terminal",
            );
          }
          if (this.#cancelRequested && frame.terminal.kind !== "cancelled") {
            throw new DedicatedProviderSupervisorError(
              "protocol_violation",
              "Provider did not acknowledge cancellation",
            );
          }
          events.assertTerminal(frame.terminal);
          this.#provisionalTerminalObserved = true;
          return frame.terminal;
        }
        throw new DedicatedProviderSupervisorError(
          "protocol_violation",
          "Provider child emitted a frame in the wrong direction or phase",
        );
      }
    }
  }

  async #runChildControlProtocol(
    context: GuestProviderControlContextV1,
  ): Promise<ProviderControlTerminalV1> {
    const child = this.#requiredChild();
    const cgroup = this.#requiredCgroup();
    const decoder = new DedicatedProviderFrameDecoderV1();
    const iterator = child.output[Symbol.asyncIterator]();
    this.#outputDecoder = decoder;
    this.#outputIterator = iterator;
    let phase: "awaiting_bootstrap" | "awaiting_inputs_ready" | "running" =
      "awaiting_bootstrap";

    for (;;) {
      if (this.#cancelRequested && phase !== "running") throw cancellationMarker();
      const next = await iterator.next();
      if (next.done) {
        decoder.finish();
        if (this.#cancelRequested) throw cancellationMarker();
        throw new DedicatedProviderSupervisorError(
          "protocol_violation",
          "Provider control child output ended before its provisional result",
        );
      }
      const frames = decoder.push(next.value);
      for (let index = 0; index < frames.length; index += 1) {
        const frame = frames[index]!;
        if (phase === "awaiting_bootstrap") {
          if (frame.type !== "bootstrap_ready" || frames.length !== 1) {
            throw new DedicatedProviderSupervisorError(
              "bootstrap_failed",
              "Provider control bootstrap emitted data before its containment gate",
            );
          }
          await cgroup.attachBootstrapPID(child.pid);
          await cgroup.verifyBootstrapPlacement(child.pid);
          if (this.#cancelRequested) throw cancellationMarker();
          if (this.#cancelRequested) throw cancellationMarker();
          await this.#sendCredential(child, context);
          phase = "awaiting_inputs_ready";
          continue;
        }
        if (phase === "awaiting_inputs_ready") {
          if (frame.type !== "bootstrap_inputs_ready") {
            throw new DedicatedProviderSupervisorError(
              "bootstrap_failed",
              "Provider control bootstrap did not acknowledge private input pipes",
            );
          }
          await this.#writeFrame(child, {
            type: "start_control",
            protocolVersion: DEDICATED_PROVIDER_PROTOCOL_VERSION,
            request: context.request,
          });
          this.#startReleased = true;
          this.#state = "running";
          phase = "running";
          continue;
        }
        if (frame.type === "provisional_control_result") {
          if (index !== frames.length - 1) {
            throw new DedicatedProviderSupervisorError(
              "protocol_violation",
              "Provider emitted data after its provisional control result",
            );
          }
          if (this.#cancelRequested && frame.terminal.status !== "cancelled") {
            throw new DedicatedProviderSupervisorError(
              "protocol_violation",
              "Provider control did not acknowledge cancellation",
            );
          }
          assertMatchingProviderControlTerminalV1(context.request, frame.terminal);
          this.#provisionalTerminalObserved = true;
          return frame.terminal;
        }
        throw new DedicatedProviderSupervisorError(
          "protocol_violation",
          "Provider control child emitted a frame in the wrong direction or phase",
        );
      }
    }
  }

  async #sendCredential(
    child: DedicatedProviderChildV1,
    context: Pick<GuestProviderAttemptContextV1, "credential" | "signal">,
  ): Promise<void> {
    let credential: Buffer | undefined;
    let consumed: Uint8Array | undefined;
    if (context.credential !== null) {
      if (!Number.isSafeInteger(context.credential.byteLength)
        || context.credential.byteLength <= 0
        || context.credential.byteLength > DEDICATED_PROVIDER_MAX_CREDENTIAL_BYTES) {
        throw new DedicatedProviderSupervisorError(
          "credential_invalid",
          "Opaque credential is outside its internal transport bound",
        );
      }
      consumed = context.credential.consume();
      credential = Buffer.from(consumed);
      consumed.fill(0);
      if (credential.byteLength !== context.credential.byteLength) {
        credential.fill(0);
        throw new DedicatedProviderSupervisorError(
          "credential_invalid",
          "Opaque credential is outside its internal transport bound",
        );
      }
    }
    let encoding: DedicatedProviderCredentialEncodingV1 | undefined;
    try {
      encoding = new DedicatedProviderCredentialEncodingV1(credential ?? null);
      const packet = encoding.provide();
      try {
        await child.writeCredential(packet);
      } finally {
        encoding.clear();
      }
      if (this.#cancelRequested) throw cancellationMarker();
      await child.closeCredential();
    } finally {
      encoding?.clear();
      consumed?.fill(0);
      credential?.fill(0);
    }
  }

  async #writeFrame(
    child: DedicatedProviderChildV1,
    frame: DedicatedProviderFrameV1,
  ): Promise<void> {
    const encoded = encodeDedicatedProviderFrameV1(frame);
    try {
      await child.writeControl(encoded);
    } finally {
      encoded.fill(0);
    }
  }

  #ensureTeardown(): Promise<void> {
    if (this.#teardownPromise !== undefined) return this.#teardownPromise;
    this.#teardownPromise = this.#teardown();
    return this.#teardownPromise;
  }

  async #acquireResources(scopeID: string): Promise<void> {
    const acquisition = (async () => {
      const cgroup = await this.#cgroups.create(scopeID);
      this.#cgroup = cgroup;
      if (this.#cancelRequested) return;
      const child = await this.#spawn.spawnBootstrap();
      this.#child = child;
    })();
    // Teardown waits for adoption, not for acquisition success. The original
    // rejection remains the run's primary failure and must not be reclassified
    // as cleanup uncertainty after acquired resources were cleaned correctly.
    this.#acquisitionSettled = acquisition.then(() => {}, () => {});
    await acquisition;
  }

  async #teardown(): Promise<void> {
    this.#state = "quiescing";
    const errors: unknown[] = [];

    // Cancellation may race either async acquisition. Do not snapshot resource
    // fields until the acquisition has settled and any late resource has been
    // adopted by this supervisor.
    if (this.#acquisitionSettled !== undefined) {
      await this.#acquisitionSettled;
    }
    const child = this.#child;
    const cgroup = this.#cgroup;

    if (child !== undefined) {
      if (this.#cancelWrite !== undefined) {
        await withTimeout(
          this.#cancelWrite,
          this.#terminateGraceMilliseconds,
          "Cooperative Provider cancel did not settle",
        ).catch(() => {});
        // Once network authority is gone, give a cooperative Adapter one
        // bounded chance to close already-open normalized lifecycle objects and
        // acknowledge cancellation. No new content event is admitted above.
        if (this.#protocolSettled !== undefined && !this.#provisionalTerminalObserved) {
          await withTimeout(
            this.#protocolSettled,
            this.#terminateGraceMilliseconds,
            "Cooperative Provider cancellation did not settle",
          ).catch(() => {});
        }
      }
      await collectFailure(errors, () => child.closeCredential());
      await collectFailure(errors, () => child.revokeInput());
      await collectFailure(errors, () => child.terminate("SIGTERM"));
    }
    await collectFailure(errors, () => this.#time.sleep(this.#terminateGraceMilliseconds));
    if (cgroup !== undefined) {
      await collectFailure(errors, () => cgroup.killAll());
    }
    if (child !== undefined) {
      let outputReleased = false;
      if (this.#protocolSettled !== undefined) {
        try {
          await withTimeout(
            this.#protocolSettled,
            this.#outputDrainTimeoutMilliseconds,
            "Provider protocol reader did not stop after cgroup kill",
          );
        } catch (cause) {
          errors.push(cause);
          await collectFailure(errors, () => child.releaseOutput());
          outputReleased = true;
          await collectFailure(errors, () => withTimeout(
            this.#protocolSettled!,
            this.#outputDrainTimeoutMilliseconds,
            "Provider protocol reader remained live after output revocation",
          ));
        }
      }
      if (!outputReleased) {
        await collectFailure(errors, () => this.#drainChildOutput(child));
        await collectFailure(errors, () => child.releaseOutput());
      }
    }
    if (child !== undefined) {
      await collectFailure(errors, async () => {
        const receipt = await child.waitForExit(this.#reapTimeoutMilliseconds);
        if (!receipt.reaped) {
          throw new DedicatedProviderSupervisorError(
            "containment_failed",
            "Provider bootstrap leader was not reaped",
          );
        }
        const expectedExit = (receipt.exitCode === 0 && receipt.signal === null)
          || (receipt.exitCode === null
            && (receipt.signal === "SIGTERM" || receipt.signal === "SIGKILL"));
        if (!expectedExit) {
          throw new DedicatedProviderSupervisorError(
            "containment_failed",
            "Provider bootstrap exit disagreed with controlled teardown",
          );
        }
      });
    }
    if (cgroup !== undefined) {
      await collectFailure(errors, () => this.#waitForEmptyCgroup(cgroup));
    }
    if (cgroup !== undefined) {
      await collectFailure(errors, () => cgroup.remove());
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, "Dedicated Provider teardown failed");
    }
  }

  async #waitForEmptyCgroup(cgroup: DedicatedProviderCgroupLeaseV1): Promise<void> {
    const started = this.#time.nowMilliseconds();
    if (!Number.isSafeInteger(started) || started < 0) {
      throw new DedicatedProviderSupervisorError("containment_failed", "Supervisor clock is invalid");
    }
    for (;;) {
      if (!await cgroup.isPopulated()) return;
      const now = this.#time.nowMilliseconds();
      if (!Number.isSafeInteger(now)
        || now < started
        || now - started >= this.#cgroupEmptyTimeoutMilliseconds) {
        throw new DedicatedProviderSupervisorError(
          "containment_failed",
          "Dedicated Provider cgroup did not become empty",
        );
      }
      await this.#time.sleep(this.#cgroupPollMilliseconds);
    }
  }

  async #drainChildOutput(child: DedicatedProviderChildV1): Promise<void> {
    const iterator = this.#outputIterator ?? child.output[Symbol.asyncIterator]();
    const decoder = this.#outputDecoder ?? new DedicatedProviderFrameDecoderV1();
    for (;;) {
      const next = await withTimeout(
        iterator.next(),
        this.#outputDrainTimeoutMilliseconds,
        "Provider child output did not reach EOF after cgroup kill",
      );
      if (next.done) {
        if (this.#provisionalTerminalObserved) decoder.finish();
        return;
      }
      if (this.#provisionalTerminalObserved && next.value.byteLength > 0) {
        throw new DedicatedProviderSupervisorError(
          "protocol_violation",
          "Provider emitted bytes after its provisional terminal",
        );
      }
    }
  }

  #requiredChild(): DedicatedProviderChildV1 {
    if (this.#child === undefined) {
      throw new DedicatedProviderSupervisorError("invalid_state", "Provider child is unavailable");
    }
    return this.#child;
  }

  #requiredCgroup(): DedicatedProviderCgroupLeaseV1 {
    if (this.#cgroup === undefined) {
      throw new DedicatedProviderSupervisorError("invalid_state", "Provider cgroup is unavailable");
    }
    return this.#cgroup;
  }
}

async function collectFailure(
  errors: unknown[],
  operation: () => void | Promise<void>,
): Promise<void> {
  try {
    await operation();
  } catch (cause) {
    errors.push(cause);
  }
}

function positiveBound(value: number | undefined, fallback: number, name: string): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected <= 0 || selected > 60_000) {
    throw new TypeError(`${name} must be a positive bounded integer`);
  }
  return selected;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DedicatedProviderSupervisorError(
      "containment_failed",
      message,
    )), milliseconds);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

function cancellationMarker(): DedicatedProviderSupervisorError {
  return new DedicatedProviderSupervisorError("cancelled", "Provider operation was cancelled");
}

function isCancellationMarker(cause: unknown): boolean {
  return cause instanceof DedicatedProviderSupervisorError && cause.code === "cancelled";
}

function normalizeSupervisorError(cause: unknown): DedicatedProviderSupervisorError {
  if (cause instanceof DedicatedProviderSupervisorError) return cause;
  return new DedicatedProviderSupervisorError(
    "protocol_violation",
    "Dedicated Provider child failed before quiescence",
    { cause },
  );
}

export type DedicatedProviderSupervisorErrorCode =
  | "invalid_state"
  | "bootstrap_failed"
  | "protocol_violation"
  | "credential_invalid"
  | "cancelled"
  | "containment_failed";

export class DedicatedProviderSupervisorError extends Error {
  public constructor(
    public readonly code: DedicatedProviderSupervisorErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "DedicatedProviderSupervisorError";
  }
}
