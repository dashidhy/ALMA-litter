import { createHash } from "node:crypto";

import {
  compareCanonicalUTF8V1,
  isCanonicalUTF8V1,
  type FrozenAttemptV1,
} from "../../contract/index.js";
import {
  SUPERBOX_MAX_CANDIDATE_FILES,
  SUPERBOX_MAX_TOTAL_CANDIDATE_BYTES,
} from "../../superbox/operation.js";
import type {
  GuestLogicalMaterialV1,
  GuestLogicalWorkspaceV1,
} from "./adapter.js";

export type GuestCandidateSnapshotV1 =
  | Readonly<{
      kind: "directory";
      relativePath: string;
    }>
  | Readonly<{
      kind: "file";
      relativePath: string;
      bytes: Uint8Array;
    }>;

/**
 * Semantic-core fixture backend only. A real native Provider appliance still
 * needs a shared Guest-filesystem materialization backend behind this same
 * logical interface; that backend owns Guest paths internally and must not add
 * a physical-path field to `GuestLogicalWorkspaceV1`.
 */
export class InMemoryGuestLogicalWorkspaceV1 implements GuestLogicalWorkspaceV1 {
  readonly #materials: ReadonlyMap<string, {
    readonly descriptor: GuestLogicalMaterialV1;
    readonly bytes: Uint8Array;
  }>;
  readonly #writableRoots: readonly string[];
  readonly #candidates = new Map<string, Uint8Array>();
  readonly #candidateDirectories = new Set<string>();
  #candidateBytes = 0;

  public constructor(
    attempt: FrozenAttemptV1,
    readMaterial: (relativePath: string) => Uint8Array,
  ) {
    this.#writableRoots = attempt.workspace.writableRoots;
    this.#materials = new Map(attempt.workspace.materials.map((material) => {
      const bytes = Uint8Array.from(readMaterial(material.relativePath));
      if (bytes.byteLength !== material.byteLength || sha256(bytes) !== material.sha256) {
        throw new GuestWorkspaceError("material bytes disagree with the frozen attempt");
      }
      return [material.relativePath, {
        descriptor: Object.freeze({
          relativePath: material.relativePath,
          mediaType: material.mediaType,
          byteLength: material.byteLength,
        }),
        bytes,
      }];
    }));
    for (const seed of attempt.workspace.candidateSeeds) {
      if (seed.kind === "directory") {
        this.#candidateDirectories.add(seed.relativePath);
        continue;
      }
      const bytes = Uint8Array.from(readMaterial(seed.relativePath));
      if (bytes.byteLength !== seed.byteLength || sha256(bytes) !== seed.sha256) {
        throw new GuestWorkspaceError("candidate seed bytes disagree with the frozen attempt");
      }
      this.#candidates.set(seed.relativePath, bytes);
      this.#recordCandidateAncestors(seed.relativePath);
      this.#candidateBytes += bytes.byteLength;
    }
  }

  public listMaterials(): readonly GuestLogicalMaterialV1[] {
    return Object.freeze(
      [...this.#materials.values()]
        .map(({ descriptor }) => descriptor)
        .sort((left, right) =>
          compareCanonicalUTF8V1(left.relativePath, right.relativePath)
        ),
    );
  }

  public readMaterial(relativePath: string): Uint8Array {
    const material = this.#materials.get(relativePath);
    if (material === undefined) throw new GuestWorkspaceError("material was not declared");
    return Uint8Array.from(material.bytes);
  }

  public putCandidate(relativePath: string, bytes: Uint8Array): void {
    assertPortableRelativePath(relativePath);
    if (!isWithinWritableScope(relativePath, this.#writableRoots)) {
      throw new GuestWorkspaceError("candidate path is outside the frozen writable scope");
    }
    const previous = this.#candidates.get(relativePath);
    if (previous === undefined && this.#candidates.size >= SUPERBOX_MAX_CANDIDATE_FILES) {
      throw new GuestWorkspaceError("candidate file count exceeds the operation bound");
    }
    const copied = Uint8Array.from(bytes);
    const aggregateBytes = this.#candidateBytes - (previous?.byteLength ?? 0) + copied.byteLength;
    if (!Number.isSafeInteger(aggregateBytes)
      || aggregateBytes > SUPERBOX_MAX_TOTAL_CANDIDATE_BYTES) {
      throw new GuestWorkspaceError("candidate bytes exceed the operation bound");
    }
    this.#candidates.set(relativePath, copied);
    this.#recordCandidateAncestors(relativePath);
    this.#candidateBytes = aggregateBytes;
  }

  public candidateSnapshot(): readonly GuestCandidateSnapshotV1[] {
    return Object.freeze(
      [
        ...[...this.#candidateDirectories].map((relativePath) => Object.freeze({
          kind: "directory" as const,
          relativePath,
        })),
        ...[...this.#candidates.entries()].map(([relativePath, bytes]) => Object.freeze({
          kind: "file" as const,
          relativePath,
          bytes: Uint8Array.from(bytes),
        })),
      ]
        .sort((left, right) =>
          compareCanonicalUTF8V1(left.relativePath, right.relativePath)
        ),
    );
  }

  #recordCandidateAncestors(relativePath: string): void {
    const root = this.#writableRoots
      .filter((candidate) => relativePath.startsWith(`${candidate}/`))
      .sort((left, right) => right.length - left.length)[0];
    if (root === undefined) return;
    const suffix = relativePath.slice(root.length + 1).split("/");
    for (let index = 1; index < suffix.length; index += 1) {
      this.#candidateDirectories.add(`${root}/${suffix.slice(0, index).join("/")}`);
    }
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertPortableRelativePath(value: string): void {
  if (!isCanonicalUTF8V1(value)
    || value.length === 0
    || value.length > 1_024
    || value.startsWith("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new GuestWorkspaceError("candidate path is not a portable relative path");
  }
}

function isWithinWritableScope(relativePath: string, writableRoots: readonly string[]): boolean {
  return writableRoots.some((root) =>
    relativePath === root || relativePath.startsWith(`${root}/`)
  );
}

export class GuestWorkspaceError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GuestWorkspaceError";
  }
}
