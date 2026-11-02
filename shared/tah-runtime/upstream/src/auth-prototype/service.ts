import type { AuthNoticeCode } from "./notices.js";
import { randomUUID } from "node:crypto";
import { AUTH_PROVIDERS, AuthOperationError, cancelled, type AuthCatalog, type AuthChallenge, type AuthProviderID } from "./protocol.js";
import type { ProviderAccountUsageV1 } from "../contract/account-usage.js";
import type { AuthDriver, AuthDriverResult } from "./driver.js";
import { emptyAuthRecord, type AuthRecord, type AuthStorage } from "./storage.js";
import {inspectionFailures, type AuthInspection, type AuthInspectionFailure} from "./inspection.js";

export type ReplacementKind = "switch_provider" | "switch_account" | "reauth" | "sign_out";
export interface AuthSnapshot {
  readonly providers: typeof AUTH_PROVIDERS;
  readonly providerID: AuthProviderID | null;
  readonly state: "unauthed" | "valid" | "invalid";
  readonly phase: "idle" | "authorizing" | "deleting" | "recovering" | "fatal";
  readonly inspecting: boolean;
  readonly cancelling: boolean;
  readonly account: string | null;
  readonly checkedAt: string | null;
  readonly inspection: AuthInspection | null;
  readonly catalog: AuthCatalog | null;
  readonly accountUsage: ProviderAccountUsageV1 | null;
  readonly accountUsageUnavailable: boolean;
  readonly noticeCode: AuthNoticeCode | null;
  readonly challenge: (AuthChallenge & { readonly id: string }) | null;
  readonly replacement: { readonly id: string; readonly kind: ReplacementKind; readonly providerID: AuthProviderID } | null;
}
interface ActiveOperation {
  epoch: number;
  kind: "authenticate" | "inspect";
  abort: AbortController;
  result: Promise<AuthDriverResult>;
}

export class AuthConflictError extends Error {
  public constructor() { super("Authorization state changed; refresh and try again."); }
}

/** One system Provider. Credential borrowing is Host-internal, never an HTTP surface. */
export class AuthService {
  #record: AuthRecord = emptyAuthRecord();
  #phase: AuthSnapshot["phase"] = "idle";
  #active: ActiveOperation | null = null;
  #epoch = 0;
  #cancelling = false;
  #closed = false;
  #catalog: AuthCatalog | null = null;
  #accountUsage: ProviderAccountUsageV1 | null = null;
  #accountUsageUnavailable = false;
  #inspection: AuthInspection | null = null;
  #noticeCode: AuthNoticeCode | null = null;
  #challenge: AuthSnapshot["challenge"] = null;
  #replacement: AuthSnapshot["replacement"] = null;
  #secret: { id: string; resolve(value: Uint8Array): void; reject(error: Error): void } | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #identity = 0;
  readonly #borrowers = new Set<{ abort: AbortController; done: Promise<unknown> }>();
  #borrowerCleanupFailed = false;
  readonly #invalidators = new Set<() => Promise<void>>();
  readonly #observers = new Set<(snapshot: AuthSnapshot) => void>();
  #lastNotification = "";
  #invalidatorDrain: Promise<unknown> = Promise.resolve();

  public constructor(private readonly storage: AuthStorage, private readonly run: AuthDriver,
    private readonly catalogUsable: (provider: AuthProviderID, catalog: AuthCatalog) => boolean = () => true) {}

  public get identityVersion(): number { return this.#identity; }

  /** Public state notifications only; no polling and no credential-bearing records. */
  public observe(observer: (snapshot: AuthSnapshot) => void): () => void {
    this.#observers.add(observer);
    observer(this.snapshot());
    return () => { this.#observers.delete(observer); };
  }

  public onIdentityInvalidated(cancel: () => Promise<void>): () => void {
    this.#invalidators.add(cancel);
    return () => { this.#invalidators.delete(cancel); };
  }

  /** Only an explicit normalized Provider authentication failure may call this. */
  public reportAuthenticationInvalid(providerID: AuthProviderID, identity: number): Promise<void> {
    if (this.#closed || this.#record.providerID !== providerID || identity !== this.#identity) return Promise.resolve();
    this.#invalidateIdentity();
    this.#record = { ...this.#record, state: "invalid" };
    this.#catalog = null;
    this.#accountUsage = null;
    this.#accountUsageUnavailable = false;
    this.#noticeCode = "authorization_invalid";
    this.#failedInspection("authorization_invalid");
    const invalidIdentity = this.#identity;
    return this.#serialize(async () => {
      if (invalidIdentity !== this.#identity || this.#closed) return;
      await this.#save(this.#record);
    });
  }

  public async initialize(): Promise<void> {
    try { this.#record = await this.storage.load(); }
    catch { await this.#recover("storage_unreadable_reset", false); }
    if (this.#record.state === "invalid") this.#failedInspection("authorization_invalid");
  }

  public snapshot(): AuthSnapshot {
    // Select fields explicitly: the storage record and operation result contain private credentials.
    return structuredClone({
      providers: AUTH_PROVIDERS, providerID: this.#record.providerID, state: this.#record.state,
      phase: this.#phase, inspecting: this.#active?.kind === "inspect", cancelling: this.#cancelling,
      account: this.#record.account, checkedAt: this.#record.checkedAt,
      inspection: this.#inspection,
      catalog: this.#catalog, noticeCode: this.#noticeCode, challenge: this.#challenge, replacement: this.#replacement,
      accountUsage: this.#accountUsage, accountUsageUnavailable: this.#accountUsageUnavailable,
    });
  }

  public select(providerID: AuthProviderID): Promise<void> {
    return this.#serialize(async () => {
      this.#requireIdle();
      if (this.#record.state !== "unauthed") throw new AuthConflictError();
      const record = emptyAuthRecord(providerID);
      await this.#save(record);
      this.#noticeCode = null;
      this.#catalog = null;
      this.#accountUsage = null;
      this.#accountUsageUnavailable = false;
      this.#inspection = null;
    });
  }

  public authorize(): Promise<void> {
    return this.#serialize(async () => {
      this.#requireIdle();
      if (this.#record.state !== "unauthed" || this.#record.providerID === null) throw new AuthConflictError();
      this.#start("authenticate");
    });
  }

  public inspect(): Promise<void> {
    return this.#serialize(async () => {
      if (this.#active?.kind === "inspect") return;
      this.#requireIdle();
      if (this.#borrowers.size > 0) throw new AuthConflictError();
      if (this.#record.state !== "valid") throw new AuthConflictError();
      this.#start("inspect");
    });
  }

  /** Best-effort terminal usage refresh, serialized and bound to the completing
   * workflow's auth identity. Never queues a check for a replacement account. */
  public inspectIfCurrent(identity: number): Promise<boolean> {
    return this.#serialize(async () => {
      if (this.#closed || identity !== this.#identity || this.#phase !== "idle"
        || this.#record.state !== "valid" || this.#active || this.#replacement
        || this.#borrowerCleanupFailed || this.#borrowers.size > 0) return false;
      this.#start("inspect");
      return true;
    });
  }

  /** Lazy, combined inspection: no timer and no separate catalog VM. */
  public async inspectAndWait(): Promise<AuthSnapshot> {
    await this.inspect();
    const active = this.#active;
    if (active) await active.result.catch(() => {});
    await this.#queue;
    return this.snapshot();
  }

  /**
   * Scoped credential use. The operation must settle only after VM destruction;
   * uncertain cleanup must be raised as AuthOperationError("cleanup").
   */
  public withCredential<T>(
    providerID: AuthProviderID,
    operation: (bytes: Uint8Array, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    this.#requireIdle();
    if (signal?.aborted) return Promise.reject(cancelled());
    if (this.#record.state !== "valid" || this.#record.providerID !== providerID
      || this.#record.credential === null) throw new AuthConflictError();
    const identity = this.#identity;
    const bytes = Buffer.from(this.#record.credential, "base64");
    const abort = new AbortController();
    const onAbort = (): void => abort.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const borrower = { abort, done: Promise.resolve() as Promise<unknown> };
    const done = Promise.resolve().then(() => {
      if (abort.signal.aborted) throw cancelled();
      return operation(bytes, abort.signal);
    }).then((result) => {
      if (identity !== this.#identity || abort.signal.aborted || this.#closed) throw cancelled();
      return result;
    }).catch((error: unknown) => {
      if (error instanceof AuthOperationError && error.code === "cleanup") this.#borrowerCleanupFailed = true;
      throw error;
    }).finally(() => {
      bytes.fill(0);
      signal?.removeEventListener("abort", onAbort);
      this.#borrowers.delete(borrower);
    });
    borrower.done = done;
    this.#borrowers.add(borrower);
    // Caller owns the result; cancellation may precede its await.
    void done.catch(() => {});
    return done;
  }

  public requestReplacement(kind: ReplacementKind, target?: AuthProviderID): Promise<void> {
    return this.#serialize(async () => {
      if (this.#closed || this.#phase !== "idle" || this.#record.state === "unauthed"
        || this.#record.providerID === null || this.#replacement !== null) throw new AuthConflictError();
      const providerID = kind === "switch_provider" ? target : this.#record.providerID;
      if (providerID === undefined || (kind === "switch_provider" && providerID === this.#record.providerID)) {
        throw new AuthConflictError();
      }
      this.#replacement = { id: randomUUID(), kind, providerID };
    });
  }

  public async confirmReplacement(id: string, confirmed: boolean): Promise<void> {
    const replacement = this.#replacement;
    if (replacement?.id !== id) throw new AuthConflictError();
    if (!confirmed) {
      await this.#serialize(async () => {
        if (this.#replacement?.id !== id) throw new AuthConflictError();
        this.#replacement = null;
      });
      return;
    }
    const active = this.#invalidate();
    this.#phase = "deleting";
    this.#replacement = null;
    await this.#serialize(async () => {
      if (!await this.#drain(active)) return;
      try {
        await this.storage.reset(replacement.providerID);
        this.#record = emptyAuthRecord(replacement.providerID);
        this.#catalog = null;
        this.#accountUsage = null;
        this.#accountUsageUnavailable = false;
        this.#inspection = null;
        this.#phase = "idle";
        this.#noticeCode = "authorization_removed";
        if (replacement.kind === "reauth" || replacement.kind === "switch_account") this.#start("authenticate");
      } catch { await this.#recover("replacement_cleanup_reset", false); }
    });
  }

  public async cancel(): Promise<void> {
    if (this.#active?.kind !== "authenticate" || this.#phase !== "authorizing" || this.#cancelling) {
      throw new AuthConflictError();
    }
    const active = this.#invalidate();
    this.#cancelling = true;
    await this.#serialize(async () => {
      if (!await this.#drain(active)) return;
      try {
        await this.storage.reset(this.#record.providerID);
        this.#record = emptyAuthRecord(this.#record.providerID);
        this.#phase = "idle";
        this.#noticeCode = "authorization_cancelled";
        this.#failedInspection("cancelled");
      } catch { await this.#recover("cancellation_cleanup_failed", false); }
      finally { this.#cancelling = false; }
    });
  }

  public submitSecret(challengeID: string, value: Uint8Array): void {
    if (this.#secret?.id !== challengeID || !this.#active || this.#active.abort.signal.aborted) {
      value.fill(0); throw new AuthConflictError();
    }
    const pending = this.#secret;
    this.#secret = null;
    this.#challenge = null;
    pending.resolve(value);
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const active = this.#invalidate();
    await this.#serialize(async () => {
      const clean = await this.#drain(active);
      await this.storage.close();
      if (!clean) throw new AuthOperationError("cleanup");
    });
  }

  #start(kind: "authenticate" | "inspect"): void {
    const providerID = this.#record.providerID;
    if (providerID === null || this.#active) throw new AuthConflictError();
    const epoch = ++this.#epoch;
    this.#inspection = {id: randomUUID(), state: "checking", startedAt: new Date().toISOString(), finishedAt: null, failures: []};
    const abort = new AbortController();
    this.#phase = kind === "authenticate" ? "authorizing" : "idle";
    this.#noticeCode = null;
    this.#challenge = null;
    const credential = this.#record.credential === null ? null : Buffer.from(this.#record.credential, "base64");
    const result = Promise.resolve().then(() => this.run({
      providerID, kind, credential, signal: abort.signal,
      challenge: async (challenge) => {
        if (this.#epoch !== epoch || abort.signal.aborted) throw cancelled();
        const id = randomUUID();
        this.#challenge = { ...challenge, id };
        this.#notify();
        if (challenge.kind === "device_code") return null;
        return new Promise<Uint8Array>((resolve, reject) => {
          this.#secret = { id, resolve, reject };
        });
      },
    })).finally(() => { credential?.fill(0); });
    const active: ActiveOperation = { epoch, kind, abort, result };
    this.#active = active;
    void result.then(
      (value) => this.#serialize(() => this.#finish(active, value)),
      (error: unknown) => this.#serialize(() => this.#finish(active, undefined, error)),
    ).catch(() => { this.#phase = "fatal"; this.#noticeCode = "recovery_failed"; this.#failedInspection("cleanup"); this.#notify(); });
  }

  async #finish(active: ActiveOperation, result?: AuthDriverResult, error?: unknown): Promise<void> {
    try {
      if (this.#active !== active || this.#epoch !== active.epoch || this.#closed) return;
      this.#challenge = null;
      this.#secret = null;
      if (error !== undefined) {
        const code = error instanceof AuthOperationError ? error.code : "protocol";
        if (active.kind === "inspect" && (code === "unavailable" || code === "timeout")) {
          this.#noticeCode = "inspection_unavailable_retained";
          this.#failedInspection(code);
          return;
        }
        await this.#recover("authorization_incomplete_reset", code === "cleanup");
        this.#failedInspection(code === "cleanup" ? "cleanup" : code === "storage" ? "storage" : code === "auth_invalid" ? "authorization_invalid" : "protocol");
        return;
      }
      if (!result || (active.kind === "authenticate" && (result.state !== "valid" || !result.credential))) {
        await this.#recover("authorization_unconfirmed", false);
        this.#failedInspection("authorization_invalid");
        return;
      }
      if (result.state === "invalid") {
        this.#invalidateIdentity();
        await Promise.allSettled([...this.#borrowers].map((borrower) => borrower.done));
        if (this.#borrowerCleanupFailed) {
          await this.#recover("task_cleanup_unconfirmed", true);
          return;
        }
        if (this.#active !== active || this.#epoch !== active.epoch || this.#closed) return;
      }
      const record: AuthRecord = {
        ...this.#record, state: result.state,
        credential: result.credential === null ? this.#record.credential : Buffer.from(result.credential).toString("base64"),
        account: result.account, checkedAt: new Date().toISOString(),
      };
      await this.storage.save(record);
      // Cancel/replacement may arrive while the atomic file write is in flight.
      // Their queued reset removes this write, and this result never becomes visible.
      if (this.#epoch !== active.epoch || this.#closed) return;
      this.#record = record;
      this.#catalog = result.state === "valid" ? result.catalog : null;
      this.#accountUsage = result.state === "valid" ? result.accountUsage : null;
      this.#accountUsageUnavailable = result.state === "valid" && result.accountUsageUnavailable;
      this.#phase = "idle";
      this.#noticeCode = result.state === "invalid" ? "authorization_invalid"
        : validNotice(result.catalogUnavailable, result.accountUsageUnavailable);
      const failures = inspectionFailures(result);
      if (result.state === "valid" && result.catalog && !this.catalogUsable(record.providerID!, result.catalog)
        && !failures.includes("models_unavailable")) failures.push("models_unavailable");
      if (this.#inspection) this.#inspection = {...this.#inspection, state: failures.length ? "failed" : "succeeded",
        finishedAt: new Date().toISOString(), failures};
    } catch { await this.#recover("credential_save_failed_reset", false); }
    finally {
      if (this.#active === active) this.#active = null;
      result?.credential?.fill(0);
    }
  }

  #invalidate(): ActiveOperation | null {
    ++this.#epoch;
    this.#invalidateIdentity();
    const active = this.#active;
    active?.abort.abort();
    this.#secret?.reject(cancelled());
    this.#secret = null;
    this.#challenge = null;
    return active;
  }

  async #drain(active: ActiveOperation | null): Promise<boolean> {
    await this.#invalidatorDrain;
    await Promise.allSettled([...this.#borrowers].map((borrower) => borrower.done));
    if (this.#borrowerCleanupFailed) {
      await this.#recover("task_cleanup_unconfirmed", true);
      return false;
    }
    if (!active) return true;
    try { (await active.result).credential?.fill(0); }
    catch (error) {
      if (error instanceof AuthOperationError && error.code === "cleanup") {
        this.#active = null;
        await this.#recover("auth_cleanup_unconfirmed", true);
        return false;
      }
    }
    if (this.#active === active) this.#active = null;
    return true;
  }

  async #recover(notice: AuthNoticeCode, fatal: boolean): Promise<void> {
    this.#invalidate();
    this.#phase = "recovering";
    this.#replacement = null;
    this.#catalog = null;
    this.#accountUsage = null;
    this.#accountUsageUnavailable = false;
    this.#failedInspection(fatal ? "cleanup" : notice.includes("save") || notice.includes("storage") ? "storage" : "protocol");
    await this.#invalidatorDrain;
    await Promise.allSettled([...this.#borrowers].map((borrower) => borrower.done));
    fatal ||= this.#borrowerCleanupFailed;
    try {
      await this.storage.reset(this.#record.providerID);
      this.#record = emptyAuthRecord(this.#record.providerID);
      this.#phase = fatal ? "fatal" : "idle";
      this.#noticeCode = notice;
    } catch {
      this.#phase = "fatal";
      this.#noticeCode = "storage_cleanup_failed";
    }
  }

  async #save(record: AuthRecord): Promise<void> {
    try { await this.storage.save(record); this.#record = record; }
    catch { await this.#recover("state_save_failed_reset", false); throw new AuthOperationError("storage"); }
  }
  #invalidateIdentity(): void {
    ++this.#identity;
    for (const borrower of this.#borrowers) borrower.abort.abort();
    const pending = [this.#invalidatorDrain];
    for (const cancel of this.#invalidators) {
      try { pending.push(cancel()); }
      catch { this.#borrowerCleanupFailed = true; }
    }
    this.#invalidatorDrain = Promise.allSettled(pending).then((results) => {
      if (results.some((result) => result.status === "rejected")) this.#borrowerCleanupFailed = true;
    });
  }
  #requireIdle(): void {
    if (this.#closed || this.#phase !== "idle" || this.#active || this.#replacement
      || this.#borrowerCleanupFailed) throw new AuthConflictError();
  }
  #failedInspection(failure: AuthInspectionFailure): void {
    const now = new Date().toISOString();
    this.#inspection = {...(this.#inspection ?? {id: randomUUID(), startedAt: now}), state: "failed", finishedAt: now, failures: [failure]};
  }
  #serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(operation);
    this.#queue = next.catch(() => {}).finally(() => this.#notify());
    return next;
  }

  #notify(): void {
    const snapshot = this.snapshot();
    const encoded = JSON.stringify(snapshot);
    if (encoded === this.#lastNotification) return;
    this.#lastNotification = encoded;
    for (const observer of this.#observers) {
      try { observer(structuredClone(snapshot)); } catch { /* A UI observer never changes auth authority. */ }
    }
  }
}

function validNotice(catalogUnavailable: boolean, usageUnavailable: boolean): AuthNoticeCode {
  if (catalogUnavailable && usageUnavailable) return "authorized_catalog_usage_unavailable";
  if (catalogUnavailable) return "authorized_catalog_unavailable";
  if (usageUnavailable) return "authorized_usage_unavailable";
  return "authorized";
}
