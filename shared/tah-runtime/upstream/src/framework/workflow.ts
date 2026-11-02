import { createHash, randomUUID } from "node:crypto";

import {
  compareCanonicalUTF8V1,
  type AttemptTerminalV1,
  type NormalizedEventV1,
  type TahAttemptResultV1,
} from "../contract/index.js";
import {
  assertRegisteredActionDefinitionV1,
  type TahActionDefinitionV1,
  type TahNoteLanguageV1,
} from "./action-definition.js";
import {
  buildActorAttemptV1,
  buildExtraGuardianAttemptV1,
  buildRawGuardianAttemptV1,
  type AcceptedRevisionInputV1,
  type AttemptInferenceV1,
  type BuiltAttemptV1,
} from "./attempt-builders.js";
import {
  parseExtraGuardianAssessmentV2,
  parseRawGuardianAssessmentV2,
  type ExtraGuardianAssessmentV1,
  type RawGuardianAssessmentV1,
  type ExtraGuardianAssessmentV2,
  type RawGuardianAssessmentV2,
} from "./guardian-assessment.js";
import {
  buildCandidateOutcomeV1,
  parseCandidateOutcomeV1,
  type CandidateOutcomeV1,
  type StructuredOutcomeContractV1,
} from "./outcome-contract.js";
import {
  evaluateOutcomeCandidateV1,
  OutcomeCriticRenderError,
  renderCriticInstructionsV1,
  type OutcomeCriticResultV1,
} from "./outcome-critic.js";
import {
  appendUserRetryInstructionV1,
  appendUserRevisionInstructionV1,
  renderUserInstructionLedgerV1,
  type UserInstructionLedgerV1,
} from "./user-instructions.js";

export const TAH_MAX_ATTEMPT_IDENTITIES_PER_PROCESS = 65_536;

export interface TahFrameworkAttemptPortV1 {
  run(
    attempt: BuiltAttemptV1,
    onEvent?: (event: NormalizedEventV1) => void | Promise<void>,
    signal?: AbortSignal,
  ): Promise<TahAttemptResultV1>;
}

export class TahAttemptExecutionErrorV1 extends Error {
  public constructor(
    public readonly category: "cancelled" | "unavailable" | "cleanup_unconfirmed",
  ) {
    super("TAH attempt execution failed");
    this.name = "TahAttemptExecutionErrorV1";
  }
}

export interface TahPersistenceCommitReceiptV1 {
  readonly commitID: string;
}

export interface TahInfrastructureRetryReceiptV1 {
  readonly schemaVersion: 1;
  /** Opaque authority. Callers must not parse or synthesize it. */
  readonly opaqueRetryID: string;
}

/** Versioned, digest-bound Host-owned context; never a Provider-native session. */
export interface TahRetryCheckpointV1 {
  readonly schemaVersion: 1;
  readonly dataBase64: string;
  readonly sha256: string;
}

export interface TahInfrastructureRetryLeaseRequestV1 {
  readonly cycleID: string;
  readonly actionInstanceID: string;
  readonly revisionIndex: number;
  readonly proposalCommitID: string;
  readonly stage: "actor" | "publication_commit";
  readonly round: 0 | 1;
  readonly actorAttemptID: string;
  readonly retryInputDigest: string;
}

export interface RetryTahInfrastructureV1 {
  readonly receipt: TahInfrastructureRetryReceiptV1;
  readonly actionInstanceID?: string;
  readonly onEvent?: TahWorkflowEventObserverV1;
  readonly signal?: AbortSignal;
}

export interface TahContentIdentityV1 {
  readonly byteLength: number;
  readonly sha256: string;
}

export interface TahAcceptedRevisionIdentityV1 {
  readonly revisionIndex: number;
  readonly publicationCommitID: string;
  readonly candidateDigest: string;
}

export interface TahActorInputIdentityV1 {
  readonly actionDefinitionID: string;
  readonly actionDefinitionDigest: string;
  readonly language: TahNoteLanguageV1;
  readonly interactionLanguage: TahNoteLanguageV1;
  readonly actionInstructions: TahContentIdentityV1;
  readonly extraInstructions: TahContentIdentityV1;
  readonly outcomeContractID: string;
  readonly rawTranscript: TahContentIdentityV1;
  readonly actorPromptTemplate: TahContentIdentityV1;
  readonly acceptedRevisions: readonly TahAcceptedRevisionIdentityV1[];
  readonly basePublication: TahAcceptedRevisionIdentityV1 | null;
}

export type TahProposalSafetyEvidenceV1 =
  | Readonly<{ kind: "skipped_initial_v0" }>
  | Readonly<{ kind: "extra_guardian_pass"; attemptID: string; inference: AttemptInferenceV1 }>
  | Readonly<{
      kind: "extra_guardian_allow";
      attemptID: string;
      assessment: ExtraGuardianAssessmentV1 | ExtraGuardianAssessmentV2;
      inference: AttemptInferenceV1;
    }>;

export interface TahProposalCommitRequestV1 {
  readonly cycleID: string;
  readonly actionInstanceID: string;
  readonly providerID: string;
  readonly actionID: string;
  readonly revisionIndex: number;
  readonly actorInference: AttemptInferenceV1;
  readonly webEnabled: boolean;
  readonly ledger: UserInstructionLedgerV1;
  readonly safety: TahProposalSafetyEvidenceV1;
  readonly actorInput: TahActorInputIdentityV1;
}

export interface TahCriticRoundV1 {
  readonly round: 0 | 1;
  readonly result: OutcomeCriticResultV1;
}

export interface TahPublicationCommitRequestV1 {
  readonly cycleID: string;
  readonly actionInstanceID: string;
  readonly providerID: string;
  readonly actionID: string;
  readonly revisionIndex: number;
  readonly proposalCommitID: string;
  readonly ledger: UserInstructionLedgerV1;
  readonly outcome: CandidateOutcomeV1;
  readonly critic: OutcomeCriticResultV1;
  readonly criticRounds: readonly TahCriticRoundV1[];
  readonly actorRounds: 1 | 2;
  readonly actorAttempts: readonly Readonly<{
    attemptID: string;
    round: 0 | 1;
    inference: AttemptInferenceV1;
  }>[];
  readonly finalText: string;
}

/**
 * A transient save failure must keep the returned Promise pending while the
 * App exposes Retry Save. Rejection means cancellation before linearization or
 * an integrity failure; it must never mean "commit may have succeeded".
 */
export interface TahFrameworkPersistencePortV1 {
  commitProposal(
    request: TahProposalCommitRequestV1,
    signal?: AbortSignal,
  ): Promise<TahPersistenceCommitReceiptV1>;
  publishRevision(
    request: TahPublicationCommitRequestV1,
    signal?: AbortSignal,
  ): Promise<TahPersistenceCommitReceiptV1>;
  releaseProposalReservation(
    request: Readonly<{
      cycleID: string;
      actionInstanceID: string;
      revisionIndex: number;
      proposalCommitID: string;
    }>,
  ): Promise<void>;
  retainInfrastructureRetryLease(
    request: TahInfrastructureRetryLeaseRequestV1,
    checkpoint?: TahRetryCheckpointV1,
  ): Promise<TahInfrastructureRetryReceiptV1>;
  loadInfrastructureRetryCheckpoint?(
    receipt: TahInfrastructureRetryReceiptV1,
    actionInstanceID: string,
  ): Promise<TahRetryCheckpointV1 | null>;
  claimInfrastructureRetryLease(
    request: Readonly<{
      lease: TahInfrastructureRetryLeaseRequestV1;
      receipt: TahInfrastructureRetryReceiptV1;
    }>,
  ): Promise<void>;
}

export class TahPersistenceErrorV1 extends Error {
  public constructor(public readonly category: "cancelled" | "integrity") {
    super("TAH persistence operation did not reach its linearization point");
    this.name = "TahPersistenceErrorV1";
  }
}

export type TahAttemptScopeV1 =
  | Readonly<{ role: "raw_guardian" }>
  | Readonly<{ role: "extra_guardian" }>
  | Readonly<{ role: "actor"; round: 0 | 1 }>;

export type TahWorkflowEventObserverV1 = (
  scope: TahAttemptScopeV1,
  event: NormalizedEventV1,
) => void | Promise<void>;

export interface TahWorkflowResourcesV1 {
  readonly rawGuardianPrompt: string;
  readonly extraGuardianPrompt: string;
  readonly safetyPolicy: string;
  readonly actorPromptTemplate: string;
}

export interface RunRawSafetyV1 {
  readonly interactionLanguage?: TahNoteLanguageV1;
  readonly providerID: string;
  readonly guardianInference: AttemptInferenceV1;
  readonly rawTranscript: string | Uint8Array;
  readonly resources: TahWorkflowResourcesV1;
  readonly onEvent?: TahWorkflowEventObserverV1;
  readonly signal?: AbortSignal;
}

export type RawSafetyResultV1 =
  | Readonly<{
      kind: "allow" | "block";
      attemptID: string;
      assessment: RawGuardianAssessmentV1 | RawGuardianAssessmentV2;
    }>
  | Readonly<{ kind: "cancelled"; attemptID: string }>
  | Readonly<{ kind: "integrity_locked"; attemptID: string }>
  | Readonly<{
      kind: "unavailable";
      attemptID: string;
      terminal: AttemptTerminalV1;
    }>;

export interface RunRevisionCycleV1 {
  /** Display-only evidence after strict parsing and confirmed Guest destruction. */
  readonly onSafetyAssessment?: (assessment: ExtraGuardianAssessmentV2) => void;
  readonly cycleID: string;
  readonly actionInstanceID: string;
  readonly providerID: string;
  readonly actionDefinition: TahActionDefinitionV1;
  readonly language: TahNoteLanguageV1;
  readonly interactionLanguage?: TahNoteLanguageV1;
  readonly revisionIndex: number;
  readonly v0AlreadyAttempted: boolean;
  readonly actorInference: AttemptInferenceV1;
  readonly guardianInference: AttemptInferenceV1;
  readonly rawTranscript: string | Uint8Array;
  readonly instructionDelta: string;
  readonly currentInstructions: UserInstructionLedgerV1;
  readonly webEnabled: boolean;
  readonly acceptedRevisions: readonly AcceptedRevisionInputV1[];
  readonly resources: TahWorkflowResourcesV1;
  readonly onEvent?: TahWorkflowEventObserverV1;
  readonly signal?: AbortSignal;
}

export type RevisionCycleResultV1 =
  | Readonly<{
      kind: "extra_blocked";
      assessment: ExtraGuardianAssessmentV1 | ExtraGuardianAssessmentV2;
      attemptedLedger: UserInstructionLedgerV1;
      criticRounds?: undefined;
    }>
  | Readonly<{
      kind: "extra_unavailable";
      terminal: AttemptTerminalV1;
      attemptedLedger: UserInstructionLedgerV1;
      criticRounds?: undefined;
    }>
  | Readonly<{
      kind: "cancelled";
      stage: "extra_guardian" | "proposal_commit";
      attemptedLedger: UserInstructionLedgerV1;
      admittedLedger?: undefined;
      proposalCommitID?: undefined;
      round?: undefined;
      infrastructureRetry?: undefined;
      criticRounds?: undefined;
    }>
  | Readonly<{
      kind: "integrity_locked";
      stage: "extra_guardian" | "proposal_commit";
      attemptedLedger: UserInstructionLedgerV1;
      admittedLedger?: undefined;
      proposalCommitID?: undefined;
      round?: undefined;
      infrastructureRetry?: undefined;
      criticRounds?: undefined;
    }>
  | Readonly<{
      kind: "cancelled" | "integrity_locked";
      stage: "actor" | "publication_commit";
      attemptedLedger: UserInstructionLedgerV1;
      admittedLedger: UserInstructionLedgerV1;
      proposalCommitID: string;
      round: 0 | 1;
      criticRounds: readonly TahCriticRoundV1[];
      infrastructureRetry?: TahInfrastructureRetryReceiptV1;
    }>
  | Readonly<{
      kind: "completed";
      admittedLedger: UserInstructionLedgerV1;
      proposalCommitID: string;
      publicationCommitID: string;
      outcome: CandidateOutcomeV1;
      criticRounds: readonly TahCriticRoundV1[];
      actorRounds: 1 | 2;
      finalText: string;
    }>
  | Readonly<{
      kind: "actor_failed";
      admittedLedger: UserInstructionLedgerV1;
      proposalCommitID: string;
      round: 0 | 1;
      terminal?: AttemptTerminalV1;
      reason: "execution_failed" | "contract_exhausted";
      criticRounds: readonly TahCriticRoundV1[];
      infrastructureRetry?: TahInfrastructureRetryReceiptV1;
    }>;

export class TahWorkflowCoordinatorV1 {
  readonly #attempts: TahFrameworkAttemptPortV1;
  readonly #persistence: TahFrameworkPersistencePortV1;
  readonly #nextAttemptID: () => string;
  readonly #infrastructureRetries = new Map<string, InfrastructureRetryPlanV1>();
  readonly #issuedAttemptIDs = new Set<string>();

  public constructor(
    attempts: TahFrameworkAttemptPortV1,
    persistence: TahFrameworkPersistencePortV1,
    nextAttemptID: () => string = () => randomUUID().toLowerCase(),
  ) {
    this.#attempts = attempts;
    this.#persistence = persistence;
    this.#nextAttemptID = nextAttemptID;
  }

  public async runRawSafety(input: RunRawSafetyV1): Promise<RawSafetyResultV1> {
    const built = buildRawGuardianAttemptV1({
      attemptID: this.#freshAttemptID(),
      providerID: input.providerID,
      inference: input.guardianInference,
      guardianPrompt: input.resources.rawGuardianPrompt,
      interactionLanguage: input.interactionLanguage ?? "en",
      safetyPolicy: input.resources.safetyPolicy,
      rawTranscript: input.rawTranscript,
    });
    let result: TahAttemptResultV1;
    try {
      result = await this.#run(built, { role: "raw_guardian" }, input.onEvent, input.signal);
    } catch (error) {
      return rawAttemptError(built.attempt.attemptID, error);
    }
    if (result.terminal.kind === "cancelled") {
      return Object.freeze({ kind: "cancelled", attemptID: built.attempt.attemptID });
    }
    if (terminalHasCleanupUncertainty(result.terminal)) {
      return Object.freeze({ kind: "integrity_locked", attemptID: built.attempt.attemptID });
    }
    if (result.terminal.kind !== "end_turn") {
      return Object.freeze({
        kind: "unavailable",
        attemptID: built.attempt.attemptID,
        terminal: result.terminal,
      });
    }
    let assessment: RawGuardianAssessmentV2;
    try {
      assertNoCandidates(result);
      assessment = parseRawGuardianAssessmentV2(result.terminal.finalText);
    } catch {
      return Object.freeze({
        kind: "unavailable",
        attemptID: built.attempt.attemptID,
        terminal: frameworkUnavailableTerminal("raw_guardian_invalid_result"),
      });
    }
    return Object.freeze({
      kind: assessment.decision === "ALLOW" ? "allow" : "block",
      attemptID: built.attempt.attemptID,
      assessment,
    });
  }

  public async runRevisionCycle(input: RunRevisionCycleV1): Promise<RevisionCycleResultV1> {
    input = snapshotCycleInput(input);
    const action = assertRegisteredActionDefinitionV1(input.actionDefinition);
    const actionInstructions = action.renderActionInstructions(input.language, input.interactionLanguage);
    const contract = action.outcomeContract;
    const proposal = buildInstructionProposal(input);
    const extraInstructionsMarkdown = renderUserInstructionLedgerV1(proposal);
    const actorInput = buildActorInputIdentity(
      input,
      action,
      actionInstructions,
      extraInstructionsMarkdown,
      contract,
    );
    const extraDelta = latestDelta(proposal, input.revisionIndex);
    let safety: TahProposalSafetyEvidenceV1 = Object.freeze({ kind: "skipped_initial_v0" });

    if (extraDelta !== null) {
      const extraAttempt = buildExtraGuardianAttemptV1({
        attemptID: this.#freshAttemptID(),
        providerID: input.providerID,
        inference: input.guardianInference,
        guardianPrompt: input.resources.extraGuardianPrompt,
        interactionLanguage: input.interactionLanguage ?? "en",
        safetyPolicy: input.resources.safetyPolicy,
        actionID: action.actionID,
        revisionIndex: input.revisionIndex,
        actionInstructions,
        outcomeContract: contract,
        rawTranscript: input.rawTranscript,
        extraInstructionsMarkdown,
        extraInstructionDelta: extraDelta,
        actorWebEnabled: input.webEnabled,
        acceptedRevisions: input.acceptedRevisions,
      });
      let extraResult: TahAttemptResultV1;
      try {
        extraResult = await this.#run(
          extraAttempt,
          { role: "extra_guardian" },
          input.onEvent,
          input.signal,
        );
      } catch (error) {
        const category = attemptErrorCategory(error);
        if (category === "cancelled") return cycleStopped("cancelled", "extra_guardian", proposal);
        if (category === "cleanup_unconfirmed") {
          return cycleStopped("integrity_locked", "extra_guardian", proposal);
        }
        return Object.freeze({
          kind: "extra_unavailable",
          terminal: frameworkUnavailableTerminal("extra_guardian_execution_failed"),
          attemptedLedger: proposal,
        });
      }
      if (extraResult.terminal.kind === "cancelled") {
        return cycleStopped("cancelled", "extra_guardian", proposal);
      }
      if (terminalHasCleanupUncertainty(extraResult.terminal)) {
        return cycleStopped("integrity_locked", "extra_guardian", proposal);
      }
      if (extraResult.terminal.kind !== "end_turn") {
        return Object.freeze({
          kind: "extra_unavailable",
          terminal: extraResult.terminal,
          attemptedLedger: proposal,
        });
      }
      let assessment: ExtraGuardianAssessmentV2;
      try {
        assertNoCandidates(extraResult);
        assessment = parseExtraGuardianAssessmentV2(extraResult.terminal.finalText);
      } catch {
        return Object.freeze({
          kind: "extra_unavailable",
          terminal: frameworkUnavailableTerminal("extra_guardian_invalid_result"),
          attemptedLedger: proposal,
        });
      }
      // A display observer has no authority over admission or persistence.
      try { input.onSafetyAssessment?.(assessment); } catch { /* display only */ }
      if (assessment.decision === "BLOCK") {
        return Object.freeze({
          kind: "extra_blocked",
          assessment,
          attemptedLedger: proposal,
        });
      }
      safety = Object.freeze({
        kind: "extra_guardian_pass",
        attemptID: extraAttempt.attempt.attemptID,
        inference: input.guardianInference,
      });
    }

    const proposalRequest = Object.freeze({
      cycleID: input.cycleID,
      actionInstanceID: input.actionInstanceID,
      providerID: input.providerID,
      actionID: action.actionID,
      revisionIndex: input.revisionIndex,
      actorInference: input.actorInference,
      webEnabled: input.webEnabled,
      ledger: proposal,
      safety,
      actorInput,
    }) satisfies TahProposalCommitRequestV1;
    let proposalCommit: TahPersistenceCommitReceiptV1;
    try {
      proposalCommit = validateCommitReceipt(await this.#persistence.commitProposal(
        proposalRequest,
        input.signal,
      ));
    } catch (error) {
      return cycleStopped(persistenceErrorCategory(error), "proposal_commit", proposal);
    }

    const committed = committedCycle(
      input,
      action.actionID,
      actionInstructions,
      extraInstructionsMarkdown,
      contract,
      proposal,
      proposalRequest,
      proposalCommit.commitID,
    );
    this.#discardSupersededRetryPlans(committed);
    return this.#runActorFlow(committed, {
      round: 0,
      infrastructureRetryUsed: false,
      onEvent: input.onEvent,
      signal: input.signal,
    });
  }

  public async retryInfrastructure(
    input: RetryTahInfrastructureV1,
  ): Promise<RevisionCycleResultV1> {
    const receipt = validateInfrastructureRetryReceipt(input.receipt);
    let plan = this.#infrastructureRetries.get(receipt.opaqueRetryID);
    if (plan === undefined && input.actionInstanceID !== undefined && this.#persistence.loadInfrastructureRetryCheckpoint) {
      const checkpoint = await this.#persistence.loadInfrastructureRetryCheckpoint(receipt, input.actionInstanceID);
      if (checkpoint !== null) {
        plan = restoreRetryCheckpoint(checkpoint);
        if (plan.committed.input.actionInstanceID !== input.actionInstanceID) throw new WorkflowCoordinatorError("Retry checkpoint Action mismatch");
        // Never reuse any identity already present in a recovered cycle.
        this.#issuedAttemptIDs.add(plan.lease.actorAttemptID);
        if (plan.kind === "actor" && plan.firstRound) this.#issuedAttemptIDs.add(plan.firstRound.attemptID);
      }
    }
    if (plan === undefined) {
      throw new WorkflowCoordinatorError("Infrastructure retry receipt is unknown or consumed");
    }
    this.#infrastructureRetries.delete(receipt.opaqueRetryID);
    try {
      await this.#persistence.claimInfrastructureRetryLease({
        lease: plan.lease,
        receipt,
      });
    } catch {
      return cycleStopped(
        "integrity_locked",
        plan.lease.stage,
        plan.committed.ledger,
        plan.lease.round,
        plan.committed.proposalCommitID,
        retryPlanCriticRounds(plan),
      );
    }
    if (plan.kind === "publication_commit") {
      return this.#commitPublication(
        plan.committed,
        plan.publication,
        true,
        input.signal,
      );
    }
    return this.#runActorFlow(plan.committed, {
      round: plan.lease.round,
      infrastructureRetryUsed: true,
      onEvent: input.onEvent,
      signal: input.signal,
      ...(plan.firstRound === undefined ? {} : { firstRound: plan.firstRound }),
      ...(plan.criticInstructions === undefined
        ? {}
        : { criticInstructions: plan.criticInstructions }),
    });
  }

  async #runActorFlow(
    committed: CommittedCycleV1,
    execution: ActorFlowExecutionV1,
  ): Promise<RevisionCycleResultV1> {
    const current = await this.#runActorRound(
      committed,
      execution.round,
      execution.onEvent,
      execution.signal,
      execution.firstRound?.outcome,
      execution.criticInstructions,
    );
    if (current.kind === "stopped") {
      return this.#finishStoppedActorRound(committed, execution, current);
    }
    if (execution.round === 0) {
      if (current.critic.decision === "PASS") {
        return this.#publish(committed, current, undefined, execution.signal);
      }
      let criticInstructions: string;
      try {
        criticInstructions = renderCriticInstructionsV1(current.critic);
      } catch (error) {
        if (!(error instanceof OutcomeCriticRenderError)) {
          return cycleStopped(
            "integrity_locked",
            "actor",
            committed.ledger,
            0,
            committed.proposalCommitID,
            criticRounds(current),
          );
        }
        return this.#actorFailure(
          committed,
          0,
          "contract_exhausted",
          criticRounds(current),
        );
      }
      return this.#runActorFlow(committed, {
        round: 1,
        infrastructureRetryUsed: false,
        firstRound: current,
        criticInstructions,
        onEvent: execution.onEvent,
        signal: execution.signal,
      });
    }
    if (current.critic.decision === "REJECT") {
      return this.#actorFailure(
        committed,
        1,
        "contract_exhausted",
        execution.firstRound === undefined
          ? criticRounds(current)
          : criticRounds(execution.firstRound, current),
      );
    }
    if (execution.firstRound === undefined) {
      return cycleStopped(
        "integrity_locked",
        "actor",
        committed.ledger,
        1,
        committed.proposalCommitID,
        EMPTY_CRITIC_ROUNDS_V1,
      );
    }
    return this.#publish(committed, current, execution.firstRound, execution.signal);
  }

  async #finishStoppedActorRound(
    committed: CommittedCycleV1,
    execution: ActorFlowExecutionV1,
    stopped: Extract<ActorRoundV1, { kind: "stopped" }>,
  ): Promise<RevisionCycleResultV1> {
    const evidence = execution.firstRound === undefined
      ? EMPTY_CRITIC_ROUNDS_V1
      : criticRounds(execution.firstRound);
    if (stopped.reason === "integrity_locked") {
      return cycleStopped(
        "integrity_locked",
        "actor",
        committed.ledger,
        execution.round,
        committed.proposalCommitID,
        evidence,
      );
    }
    if (!execution.infrastructureRetryUsed
      && stopped.retryEligible
      && stopped.attemptID !== undefined) {
      return this.#offerActorRetry(committed, execution, stopped);
    }
    if (stopped.reason === "cancelled") {
      return this.#stopAfterProposal(
        "cancelled",
        "actor",
        committed,
        execution.round,
        evidence,
      );
    }
    return this.#actorFailure(
      committed,
      execution.round,
      "execution_failed",
      evidence,
      stopped.terminal,
    );
  }

  async #offerActorRetry(
    committed: CommittedCycleV1,
    execution: ActorFlowExecutionV1,
    stopped: Extract<ActorRoundV1, { kind: "stopped" }>,
  ): Promise<RevisionCycleResultV1> {
    const evidence = execution.firstRound === undefined
      ? EMPTY_CRITIC_ROUNDS_V1
      : criticRounds(execution.firstRound);
    if (stopped.attemptID === undefined
      || (execution.round === 1
        && (execution.firstRound === undefined || execution.criticInstructions === undefined))) {
      return cycleStopped(
        "integrity_locked",
        "actor",
        committed.ledger,
        execution.round,
        committed.proposalCommitID,
        evidence,
      );
    }
    const lease = buildRetryLease(
      committed,
      "actor",
      execution.round,
      stopped.attemptID,
      execution.round === 0
        ? committed.input.acceptedRevisions.at(-1)?.outcome.candidateDigest ?? null
        : execution.firstRound!.outcome.candidateDigest,
      execution.criticInstructions,
    );
    const plan: ActorInfrastructureRetryPlanV1 = Object.freeze({
      kind: "actor",
      lease,
      committed,
      ...(execution.firstRound === undefined ? {} : { firstRound: execution.firstRound }),
      ...(execution.criticInstructions === undefined
        ? {}
        : { criticInstructions: execution.criticInstructions }),
    });
    const receipt = await this.#retainRetryPlan(plan);
    if (receipt === null) {
      return cycleStopped(
        "integrity_locked",
        "actor",
        committed.ledger,
        execution.round,
        committed.proposalCommitID,
        evidence,
      );
    }
    if (stopped.reason === "cancelled") {
      return cycleStopped(
        "cancelled",
        "actor",
        committed.ledger,
        execution.round,
        committed.proposalCommitID,
        evidence,
        receipt,
      );
    }
    return actorFailureResult(
      committed,
      execution.round,
      "execution_failed",
      evidence,
      stopped.terminal,
      receipt,
    );
  }

  async #publish(
    committed: CommittedCycleV1,
    acceptedRound: ActorCandidateRoundV1,
    firstRound: ActorCandidateRoundV1 | undefined,
    signal: AbortSignal | undefined,
  ): Promise<RevisionCycleResultV1> {
    const publication = buildPublicationRequest(committed, acceptedRound, firstRound);
    return this.#commitPublication(committed, publication, false, signal);
  }

  async #commitPublication(
    committed: CommittedCycleV1,
    request: TahPublicationCommitRequestV1,
    infrastructureRetryUsed: boolean,
    signal: AbortSignal | undefined,
  ): Promise<RevisionCycleResultV1> {
    let publication: TahPersistenceCommitReceiptV1;
    try {
      publication = validateCommitReceipt(await this.#persistence.publishRevision(request, signal));
    } catch (error) {
      const category = persistenceErrorCategory(error);
      if (category === "cancelled") {
        if (!infrastructureRetryUsed) {
          return this.#offerPublicationRetry(committed, request);
        }
        return this.#stopAfterProposal(
          "cancelled",
          "publication_commit",
          committed,
          request.actorRounds === 1 ? 0 : 1,
          request.criticRounds,
        );
      }
      return cycleStopped(
        "integrity_locked",
        "publication_commit",
        committed.ledger,
        request.actorRounds === 1 ? 0 : 1,
        committed.proposalCommitID,
        request.criticRounds,
      );
    }
    return Object.freeze({
      kind: "completed",
      admittedLedger: committed.ledger,
      proposalCommitID: committed.proposalCommitID,
      publicationCommitID: publication.commitID,
      outcome: request.outcome,
      criticRounds: request.criticRounds,
      actorRounds: request.actorRounds,
      finalText: request.finalText,
    });
  }

  async #offerPublicationRetry(
    committed: CommittedCycleV1,
    publication: TahPublicationCommitRequestV1,
  ): Promise<RevisionCycleResultV1> {
    const lastAttempt = publication.actorAttempts.at(-1);
    const round = publication.actorRounds === 1 ? 0 : 1;
    if (lastAttempt === undefined) {
      return cycleStopped(
        "integrity_locked",
        "publication_commit",
        committed.ledger,
        round,
        committed.proposalCommitID,
        publication.criticRounds,
      );
    }
    const lease = buildRetryLease(
      committed,
      "publication_commit",
      round,
      lastAttempt.attemptID,
      publication.outcome.candidateDigest,
      canonicalDigest(publication),
    );
    const plan: PublicationInfrastructureRetryPlanV1 = Object.freeze({
      kind: "publication_commit",
      lease,
      committed,
      publication,
    });
    const receipt = await this.#retainRetryPlan(plan);
    if (receipt === null) {
      return cycleStopped(
        "integrity_locked",
        "publication_commit",
        committed.ledger,
        round,
        committed.proposalCommitID,
        publication.criticRounds,
      );
    }
    return cycleStopped(
      "cancelled",
      "publication_commit",
      committed.ledger,
      round,
      committed.proposalCommitID,
      publication.criticRounds,
      receipt,
    );
  }

  async #retainRetryPlan(
    plan: InfrastructureRetryPlanV1,
  ): Promise<TahInfrastructureRetryReceiptV1 | null> {
    let receipt: TahInfrastructureRetryReceiptV1;
    try {
      receipt = validateInfrastructureRetryReceipt(
        await this.#persistence.retainInfrastructureRetryLease(plan.lease, serializeRetryCheckpoint(plan)),
      );
    } catch {
      return null;
    }
    if (this.#infrastructureRetries.has(receipt.opaqueRetryID)) return null;
    this.#infrastructureRetries.set(receipt.opaqueRetryID, plan);
    return receipt;
  }

  async #stopAfterProposal(
    kind: "cancelled",
    stage: "actor" | "publication_commit",
    committed: CommittedCycleV1,
    round: 0 | 1,
    evidence: readonly TahCriticRoundV1[],
  ): Promise<RevisionCycleResultV1> {
    if (!await this.#releaseReservation(committed)) {
      return cycleStopped(
        "integrity_locked",
        stage,
        committed.ledger,
        round,
        committed.proposalCommitID,
        evidence,
      );
    }
    return cycleStopped(
      kind,
      stage,
      committed.ledger,
      round,
      committed.proposalCommitID,
      evidence,
    );
  }

  async #actorFailure(
    committed: CommittedCycleV1,
    round: 0 | 1,
    reason: "execution_failed" | "contract_exhausted",
    evidence: readonly TahCriticRoundV1[],
    terminal?: AttemptTerminalV1,
  ): Promise<RevisionCycleResultV1> {
    if (!await this.#releaseReservation(committed)) {
      return cycleStopped(
        "integrity_locked",
        "actor",
        committed.ledger,
        round,
        committed.proposalCommitID,
        evidence,
      );
    }
    return actorFailureResult(committed, round, reason, evidence, terminal);
  }

  async #releaseReservation(committed: CommittedCycleV1): Promise<boolean> {
    try {
      await this.#persistence.releaseProposalReservation({
        cycleID: committed.input.cycleID,
        actionInstanceID: committed.input.actionInstanceID,
        revisionIndex: committed.input.revisionIndex,
        proposalCommitID: committed.proposalCommitID,
      });
      this.#discardRetryPlansForCycle(committed.input.cycleID);
      return true;
    } catch {
      return false;
    }
  }

  #discardSupersededRetryPlans(committed: CommittedCycleV1): void {
    for (const [retryID, plan] of this.#infrastructureRetries) {
      if (plan.committed.input.actionInstanceID === committed.input.actionInstanceID
        && plan.committed.input.revisionIndex === committed.input.revisionIndex
        && plan.committed.input.cycleID !== committed.input.cycleID) {
        this.#infrastructureRetries.delete(retryID);
      }
    }
  }

  #discardRetryPlansForCycle(cycleID: string): void {
    for (const [retryID, plan] of this.#infrastructureRetries) {
      if (plan.committed.input.cycleID === cycleID) this.#infrastructureRetries.delete(retryID);
    }
  }

  async #runActorRound(
    committed: CommittedCycleV1,
    round: 0 | 1,
    observer: TahWorkflowEventObserverV1 | undefined,
    signal: AbortSignal | undefined,
    correctionSeed?: CandidateOutcomeV1,
    criticInstructions?: string,
  ): Promise<ActorRoundV1> {
    const input = committed.input;
    const priorSeed = input.acceptedRevisions.at(-1)?.outcome;
    let built: BuiltAttemptV1;
    try {
      built = buildActorAttemptV1({
        attemptID: this.#freshAttemptID(),
        providerID: input.providerID,
        inference: input.actorInference,
        actorPromptTemplate: input.resources.actorPromptTemplate,
        interactionLanguage: input.interactionLanguage ?? "en",
        revisionIndex: input.revisionIndex,
        actionInstructions: committed.actionInstructions,
        outcomeContract: committed.contract,
        rawTranscript: input.rawTranscript,
        extraInstructionsMarkdown: committed.extraInstructionsMarkdown,
        ...(criticInstructions === undefined ? {} : { criticInstructionsMarkdown: criticInstructions }),
        webEnabled: input.webEnabled,
        acceptedRevisions: input.acceptedRevisions,
        ...((correctionSeed ?? priorSeed) === undefined
          ? {}
          : { candidateSeed: correctionSeed ?? priorSeed! }),
      });
    } catch {
      return Object.freeze({
        kind: "stopped",
        round,
        reason: "integrity_locked",
        retryEligible: false,
      });
    }
    let result: TahAttemptResultV1;
    try {
      result = await this.#run(
        built,
        { role: "actor", round },
        observer,
        signal,
      );
    } catch (error) {
      const reason = actorErrorReason(error);
      return Object.freeze({
        kind: "stopped",
        round,
        reason,
        retryEligible: reason === "cancelled" || reason === "execution_failed",
        attemptID: built.attempt.attemptID,
      });
    }
    if (result.terminal.kind === "cancelled") {
      return Object.freeze({
        kind: "stopped",
        round,
        reason: "cancelled",
        retryEligible: true,
        attemptID: built.attempt.attemptID,
      });
    }
    if (terminalHasCleanupUncertainty(result.terminal)) {
      return Object.freeze({
        kind: "stopped",
        round,
        reason: "integrity_locked",
        retryEligible: false,
        attemptID: built.attempt.attemptID,
      });
    }
    if (result.terminal.kind !== "end_turn") {
      return Object.freeze({
        kind: "stopped",
        round,
        reason: "execution_failed",
        retryEligible: result.terminal.kind === "failed" && result.terminal.failure.retryable,
        attemptID: built.attempt.attemptID,
        terminal: result.terminal,
      });
    }
    try {
      const outcome = buildCandidateOutcomeV1(
        `outbox/revision_v${input.revisionIndex}`,
        result.candidateManifest,
        result.candidateFiles,
      );
      const critic = deepFreeze(evaluateOutcomeCandidateV1(committed.contract, outcome));
      return Object.freeze({
        kind: "candidate",
        round,
        attemptID: built.attempt.attemptID,
        outcome,
        critic,
        finalText: result.terminal.finalText,
      });
    } catch {
      return Object.freeze({
        kind: "stopped",
        round,
        reason: "integrity_locked",
        retryEligible: false,
        attemptID: built.attempt.attemptID,
      });
    }
  }

  #run(
    attempt: BuiltAttemptV1,
    scope: TahAttemptScopeV1,
    observer: TahWorkflowEventObserverV1 | undefined,
    signal: AbortSignal | undefined,
  ): Promise<TahAttemptResultV1> {
    return this.#attempts.run(
      attempt,
      observer === undefined ? undefined : (event) => observer(scope, event),
      signal,
    );
  }

  #freshAttemptID(): string {
    if (this.#issuedAttemptIDs.size >= TAH_MAX_ATTEMPT_IDENTITIES_PER_PROCESS) {
      throw new WorkflowCoordinatorError("Process attempt identity budget is exhausted");
    }
    const value = this.#nextAttemptID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value)) {
      throw new WorkflowCoordinatorError("Attempt identity factory returned an invalid UUID");
    }
    if (this.#issuedAttemptIDs.has(value)) {
      throw new WorkflowCoordinatorError("Attempt identity factory reused an issued UUID");
    }
    this.#issuedAttemptIDs.add(value);
    return value;
  }
}

interface ActorCandidateRoundV1 {
  readonly kind: "candidate";
  readonly round: 0 | 1;
  readonly attemptID: string;
  readonly outcome: CandidateOutcomeV1;
  readonly critic: OutcomeCriticResultV1;
  readonly finalText: string;
}

type ActorRoundV1 = ActorCandidateRoundV1 | Readonly<{
  kind: "stopped";
  round: 0 | 1;
  reason: "cancelled" | "execution_failed" | "integrity_locked";
  retryEligible: boolean;
  attemptID?: string;
  terminal?: AttemptTerminalV1;
}>;

interface CommittedCycleInputV1 {
  readonly interactionLanguage: TahNoteLanguageV1;
  readonly cycleID: string;
  readonly actionInstanceID: string;
  readonly providerID: string;
  readonly revisionIndex: number;
  readonly actorInference: AttemptInferenceV1;
  readonly rawTranscript: string | Uint8Array;
  readonly webEnabled: boolean;
  readonly acceptedRevisions: readonly AcceptedRevisionInputV1[];
  readonly resources: TahWorkflowResourcesV1;
}

interface CommittedCycleV1 {
  readonly input: CommittedCycleInputV1;
  readonly actionID: string;
  readonly actionInstructions: string;
  readonly extraInstructionsMarkdown: string;
  readonly contract: StructuredOutcomeContractV1;
  readonly ledger: UserInstructionLedgerV1;
  readonly proposalCommitID: string;
  readonly proposalDigest: string;
}

interface ActorFlowExecutionV1 {
  readonly round: 0 | 1;
  readonly infrastructureRetryUsed: boolean;
  readonly firstRound?: ActorCandidateRoundV1;
  readonly criticInstructions?: string;
  readonly onEvent: TahWorkflowEventObserverV1 | undefined;
  readonly signal: AbortSignal | undefined;
}

interface InfrastructureRetryPlanBaseV1 {
  readonly lease: TahInfrastructureRetryLeaseRequestV1;
  readonly committed: CommittedCycleV1;
}

interface ActorInfrastructureRetryPlanV1 extends InfrastructureRetryPlanBaseV1 {
  readonly kind: "actor";
  readonly firstRound?: ActorCandidateRoundV1;
  readonly criticInstructions?: string;
}

interface PublicationInfrastructureRetryPlanV1 extends InfrastructureRetryPlanBaseV1 {
  readonly kind: "publication_commit";
  readonly publication: TahPublicationCommitRequestV1;
}

type InfrastructureRetryPlanV1 =
  | ActorInfrastructureRetryPlanV1
  | PublicationInfrastructureRetryPlanV1;

const EMPTY_CRITIC_ROUNDS_V1: readonly TahCriticRoundV1[] = Object.freeze([]);

function criticRounds(
  ...rounds: readonly ActorCandidateRoundV1[]
): readonly TahCriticRoundV1[] {
  return Object.freeze(rounds.map((round) => Object.freeze({
    round: round.round,
    result: round.critic,
  })));
}

function retryPlanCriticRounds(
  plan: InfrastructureRetryPlanV1,
): readonly TahCriticRoundV1[] {
  if (plan.kind === "publication_commit") return plan.publication.criticRounds;
  return plan.firstRound === undefined
    ? EMPTY_CRITIC_ROUNDS_V1
    : criticRounds(plan.firstRound);
}

function serializeRetryCheckpoint(plan: InfrastructureRetryPlanV1): TahRetryCheckpointV1 {
  const raw = plan.committed.input.rawTranscript;
  const rawTranscript = typeof raw === "string" ? raw : new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const snapshot = { ...plan, committed: { ...plan.committed, input: { ...plan.committed.input, rawTranscript } } };
  const bytes = Buffer.from(JSON.stringify(snapshot), "utf8");
  if (bytes.length > 48 * 1024 * 1024) throw new WorkflowCoordinatorError("Retry checkpoint exceeds bound");
  return Object.freeze({ schemaVersion: 1, dataBase64: bytes.toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") });
}

function restoreRetryCheckpoint(checkpoint: TahRetryCheckpointV1): InfrastructureRetryPlanV1 {
  try {
    if (checkpoint.schemaVersion !== 1 || Object.keys(checkpoint).length !== 3
      || checkpoint.dataBase64.length > 64 * 1024 * 1024) throw new Error();
    const bytes = Buffer.from(checkpoint.dataBase64, "base64");
    if (bytes.toString("base64") !== checkpoint.dataBase64 || createHash("sha256").update(bytes).digest("hex") !== checkpoint.sha256) throw new Error();
    const plan = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as InfrastructureRetryPlanV1;
    if (plan.kind !== "actor" && plan.kind !== "publication_commit") throw new Error();
    const { committed, lease } = plan;
    const input = committed.input;
    if (input.cycleID !== lease.cycleID || input.actionInstanceID !== lease.actionInstanceID
      || (input.interactionLanguage !== "en" && input.interactionLanguage !== "zh-CN")
      || input.revisionIndex !== lease.revisionIndex || committed.proposalCommitID !== lease.proposalCommitID
      || lease.stage !== plan.kind || (lease.round !== 0 && lease.round !== 1)
      || committed.actionID !== "structured_notes" || typeof input.rawTranscript !== "string"
      || renderUserInstructionLedgerV1(committed.ledger) !== committed.extraInstructionsMarkdown) throw new Error();
    let expected: TahInfrastructureRetryLeaseRequestV1;
    if (plan.kind === "publication_commit") {
      parseCandidateOutcomeV1(plan.publication.outcome);
      expected = buildRetryLease(committed, plan.kind, lease.round, lease.actorAttemptID,
        plan.publication.outcome.candidateDigest, canonicalDigest(plan.publication));
    } else {
      if (lease.round === 1) {
        if (!plan.firstRound || plan.firstRound.round !== 0 || plan.firstRound.critic.decision !== "REJECT"
          || plan.criticInstructions !== renderCriticInstructionsV1(plan.firstRound.critic)) throw new Error();
        const candidate = parseCandidateOutcomeV1(plan.firstRound.outcome);
        if (canonicalDigest(evaluateOutcomeCandidateV1(committed.contract, candidate)) !== canonicalDigest(plan.firstRound.critic)) throw new Error();
      } else if (plan.firstRound !== undefined || plan.criticInstructions !== undefined) throw new Error();
      expected = buildRetryLease(committed, "actor", lease.round, lease.actorAttemptID,
        lease.round === 0 ? input.acceptedRevisions.at(-1)?.outcome.candidateDigest ?? null : plan.firstRound!.outcome.candidateDigest,
        plan.criticInstructions);
      // Rebuild and validate the frozen projection without starting a Provider.
      const seed = plan.firstRound?.outcome ?? input.acceptedRevisions.at(-1)?.outcome;
      buildActorAttemptV1({ attemptID: lease.actorAttemptID, providerID: input.providerID, inference: input.actorInference,
        actorPromptTemplate: input.resources.actorPromptTemplate, revisionIndex: input.revisionIndex,
        interactionLanguage: input.interactionLanguage ?? "en",
        actionInstructions: committed.actionInstructions, outcomeContract: committed.contract, rawTranscript: input.rawTranscript,
        extraInstructionsMarkdown: committed.extraInstructionsMarkdown, webEnabled: input.webEnabled,
        acceptedRevisions: input.acceptedRevisions, ...(plan.criticInstructions === undefined ? {} : { criticInstructionsMarkdown: plan.criticInstructions }),
        ...(seed === undefined ? {} : { candidateSeed: seed }) });
    }
    if (canonicalDigest(expected) !== canonicalDigest(lease)) throw new Error();
    return deepFreeze(plan);
  } catch { throw new WorkflowCoordinatorError("Persisted retry checkpoint is invalid"); }
}

function committedCycle(
  input: RunRevisionCycleV1,
  actionID: string,
  actionInstructions: string,
  extraInstructionsMarkdown: string,
  contract: StructuredOutcomeContractV1,
  ledger: UserInstructionLedgerV1,
  proposal: TahProposalCommitRequestV1,
  proposalCommitID: string,
): CommittedCycleV1 {
  const committedInput: CommittedCycleInputV1 = Object.freeze({
    interactionLanguage: input.interactionLanguage ?? "en",
    cycleID: input.cycleID,
    actionInstanceID: input.actionInstanceID,
    providerID: input.providerID,
    revisionIndex: input.revisionIndex,
    actorInference: input.actorInference,
    rawTranscript: input.rawTranscript,
    webEnabled: input.webEnabled,
    acceptedRevisions: input.acceptedRevisions,
    resources: input.resources,
  });
  return Object.freeze({
    input: committedInput,
    actionID,
    actionInstructions,
    extraInstructionsMarkdown,
    contract,
    ledger,
    proposalCommitID,
    proposalDigest: canonicalDigest(proposal),
  });
}

function buildPublicationRequest(
  committed: CommittedCycleV1,
  acceptedRound: ActorCandidateRoundV1,
  firstRound: ActorCandidateRoundV1 | undefined,
): TahPublicationCommitRequestV1 {
  const actorRounds = firstRound === undefined ? 1 : 2;
  const actorAttempts = Object.freeze([
    ...(firstRound === undefined ? [] : [Object.freeze({
      attemptID: firstRound.attemptID,
      round: 0 as const,
      inference: committed.input.actorInference,
    })]),
    Object.freeze({
      attemptID: acceptedRound.attemptID,
      round: (actorRounds - 1) as 0 | 1,
      inference: committed.input.actorInference,
    }),
  ]);
  const criticRounds = Object.freeze([
    ...(firstRound === undefined ? [] : [Object.freeze({
      round: 0 as const,
      result: firstRound.critic,
    })]),
    Object.freeze({
      round: (actorRounds - 1) as 0 | 1,
      result: acceptedRound.critic,
    }),
  ]);
  return deepFreeze({
    cycleID: committed.input.cycleID,
    actionInstanceID: committed.input.actionInstanceID,
    providerID: committed.input.providerID,
    actionID: committed.actionID,
    revisionIndex: committed.input.revisionIndex,
    proposalCommitID: committed.proposalCommitID,
    ledger: committed.ledger,
    outcome: acceptedRound.outcome,
    critic: acceptedRound.critic,
    criticRounds,
    actorRounds,
    actorAttempts,
    finalText: acceptedRound.finalText,
  }) as TahPublicationCommitRequestV1;
}

function buildRetryLease(
  committed: CommittedCycleV1,
  stage: "actor" | "publication_commit",
  round: 0 | 1,
  actorAttemptID: string,
  candidateSeedDigest: string | null,
  exactRetryContext?: string,
): TahInfrastructureRetryLeaseRequestV1 {
  return Object.freeze({
    cycleID: committed.input.cycleID,
    actionInstanceID: committed.input.actionInstanceID,
    revisionIndex: committed.input.revisionIndex,
    proposalCommitID: committed.proposalCommitID,
    stage,
    round,
    actorAttemptID,
    retryInputDigest: canonicalDigest({
      schemaVersion: 1,
      proposalDigest: committed.proposalDigest,
      interactionLanguage: committed.input.interactionLanguage,
      stage,
      round,
      candidateSeedDigest,
      exactRetryContext: exactRetryContext === undefined
        ? null
        : contentIdentity(exactRetryContext),
    }),
  });
}

function actorFailureResult(
  committed: CommittedCycleV1,
  round: 0 | 1,
  reason: "execution_failed" | "contract_exhausted",
  evidence: readonly TahCriticRoundV1[],
  terminal?: AttemptTerminalV1,
  infrastructureRetry?: TahInfrastructureRetryReceiptV1,
): Extract<RevisionCycleResultV1, { kind: "actor_failed" }> {
  return Object.freeze({
    kind: "actor_failed",
    admittedLedger: committed.ledger,
    proposalCommitID: committed.proposalCommitID,
    round,
    reason,
    criticRounds: evidence,
    ...(terminal === undefined ? {} : { terminal }),
    ...(infrastructureRetry === undefined ? {} : { infrastructureRetry }),
  });
}

function buildInstructionProposal(input: RunRevisionCycleV1): UserInstructionLedgerV1 {
  const isNewRevision = input.currentInstructions.length === input.revisionIndex;
  const isRetry = input.currentInstructions.length === input.revisionIndex + 1;
  if (!isNewRevision && !isRetry) {
    throw new WorkflowCoordinatorError("Instruction ledger does not match the current revision");
  }
  if (input.revisionIndex === 0
    && ((input.v0AlreadyAttempted && !isRetry) || (!input.v0AlreadyAttempted && !isNewRevision))) {
    throw new WorkflowCoordinatorError("v0 attempt state disagrees with its committed instruction ledger");
  }
  if (input.revisionIndex === 0 && input.v0AlreadyAttempted
    && input.instructionDelta.trim().length === 0) {
    throw new WorkflowCoordinatorError("Retried v0 requires an explicit instruction");
  }
  return isNewRevision
    ? appendUserRevisionInstructionV1(
        input.currentInstructions,
        input.revisionIndex,
        input.instructionDelta,
      )
    : appendUserRetryInstructionV1(
        input.currentInstructions,
        input.revisionIndex,
        input.instructionDelta,
      );
}

function latestDelta(ledger: UserInstructionLedgerV1, revisionIndex: number): string | null {
  const entry = ledger[revisionIndex];
  if (entry === undefined) throw new WorkflowCoordinatorError("Proposed instruction is unavailable");
  return entry.retries.at(-1) ?? entry.initial;
}

function rawAttemptError(attemptID: string, error: unknown): RawSafetyResultV1 {
  const category = attemptErrorCategory(error);
  if (category === "cancelled") return Object.freeze({ kind: "cancelled", attemptID });
  if (category === "cleanup_unconfirmed") {
    return Object.freeze({ kind: "integrity_locked", attemptID });
  }
  return Object.freeze({
    kind: "unavailable",
    attemptID,
    terminal: frameworkUnavailableTerminal("raw_guardian_execution_failed"),
  });
}

function attemptErrorCategory(error: unknown): TahAttemptExecutionErrorV1["category"] {
  return error instanceof TahAttemptExecutionErrorV1 ? error.category : "unavailable";
}

function actorErrorReason(error: unknown): "cancelled" | "execution_failed" | "integrity_locked" {
  const category = attemptErrorCategory(error);
  if (category === "cancelled") return "cancelled";
  return category === "cleanup_unconfirmed" ? "integrity_locked" : "execution_failed";
}

function terminalHasCleanupUncertainty(terminal: AttemptTerminalV1): boolean {
  return terminal.kind === "failed" && terminal.failure.family === "cleanup";
}

function persistenceErrorCategory(error: unknown): "cancelled" | "integrity_locked" {
  return error instanceof TahPersistenceErrorV1 && error.category === "cancelled"
    ? "cancelled"
    : "integrity_locked";
}

function cycleStopped(
  kind: "cancelled" | "integrity_locked",
  stage: "extra_guardian" | "proposal_commit",
  attemptedLedger: UserInstructionLedgerV1,
): Extract<RevisionCycleResultV1, {
  kind: typeof kind;
  stage: "extra_guardian" | "proposal_commit";
}>;
function cycleStopped(
  kind: "cancelled" | "integrity_locked",
  stage: "actor" | "publication_commit",
  attemptedLedger: UserInstructionLedgerV1,
  round: 0 | 1,
  proposalCommitID: string,
  evidence: readonly TahCriticRoundV1[],
  infrastructureRetry?: TahInfrastructureRetryReceiptV1,
): Extract<RevisionCycleResultV1, {
  kind: "cancelled" | "integrity_locked";
  stage: "actor" | "publication_commit";
}>;
function cycleStopped(
  kind: "cancelled" | "integrity_locked",
  stage: "extra_guardian" | "proposal_commit" | "actor" | "publication_commit",
  attemptedLedger: UserInstructionLedgerV1,
  round?: 0 | 1,
  proposalCommitID?: string,
  evidence?: readonly TahCriticRoundV1[],
  infrastructureRetry?: TahInfrastructureRetryReceiptV1,
): RevisionCycleResultV1 {
  const isPostProposal = stage === "actor" || stage === "publication_commit";
  if (isPostProposal
    && (round === undefined || proposalCommitID === undefined || evidence === undefined)) {
    throw new WorkflowCoordinatorError("Post-proposal terminal lost its proposal identity");
  }
  return Object.freeze({
    kind,
    stage,
    attemptedLedger,
    ...(proposalCommitID === undefined
      ? {}
      : { admittedLedger: attemptedLedger, proposalCommitID }),
    ...(round === undefined ? {} : { round }),
    ...(evidence === undefined ? {} : { criticRounds: evidence }),
    ...(infrastructureRetry === undefined ? {} : { infrastructureRetry }),
  }) as RevisionCycleResultV1;
}

function validateCommitReceipt(value: TahPersistenceCommitReceiptV1): TahPersistenceCommitReceiptV1 {
  if (typeof value !== "object" || value === null
    || typeof value.commitID !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u.test(value.commitID)
    || Object.keys(value).length !== 1) {
    throw new TahPersistenceErrorV1("integrity");
  }
  return Object.freeze({ commitID: value.commitID });
}

function validateInfrastructureRetryReceipt(
  value: TahInfrastructureRetryReceiptV1,
): TahInfrastructureRetryReceiptV1 {
  if (typeof value !== "object" || value === null
    || value.schemaVersion !== 1
    || typeof value.opaqueRetryID !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      .test(value.opaqueRetryID)
    || Object.keys(value).length !== 2) {
    throw new WorkflowCoordinatorError("Infrastructure retry receipt is invalid");
  }
  return Object.freeze({ schemaVersion: 1, opaqueRetryID: value.opaqueRetryID });
}

function canonicalDigest(value: unknown): string {
  return createHash("sha256").update(canonicalJSON(value), "utf8").digest("hex");
}

function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new WorkflowCoordinatorError("Retry identity contains a non-canonical number");
    }
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(",")}]`;
  if (typeof value !== "object") {
    throw new WorkflowCoordinatorError("Retry identity contains unsupported data");
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort(compareCanonicalUTF8V1);
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJSON(record[key])}`).join(",")}}`;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  if (ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function snapshotCycleInput(input: RunRevisionCycleV1): RunRevisionCycleV1 {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
  if (!uuid.test(input.cycleID)) {
    throw new WorkflowCoordinatorError("Revision cycle identity is invalid");
  }
  if (!uuid.test(input.actionInstanceID)) {
    throw new WorkflowCoordinatorError("Action instance identity is invalid");
  }
  return Object.freeze({
    ...input,
    actorInference: Object.freeze({ ...input.actorInference }),
    guardianInference: Object.freeze({ ...input.guardianInference }),
    rawTranscript: typeof input.rawTranscript === "string"
      ? input.rawTranscript
      : Uint8Array.from(input.rawTranscript),
    acceptedRevisions: Object.freeze(input.acceptedRevisions.map((revision) => Object.freeze({
      revisionIndex: revision.revisionIndex,
      publicationCommitID: revision.publicationCommitID,
      outcome: parseCandidateOutcomeV1(revision.outcome),
    }))),
    resources: Object.freeze({ ...input.resources }),
  });
}

function buildActorInputIdentity(
  input: RunRevisionCycleV1,
  action: TahActionDefinitionV1,
  actionInstructions: string,
  extraInstructionsMarkdown: string,
  contract: StructuredOutcomeContractV1,
): TahActorInputIdentityV1 {
  const acceptedRevisions = Object.freeze(input.acceptedRevisions.map((revision) =>
    Object.freeze({
      revisionIndex: revision.revisionIndex,
      publicationCommitID: revision.publicationCommitID,
      candidateDigest: revision.outcome.candidateDigest,
    }))
  );
  const basePublication = acceptedRevisions.at(-1) ?? null;
  return Object.freeze({
    actionDefinitionID: action.definitionID,
    actionDefinitionDigest: action.definitionDigest,
    language: input.language,
    interactionLanguage: input.interactionLanguage ?? "en",
    actionInstructions: contentIdentity(actionInstructions),
    extraInstructions: contentIdentity(extraInstructionsMarkdown),
    outcomeContractID: contract.contractID,
    rawTranscript: contentIdentity(input.rawTranscript),
    actorPromptTemplate: contentIdentity(input.resources.actorPromptTemplate),
    acceptedRevisions,
    basePublication,
  });
}

function contentIdentity(value: string | Uint8Array): TahContentIdentityV1 {
  const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  return Object.freeze({
    byteLength: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}

function assertNoCandidates(result: TahAttemptResultV1): void {
  if (result.candidateManifest.length !== 0
    || result.candidateFiles.size !== 0) {
    throw new WorkflowCoordinatorError("Guardian returned a candidate filesystem outcome");
  }
}

function frameworkUnavailableTerminal(code: string): AttemptTerminalV1 {
  const terminal: AttemptTerminalV1 = {
    kind: "failed",
    failure: {
      family: "protocol",
      code,
      retryable: true,
      message: "The required TAH safety check could not produce a valid result.",
    },
  };
  return Object.freeze(terminal);
}

export class WorkflowCoordinatorError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "WorkflowCoordinatorError";
  }
}
