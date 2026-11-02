import { createHash } from "node:crypto";

import {
  buildFrozenAttempt,
  type ResolvedAttemptChoices,
} from "./role-requirements.js";
import type {
  FrozenAttemptV1,
  PromptPartV1,
} from "../contract/index.js";
import { compareCanonicalUTF8V1 } from "../contract/index.js";
import type {
  CandidateOutcomeV1,
  StructuredOutcomeContractV1,
} from "./outcome-contract.js";
import {
  parseCandidateOutcomeV1,
  readCandidateOutcomeFileV1,
} from "./outcome-contract.js";
import { CRITIC_INSTRUCTIONS_NA } from "./outcome-critic.js";

export interface AttemptInferenceV1 {
  readonly modelID: string;
  readonly reasoningEffortID: string | null;
  readonly contextWindowTokens?: number | undefined;
}

export interface BuiltAttemptV1 {
  readonly attempt: FrozenAttemptV1;
  /** Exact bytes for immutable materials and mutable candidate seed files. */
  readonly inputBytes: ReadonlyMap<string, Uint8Array>;
}

export interface AcceptedRevisionInputV1 {
  readonly revisionIndex: number;
  readonly publicationCommitID: string;
  readonly outcome: CandidateOutcomeV1;
}

interface CommonAttemptInputV1 {
  readonly attemptID: string;
  readonly providerID: string;
  readonly inference: AttemptInferenceV1;
}

export interface BuildRawGuardianAttemptV1 extends CommonAttemptInputV1 {
  readonly interactionLanguage?: "en" | "zh-CN";
  readonly guardianPrompt: string;
  readonly safetyPolicy: string;
  readonly rawTranscript: string | Uint8Array;
}

export interface BuildExtraGuardianAttemptV1 extends CommonAttemptInputV1 {
  readonly interactionLanguage?: "en" | "zh-CN";
  readonly guardianPrompt: string;
  readonly safetyPolicy: string;
  readonly actionID: string;
  readonly revisionIndex: number;
  readonly actionInstructions: string;
  readonly outcomeContract: StructuredOutcomeContractV1;
  readonly rawTranscript: string | Uint8Array;
  readonly extraInstructionsMarkdown: string;
  readonly extraInstructionDelta: string;
  readonly actorWebEnabled: boolean;
  readonly acceptedRevisions: readonly AcceptedRevisionInputV1[];
}

export interface BuildActorAttemptV1 extends CommonAttemptInputV1 {
  readonly interactionLanguage?: "en" | "zh-CN";
  readonly actorPromptTemplate: string;
  readonly revisionIndex: number;
  readonly actionInstructions: string;
  readonly outcomeContract: StructuredOutcomeContractV1;
  readonly rawTranscript: string | Uint8Array;
  readonly extraInstructionsMarkdown: string;
  readonly criticInstructionsMarkdown?: string;
  readonly webEnabled: boolean;
  readonly acceptedRevisions: readonly AcceptedRevisionInputV1[];
  /** Prior accepted outcome or rejected correction candidate copied into the current root. */
  readonly candidateSeed?: CandidateOutcomeV1;
}

export function buildRawGuardianAttemptV1(
  input: BuildRawGuardianAttemptV1,
): BuiltAttemptV1 {
  const collector = new AttemptInputCollectorV1();
  collector.addMaterial("raw-transcript.md", "text/plain", input.rawTranscript);
  return collector.finish({
    common: input,
    role: "raw_guardian",
    prompt: [
      { authority: "tah_instruction", text: input.guardianPrompt },
      { authority: "tah_instruction", text: input.safetyPolicy },
      { authority: "tah_trusted_context", text: guardianExplanationContext(input.interactionLanguage) },
    ],
    writableRoots: [],
    responseExpectation: {
      kind: "strict_json",
      schemaID: "safety_guardian/raw-v2",
      maximumUTF8Bytes: 4_096,
    },
    choices: { webEnabled: false },
  });
}

export function buildExtraGuardianAttemptV1(
  input: BuildExtraGuardianAttemptV1,
): BuiltAttemptV1 {
  const acceptedRevisions = validateRevisionHistory(
    input.revisionIndex,
    input.acceptedRevisions,
  );
  const collector = new AttemptInputCollectorV1();
  collector.addMaterial("inbox/action-instructions.md", "text/plain", input.actionInstructions);
  collector.addMaterial("inbox/critic-instructions.md", "text/plain", CRITIC_INSTRUCTIONS_NA);
  collector.addMaterial("inbox/extra-instructions.md", "text/plain", input.extraInstructionsMarkdown);
  collector.addMaterial("inbox/raw-transcript.md", "text/plain", input.rawTranscript);
  addAcceptedHistory(collector, acceptedRevisions);
  const actionBytes = utf8(input.actionInstructions);
  const trustedContext = JSON.stringify({
    explanationLanguage: guardianExplanationLanguage(input.interactionLanguage),
    actionInstructionsIdentity: {
      path: "inbox/action-instructions.md",
      byteLength: actionBytes.byteLength,
      sha256: sha256(actionBytes),
    },
    outcomeContractSummary: {
      schemaVersion: input.outcomeContract.schemaVersion,
      contractID: input.outcomeContract.contractID,
      files: input.outcomeContract.files,
    },
    permissionSummary: {
      web: input.actorWebEnabled ? "Approved" : "Forbidden",
    },
    reviewMetadata: {
      actionID: input.actionID,
      revisionIndex: input.revisionIndex,
      extraInstructionDeltaSHA256: sha256(utf8(input.extraInstructionDelta)),
    },
  });
  return collector.finish({
    common: input,
    role: "extra_guardian",
    prompt: [
      { authority: "tah_instruction", text: input.guardianPrompt },
      { authority: "tah_instruction", text: input.safetyPolicy },
      { authority: "tah_trusted_context", text: trustedContext },
    ],
    writableRoots: [],
    responseExpectation: {
      kind: "strict_json",
      schemaID: "safety_guardian/extra-v2",
      maximumUTF8Bytes: 4_096,
    },
    choices: { webEnabled: false },
  });
}

function guardianExplanationLanguage(language: "en" | "zh-CN" = "en"): string {
  if (language !== "en" && language !== "zh-CN") throw new AttemptBuilderError("Invalid Guardian interaction language");
  return language === "zh-CN" ? "Simplified Chinese (zh-CN)" : "English (en)";
}

function guardianExplanationContext(language: "en" | "zh-CN" | undefined): string {
  return JSON.stringify({ explanationLanguage: guardianExplanationLanguage(language) });
}

export function buildActorAttemptV1(input: BuildActorAttemptV1): BuiltAttemptV1 {
  const acceptedRevisions = validateRevisionHistory(
    input.revisionIndex,
    input.acceptedRevisions,
  );
  const candidateSeed = input.candidateSeed === undefined
    ? undefined
    : parseCandidateOutcomeV1(input.candidateSeed);
  if (input.revisionIndex > 0 && candidateSeed === undefined) {
    throw new AttemptBuilderError("A later revision requires the exact prior accepted seed");
  }
  const currentRoot = `outbox/revision_v${input.revisionIndex}`;
  if (candidateSeed !== undefined) {
    const allowedSeedRoots = new Set([
      currentRoot,
      ...(input.revisionIndex === 0
        ? []
        : [`outbox/revision_v${input.revisionIndex - 1}`]),
    ]);
    if (!allowedSeedRoots.has(candidateSeed.writableRoot)) {
      throw new AttemptBuilderError("Candidate seed provenance does not match this revision");
    }
    if (input.revisionIndex > 0
      && candidateSeed.writableRoot === `outbox/revision_v${input.revisionIndex - 1}`
      && candidateSeed.candidateDigest !== acceptedRevisions.at(-1)?.outcome.candidateDigest) {
      throw new AttemptBuilderError(
        "Prior accepted seed does not match the exact accepted revision",
      );
    }
  }
  const collector = new AttemptInputCollectorV1();
  collector.addMaterial("inbox/action-instructions.md", "text/plain", input.actionInstructions);
  collector.addMaterial(
    "inbox/critic-instructions.md",
    "text/plain",
    input.criticInstructionsMarkdown ?? CRITIC_INSTRUCTIONS_NA,
  );
  collector.addMaterial("inbox/extra-instructions.md", "text/plain", input.extraInstructionsMarkdown);
  collector.addMaterial("inbox/raw-transcript.md", "text/plain", input.rawTranscript);
  addAcceptedHistory(collector, acceptedRevisions);
  if (candidateSeed !== undefined) {
    for (const entry of candidateSeed.entries) {
      const path = `${currentRoot}/${entry.relativePath}`;
      if (entry.kind === "directory") collector.addSeedDirectory(path);
      else {
        const bytes = readCandidateOutcomeFileV1(entry);
        try {
          collector.addSeedFile(path, "text/plain", bytes);
        } finally {
          bytes.fill(0);
        }
      }
    }
  }

  return collector.finish({
    common: input,
    role: "actor",
    prompt: [{
      authority: "tah_instruction",
      text: renderActorPrompt(
        input.actorPromptTemplate,
        input.revisionIndex,
        currentRoot,
        input.webEnabled,
        input.interactionLanguage ?? "en",
      ),
    }],
    writableRoots: [currentRoot],
    responseExpectation: {
      kind: "workspace_outcome",
      contractID: input.outcomeContract.contractID,
      maximumFinalMessageUTF8Bytes: 64 * 1024,
    },
    choices: { webEnabled: input.webEnabled },
  });
}

function addAcceptedHistory(
  collector: AttemptInputCollectorV1,
  revisions: readonly AcceptedRevisionInputV1[],
): void {
  for (const revision of revisions) {
    for (const entry of revision.outcome.entries) {
      if (entry.kind !== "file") continue;
      const bytes = readCandidateOutcomeFileV1(entry);
      try {
        collector.addMaterial(
          `outbox/revision_v${revision.revisionIndex}/${entry.relativePath}`,
          "text/plain",
          bytes,
        );
      } finally {
        bytes.fill(0);
      }
    }
  }
}

function validateRevisionHistory(
  currentRevision: number,
  revisions: readonly AcceptedRevisionInputV1[],
): readonly AcceptedRevisionInputV1[] {
  if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) {
    throw new AttemptBuilderError("Current revision index is invalid");
  }
  let previous = -1;
  const validated: AcceptedRevisionInputV1[] = [];
  for (const revision of revisions) {
    if (!Number.isSafeInteger(revision.revisionIndex)
      || revision.revisionIndex <= previous
      || revision.revisionIndex >= currentRevision) {
      throw new AttemptBuilderError("Accepted revision history is not canonical");
    }
    const outcome = parseCandidateOutcomeV1(revision.outcome);
    if (!isCommitID(revision.publicationCommitID)
      || outcome.writableRoot !== `outbox/revision_v${revision.revisionIndex}`) {
      throw new AttemptBuilderError("Accepted revision outcome provenance is invalid");
    }
    validated.push(Object.freeze({
      revisionIndex: revision.revisionIndex,
      publicationCommitID: revision.publicationCommitID,
      outcome,
    }));
    previous = revision.revisionIndex;
  }
  if ((currentRevision === 0 && validated.length !== 0)
    || (currentRevision > 0 && validated.at(-1)?.revisionIndex !== currentRevision - 1)) {
    throw new AttemptBuilderError("Exact previous accepted revision is unavailable");
  }
  return Object.freeze(validated);
}

function isCommitID(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value);
}

function renderActorPrompt(
  template: string,
  revisionIndex: number,
  currentRoot: string,
  webEnabled: boolean,
  interactionLanguage: "en" | "zh-CN",
): string {
  const interactionLabel = interactionLanguage === "en" ? "English"
    : interactionLanguage === "zh-CN" ? "Simplified Chinese (简体中文)" : undefined;
  if (interactionLabel === undefined) throw new AttemptBuilderError("Interaction language is unsupported");
  const replacements: Readonly<Record<string, string>> = {
    "{ALMA_JOB_FOLDER}": ".",
    "{WEB_PERMISSION}": webEnabled ? "Approved" : "Forbidden",
    "{VERSION_INDEX}": String(revisionIndex),
    "{ALMA_CURRENT_REVISION_FOLDER}": currentRoot,
  };
  let result = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    if (result.split(placeholder).length !== 2) {
      throw new AttemptBuilderError(`Actor prompt placeholder is not exact: ${placeholder}`);
    }
    result = result.replace(placeholder, value);
  }
  if (/\{[A-Z0-9_]+\}/u.test(result)) {
    throw new AttemptBuilderError("Actor prompt contains an unresolved placeholder");
  }
  return `${result}\n\nHost-selected interaction language for this attempt: ${interactionLabel}.\nUse it for public commentary and final replies, including before the first file read; never infer it from inputs or expose private reasoning. Notes language is separate. Preserve source quotations, names, code, URLs and native tool text.\n`;
}

class AttemptInputCollectorV1 {
  readonly #materials: Array<{
    readonly relativePath: string;
    readonly mediaType: "text/plain" | "application/json";
    readonly byteLength: number;
    readonly sha256: string;
  }> = [];
  readonly #candidateSeeds: Array<
    | { readonly kind: "directory"; readonly relativePath: string }
    | {
        readonly kind: "file";
        readonly relativePath: string;
        readonly mediaType: "text/plain" | "application/json";
        readonly byteLength: number;
        readonly sha256: string;
      }
  > = [];
  readonly #bytes = new Map<string, Uint8Array>();
  readonly #paths = new Set<string>();

  public addMaterial(
    relativePath: string,
    mediaType: "text/plain" | "application/json",
    value: string | Uint8Array,
  ): void {
    const bytes = typeof value === "string" ? utf8(value) : Uint8Array.from(value);
    this.#addPath(relativePath);
    this.#materials.push(Object.freeze({
      relativePath,
      mediaType,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    }));
    this.#bytes.set(relativePath, bytes);
  }

  public addSeedDirectory(relativePath: string): void {
    this.#addPath(relativePath);
    this.#candidateSeeds.push(Object.freeze({ kind: "directory", relativePath }));
  }

  public addSeedFile(
    relativePath: string,
    mediaType: "text/plain" | "application/json",
    value: Uint8Array,
  ): void {
    const bytes = Uint8Array.from(value);
    this.#addPath(relativePath);
    this.#candidateSeeds.push(Object.freeze({
      kind: "file",
      relativePath,
      mediaType,
      byteLength: bytes.byteLength,
      sha256: sha256(bytes),
    }));
    this.#bytes.set(relativePath, bytes);
  }

  public finish(input: {
    readonly common: CommonAttemptInputV1;
    readonly role: FrozenAttemptV1["role"];
    readonly prompt: readonly PromptPartV1[];
    readonly writableRoots: readonly string[];
    readonly responseExpectation: FrozenAttemptV1["responseExpectation"];
    readonly choices: ResolvedAttemptChoices;
  }): BuiltAttemptV1 {
    this.#materials.sort((left, right) =>
      compareCanonicalUTF8V1(left.relativePath, right.relativePath)
    );
    this.#candidateSeeds.sort((left, right) =>
      compareCanonicalUTF8V1(left.relativePath, right.relativePath)
    );
    const attempt = buildFrozenAttempt({
      contractVersion: 1,
      attemptID: input.common.attemptID,
      providerID: input.common.providerID,
      role: input.role,
      inference: input.common.inference,
      prompt: [...input.prompt],
      workspace: {
        materials: [...this.#materials],
        candidateSeeds: [...this.#candidateSeeds],
        writableRoots: [...input.writableRoots].sort(compareCanonicalUTF8V1),
      },
      responseExpectation: input.responseExpectation,
    }, input.choices);
    return Object.freeze({ attempt, inputBytes: new Map(this.#bytes) });
  }

  #addPath(path: string): void {
    if (this.#paths.has(path)) throw new AttemptBuilderError("Attempt input path repeats");
    this.#paths.add(path);
  }
}

function utf8(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, "utf8"));
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class AttemptBuilderError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "AttemptBuilderError";
  }
}
