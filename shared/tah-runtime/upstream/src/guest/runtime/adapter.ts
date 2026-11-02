import type {
  AttemptTerminalV1,
  FrozenAttemptV1,
  NormalizedEventV1,
} from "../../contract/index.js";

export type GuestNormalizedEventInputV1 =
  NormalizedEventV1 extends infer Event
    ? Event extends NormalizedEventV1
      ? Omit<Event, "attemptID" | "sequence">
      : never
    : never;

export interface GuestLogicalMaterialV1 {
  readonly relativePath: string;
  readonly mediaType: "text/plain" | "application/json";
  readonly byteLength: number;
}

/**
 * Logical Guest-local workspace view. It deliberately exposes no physical
 * Host/Guest path and is not a model tool API. Native appliances implement a
 * shared filesystem materialization backend behind this interface rather than
 * adding a path to the Adapter contract.
 */
export interface GuestLogicalWorkspaceV1 {
  listMaterials(): readonly GuestLogicalMaterialV1[];
  readMaterial(relativePath: string): Uint8Array;
  putCandidate(relativePath: string, bytes: Uint8Array): void;
}

/** One-shot opaque credential transport; its bytes have no core-visible type. */
export interface GuestOpaqueCredentialHandleV1 {
  readonly byteLength: number;
  consume(): Uint8Array;
}

export interface GuestProviderAttemptContextV1 {
  readonly attempt: FrozenAttemptV1;
  readonly workspace: GuestLogicalWorkspaceV1;
  readonly credential: GuestOpaqueCredentialHandleV1 | null;
  readonly emit: (event: GuestNormalizedEventInputV1) => void;
  readonly signal: AbortSignal;
}

/**
 * Child-side implementation for one selected Provider. Production Host-facing
 * Guest execution must wrap this implementation in the dedicated cgroup
 * supervisor; direct in-process execution is fixture-only.
 */
export interface GuestProviderAdapterV1 {
  /**
   * Resolves only after the native turn and every model-controlled tool effect
   * have quiesced. A Provider that cannot establish that fact must return a
   * cleanup failure; candidate collection starts only after this Promise.
   */
  run(context: GuestProviderAttemptContextV1): Promise<AttemptTerminalV1>;
  cancel(): Promise<void>;
}
