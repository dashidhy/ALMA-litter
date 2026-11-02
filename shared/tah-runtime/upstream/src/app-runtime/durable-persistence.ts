import { randomUUID } from "node:crypto";
import { z } from "zod";
import { TahPersistenceStateV1 } from "../framework/persistence-state.js";
import { TahPersistenceErrorV1, type TahFrameworkPersistencePortV1, type TahProposalCommitRequestV1,
  type TahPublicationCommitRequestV1, type TahInfrastructureRetryLeaseRequestV1, type TahInfrastructureRetryReceiptV1,
  type TahRetryCheckpointV1,
} from "../framework/workflow.js";
import { AppBridgeError } from "./bridge.js";
import { prepareJournalWrite, type JournalPort, type JournalRecord, type JournalWrite } from "./journal.js";

type Method = "commitProposal" | "publishRevision" | "releaseProposalReservation" | "retainInfrastructureRetryLease" | "claimInfrastructureRetryLease";
const kinds: Readonly<Record<Method, JournalWrite["kind"]>> = {
  commitProposal: "proposal", publishRevision: "publication", releaseProposalReservation: "release",
  retainInfrastructureRetryLease: "retry_retain", claimInfrastructureRetryLease: "retry_claim",
};
const transitionSchema = z.strictObject({ schemaVersion: z.literal(1),
  method: z.enum(["commitProposal", "publishRevision", "releaseProposalReservation", "retainInfrastructureRetryLease", "claimInfrastructureRetryLease"]),
  retryID: z.uuid(), request: z.unknown(), result: z.unknown(), checkpoint: z.strictObject({ schemaVersion: z.literal(1),
    dataBase64: z.string().max(64 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/u) }).nullable() });
type Transition = z.infer<typeof transitionSchema>;
export interface PendingTahSave { readonly operationID: string; readonly actionInstanceID: string; readonly kind: JournalWrite["kind"] }

/** Replays shared TAH validation, then commits its exact transition. Transient
 * writes remain pending: Retry Save does not unwind the workflow or re-run AI. */
export class DurableTahPersistence implements TahFrameworkPersistencePortV1 {
  readonly #history = new Map<string, JournalRecord[]>();
  readonly #waiting = new Map<string, { resolve(): void; reject(error: Error): void; info: PendingTahSave }>();
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  public constructor(private readonly journal: JournalPort, private readonly ownerForAction: (actionID: string) => string,
    private readonly changed: (pending: readonly PendingTahSave[]) => void = () => {}) {}

  public pendingSaves(): readonly PendingTahSave[] { return [...this.#waiting.values()].map(value => value.info); }
  public retrySave(operationID: string): void {
    const waiting = this.#waiting.get(operationID);
    if (!waiting) throw new Error("Save operation is not pending");
    this.#waiting.delete(operationID); this.changed(this.pendingSaves()); waiting.resolve();
  }
  public async recoverPending(write: JournalWrite, bytes: Uint8Array): Promise<void> {
    const transition = transitionSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (write.kind !== kinds[transition.method] || write.streamID !== `action/${transitionActionID(transition)}`) throw new TahPersistenceErrorV1("integrity");
    const history = await this.journal.read(write.streamID);
    const state = await replay(history, transition.retryID);
    const result = await apply(state, transition.method, transition.request);
    if (canonical(result ?? null) !== canonical(transition.result)) throw new TahPersistenceErrorV1("integrity");
    await this.journal.append(write, bytes);
    this.#history.clear();
  }
  public close(): void {
    this.#closed = true;
    for (const waiting of this.#waiting.values()) waiting.reject(new TahPersistenceErrorV1("integrity"));
    this.#waiting.clear(); this.changed([]);
  }
  public commitProposal(request: TahProposalCommitRequestV1, signal?: AbortSignal) {
    return this.#transition("commitProposal", request, request.actionInstanceID, signal) as ReturnType<TahFrameworkPersistencePortV1["commitProposal"]>;
  }
  public publishRevision(request: TahPublicationCommitRequestV1, signal?: AbortSignal) {
    return this.#transition("publishRevision", request, request.actionInstanceID, signal, request.revisionIndex) as ReturnType<TahFrameworkPersistencePortV1["publishRevision"]>;
  }
  public releaseProposalReservation(request: Parameters<TahFrameworkPersistencePortV1["releaseProposalReservation"]>[0]) {
    return this.#transition("releaseProposalReservation", request, request.actionInstanceID) as Promise<void>;
  }
  public retainInfrastructureRetryLease(request: TahInfrastructureRetryLeaseRequestV1, checkpoint?: TahRetryCheckpointV1) {
    return this.#transition("retainInfrastructureRetryLease", request, request.actionInstanceID, undefined, null, checkpoint ?? null) as Promise<TahInfrastructureRetryReceiptV1>;
  }
  public async loadInfrastructureRetryCheckpoint(receipt: TahInfrastructureRetryReceiptV1, actionInstanceID: string): Promise<TahRetryCheckpointV1 | null> {
    const history = await this.journal.read(`action/${z.uuid().parse(actionInstanceID)}`);
    const state = await replay(history);
    for (const record of history) {
      const transition = transitionSchema.parse(record.value);
      if (transition.method !== "retainInfrastructureRetryLease" || canonical(transition.result) !== canonical(receipt)) continue;
      // Validate against current proposal/lease authority on a disposable projection.
      await state.claimInfrastructureRetryLease({ lease: transition.request as TahInfrastructureRetryLeaseRequestV1, receipt });
      return transition.checkpoint;
    }
    return null;
  }
  public claimInfrastructureRetryLease(request: Parameters<TahFrameworkPersistencePortV1["claimInfrastructureRetryLease"]>[0]) {
    return this.#transition("claimInfrastructureRetryLease", request, request.lease.actionInstanceID) as Promise<void>;
  }
  public async acceptedPublications(actionID: string): Promise<readonly TahPublicationCommitRequestV1[]> {
    // Read an independent committed snapshot: history browsing must not wait for
    // a pending save, nor replace the mutation queue's current validation state.
    const history = await this.journal.read(`action/${z.uuid().parse(actionID)}`);
    return (await replay(history)).acceptedPublications(actionID);
  }
  public async latestProposal(actionID: string): Promise<TahProposalCommitRequestV1 | null> {
    const history = await this.journal.read(`action/${z.uuid().parse(actionID)}`);
    await replay(history);
    const record = [...history].reverse().find(value => value.kind === "proposal");
    return record ? transitionSchema.parse(record.value).request as TahProposalCommitRequestV1 : null;
  }

  #transition(method: Method, request: unknown, actionID: string, signal?: AbortSignal, revision: number | null = null, checkpoint: TahRetryCheckpointV1 | null = null): Promise<unknown> {
    // Snapshot before waiting behind another operation so callers cannot alter input during a save.
    const snapshot: unknown = JSON.parse(JSON.stringify(request));
    const operation = this.#tail.then(async () => {
      if (this.#closed) throw new TahPersistenceErrorV1("integrity");
      if (signal?.aborted) throw new TahPersistenceErrorV1("cancelled");
      const history = await this.#load(actionID);
      const retryID = randomUUID();
      const state = await replay(history, retryID);
      const result = await apply(state, method, snapshot);
      // A repeated publication returns its receipt without advancing the stream twice.
      if (history.some(record => {
        const prior = transitionSchema.parse(record.value);
        return prior.method === method && canonical(prior.request) === canonical(snapshot)
          && canonical(prior.result) === canonical(result ?? null);
      })) return result;
      const value: Transition = { schemaVersion: 1, method, retryID, request: snapshot, result: result ?? null, checkpoint };
      const { write, bytes } = prepareJournalWrite(`action/${actionID}`, this.ownerForAction(actionID), history.length, kinds[method], value, revision);
      while (true) {
        if (this.#closed) throw new TahPersistenceErrorV1("integrity");
        try {
          const version = await this.journal.append(write, bytes, signal);
          history.push({ operationID: write.operationID, version, kind: write.kind, value });
          return result;
        } catch (error) {
          if (error instanceof AppBridgeError && error.code === "integrity_locked") throw new TahPersistenceErrorV1("integrity");
          if (error instanceof AppBridgeError && error.code === "cancelled") throw new TahPersistenceErrorV1("cancelled");
          if (this.#closed) throw new TahPersistenceErrorV1("integrity");
          await new Promise<void>((resolve, reject) => {
            const retry = () => { signal?.removeEventListener("abort", retry); resolve(); };
            signal?.addEventListener("abort", retry, { once: true });
            this.#waiting.set(write.operationID, { resolve: retry, reject: error => { signal?.removeEventListener("abort", retry); reject(error); },
              info: { operationID: write.operationID, actionInstanceID: actionID, kind: write.kind } });
            this.changed(this.pendingSaves());
            if (signal?.aborted) retry();
          });
          this.#waiting.delete(write.operationID); this.changed(this.pendingSaves());
        }
      }
    });
    this.#tail = operation.catch(() => {});
    return operation;
  }

  async #load(actionID: string): Promise<JournalRecord[]> {
    z.uuid().parse(actionID);
    let records = this.#history.get(actionID);
    if (!records) {
      records = [...await this.journal.read(`action/${actionID}`)];
      for (const record of records) if (transitionActionID(transitionSchema.parse(record.value)) !== actionID) throw new TahPersistenceErrorV1("integrity");
      await replay(records);
      this.#history.clear(); // Only the actively written Action is cached in Node.
      this.#history.set(actionID, records);
    }
    return records;
  }
}

function transitionActionID(transition: Transition): string {
  const request = transition.request as { actionInstanceID?: unknown; lease?: { actionInstanceID?: unknown } };
  return z.uuid().parse(transition.method === "claimInfrastructureRetryLease" ? request.lease?.actionInstanceID : request.actionInstanceID);
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, child: unknown) => child !== null && typeof child === "object" && !Array.isArray(child)
    ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b, "en"))) : child);
}

async function replay(records: readonly JournalRecord[], nextRetryID: string = randomUUID()): Promise<TahPersistenceStateV1> {
  let retryID = nextRetryID;
  const state = new TahPersistenceStateV1(() => retryID);
  for (const record of records) {
    const transition = transitionSchema.parse(record.value);
    if (record.kind !== kinds[transition.method]) throw new TahPersistenceErrorV1("integrity");
    retryID = transition.retryID;
    const result = await apply(state, transition.method, transition.request);
    if (JSON.stringify(result ?? null) !== JSON.stringify(transition.result)) throw new TahPersistenceErrorV1("integrity");
  }
  retryID = nextRetryID;
  return state;
}
function apply(state: TahPersistenceStateV1, method: Method, request: unknown): Promise<unknown> {
  // The state validator performs the complete closed-shape and semantic validation.
  switch (method) {
    case "commitProposal": return state.commitProposal(request as TahProposalCommitRequestV1);
    case "publishRevision": return state.publishRevision(request as TahPublicationCommitRequestV1);
    case "releaseProposalReservation": return state.releaseProposalReservation(request as Parameters<TahFrameworkPersistencePortV1["releaseProposalReservation"]>[0]);
    case "retainInfrastructureRetryLease": return state.retainInfrastructureRetryLease(request as TahInfrastructureRetryLeaseRequestV1);
    case "claimInfrastructureRetryLease": return state.claimInfrastructureRetryLease(request as Parameters<TahFrameworkPersistencePortV1["claimInfrastructureRetryLease"]>[0]);
  }
}
