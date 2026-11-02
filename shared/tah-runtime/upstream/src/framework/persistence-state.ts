import { createHash, randomUUID } from "node:crypto";
import { parseExtraGuardianAssessmentV1, parseExtraGuardianAssessmentV2 } from "./guardian-assessment.js";

function validExtraAssessmentEvidence(value: object): boolean {
  try {
    if (!hasExactKeys(value, "explanation" in value ? ["decision", "reasonCodes", "explanation"] : ["decision", "reasonCodes"])) return false;
    const assessment = value as Record<string, unknown>;
    // Journal serialization may reorder object keys; wire responses may not.
    const ordered = {decision: assessment.decision, reasonCodes: assessment.reasonCodes};
    if ("explanation" in value) parseExtraGuardianAssessmentV2(JSON.stringify({...ordered, explanation: value.explanation}));
    else parseExtraGuardianAssessmentV1(JSON.stringify(ordered)); // historical v1 journal evidence
    return true;
  } catch { return false; }
}

import { compareCanonicalUTF8V1, frozenAttemptSchema } from "../contract/index.js";
import {
  STRUCTURED_NOTES_ACTION_DEFINITION_DIGEST,
  STRUCTURED_NOTES_ACTION_DEFINITION_ID,
} from "./action-definition.js";
import {
  parseCandidateOutcomeV1,
  STRUCTURED_NOTES_OUTCOME_CONTRACT_V1,
} from "./outcome-contract.js";
import {
  evaluateOutcomeCandidateV1,
  outcomeCriticResultSchema,
} from "./outcome-critic.js";
import { renderUserInstructionLedgerV1 } from "./user-instructions.js";
import {
  TahPersistenceErrorV1,
  type TahFrameworkPersistencePortV1,
  type TahInfrastructureRetryLeaseRequestV1,
  type TahInfrastructureRetryReceiptV1,
  type TahPersistenceCommitReceiptV1,
  type TahProposalCommitRequestV1,
  type TahPublicationCommitRequestV1,
} from "./workflow.js";

interface StoredCommitV1<T> {
  readonly fingerprint: string;
  readonly request: T;
  readonly receipt: TahPersistenceCommitReceiptV1;
}

interface ActionBindingV1 {
  readonly actionID: string;
  readonly actionDefinitionID: string;
  readonly actionDefinitionDigest: string;
  readonly outcomeContractID: string;
  readonly language: string;
  readonly rawTranscript: TahProposalCommitRequestV1["actorInput"]["rawTranscript"];
}

interface StoredRetryLeaseV1 {
  readonly fingerprint: string;
  readonly request: TahInfrastructureRetryLeaseRequestV1;
  readonly receipt: TahInfrastructureRetryReceiptV1;
  state: "available" | "claimed" | "closed";
}

/**
 * Shared semantic transition validator. The prototype applies transitions in
 * memory; the App validates/replays the same transitions around a durable journal.
 */
export class TahPersistenceStateV1 implements TahFrameworkPersistencePortV1 {
  public constructor(private readonly nextRetryID: () => string = () => randomUUID().toLowerCase()) {}
  readonly #proposals = new Map<string, StoredCommitV1<TahProposalCommitRequestV1>>();
  readonly #publications = new Map<string, StoredCommitV1<TahPublicationCommitRequestV1>>();
  readonly #acceptedByAction = new Map<
    string,
    Map<number, StoredCommitV1<TahPublicationCommitRequestV1>>
  >();
  readonly #actionBindings = new Map<string, ActionBindingV1>();
  readonly #revisionReservations = new Map<
    string,
    StoredCommitV1<TahProposalCommitRequestV1>
  >();
  readonly #closedProposalCycles = new Set<string>();
  readonly #releasedProposalCycles = new Set<string>();
  readonly #retryLeases = new Map<string, StoredRetryLeaseV1>();
  readonly #retryLeaseByScope = new Map<string, StoredRetryLeaseV1>();

  public commitProposal(
    request: TahProposalCommitRequestV1,
    signal?: AbortSignal,
  ): Promise<TahPersistenceCommitReceiptV1> {
    if (signal?.aborted) return Promise.reject(new TahPersistenceErrorV1("cancelled"));
    let snapshot: TahProposalCommitRequestV1;
    let fingerprint: string;
    try {
      snapshot = immutableClone(request);
      fingerprint = fingerprintOf(snapshot);
    } catch {
      return Promise.reject(new TahPersistenceErrorV1("integrity"));
    }
    const existing = this.#proposals.get(snapshot.cycleID);
    if (existing !== undefined) {
      return existing.fingerprint === fingerprint
        && !this.#closedProposalCycles.has(snapshot.cycleID)
        ? Promise.resolve(existing.receipt)
        : Promise.reject(new TahPersistenceErrorV1("integrity"));
    }
    try {
      this.#validateProposal(snapshot);
    } catch {
      return Promise.reject(new TahPersistenceErrorV1("integrity"));
    }
    const reservationKey = revisionReservationKey(
      snapshot.actionInstanceID,
      snapshot.revisionIndex,
    );
    const reserved = this.#revisionReservations.get(reservationKey);
    if (reserved !== undefined) {
      if (!this.#isExactUserSupersession(reserved, snapshot)) {
        return Promise.reject(new TahPersistenceErrorV1("integrity"));
      }
      this.#revisionReservations.delete(reservationKey);
      this.#closeRetryLeases(reserved.request.cycleID);
      this.#closedProposalCycles.add(reserved.request.cycleID);
    }
    const receipt = Object.freeze({ commitID: `proposal/${snapshot.cycleID}` });
    const stored = Object.freeze({
      fingerprint,
      request: snapshot,
      receipt,
    });
    this.#proposals.set(snapshot.cycleID, stored);
    this.#revisionReservations.set(reservationKey, stored);
    if (!this.#actionBindings.has(snapshot.actionInstanceID)) {
      this.#actionBindings.set(
        snapshot.actionInstanceID,
        actionBinding(snapshot),
      );
    }
    return Promise.resolve(receipt);
  }

  public publishRevision(
    request: TahPublicationCommitRequestV1,
    signal?: AbortSignal,
  ): Promise<TahPersistenceCommitReceiptV1> {
    if (signal?.aborted) return Promise.reject(new TahPersistenceErrorV1("cancelled"));
    let snapshot: TahPublicationCommitRequestV1;
    let fingerprint: string;
    try {
      snapshot = immutableClone(request);
      fingerprint = fingerprintOf(snapshot);
    } catch {
      return Promise.reject(new TahPersistenceErrorV1("integrity"));
    }
    const existing = this.#publications.get(snapshot.cycleID);
    if (existing !== undefined) {
      return existing.fingerprint === fingerprint
        ? Promise.resolve(existing.receipt)
        : Promise.reject(new TahPersistenceErrorV1("integrity"));
    }
    try {
      this.#validatePublication(snapshot);
    } catch {
      return Promise.reject(new TahPersistenceErrorV1("integrity"));
    }
    const action = this.#acceptedByAction.get(snapshot.actionInstanceID) ?? new Map();
    const previous = action.get(snapshot.revisionIndex);
    if (previous !== undefined) {
      return Promise.reject(new TahPersistenceErrorV1("integrity"));
    }
    const receipt = Object.freeze({ commitID: `publication/${snapshot.cycleID}` });
    const stored = Object.freeze({
      fingerprint,
      request: snapshot,
      receipt,
    });
    this.#publications.set(snapshot.cycleID, stored);
    action.set(snapshot.revisionIndex, stored);
    this.#acceptedByAction.set(snapshot.actionInstanceID, action);
    this.#revisionReservations.delete(revisionReservationKey(
      snapshot.actionInstanceID,
      snapshot.revisionIndex,
    ));
    this.#closeRetryLeases(snapshot.cycleID);
    this.#closedProposalCycles.add(snapshot.cycleID);
    return Promise.resolve(receipt);
  }

  public releaseProposalReservation(request: Readonly<{
    cycleID: string;
    actionInstanceID: string;
    revisionIndex: number;
    proposalCommitID: string;
  }>): Promise<void> {
    const proposal = this.#proposals.get(request.cycleID);
    if (proposal === undefined
      || proposal.receipt.commitID !== request.proposalCommitID
      || proposal.request.actionInstanceID !== request.actionInstanceID
      || proposal.request.revisionIndex !== request.revisionIndex) {
      return Promise.reject(new TahPersistenceErrorV1("integrity"));
    }
    if (this.#publications.has(request.cycleID)) {
      return Promise.reject(new TahPersistenceErrorV1("integrity"));
    }
    if (this.#releasedProposalCycles.has(request.cycleID)) return Promise.resolve();
    const key = revisionReservationKey(request.actionInstanceID, request.revisionIndex);
    const reserved = this.#revisionReservations.get(key);
    if (reserved === undefined || reserved.request.cycleID !== request.cycleID) {
      return Promise.reject(new TahPersistenceErrorV1("integrity"));
    }
    this.#revisionReservations.delete(key);
    this.#closeRetryLeases(request.cycleID);
    this.#releasedProposalCycles.add(request.cycleID);
    this.#closedProposalCycles.add(request.cycleID);
    return Promise.resolve();
  }

  public retainInfrastructureRetryLease(
    request: TahInfrastructureRetryLeaseRequestV1,
  ): Promise<TahInfrastructureRetryReceiptV1> {
    let snapshot: TahInfrastructureRetryLeaseRequestV1;
    let fingerprint: string;
    try {
      snapshot = immutableClone(request);
      fingerprint = fingerprintOf(snapshot);
      this.#validateRetryLease(snapshot);
    } catch {
      return Promise.reject(new TahPersistenceErrorV1("integrity"));
    }
    const scope = retryLeaseScope(snapshot);
    const existing = this.#retryLeaseByScope.get(scope);
    if (existing !== undefined) {
      return existing.fingerprint === fingerprint && existing.state === "available"
        ? Promise.resolve(existing.receipt)
        : Promise.reject(new TahPersistenceErrorV1("integrity"));
    }
    const receipt = Object.freeze({
      schemaVersion: 1 as const,
      opaqueRetryID: this.nextRetryID(),
    });
    const stored: StoredRetryLeaseV1 = {
      fingerprint,
      request: snapshot,
      receipt,
      state: "available",
    };
    this.#retryLeases.set(receipt.opaqueRetryID, stored);
    this.#retryLeaseByScope.set(scope, stored);
    return Promise.resolve(receipt);
  }

  public claimInfrastructureRetryLease(request: Readonly<{
    lease: TahInfrastructureRetryLeaseRequestV1;
    receipt: TahInfrastructureRetryReceiptV1;
  }>): Promise<void> {
    let lease: TahInfrastructureRetryLeaseRequestV1;
    try {
      if (!hasExactKeys(request, ["lease", "receipt"])
        || !isRetryReceipt(request.receipt)) {
        throw new Error("retry claim is invalid");
      }
      lease = immutableClone(request.lease);
      this.#validateRetryLease(lease);
    } catch {
      return Promise.reject(new TahPersistenceErrorV1("integrity"));
    }
    const stored = this.#retryLeases.get(request.receipt.opaqueRetryID);
    if (stored === undefined
      || stored.state !== "available"
      || stored.fingerprint !== fingerprintOf(lease)
      || stored.receipt.schemaVersion !== request.receipt.schemaVersion) {
      return Promise.reject(new TahPersistenceErrorV1("integrity"));
    }
    stored.state = "claimed";
    return Promise.resolve();
  }

  public acceptedPublications(actionInstanceID: string): readonly TahPublicationCommitRequestV1[] {
    return Object.freeze(
      [...(this.#acceptedByAction.get(actionInstanceID)?.values() ?? [])]
        .map(({ request }) => request)
        .sort((left, right) => left.revisionIndex - right.revisionIndex),
    );
  }

  #validateRetryLease(request: TahInfrastructureRetryLeaseRequestV1): void {
    const proposal = this.#proposals.get(request.cycleID);
    const reservation = this.#revisionReservations.get(revisionReservationKey(
      request.actionInstanceID,
      request.revisionIndex,
    ));
    if (!hasExactKeys(request, [
      "actionInstanceID",
      "actorAttemptID",
      "cycleID",
      "proposalCommitID",
      "retryInputDigest",
      "revisionIndex",
      "round",
      "stage",
    ])
      || proposal === undefined
      || reservation?.request.cycleID !== request.cycleID
      || proposal.receipt.commitID !== request.proposalCommitID
      || proposal.request.actionInstanceID !== request.actionInstanceID
      || proposal.request.revisionIndex !== request.revisionIndex
      || this.#closedProposalCycles.has(request.cycleID)
      || this.#publications.has(request.cycleID)
      || (request.stage !== "actor" && request.stage !== "publication_commit")
      || (request.round !== 0 && request.round !== 1)
      || !isUUID(request.actorAttemptID)
      || !isSHA256(request.retryInputDigest)) {
      throw new Error("retry lease has no active proposal authority");
    }
  }

  #closeRetryLeases(cycleID: string): void {
    for (const lease of this.#retryLeases.values()) {
      if (lease.request.cycleID === cycleID) lease.state = "closed";
    }
  }

  #isExactUserSupersession(
    reserved: StoredCommitV1<TahProposalCommitRequestV1>,
    next: TahProposalCommitRequestV1,
  ): boolean {
    if (next.cycleID === reserved.request.cycleID
      || !["extra_guardian_allow", "extra_guardian_pass"].includes(next.safety.kind)
      || ![...this.#retryLeases.values()].some((lease) =>
        lease.request.cycleID === reserved.request.cycleID
          && lease.request.stage === "actor"
          && lease.state === "available"
      )
      || !ledgerAddsOneUserRetry(reserved.request.ledger, next.ledger)) {
      return false;
    }
    return fingerprintOf(stableActorInput(reserved.request.actorInput))
      === fingerprintOf(stableActorInput(next.actorInput));
  }

  #validateProposal(request: TahProposalCommitRequestV1): void {
    assertUUID(request.cycleID);
    assertUUID(request.actionInstanceID);
    if (!hasExactKeys(request, [
      "actionID",
      "actionInstanceID",
      "actorInference",
      "actorInput",
      "cycleID",
      "ledger",
      "providerID",
      "revisionIndex",
      "safety",
      "webEnabled",
    ])
      || !Number.isSafeInteger(request.revisionIndex) || request.revisionIndex < 0
      || !/^[a-z][a-z0-9_-]*$/u.test(request.providerID)
      || request.actionID !== "structured_notes"
      || typeof request.webEnabled !== "boolean"
      || !isInference(request.actorInference)
      || !Array.isArray(request.ledger)
      || !isCommitIdentityInput(request.actorInput)
      || request.actorInput.actionDefinitionID !== STRUCTURED_NOTES_ACTION_DEFINITION_ID
      || request.actorInput.actionDefinitionDigest !== STRUCTURED_NOTES_ACTION_DEFINITION_DIGEST
      || request.actorInput.outcomeContractID !== STRUCTURED_NOTES_OUTCOME_CONTRACT_V1.contractID) {
      throw new Error("proposal identity is invalid");
    }
    const renderedLedger = renderUserInstructionLedgerV1(request.ledger);
    if (request.ledger.length !== request.revisionIndex + 1
      || fingerprintOf(contentIdentity(renderedLedger))
        !== fingerprintOf(request.actorInput.extraInstructions)
      || request.ledger.some((entry) => !hasExactKeys(entry, [
        "initial",
        "retries",
        "revisionIndex",
      ]))) {
      throw new Error("proposal instruction ledger is invalid");
    }
    const binding = actionBinding(request);
    const existingBinding = this.#actionBindings.get(request.actionInstanceID);
    if (existingBinding !== undefined
      && fingerprintOf(existingBinding) !== fingerprintOf(binding)) {
      throw new Error("Action instance identity changed");
    }

    const accepted = request.actorInput.acceptedRevisions;
    if (accepted.some((revision, index) =>
      !Number.isSafeInteger(revision.revisionIndex)
      || revision.revisionIndex < 0
      || (index > 0 && revision.revisionIndex <= accepted[index - 1]!.revisionIndex)
      || !isCommitID(revision.publicationCommitID)
      || !isSHA256(revision.candidateDigest))) {
      throw new Error("accepted revision identity list is invalid");
    }
    const base = request.actorInput.basePublication;
    if (request.revisionIndex === 0) {
      if (base !== null || accepted.length !== 0
        || (this.#acceptedByAction.get(request.actionInstanceID)?.size ?? 0) !== 0) {
        throw new Error("v0 proposal has an accepted base");
      }
    } else {
      const last = accepted.at(-1);
      const storedBase = this.#acceptedByAction
        .get(request.actionInstanceID)
        ?.get(request.revisionIndex - 1);
      if (base === null || last === undefined || storedBase === undefined
        || base.revisionIndex !== request.revisionIndex - 1
        || fingerprintOf(base) !== fingerprintOf(last)
        || base.publicationCommitID !== storedBase.receipt.commitID
        || base.candidateDigest !== storedBase.request.outcome.candidateDigest) {
        throw new Error("proposal is not based on the persisted accepted revision");
      }
    }
    const storedAction = this.#acceptedByAction.get(request.actionInstanceID);
    for (const revision of accepted) {
      const stored = storedAction?.get(revision.revisionIndex);
      if (stored === undefined
        || stored.receipt.commitID !== revision.publicationCommitID
        || stored.request.outcome.candidateDigest !== revision.candidateDigest) {
        throw new Error("accepted history identity disagrees with persistence");
      }
    }

    if (request.safety.kind === "skipped_initial_v0") {
      const earlierV0 = [...this.#proposals.values()].some(({ request: proposal }) =>
        proposal.actionInstanceID === request.actionInstanceID
          && proposal.revisionIndex === 0
          && !this.#releasedProposalCycles.has(proposal.cycleID)
      );
      const v0 = request.ledger[0];
      if (!hasExactKeys(request.safety, ["kind"])
        || request.revisionIndex !== 0 || earlierV0
        || v0?.initial !== null || v0.retries.length !== 0) {
        throw new Error("Empty v0 requires no unreleased proposal or accepted publication");
      }
    } else if (request.safety.kind === "extra_guardian_pass") {
      if (!hasExactKeys(request.safety, ["attemptID", "inference", "kind"])
        || !isUUID(request.safety.attemptID) || !isInference(request.safety.inference)) {
        throw new Error("Extra Guardian admission is invalid");
      }
    } else if (!hasExactKeys(request.safety, ["assessment", "attemptID", "inference", "kind"])
      || !validExtraAssessmentEvidence(request.safety.assessment)
      || request.safety.assessment.decision !== "ALLOW"
      || !Array.isArray(request.safety.assessment.reasonCodes)
      || request.safety.assessment.reasonCodes.length !== 0
      || !isUUID(request.safety.attemptID)
      || !isInference(request.safety.inference)) {
      throw new Error("Extra Guardian evidence is invalid");
    }
  }

  #validatePublication(request: TahPublicationCommitRequestV1): void {
    const proposal = this.#proposals.get(request.cycleID);
    const reservation = this.#revisionReservations.get(revisionReservationKey(
      request.actionInstanceID,
      request.revisionIndex,
    ));
    if (!hasExactKeys(request, [
      "actionID",
      "actionInstanceID",
      "actorAttempts",
      "actorRounds",
      "critic",
      "criticRounds",
      "cycleID",
      "finalText",
      "ledger",
      "outcome",
      "proposalCommitID",
      "providerID",
      "revisionIndex",
    ])
      || proposal === undefined
      || reservation?.request.cycleID !== request.cycleID
      || proposal.receipt.commitID !== request.proposalCommitID
      || proposal.request.actionInstanceID !== request.actionInstanceID
      || proposal.request.providerID !== request.providerID
      || proposal.request.actionID !== request.actionID
      || proposal.request.revisionIndex !== request.revisionIndex
      || fingerprintOf(proposal.request.ledger) !== fingerprintOf(request.ledger)) {
      throw new Error("publication has no exact committed proposal");
    }
    const outcome = parseCandidateOutcomeV1(request.outcome);
    const critic = outcomeCriticResultSchema.parse(request.critic);
    const authoritativeCritic = evaluateOutcomeCandidateV1(
      STRUCTURED_NOTES_OUTCOME_CONTRACT_V1,
      outcome,
    );
    const criticRounds = request.criticRounds.map(({ round, result }) => ({
      round,
      result: outcomeCriticResultSchema.parse(result),
    }));
    const expectedRounds = request.actorRounds === 1 ? [0] : [0, 1];
    const attemptIDs = request.actorAttempts.map(({ attemptID }) => attemptID);
    const lastCritic = criticRounds.at(-1)?.result;
    if ((request.actorRounds !== 1 && request.actorRounds !== 2)
      || typeof request.finalText !== "string"
      || Buffer.byteLength(request.finalText, "utf8") > 64 * 1024
      || outcome.writableRoot !== `outbox/revision_v${request.revisionIndex}`
      || critic.decision !== "PASS"
      || fingerprintOf(critic) !== fingerprintOf(authoritativeCritic)
      || critic.candidateDigest !== outcome.candidateDigest
      || critic.contractID !== proposal.request.actorInput.outcomeContractID
      || fingerprintOf(critic) !== fingerprintOf(lastCritic)
      || criticRounds.length !== request.actorRounds
      || request.actorAttempts.length !== request.actorRounds
      || request.criticRounds.some((round) => !hasExactKeys(round, ["result", "round"]))
      || request.actorAttempts.some((attempt) =>
        !hasExactKeys(attempt, ["attemptID", "inference", "round"]))
      || criticRounds.some(({ result }) =>
        result.contractID !== proposal.request.actorInput.outcomeContractID)
      || criticRounds.some(({ round }, index) => round !== expectedRounds[index])
      || request.actorAttempts.some(({ round }, index) => round !== expectedRounds[index])
      || (request.actorRounds === 2 && criticRounds[0]?.result.decision !== "REJECT")
      || (request.actorRounds === 2
        && criticRounds[0]?.result.candidateDigest === outcome.candidateDigest)
      || lastCritic?.decision !== "PASS"
      || lastCritic.candidateDigest !== outcome.candidateDigest
      || attemptIDs.some((attemptID) => !isUUID(attemptID))
      || new Set(attemptIDs).size !== attemptIDs.length
      || (proposal.request.safety.kind !== "skipped_initial_v0"
        && attemptIDs.includes(proposal.request.safety.attemptID))
      || request.actorAttempts.some(({ inference }) =>
        !isInference(inference)
          || fingerprintOf(inference) !== fingerprintOf(proposal.request.actorInference))) {
      throw new Error("publication evidence is inconsistent");
    }
    const action = this.#acceptedByAction.get(request.actionInstanceID);
    const acceptedIndices = [...(action?.keys() ?? [])].sort((left, right) => left - right);
    if (request.revisionIndex === 0) {
      if (acceptedIndices.length !== 0 && !action?.has(0)) {
        throw new Error("v0 publication is not the first revision");
      }
    } else if (!action?.has(request.revisionIndex - 1)) {
      throw new Error("publication skipped the previous accepted revision");
    }
  }
}

function actionBinding(request: TahProposalCommitRequestV1): ActionBindingV1 {
  return Object.freeze({
    actionID: request.actionID,
    actionDefinitionID: request.actorInput.actionDefinitionID,
    actionDefinitionDigest: request.actorInput.actionDefinitionDigest,
    outcomeContractID: request.actorInput.outcomeContractID,
    language: request.actorInput.language,
    rawTranscript: Object.freeze({ ...request.actorInput.rawTranscript }),
  });
}

function isCommitIdentityInput(value: TahProposalCommitRequestV1["actorInput"]): boolean {
  return typeof value === "object" && value !== null
    && hasExactKeys(value, [
      "acceptedRevisions",
      "actionDefinitionDigest",
      "actionDefinitionID",
      "actionInstructions",
      "actorPromptTemplate",
      "basePublication",
      "extraInstructions",
      "language",
      "interactionLanguage",
      "outcomeContractID",
      "rawTranscript",
    ])
    && isSHA256(value.actionDefinitionDigest)
    && (value.language === "zh-CN" || value.language === "en")
    && (value.interactionLanguage === "zh-CN" || value.interactionLanguage === "en")
    && isContentIdentity(value.actionInstructions)
    && isContentIdentity(value.extraInstructions)
    && isContentIdentity(value.rawTranscript)
    && isContentIdentity(value.actorPromptTemplate)
    && Array.isArray(value.acceptedRevisions)
    && value.acceptedRevisions.every((revision) => typeof revision === "object"
      && revision !== null
      && hasExactKeys(revision, ["candidateDigest", "publicationCommitID", "revisionIndex"]))
    && (value.basePublication === null
      || (hasExactKeys(value.basePublication, [
        "candidateDigest",
        "publicationCommitID",
        "revisionIndex",
      ])
        && Number.isSafeInteger(value.basePublication.revisionIndex)
        && isCommitID(value.basePublication.publicationCommitID)
        && isSHA256(value.basePublication.candidateDigest)));
}

function isContentIdentity(value: unknown): boolean {
  return typeof value === "object" && value !== null
    && hasExactKeys(value, ["byteLength", "sha256"])
    && Number.isSafeInteger(Reflect.get(value, "byteLength"))
    && (Reflect.get(value, "byteLength") as number) >= 0
    && isSHA256(Reflect.get(value, "sha256"));
}

function isInference(value: unknown): boolean {
  // Share the closed attempt contract, including optional capacity. Publication
  // still compares the complete inference fingerprint against its proposal.
  return frozenAttemptSchema.shape.inference.safeParse(value).success;
}

function isSHA256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isCommitID(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value);
}

function isUUID(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value);
}

function assertUUID(value: unknown): asserts value is string {
  if (!isUUID(value)) throw new Error("persistence identity is invalid");
}

function revisionReservationKey(actionInstanceID: string, revisionIndex: number): string {
  return `${actionInstanceID}\0${String(revisionIndex)}`;
}

function retryLeaseScope(request: TahInfrastructureRetryLeaseRequestV1): string {
  return [request.cycleID, request.stage, String(request.round)].join("\0");
}

function isRetryReceipt(value: unknown): value is TahInfrastructureRetryReceiptV1 {
  return typeof value === "object" && value !== null
    && hasExactKeys(value, ["opaqueRetryID", "schemaVersion"])
    && Reflect.get(value, "schemaVersion") === 1
    && isUUID(Reflect.get(value, "opaqueRetryID"));
}

function ledgerAddsOneUserRetry(
  previous: TahProposalCommitRequestV1["ledger"],
  next: TahProposalCommitRequestV1["ledger"],
): boolean {
  if (previous.length === 0 || next.length !== previous.length) return false;
  const previousLast = previous.at(-1)!;
  const nextLast = next.at(-1);
  if (nextLast === undefined
    || previousLast.revisionIndex !== nextLast.revisionIndex
    || previousLast.initial !== nextLast.initial
    || nextLast.retries.length !== previousLast.retries.length + 1
    || previousLast.retries.some((retry, index) => retry !== nextLast.retries[index])
    || nextLast.retries.at(-1)?.length === 0) {
    return false;
  }
  return previous.slice(0, -1).every((entry, index) =>
    fingerprintOf(entry) === fingerprintOf(next[index])
  );
}

function stableActorInput(
  input: TahProposalCommitRequestV1["actorInput"],
): Omit<TahProposalCommitRequestV1["actorInput"], "extraInstructions"> {
  return {
    actionDefinitionID: input.actionDefinitionID,
    actionDefinitionDigest: input.actionDefinitionDigest,
    language: input.language,
    interactionLanguage: input.interactionLanguage,
    actionInstructions: input.actionInstructions,
    outcomeContractID: input.outcomeContractID,
    rawTranscript: input.rawTranscript,
    actorPromptTemplate: input.actorPromptTemplate,
    acceptedRevisions: input.acceptedRevisions,
    basePublication: input.basePublication,
  };
}

function contentIdentity(value: string): Readonly<{ byteLength: number; sha256: string }> {
  const bytes = Buffer.from(value, "utf8");
  return Object.freeze({
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function hasExactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareCanonicalUTF8V1);
  const sortedExpected = [...expected].sort(compareCanonicalUTF8V1);
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function fingerprintOf(value: unknown): string {
  return canonicalJSON(value);
}

function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TahPersistenceErrorV1("integrity");
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (typeof value !== "object") throw new TahPersistenceErrorV1("integrity");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareCanonicalUTF8V1);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`).join(",")}}`;
}

function immutableClone<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
