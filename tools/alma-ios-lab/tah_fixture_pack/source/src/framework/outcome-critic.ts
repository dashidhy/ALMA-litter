import { z } from "zod";

import {
  compareCanonicalUTF8V1,
  isCanonicalUTF8V1,
} from "../contract/index.js";

import type {
  CandidateOutcomeFileV1,
  CandidateOutcomeV1,
  StructuredOutcomeContractV1,
} from "./outcome-contract.js";
import { readCandidateOutcomeFileV1 } from "./outcome-contract.js";

export const OUTCOME_CRITIC_ISSUE_CODES = Object.freeze([
  "missing_required_file",
  "expected_file_is_directory",
  "unexpected_file",
  "unexpected_directory",
  "file_too_small",
  "file_too_large",
  "invalid_utf8",
  "forbidden_nul_byte",
] as const);

export type OutcomeCriticIssueCodeV1 = (typeof OUTCOME_CRITIC_ISSUE_CODES)[number];

const issuePath = z.string().min(1).max(1_024).superRefine((value, context) => {
  if (!isCanonicalUTF8V1(value)
    || value.startsWith("/")
    || value.includes("\\")
    || /[\u0000-\u001f\u007f]/u.test(value)
    || value.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    context.addIssue({ code: "custom", message: "Critic issue path is invalid" });
  }
});
const criticIssueSchema = z.discriminatedUnion("code", [
  z.strictObject({ code: z.literal("missing_required_file"), relativePath: issuePath }),
  z.strictObject({ code: z.literal("expected_file_is_directory"), relativePath: issuePath }),
  z.strictObject({ code: z.literal("unexpected_file"), relativePath: issuePath }),
  z.strictObject({ code: z.literal("unexpected_directory"), relativePath: issuePath }),
  z.strictObject({ code: z.literal("invalid_utf8"), relativePath: issuePath }),
  z.strictObject({ code: z.literal("forbidden_nul_byte"), relativePath: issuePath }),
  z.strictObject({
    code: z.literal("file_too_small"),
    relativePath: issuePath,
    actualBytes: z.number().int().nonnegative(),
    minimumBytes: z.number().int().nonnegative(),
  }),
  z.strictObject({
    code: z.literal("file_too_large"),
    relativePath: issuePath,
    actualBytes: z.number().int().nonnegative(),
    maximumBytes: z.number().int().nonnegative(),
  }),
]);

export const outcomeCriticResultSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    schemaVersion: z.literal(1),
    contractID: z.string().min(1).max(128),
    candidateDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    decision: z.literal("PASS"),
    issues: z.tuple([]),
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    contractID: z.string().min(1).max(128),
    candidateDigest: z.string().regex(/^[0-9a-f]{64}$/u),
    decision: z.literal("REJECT"),
    issues: z.array(criticIssueSchema).min(1).max(1_024),
  }),
]);

export type OutcomeCriticIssueV1 = z.infer<typeof criticIssueSchema>;
export type OutcomeCriticResultV1 = z.infer<typeof outcomeCriticResultSchema>;

/** Pure, deterministic exact-files critic. It performs no semantic review. */
export function evaluateOutcomeCandidateV1(
  contract: StructuredOutcomeContractV1,
  candidate: CandidateOutcomeV1,
): OutcomeCriticResultV1 {
  const issues: OutcomeCriticIssueV1[] = [];
  const byPath = new Map(candidate.entries.map((entry) => [entry.relativePath, entry]));
  const expectedPaths = new Set(contract.files.map((file) => file.relativePath));
  const allowedDirectories = requiredDirectoryAncestors(contract.files.map((file) => file.relativePath));

  for (const rule of contract.files) {
    const entry = byPath.get(rule.relativePath);
    if (entry === undefined) {
      issues.push({ code: "missing_required_file", relativePath: rule.relativePath });
      continue;
    }
    if (entry.kind === "directory") {
      issues.push({ code: "expected_file_is_directory", relativePath: rule.relativePath });
      continue;
    }
    validateExpectedFile(rule.minimumBytes, rule.maximumBytes, entry, issues);
  }

  for (const entry of candidate.entries) {
    if (entry.kind === "file" && !expectedPaths.has(entry.relativePath)) {
      issues.push({ code: "unexpected_file", relativePath: entry.relativePath });
    } else if (entry.kind === "directory" && !allowedDirectories.has(entry.relativePath)) {
      issues.push({ code: "unexpected_directory", relativePath: entry.relativePath });
    }
  }

  issues.sort((left, right) =>
    compareCanonicalUTF8V1(left.relativePath, right.relativePath)
      || compareCanonicalUTF8V1(left.code, right.code)
  );
  return outcomeCriticResultSchema.parse({
    schemaVersion: 1,
    contractID: contract.contractID,
    candidateDigest: candidate.candidateDigest,
    decision: issues.length === 0 ? "PASS" : "REJECT",
    issues,
  });
}

function validateExpectedFile(
  minimumBytes: number,
  maximumBytes: number,
  file: CandidateOutcomeFileV1,
  issues: OutcomeCriticIssueV1[],
): void {
  if (file.byteLength < minimumBytes) {
    issues.push({
      code: "file_too_small",
      relativePath: file.relativePath,
      actualBytes: file.byteLength,
      minimumBytes,
    });
  }
  if (file.byteLength > maximumBytes) {
    issues.push({
      code: "file_too_large",
      relativePath: file.relativePath,
      actualBytes: file.byteLength,
      maximumBytes,
    });
  }
  const bytes = readCandidateOutcomeFileV1(file);
  if (bytes.includes(0)) {
    issues.push({ code: "forbidden_nul_byte", relativePath: file.relativePath });
  }
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    issues.push({ code: "invalid_utf8", relativePath: file.relativePath });
  } finally {
    bytes.fill(0);
  }
}

function requiredDirectoryAncestors(paths: readonly string[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let index = 1; index < parts.length; index += 1) {
      result.add(parts.slice(0, index).join("/"));
    }
  }
  return result;
}

export const CRITIC_INSTRUCTIONS_NA = "# Critic Instructions\n\nN/A\n" as const;

export function renderCriticInstructionsV1(result: OutcomeCriticResultV1): string {
  const parsed = outcomeCriticResultSchema.parse(result);
  if (parsed.decision === "PASS") return CRITIC_INSTRUCTIONS_NA;
  const lines = parsed.issues.map((issue, index) =>
    `${index + 1}. ${renderIssue(issue)}`
  );
  const rendered = [
    "# Critic Instructions",
    "",
    "The previous candidate did not satisfy the Host-enforced output requirements. Apply every correction below to the Host-provided current revision folder.",
    "",
    ...lines,
    "",
    "Do not modify input files, prior revisions, filesystem permissions, or action scope.",
    "",
  ].join("\n");
  if (Buffer.byteLength(rendered, "utf8") > 64 * 1024) {
    throw new OutcomeCriticRenderError("Critic instructions exceed their bound");
  }
  return rendered;
}

function renderIssue(issue: OutcomeCriticIssueV1): string {
  const path = quotedPath(issue.relativePath);
  switch (issue.code) {
    case "missing_required_file": return `Create the required outcome file ${path}.`;
    case "expected_file_is_directory": return `Replace the directory at ${path} with the required regular file.`;
    case "unexpected_file": return `Remove the undeclared outcome file ${path}.`;
    case "unexpected_directory": return `Remove the undeclared outcome directory ${path} and anything inside it.`;
    case "file_too_small": return `Expand ${path} so it contains at least ${String(issue.minimumBytes)} UTF-8 bytes.`;
    case "file_too_large": return `Reduce ${path} so it contains at most ${String(issue.maximumBytes)} UTF-8 bytes.`;
    case "invalid_utf8": return `Rewrite ${path} as valid UTF-8 Markdown.`;
    case "forbidden_nul_byte": return `Remove every NUL byte from ${path}.`;
  }
}

function quotedPath(value: string): string {
  let result = '"';
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    const character = value[index]!;
    result += /^[A-Za-z0-9./-]$/u.test(character)
      ? character
      : `\\u${codeUnit.toString(16).padStart(4, "0")}`;
  }
  return `${result}\"`;
}

export class OutcomeCriticRenderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "OutcomeCriticRenderError";
  }
}
