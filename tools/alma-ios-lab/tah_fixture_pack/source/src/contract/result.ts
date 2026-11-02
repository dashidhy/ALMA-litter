import type { AttemptTerminalV1 } from "./events.js";

export const TAH_MAX_CANDIDATE_FILES = 256;
export const TAH_MAX_CANDIDATE_ENTRIES = 512;
export const TAH_MAX_CANDIDATE_DEPTH = 32;
export const TAH_MAX_TOTAL_CANDIDATE_BYTES = 64 * 1024 * 1024;

/** Logical, untrusted candidate entry after transport-level quarantine. */
export interface TahCandidateManifestEntryV1 {
  readonly relativePath: string;
  readonly kind: "directory" | "file";
  readonly byteLength: number | null;
}

/** Provider- and transport-neutral attempt result consumed by TAH Framework. */
export interface TahAttemptResultV1 {
  readonly terminal: AttemptTerminalV1;
  readonly candidateManifest: readonly TahCandidateManifestEntryV1[];
  readonly candidateFiles: ReadonlyMap<string, Uint8Array>;
}
