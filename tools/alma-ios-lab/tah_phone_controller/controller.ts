// Qualification skeleton only. No phone implementation, credentials, or automatic execution.
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { TahWorkflowCoordinatorV1, TahAttemptExecutionErrorV1 } from "../../../../ALMA/app/TAH/src/framework/workflow.js";
import type { TahFrameworkAttemptPortV1, TahWorkflowResourcesV1 } from "../../../../ALMA/app/TAH/src/framework/workflow.js";
import type { AcceptedRevisionInputV1, AttemptInferenceV1, BuiltAttemptV1 } from "../../../../ALMA/app/TAH/src/framework/attempt-builders.js";
import { createStructuredNotesActionDefinitionV1 } from "../../../../ALMA/app/TAH/src/framework/action-definition.js";
import { projectNativePromptChannelsV1 } from "../../../../ALMA/app/TAH/src/guest/adapter-kit/prompt-envelope.js";
import { NormalizedEventLedgerV1 } from "../../../../ALMA/app/TAH/src/contract/events.js";
import type { NormalizedEventV1, TahAttemptResultV1 } from "../../../../ALMA/app/TAH/src/contract/index.js";
import { parseFrozenAttempt, compareCanonicalUTF8V1 } from "../../../../ALMA/app/TAH/src/contract/index.js";
import { catalogSchema } from "../../../../ALMA/app/TAH/src/auth-prototype/protocol.js";
import { authorizationCheckSucceeded } from "../../../../ALMA/app/TAH/src/auth-prototype/inspection.js";
import type { AuthInspection } from "../../../../ALMA/app/TAH/src/auth-prototype/inspection.js";
import { DurableTahPersistence } from "../../../../ALMA/app/TAH/src/app-runtime/durable-persistence.js";
import type { JournalPort } from "../../../../ALMA/app/TAH/src/app-runtime/journal.js";

export interface PhoneBinding {
  providerID: "codex";
  accountFingerprint: string; // SHA256 of actual phone OAuth account ID; never the ID itself.
  profileDigest: string;
  catalog: unknown;
  authorization: {
    state: string; phase: string; inspecting: boolean;
    inspection: AuthInspection | null; replacement: null;
  };
}
export interface PhoneRequest {
  runID: string;
  binding: PhoneBinding;
  built: BuiltAttemptV1;
  payload: ReturnType<typeof projectPhonePayload>;
  channels: ReturnType<typeof projectNativePromptChannelsV1>;
}
/** Trusted HOST boundary, NOT a JSON transport shape or phone self-attestation.
 * Main must implement real launch identity, current account/catalog inspection,
 * immutable scope installation, authoritative completion, OS exit observation,
 * exact file quarantine and anti-replay checks. No result can skip admitReaped.
 */
export interface PhonePort {
  inspect(signal?: AbortSignal): Promise<PhoneBinding>;
  runFresh(request: PhoneRequest, event: (event: NormalizedEventV1) => Promise<void>,
    signal?: AbortSignal): Promise<unknown>;
  admitReaped(receipt: unknown, request: PhoneRequest): Promise<{
    binding: PhoneBinding; result: TahAttemptResultV1;
  }>;
}
export const unwiredPhonePort: PhonePort = {
  async inspect() { throw new Error("phone authorization port is not wired"); },
  async runFresh() { throw new Error("fresh phone attempt port is not wired"); },
  async admitReaped() { throw new TahAttemptExecutionErrorV1("cleanup_unconfirmed"); },
};
export const unwiredJournal: JournalPort = {
  async read() { throw new Error("durable qualification journal is not wired"); },
  async append() { throw new Error("durable qualification journal is not wired"); },
};

const digest = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export function bindingKey(binding: PhoneBinding): string {
  if (binding.providerID !== "codex" || !/^[a-f0-9]{64}$/u.test(binding.accountFingerprint)
    || !/^[a-f0-9]{64}$/u.test(binding.profileDigest)
    || !authorizationCheckSucceeded(binding.authorization)) {
    throw new Error("phone identity/authorization inspection is unavailable");
  }
  return digest(JSON.stringify([binding.providerID, binding.accountFingerprint,
    binding.profileDigest, catalogSchema.parse(binding.catalog)]));
}
/** Draft payload only; main owns the final wire and Documents transport. */
export function projectPhonePayload(built: BuiltAttemptV1) {
  parseFrozenAttempt(built.attempt); // Original schema/role/path validation.
  const declared = [...built.attempt.workspace.materials,
    ...built.attempt.workspace.candidateSeeds.filter(value => value.kind === "file")]
    .sort((a, b) => compareCanonicalUTF8V1(a.relativePath, b.relativePath));
  if (built.inputBytes.size !== declared.length) throw new Error("input map is not exact");
  const inputFiles = declared.map(meta => {
    const bytes = built.inputBytes.get(meta.relativePath);
    if (!bytes || bytes.byteLength !== meta.byteLength || digest(bytes) !== meta.sha256)
      throw new Error("input bytes disagree with frozen metadata");
    return { relativePath: meta.relativePath, base64: Buffer.from(bytes).toString("base64") };
  });
  const attemptJSON = JSON.stringify(built.attempt);
  return { attemptJSON, attemptSHA256: digest(attemptJSON), inputFiles };
}
export function assertSelection(binding: PhoneBinding, selection: AttemptInferenceV1): void {
  bindingKey(binding);
  const catalog = catalogSchema.parse(binding.catalog);
  const model = catalog.models.find(value => value.handle === selection.modelID);
  if (!model || selection.contextWindowTokens !== undefined
    || (selection.reasoningEffortID !== null
      && !model.efforts.some(value => value.handle === selection.reasoningEffortID))) {
    throw new Error("exact model/effort unavailable; fallback is forbidden");
  }
}

export async function loadFixture() {
  const pack = new URL("../tah_fixture_pack/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", pack), "utf8"));
  // Every prompt/schema reference is checked against both the pack and its source.
  for (const asset of manifest.assets) {
    const packed = await readFile(new URL(asset.pack_path, pack));
    const original = await readFile(asset.source_path);
    if (packed.length !== asset.byteLength || digest(packed) !== asset.sha256
      || digest(original) !== asset.sha256) throw new Error("fixture/source asset drift");
  }
  for (const ref of manifest.source.noncopied_behavior_references) {
    if (digest(await readFile(ref.source_path)) !== ref.sha256) throw new Error("TAH source drift");
  }
  const prompt = (path: string) => readFile(new URL(`source/prompts/${path}`, pack), "utf8");
  const resources: TahWorkflowResourcesV1 = {
    actorPromptTemplate: await prompt("system_prompts/actor_prompt_v4_2.txt"),
    rawGuardianPrompt: await prompt("system_prompts/safety_guardian_raw_prompt_v0_3.txt"),
    extraGuardianPrompt: await prompt("system_prompts/safety_guardian_extra_prompt_v0_6.txt"),
    safetyPolicy: await prompt("system_prompts/safety_guardian_policy_v0_2.txt"),
  };
  const rawTranscript: string = manifest.synthetic_fixture.raw_transcript_utf8;
  if (digest(rawTranscript) !== manifest.synthetic_fixture.raw_transcript_sha256)
    throw new Error("synthetic transcript drift");
  const deltas: string[] = manifest.synthetic_fixture.revision_instruction_deltas.map(
    (value: { text: string; sha256: string }) => {
      if (digest(value.text) !== value.sha256) throw new Error("instruction drift");
      return value.text;
    });
  if (deltas.length !== 3 || deltas[0] !== "" || !deltas[1] || !deltas[2])
    throw new Error("expected empty V0 plus V1/V2 instructions");
  return {
    resources, rawTranscript, deltas,
    actionDefinition: createStructuredNotesActionDefinitionV1(
      await prompt("action_instructions/structured_notes_v4_3.txt")),
    guardianInference: { modelID: manifest.inference.guardian.modelID,
      reasoningEffortID: manifest.inference.guardian.reasoningEffortID } as AttemptInferenceV1,
    manifestPath: fileURLToPath(new URL("manifest.json", pack)),
  };
}

/** No device operation occurs until explicitly invoked with a real PhonePort.
 * One host invocation only; crash resume/raw-cache persistence is not implemented.
 */
export async function runQualification(actorInference: AttemptInferenceV1,
  phone: PhonePort = unwiredPhonePort, journal: JournalPort = unwiredJournal,
  signal?: AbortSignal) {
  const fixture = await loadFixture();
  const binding = structuredClone(await phone.inspect(signal));
  const expectedBinding = bindingKey(binding);
  assertSelection(binding, actorInference);
  assertSelection(binding, fixture.guardianInference);
  const runID = randomUUID();
  const actionInstanceID = randomUUID();
  const attempts = new Set<string>();
  let busy = false;
  let locked = false;
  let cursor = 0;
  const port: TahFrameworkAttemptPortV1 = {
    async run(built, onEvent, attemptSignal) {
      // The original coordinator owns role order and its one structural repair
      // per revision. A fixed six-role list incorrectly rejected repair Actors.
      if (locked || busy || cursor >= 9
        || attempts.has(built.attempt.attemptID) || attemptSignal?.aborted)
        throw new TahAttemptExecutionErrorV1("unavailable");
      assertSelection(binding, built.attempt.inference);
      const fresh = await phone.inspect(attemptSignal);
      if (bindingKey(fresh) !== expectedBinding) {
        locked = true;
        throw new TahAttemptExecutionErrorV1("unavailable");
      }
      attempts.add(built.attempt.attemptID);
      busy = true;
      cursor++;
      const events = new NormalizedEventLedgerV1(built.attempt.attemptID);
      const request = { runID, binding: structuredClone(binding), built,
        payload: projectPhonePayload(built),
        channels: projectNativePromptChannelsV1(built.attempt.prompt) };
      try {
        const receipt = await phone.runFresh(request, async event => {
          events.observe(event);
          await onEvent?.(event);
        }, attemptSignal);
        // MUST verify externally observed OS exit and files before returning to TAH.
        const admitted = await phone.admitReaped(receipt, request);
        if (bindingKey(admitted.binding) !== expectedBinding || attemptSignal?.aborted)
          throw new TahAttemptExecutionErrorV1("unavailable");
        events.assertTerminal(admitted.result.terminal);
        return admitted.result;
      } catch {
        locked = true; // Uncertain effects never trigger an automatic relaunch.
        throw new TahAttemptExecutionErrorV1("cleanup_unconfirmed");
      } finally { busy = false; }
    },
  };
  // Original durable publisher: caller supplies storage, never acceptance booleans.
  const persistence = new DurableTahPersistence(journal, () => `qualification/${runID}`);
  const coordinator = new TahWorkflowCoordinatorV1(port, persistence);
  try {
    const raw = await coordinator.runRawSafety({ providerID: "codex",
      guardianInference: fixture.guardianInference, rawTranscript: fixture.rawTranscript,
      resources: fixture.resources, interactionLanguage: "en", ...(signal ? { signal } : {}) });
    if (raw.kind !== "allow") return { runID, stage: "raw_guardian", result: raw };
    const accepted: AcceptedRevisionInputV1[] = [];
    let ledger: import("../../../../ALMA/app/TAH/src/framework/user-instructions.js").UserInstructionLedgerV1 = [];
    for (let revisionIndex = 0; revisionIndex < 3; revisionIndex++) {
      const result = await coordinator.runRevisionCycle({ cycleID: randomUUID(), actionInstanceID,
        providerID: "codex", actionDefinition: fixture.actionDefinition, language: "en",
        interactionLanguage: "en", revisionIndex, v0AlreadyAttempted: revisionIndex > 0,
        actorInference, guardianInference: fixture.guardianInference,
        rawTranscript: fixture.rawTranscript, resources: fixture.resources,
        instructionDelta: fixture.deltas[revisionIndex]!, currentInstructions: ledger,
        webEnabled: false, acceptedRevisions: [...accepted], ...(signal ? { signal } : {}) });
      if (result.kind !== "completed") return { runID, revisionIndex, result };
      ledger = result.admittedLedger;
      accepted.push({ revisionIndex, publicationCommitID: result.publicationCommitID,
        outcome: result.outcome });
    }
    return { runID, actionInstanceID, accepted, attempts: cursor,
      scope: "synthetic V0/V1/V2 qualification, including original bounded structural repairs; not full App/security parity" };
  } finally { persistence.close(); }
}
