import { createHash, randomUUID } from "node:crypto";
import { STRUCTURED_NOTES_ACTION_DEFINITION_DIGEST } from "../framework/action-definition.js";
import { buildCandidateOutcomeV1, STRUCTURED_NOTES_OUTCOME_CONTRACT_V1 } from "../framework/outcome-contract.js";
import { evaluateOutcomeCandidateV1 } from "../framework/outcome-critic.js";
import { appendUserRevisionInstructionV1, renderUserInstructionLedgerV1 } from "../framework/user-instructions.js";
import type { TahProposalCommitRequestV1, TahPublicationCommitRequestV1 } from "../framework/workflow.js";

export function persistenceFixture(actionInstanceID = randomUUID().toLowerCase()) {
  const cycleID = randomUUID();
  const ledger = appendUserRevisionInstructionV1([], 0, "");
  const root = "outbox/revision_v0";
  // Exercise chunking using two files larger than a single private RPC frame.
  const files = new Map([[`${root}/structured-notes.md`, Buffer.from(`# Notes\n${"Multilingual 中文\n".repeat(12_000)}`)],
    [`${root}/suspicious-asr-terms.md`, Buffer.from("None.\n")]]);
  const outcome = buildCandidateOutcomeV1(root, [...files].map(([relativePath, bytes]) => ({ relativePath, kind: "file" as const, byteLength: bytes.length })), files);
  const critic = evaluateOutcomeCandidateV1(STRUCTURED_NOTES_OUTCOME_CONTRACT_V1, outcome);
  const identity = (text: string) => ({ byteLength: Buffer.byteLength(text), sha256: createHash("sha256").update(text).digest("hex") });
  const proposal: TahProposalCommitRequestV1 = { cycleID, actionInstanceID, providerID: "fixture", actionID: "structured_notes",
    revisionIndex: 0, actorInference: { modelID: "fixture-model", reasoningEffortID: null }, webEnabled: false, ledger,
    safety: { kind: "skipped_initial_v0" }, actorInput: { actionDefinitionID: "structured_notes/v1", actionDefinitionDigest: STRUCTURED_NOTES_ACTION_DEFINITION_DIGEST,
      language: "en", interactionLanguage: "en", actionInstructions: identity("fixture action"), extraInstructions: identity(renderUserInstructionLedgerV1(ledger)),
      outcomeContractID: "structured_notes/v2", rawTranscript: identity("fixture transcript"), actorPromptTemplate: identity("fixture prompt"),
      acceptedRevisions: [], basePublication: null } };
  const publication: TahPublicationCommitRequestV1 = { cycleID, actionInstanceID, providerID: "fixture", actionID: "structured_notes", revisionIndex: 0,
    proposalCommitID: `proposal/${cycleID}`, ledger, outcome, critic, criticRounds: [{ round: 0, result: critic }], actorRounds: 1,
    actorAttempts: [{ attemptID: randomUUID(), round: 0, inference: proposal.actorInference }], finalText: "Completed." };
  return { proposal, publication };
}
