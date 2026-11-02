import { randomUUID } from "node:crypto";

import {
  BoundedTahHostOperationSchedulerV1,
  TahHostOperationSchedulerErrorV1,
} from "../host/operation-scheduler.js";
import {
  NodeSuperBoxChildTransportError,
  SUPERBOX_MAX_CREDENTIAL_DECODED_BYTES,
  SuperBoxProcessClientError,
  inspectSealedSuperBoxManifestIdentityV1,
  type SuperBoxNodeLaunchPolicyV1,
} from "../superbox/index.js";
import {
  assertMatchingProviderControlTerminalV1,
  parseProviderControlTerminalV1,
  TAH_PROVIDER_CONTROL_VERSION,
  type ProviderControlRequestV1,
  type ProviderControlTerminalV1,
} from "./contract.js";
import {
  runSuperBoxNodeProviderControlV1,
  type RunSuperBoxNodeProviderControlV1,
} from "./node-operation.js";

export type TahProviderControlOperationKindV1 = ProviderControlRequestV1["kind"];

export interface TahProviderControlPortV1 {
  run(
    providerID: string,
    kind: TahProviderControlOperationKindV1,
    signal?: AbortSignal,
  ): Promise<TahProviderControlHostReceiptV1>;
}

export interface TahProviderControlHostReceiptV1 {
  /** Host-authoritative value from the digest-pinned sealed manifest. */
  readonly attemptQualification: "qualified" | "unverified" | "no_go" | null;
  readonly terminal: ProviderControlTerminalV1;
}

export interface TahProviderControlApplianceRouteV1 {
  readonly providerID: string;
  readonly applianceID: string;
  readonly launch: SuperBoxNodeLaunchPolicyV1;
}

/** Returns fresh mutable bytes and transfers their ownership to the caller. */
export interface TahProviderControlCredentialSourceV1 {
  /** Trusted Host port: must settle promptly on `signal` abort and retain no borrowed bytes. */
  takeCredentialEnvelope(providerID: string, signal?: AbortSignal): Promise<Uint8Array | null>;
}

export interface SuperBoxTahProviderControlPortOptionsV1 {
  readonly appliances: readonly TahProviderControlApplianceRouteV1[];
  readonly credentials: TahProviderControlCredentialSourceV1;
  /** Must be the exact global scheduler also used by Action attempts. */
  readonly scheduler: BoundedTahHostOperationSchedulerV1;
  readonly operationRunner?: (
    request: RunSuperBoxNodeProviderControlV1,
  ) => Promise<ProviderControlTerminalV1>;
  readonly manifestInspector?: typeof inspectSealedSuperBoxManifestIdentityV1;
  readonly nextOperationID?: () => string;
}

/** Provider-neutral Host route for read-only supporting operations. */
export class SuperBoxTahProviderControlPortV1 implements TahProviderControlPortV1 {
  readonly #routes: ReadonlyMap<string, TahProviderControlApplianceRouteV1>;
  readonly #credentials: TahProviderControlCredentialSourceV1;
  readonly #scheduler: BoundedTahHostOperationSchedulerV1;
  readonly #runner: (
    request: RunSuperBoxNodeProviderControlV1,
  ) => Promise<ProviderControlTerminalV1>;
  readonly #inspectManifest: typeof inspectSealedSuperBoxManifestIdentityV1;
  readonly #nextOperationID: () => string;

  public constructor(options: SuperBoxTahProviderControlPortOptionsV1) {
    this.#routes = routeRegistry(options.appliances);
    if (options.credentials === null
      || typeof options.credentials !== "object"
      || typeof options.credentials.takeCredentialEnvelope !== "function"
      || !(options.scheduler instanceof BoundedTahHostOperationSchedulerV1)) {
      throw new TypeError("Provider control Host composition is invalid");
    }
    this.#credentials = options.credentials;
    this.#scheduler = options.scheduler;
    this.#runner = options.operationRunner ?? runSuperBoxNodeProviderControlV1;
    this.#inspectManifest = options.manifestInspector ?? inspectSealedSuperBoxManifestIdentityV1;
    this.#nextOperationID = options.nextOperationID ?? (() => randomUUID().toLowerCase());
  }

  public async run(
    providerID: string,
    kind: TahProviderControlOperationKindV1,
    signal?: AbortSignal,
  ): Promise<TahProviderControlHostReceiptV1> {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(providerID)
      || (kind !== "describe"
        && kind !== "inspect_authentication"
        && kind !== "list_inference_catalog")) {
      return hostReceipt(null, configurationFailure());
    }
    if (signal?.aborted) return hostReceipt(null, { status: "cancelled" });
    const route = this.#routes.get(providerID);
    if (route === undefined) return hostReceipt(null, configurationFailure());

    try {
      return await this.#scheduler.schedule({
        // Auth/catalog may consume the full bounded envelope. Reserving before
        // dequeue means credential I/O can never escape global admission.
        declaredInputBytes: kind === "describe" ? 0 : SUPERBOX_MAX_CREDENTIAL_DECODED_BYTES,
        ...(signal === undefined ? {} : { signal }),
        run: (scheduledSignal) => this.#runWithAbsoluteDeadline(
          route,
          kind,
          scheduledSignal,
        ),
      });
    } catch (cause) {
      if (cause instanceof TahProviderControlIntegrityErrorV1) throw cause;
      if (cause instanceof TahHostOperationSchedulerErrorV1) {
        return hostReceipt(
          null,
          cause.code === "cancelled" ? { status: "cancelled" } : resourceFailure(),
        );
      }
      return hostReceipt(null, providerUnavailableFailure());
    }
  }

  async #runWithAbsoluteDeadline(
    route: TahProviderControlApplianceRouteV1,
    kind: TahProviderControlOperationKindV1,
    scheduledSignal: AbortSignal,
  ): Promise<TahProviderControlHostReceiptV1> {
    const operationAbort = new AbortController();
    let deadlineExpired = false;
    const onScheduledAbort = (): void => operationAbort.abort();
    if (scheduledSignal.aborted) operationAbort.abort();
    else scheduledSignal.addEventListener("abort", onScheduledAbort, { once: true });
    const timer = setTimeout(() => {
      deadlineExpired = true;
      operationAbort.abort();
    }, 5 * 60_000);
    timer.unref();
    try {
      const receipt = await this.#runScheduled(route, kind, operationAbort.signal);
      if (deadlineExpired && !scheduledSignal.aborted) {
        return hostReceipt(receipt.attemptQualification, controlTimeoutFailure());
      }
      return receipt;
    } finally {
      clearTimeout(timer);
      scheduledSignal.removeEventListener("abort", onScheduledAbort);
    }
  }

  async #runScheduled(
    route: TahProviderControlApplianceRouteV1,
    kind: TahProviderControlOperationKindV1,
    signal: AbortSignal,
  ): Promise<TahProviderControlHostReceiptV1> {
    let credential: Buffer | undefined;
    let qualification: TahProviderControlHostReceiptV1["attemptQualification"] = null;
    try {
      const identity = await this.#inspectManifest(route.launch.sealedManifest);
      if (identity.attemptQualification !== "qualified"
        && identity.attemptQualification !== "unverified"
        && identity.attemptQualification !== "no_go") {
        return hostReceipt(null, policyFailure());
      }
      qualification = identity.attemptQualification;
      // Read-only inspection remains useful for unverified/no-go attempt
      // appliances, but routing identity is still fail-closed.
      if (identity.providerID !== route.providerID || identity.applianceID !== route.applianceID) {
        return hostReceipt(null, policyFailure());
      }
      if (kind !== "describe" && qualification !== "qualified") {
        // attemptQualification covers the complete appliance, including
        // credential isolation. Product control never uses a durable vault
        // credential as a qualification probe.
        return hostReceipt(qualification, credentialQualificationFailure());
      }
      if (signal.aborted) return hostReceipt(qualification, { status: "cancelled" });
      if (kind !== "describe") {
        const transferred = await this.#credentials.takeCredentialEnvelope(route.providerID, signal);
        if (transferred !== null) {
          if (!(transferred instanceof Uint8Array)
            || transferred.byteLength === 0
            || transferred.byteLength > SUPERBOX_MAX_CREDENTIAL_DECODED_BYTES) {
            if (transferred instanceof Uint8Array) transferred.fill(0);
            return hostReceipt(qualification, policyFailure());
          }
          credential = Buffer.from(transferred);
          transferred.fill(0);
        }
      }
      if (signal.aborted) return hostReceipt(qualification, { status: "cancelled" });

      const operationID = this.#operationID(this.#nextOperationID());
      const request: ProviderControlRequestV1 = Object.freeze({
        controlVersion: TAH_PROVIDER_CONTROL_VERSION,
        operationID,
        providerID: route.providerID,
        kind,
      });
      const terminal = parseProviderControlTerminalV1(await this.#runner({
        launch: route.launch,
        operation: {
          operationID,
          request,
          ...(credential === undefined ? {} : { credentialEnvelope: credential }),
          timeoutMilliseconds: 5 * 60_000,
          signal,
        },
      }));
      assertMatchingProviderControlTerminalV1(request, terminal);
      return hostReceipt(qualification, terminal);
    } catch (cause) {
      if (isCleanupUncertain(cause)) throw new TahProviderControlIntegrityErrorV1();
      if (cause instanceof SuperBoxProcessClientError && cause.code === "cancelled") {
        return hostReceipt(qualification, { status: "cancelled" });
      }
      return hostReceipt(qualification, providerUnavailableFailure());
    } finally {
      credential?.fill(0);
    }
  }

  #operationID(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value)) throw new TypeError("Provider control operation identity is invalid");
    return value;
  }

}

/** Success is forbidden when whole-runtime destruction cannot be proven. */
export class TahProviderControlIntegrityErrorV1 extends Error {
  public constructor() {
    super("Provider control VM cleanup could not be confirmed");
    this.name = "TahProviderControlIntegrityErrorV1";
  }
}

function routeRegistry(
  routes: readonly TahProviderControlApplianceRouteV1[],
): ReadonlyMap<string, TahProviderControlApplianceRouteV1> {
  if (!Array.isArray(routes) || routes.length === 0 || routes.length > 32) {
    throw new TypeError("Provider control route registry is invalid");
  }
  const result = new Map<string, TahProviderControlApplianceRouteV1>();
  for (const route of routes) {
    if (route === null || typeof route !== "object"
      || !/^[a-z][a-z0-9_-]{0,63}$/u.test(route.providerID)
      || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(route.applianceID)
      || route.launch === null || typeof route.launch !== "object"
      || route.launch.hostExecutable === null
      || typeof route.launch.hostExecutable !== "object"
      || route.launch.sealedManifest === null
      || typeof route.launch.sealedManifest !== "object"
      || result.has(route.providerID)) {
      throw new TypeError("Provider control route is invalid or duplicated");
    }
    result.set(route.providerID, Object.freeze({
      providerID: route.providerID,
      applianceID: route.applianceID,
      launch: Object.freeze({
        ...route.launch,
        hostExecutable: Object.freeze({ ...route.launch.hostExecutable }),
        sealedManifest: Object.freeze({ ...route.launch.sealedManifest }),
      }),
    }));
  }
  return result;
}

function hostReceipt(
  attemptQualification: TahProviderControlHostReceiptV1["attemptQualification"],
  terminal: ProviderControlTerminalV1,
): TahProviderControlHostReceiptV1 {
  const ownedTerminal = structuredClone(terminal) as ProviderControlTerminalV1;
  deepFreeze(ownedTerminal);
  return Object.freeze({ attemptQualification, terminal: ownedTerminal });
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function isCleanupUncertain(cause: unknown): boolean {
  return (cause instanceof SuperBoxProcessClientError
      && (cause.code === "cleanup_failed"
        || cause.code === "destruction_unconfirmed"
        || (cause.code === "guest_fatal" && cause.guestFatalCode === "cleanup_failed")))
    || (cause instanceof NodeSuperBoxChildTransportError && cause.code === "destroy_failed");
}

function configurationFailure(): ProviderControlTerminalV1 {
  return Object.freeze({
    status: "failed",
    failure: Object.freeze({
      family: "configuration",
      code: "provider_control_route_unavailable",
      retryable: false,
      message: "The selected Provider is unavailable in this build.",
    }),
  });
}

function policyFailure(): ProviderControlTerminalV1 {
  return Object.freeze({
    status: "failed",
    failure: Object.freeze({
      family: "policy",
      code: "provider_control_composition_untrusted",
      retryable: false,
      message: "The selected Provider appliance could not be verified.",
    }),
  });
}

function credentialQualificationFailure(): ProviderControlTerminalV1 {
  return Object.freeze({
    status: "failed",
    failure: Object.freeze({
      family: "policy",
      code: "provider_credential_isolation_unqualified",
      retryable: false,
      message: "This Provider appliance is not qualified to receive account credentials.",
    }),
  });
}

function resourceFailure(): ProviderControlTerminalV1 {
  return Object.freeze({
    status: "failed",
    failure: Object.freeze({
      family: "resource",
      code: "provider_control_capacity_unavailable",
      retryable: true,
      message: "Provider inspection is temporarily at capacity.",
    }),
  });
}

function providerUnavailableFailure(): ProviderControlTerminalV1 {
  return Object.freeze({
    status: "failed",
    failure: Object.freeze({
      family: "provider_availability",
      code: "provider_control_unavailable",
      retryable: true,
      message: "Provider inspection could not finish.",
    }),
  });
}

function controlTimeoutFailure(): ProviderControlTerminalV1 {
  return Object.freeze({
    status: "failed",
    failure: Object.freeze({
      family: "provider_availability",
      code: "provider_control_timed_out",
      retryable: true,
      message: "Provider inspection timed out.",
    }),
  });
}
