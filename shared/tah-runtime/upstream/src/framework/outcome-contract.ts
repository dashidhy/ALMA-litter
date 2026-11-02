import { createHash } from "node:crypto";

import { z } from "zod";

import {
  compareCanonicalUTF8V1,
  isCanonicalUTF8V1,
  isStrictlyCanonicalUTF8SortedV1,
  TAH_MAX_CANDIDATE_DEPTH,
  TAH_MAX_CANDIDATE_ENTRIES,
  TAH_MAX_CANDIDATE_FILES,
  TAH_MAX_TOTAL_CANDIDATE_BYTES,
  type TahCandidateManifestEntryV1,
} from "../contract/index.js";

export const TAH_OUTCOME_CONTRACT_VERSION = 1 as const;
export const TAH_MAX_OUTCOME_FILES = 32;
export const TAH_MAX_OUTCOME_FILE_BYTES = 16 * 1024 * 1024;
export const TAH_MAX_OUTCOME_TOTAL_BYTES = 64 * 1024 * 1024;

const contractID = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u);
const relativePath = z.string().min(1).max(1_024).superRefine((value, context) => {
  if (!isCanonicalUTF8V1(value)
    || value.startsWith("/") || value.includes("\\") || /[\u0000-\u001f\u007f]/u.test(value)
    || value.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    context.addIssue({ code: "custom", message: "outcome path must be portable and relative" });
  }
});

const outcomeFileRuleSchema = z.strictObject({
  relativePath,
  contentKind: z.literal("utf8_markdown"),
  minimumBytes: z.number().int().nonnegative().max(TAH_MAX_OUTCOME_FILE_BYTES),
  maximumBytes: z.number().int().positive().max(TAH_MAX_OUTCOME_FILE_BYTES),
}).superRefine((value, context) => {
  if (value.minimumBytes > value.maximumBytes) {
    context.addIssue({ code: "custom", message: "minimumBytes exceeds maximumBytes" });
  }
});

export const structuredOutcomeContractSchema = z.strictObject({
  schemaVersion: z.literal(TAH_OUTCOME_CONTRACT_VERSION),
  contractID,
  files: z.array(outcomeFileRuleSchema).min(1).max(TAH_MAX_OUTCOME_FILES),
}).superRefine((value, context) => {
  const paths = value.files.map((file) => file.relativePath);
  if (new Set(paths).size !== paths.length) {
    context.addIssue({ code: "custom", path: ["files"], message: "outcome paths repeat" });
  }
  if (!isStrictlyCanonicalUTF8SortedV1(paths)) {
    context.addIssue({ code: "custom", path: ["files"], message: "outcome paths are not sorted" });
  }
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      if (paths[right]!.startsWith(`${paths[left]!}/`)) {
        context.addIssue({
          code: "custom",
          path: ["files"],
          message: "outcome file path collides with a descendant",
        });
      }
    }
  }
  const totalMaximum = value.files.reduce((sum, file) => sum + file.maximumBytes, 0);
  if (!Number.isSafeInteger(totalMaximum) || totalMaximum > TAH_MAX_OUTCOME_TOTAL_BYTES) {
    context.addIssue({ code: "custom", path: ["files"], message: "outcome total exceeds bound" });
  }
});

export type StructuredOutcomeContractV1 = z.infer<typeof structuredOutcomeContractSchema>;
export type OutcomeFileRuleV1 = StructuredOutcomeContractV1["files"][number];

export const STRUCTURED_NOTES_OUTCOME_CONTRACT_V1 = parseStructuredOutcomeContract({
  schemaVersion: 1,
  contractID: "structured_notes/v2",
  files: [
    {
      relativePath: "structured-notes.md",
      contentKind: "utf8_markdown",
      minimumBytes: 1,
      maximumBytes: 8 * 1024 * 1024,
    },
    {
      relativePath: "suspicious-asr-terms.md",
      contentKind: "utf8_markdown",
      minimumBytes: 1,
      maximumBytes: 1024 * 1024,
    },
  ],
});

export interface CandidateOutcomeDirectoryV1 {
  readonly kind: "directory";
  readonly relativePath: string;
}

export interface CandidateOutcomeFileV1 {
  readonly kind: "file";
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly dataBase64: string;
}

export type CandidateOutcomeEntryV1 = CandidateOutcomeDirectoryV1 | CandidateOutcomeFileV1;

export interface CandidateOutcomeV1 {
  readonly writableRoot: string;
  readonly candidateDigest: string;
  readonly entries: readonly CandidateOutcomeEntryV1[];
}

const candidateOutcomeDirectorySchema = z.strictObject({
  kind: z.literal("directory"),
  relativePath,
});

const candidateOutcomeFileSchema = z.strictObject({
  kind: z.literal("file"),
  relativePath,
  byteLength: z.number().int().nonnegative().max(TAH_MAX_TOTAL_CANDIDATE_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  dataBase64: z.string().max(Math.ceil(TAH_MAX_TOTAL_CANDIDATE_BYTES / 3) * 4),
});

const candidateOutcomeSchema = z.strictObject({
  writableRoot: relativePath,
  candidateDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  entries: z.array(z.discriminatedUnion("kind", [
    candidateOutcomeDirectorySchema,
    candidateOutcomeFileSchema,
  ])).max(TAH_MAX_CANDIDATE_ENTRIES),
});

export function parseStructuredOutcomeContract(value: unknown): StructuredOutcomeContractV1 {
  return deepFreeze(structuredOutcomeContractSchema.parse(value));
}

/**
 * Revalidates the untrusted, transport-admitted candidate tree and projects
 * logical revision-root paths to contract-relative outcome paths.
 */
export function buildCandidateOutcomeV1(
  writableRoot: string,
  manifest: readonly TahCandidateManifestEntryV1[],
  files: ReadonlyMap<string, Uint8Array>,
): CandidateOutcomeV1 {
  assertPortablePath(writableRoot);
  if (!Array.isArray(manifest)
    || manifest.length > TAH_MAX_CANDIDATE_ENTRIES
    || !(files instanceof Map)) {
    throw new OutcomeIntegrityError("Candidate quarantine shape is invalid");
  }
  const fullPaths = new Set<string>();
  const projected: CandidateOutcomeEntryV1[] = [];
  let lastFullPath: string | undefined;
  let totalBytes = 0;
  let fileCount = 0;

  for (const entry of manifest) {
    if (entry === null || typeof entry !== "object") {
      throw new OutcomeIntegrityError("Candidate manifest entry is invalid");
    }
    assertPortablePath(entry.relativePath);
    if (lastFullPath !== undefined
      && compareCanonicalUTF8V1(lastFullPath, entry.relativePath) >= 0) {
      throw new OutcomeIntegrityError("Candidate manifest is not canonically ordered");
    }
    lastFullPath = entry.relativePath;
    if (fullPaths.has(entry.relativePath)) {
      throw new OutcomeIntegrityError("Candidate manifest repeats a path");
    }
    fullPaths.add(entry.relativePath);
    if (!entry.relativePath.startsWith(`${writableRoot}/`)) {
      throw new OutcomeIntegrityError("Candidate manifest escaped the writable root");
    }
    const outcomePath = entry.relativePath.slice(writableRoot.length + 1);
    assertPortablePath(outcomePath);
    if (entry.kind === "directory") {
      if (entry.byteLength !== null || files.has(entry.relativePath)) {
        throw new OutcomeIntegrityError("Candidate directory carries file bytes");
      }
      projected.push(Object.freeze({ kind: "directory", relativePath: outcomePath }));
      continue;
    }
    if (entry.kind !== "file" || !Number.isSafeInteger(entry.byteLength)
      || entry.byteLength === null || entry.byteLength < 0
      || entry.byteLength > TAH_MAX_TOTAL_CANDIDATE_BYTES) {
      throw new OutcomeIntegrityError("Candidate file declaration is invalid");
    }
    const bytes = files.get(entry.relativePath);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== entry.byteLength) {
      throw new OutcomeIntegrityError("Candidate file bytes disagree with the manifest");
    }
    fileCount += 1;
    totalBytes += bytes.byteLength;
    if (fileCount > TAH_MAX_CANDIDATE_FILES || !Number.isSafeInteger(totalBytes)
      || totalBytes > TAH_MAX_TOTAL_CANDIDATE_BYTES) {
      throw new OutcomeIntegrityError("Candidate outcome exceeds its resource bound");
    }
    const copy = Uint8Array.from(bytes);
    const digest = sha256(copy);
    const dataBase64 = Buffer.from(copy).toString("base64");
    copy.fill(0);
    projected.push(Object.freeze({
      kind: "file",
      relativePath: outcomePath,
      byteLength: bytes.byteLength,
      sha256: digest,
      dataBase64,
    }));
  }

  const declaredFiles = manifest.filter((entry) => entry.kind === "file");
  if (files.size !== declaredFiles.length
    || [...files.keys()].some((path) => !fullPaths.has(path))) {
    throw new OutcomeIntegrityError("Candidate byte map is not exact");
  }
  assertManifestHierarchy(projected);
  const entries = Object.freeze(projected);
  return parseCandidateOutcomeV1({
    writableRoot,
    candidateDigest: digestCandidate(writableRoot, entries),
    entries,
  });
}

/** Revalidates an App-owned persisted candidate/correction snapshot. */
export function parseCandidateOutcomeV1(value: unknown): CandidateOutcomeV1 {
  let candidate: z.infer<typeof candidateOutcomeSchema>;
  try {
    candidate = candidateOutcomeSchema.parse(value);
  } catch (cause) {
    throw new OutcomeIntegrityError("Persisted candidate outcome is malformed", { cause });
  }
  const paths = candidate.entries.map((entry) => entry.relativePath);
  if (!isStrictlyCanonicalUTF8SortedV1(paths)) {
    throw new OutcomeIntegrityError("Persisted candidate outcome is not canonically ordered");
  }
  let fileCount = 0;
  let totalBytes = 0;
  for (const entry of candidate.entries) {
    if (entry.kind !== "file") continue;
    fileCount += 1;
    const bytes = decodeCandidateFile(entry);
    totalBytes += bytes.byteLength;
    bytes.fill(0);
    if (fileCount > TAH_MAX_CANDIDATE_FILES
      || !Number.isSafeInteger(totalBytes)
      || totalBytes > TAH_MAX_TOTAL_CANDIDATE_BYTES) {
      throw new OutcomeIntegrityError("Persisted candidate outcome exceeds its resource bound");
    }
  }
  assertManifestHierarchy(candidate.entries);
  if (digestCandidate(candidate.writableRoot, candidate.entries) !== candidate.candidateDigest) {
    throw new OutcomeIntegrityError("Persisted candidate outcome digest changed");
  }
  return deepFreeze(candidate) as CandidateOutcomeV1;
}

export function readCandidateOutcomeFileV1(file: CandidateOutcomeFileV1): Uint8Array {
  let parsed: z.infer<typeof candidateOutcomeFileSchema>;
  try {
    parsed = candidateOutcomeFileSchema.parse(file);
  } catch (cause) {
    throw new OutcomeIntegrityError("Candidate outcome file is malformed", { cause });
  }
  const bytes = decodeCandidateFile(parsed);
  const copy = Uint8Array.from(bytes);
  bytes.fill(0);
  return copy;
}

function decodeCandidateFile(file: z.infer<typeof candidateOutcomeFileSchema>): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u
    .test(file.dataBase64)) {
    throw new OutcomeIntegrityError("Candidate outcome file encoding is invalid");
  }
  const bytes = Buffer.from(file.dataBase64, "base64");
  if (bytes.toString("base64") !== file.dataBase64
    || bytes.byteLength !== file.byteLength
    || sha256(bytes) !== file.sha256) {
    bytes.fill(0);
    throw new OutcomeIntegrityError("Candidate outcome file identity changed");
  }
  return bytes;
}

function assertManifestHierarchy(entries: readonly CandidateOutcomeEntryV1[]): void {
  const byPath = new Map(entries.map((entry) => [entry.relativePath, entry]));
  for (const entry of entries) {
    const components = entry.relativePath.split("/");
    if (components.length > TAH_MAX_CANDIDATE_DEPTH) {
      throw new OutcomeIntegrityError("Candidate path exceeds the outcome depth bound");
    }
    for (let index = 1; index < components.length; index += 1) {
      const ancestor = components.slice(0, index).join("/");
      if (byPath.get(ancestor)?.kind !== "directory") {
        throw new OutcomeIntegrityError("Candidate manifest omitted a directory ancestor");
      }
    }
  }
}

function digestCandidate(
  writableRoot: string,
  entries: readonly CandidateOutcomeEntryV1[],
): string {
  const hash = createHash("sha256");
  hash.update("ALMA_TAH_CANDIDATE_V1\0", "utf8");
  hash.update(writableRoot, "utf8");
  hash.update("\0");
  for (const entry of entries) {
    hash.update(entry.kind);
    hash.update("\0");
    hash.update(entry.relativePath, "utf8");
    hash.update("\0");
    if (entry.kind === "file") {
      hash.update(String(entry.byteLength));
      hash.update("\0");
      hash.update(entry.sha256);
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

function assertPortablePath(value: string): void {
  const result = relativePath.safeParse(value);
  if (!result.success) throw new OutcomeIntegrityError("Candidate path is invalid");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export class OutcomeIntegrityError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "OutcomeIntegrityError";
  }
}
