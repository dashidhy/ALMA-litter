import { randomUUID } from "node:crypto";

import type {
  NormalizedEventV1,
  TahAttemptResultV1,
} from "../contract/index.js";
import {
  TahAttemptExecutionErrorV1,
  type BuiltAttemptV1,
  type TahFrameworkAttemptPortV1,
} from "../framework/index.js";
import {
  NodeSuperBoxChildTransportError,
  SUPERBOX_MAX_CREDENTIAL_DECODED_BYTES,
  SuperBoxProcessClientError,
  inspectSealedSuperBoxManifestIdentityV1,
  runSuperBoxNodeOperationV1,
  type RunSuperBoxNodeOperationV1,
  type SuperBoxNodeLaunchPolicyV1,
  type SuperBoxTransportReadyResultV1,
} from "../superbox/index.js";

export interface TahSuperBoxApplianceRouteV1 {
  readonly providerID: string;
  readonly applianceID: string;
  readonly launch: SuperBoxNodeLaunchPolicyV1;
}

/**
 * Transfers ownership of one opaque credential envelope to the caller.
 * Implementations must return fresh mutable bytes; this port clears them.
 */
export interface TahCredentialEnvelopeSourceV1 {
  takeCredentialEnvelope(
    providerID: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array | null>;
}

export interface SuperBoxTahAttemptPortOptionsV1 {
  readonly appliances: readonly TahSuperBoxApplianceRouteV1[];
  readonly credentials: TahCredentialEnvelopeSourceV1;
  readonly operationRunner?: (
    request: RunSuperBoxNodeOperationV1,
  ) => Promise<SuperBoxTransportReadyResultV1>;
  readonly nextOperationID?: () => string;
  readonly manifestInspector?: typeof inspectSealedSuperBoxManifestIdentityV1;
}

/**
 * The sole Framework -> whole-runtime SuperBox composition seam.
 *
 * Provider identity selects sealed appliance metadata only. No Provider module,
 * SDK, method, tool name or error shape is visible to this Host component.
 */
export class SuperBoxTahAttemptPortV1 implements TahFrameworkAttemptPortV1 {
  readonly #appliances: ReadonlyMap<string, TahSuperBoxApplianceRouteV1>;
  readonly #credentials: TahCredentialEnvelopeSourceV1;
  readonly #operationRunner: (
    request: RunSuperBoxNodeOperationV1,
  ) => Promise<SuperBoxTransportReadyResultV1>;
  readonly #nextOperationID: () => string;
  readonly #manifestInspector: typeof inspectSealedSuperBoxManifestIdentityV1;

  public constructor(options: SuperBoxTahAttemptPortOptionsV1) {
    this.#appliances = applianceRegistry(options.appliances);
    if (options.credentials === null
      || typeof options.credentials !== "object"
      || typeof options.credentials.takeCredentialEnvelope !== "function") {
      throw new TypeError("TAH credential source is invalid");
    }
    this.#credentials = options.credentials;
    this.#operationRunner = options.operationRunner ?? runSuperBoxNodeOperationV1;
    this.#nextOperationID = options.nextOperationID ?? (() => randomUUID().toLowerCase());
    this.#manifestInspector = options.manifestInspector
      ?? inspectSealedSuperBoxManifestIdentityV1;
  }

  public async run(
    built: BuiltAttemptV1,
    onEvent?: (event: NormalizedEventV1) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<TahAttemptResultV1> {
    if (signal?.aborted) throw executionFailure("cancelled");
    const route = this.#appliances.get(built.attempt.providerID);
    if (route === undefined) throw executionFailure("unavailable");
    return this.#runAdmitted(built, route, onEvent, signal);
  }

  async #runAdmitted(
    built: BuiltAttemptV1,
    route: TahSuperBoxApplianceRouteV1,
    onEvent: ((event: NormalizedEventV1) => void | Promise<void>) | undefined,
    signal: AbortSignal | undefined,
  ): Promise<TahAttemptResultV1> {
    let credential: Buffer | undefined;
    try {
      const identity = await this.#manifestInspector(route.launch.sealedManifest);
      if (identity.providerID !== route.providerID
        || identity.applianceID !== route.applianceID
        || identity.attemptQualification !== "qualified") {
        throw executionFailure("unavailable");
      }
      credential = await this.#takeCredential(built.attempt.providerID, signal);
      if (signal?.aborted) throw executionFailure("cancelled");
      const operationID = this.#validatedOperationID(this.#nextOperationID());

      const result = await this.#operationRunner({
        launch: route.launch,
        operation: {
          operationID,
          attempt: built.attempt,
          materialBytes: built.inputBytes,
          ...(credential === undefined ? {} : { credentialEnvelope: credential }),
          ...(onEvent === undefined ? {} : { onEvent }),
          ...(signal === undefined ? {} : { signal }),
        },
      });
      return Object.freeze({
        terminal: result.terminal,
        candidateManifest: Object.freeze(
          result.quarantinedCandidateManifest.map((entry) => Object.freeze({ ...entry })),
        ),
        candidateFiles: new Map(result.quarantinedCandidates),
      });
    } catch (cause) {
      throw normalizeExecutionFailure(cause, signal);
    } finally {
      credential?.fill(0);
    }
  }

  async #takeCredential(providerID: string, signal?: AbortSignal): Promise<Buffer | undefined> {
    let transferred: Uint8Array | null;
    try {
      transferred = await this.#credentials.takeCredentialEnvelope(providerID, signal);
    } catch (cause) {
      throw normalizeExecutionFailure(cause, signal);
    }
    if (transferred === null) return undefined;
    if (!(transferred instanceof Uint8Array)
      || transferred.byteLength === 0
      || transferred.byteLength > SUPERBOX_MAX_CREDENTIAL_DECODED_BYTES) {
      if (transferred instanceof Uint8Array) transferred.fill(0);
      throw executionFailure("unavailable");
    }
    const owned = Buffer.from(transferred);
    transferred.fill(0);
    return owned;
  }

  #validatedOperationID(value: string): string {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value)) {
      throw executionFailure("unavailable");
    }
    return value;
  }
}

function applianceRegistry(
  values: readonly TahSuperBoxApplianceRouteV1[],
): ReadonlyMap<string, TahSuperBoxApplianceRouteV1> {
  if (!Array.isArray(values) || values.length === 0 || values.length > 32) {
    throw new TypeError("TAH appliance registry must contain one to 32 routes");
  }
  const result = new Map<string, TahSuperBoxApplianceRouteV1>();
  for (const value of values) {
    if (value === null
      || typeof value !== "object"
      || !/^[a-z][a-z0-9_-]{0,63}$/u.test(value.providerID)
      || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(value.applianceID)
      || value.launch === null
      || typeof value.launch !== "object"
      || value.launch.hostExecutable === null
      || typeof value.launch.hostExecutable !== "object"
      || value.launch.sealedManifest === null
      || typeof value.launch.sealedManifest !== "object"
      || result.has(value.providerID)) {
      throw new TypeError("TAH appliance route is invalid or duplicated");
    }
    result.set(value.providerID, Object.freeze({
      providerID: value.providerID,
      applianceID: value.applianceID,
      launch: Object.freeze({
        ...value.launch,
        hostExecutable: Object.freeze({ ...value.launch.hostExecutable }),
        sealedManifest: Object.freeze({ ...value.launch.sealedManifest }),
      }),
    }));
  }
  return result;
}

function normalizeExecutionFailure(
  cause: unknown,
  signal?: AbortSignal,
): TahAttemptExecutionErrorV1 {
  if (cause instanceof TahAttemptExecutionErrorV1) return cause;
  if (cause instanceof SuperBoxProcessClientError) {
    if (cause.code === "cleanup_failed"
      || cause.code === "destruction_unconfirmed"
      || (cause.code === "guest_fatal" && cause.guestFatalCode === "cleanup_failed")) {
      return executionFailure("cleanup_unconfirmed");
    }
    if (cause.code === "cancelled") return executionFailure("cancelled");
  }
  if (cause instanceof NodeSuperBoxChildTransportError && cause.code === "destroy_failed") {
    return executionFailure("cleanup_unconfirmed");
  }
  if (signal?.aborted) return executionFailure("cancelled");
  return executionFailure("unavailable");
}

function executionFailure(
  category: TahAttemptExecutionErrorV1["category"],
): TahAttemptExecutionErrorV1 {
  return new TahAttemptExecutionErrorV1(category);
}
