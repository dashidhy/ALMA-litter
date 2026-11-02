import { z } from "zod";
import { AppBridgeError } from "./bridge.js";
import { prepareJournalWrite, type JournalPort } from "./journal.js";

/** Small App-owned documents live beside, not inside, semantic Action streams. */
export class AppDocuments {
  readonly #pending = new Map<string, { resolve(): void; reject(error: Error): void }>();
  #closed = false;
  public constructor(private readonly journal: JournalPort, private readonly onPending: (operationID: string | null) => void) {}
  public async last<T>(streamID: string, schema: z.ZodType<T>): Promise<T | null> {
    const entry = this.journal.readLast ? await this.journal.readLast(streamID) : (await this.journal.read(streamID)).at(-1);
    return entry === undefined ? null : schema.parse(entry.value);
  }
  public retry(operationID: string): boolean {
    const resume = this.#pending.get(operationID);
    if (!resume) return false;
    this.#pending.delete(operationID); resume.resolve(); return true;
  }
  public close(): void { this.#closed = true; for (const pending of this.#pending.values()) pending.reject(new AppBridgeError("unavailable")); this.#pending.clear(); }
  public async save(streamID: string, ownerID: string, value: unknown, signal?: AbortSignal, stopWaiting?: AbortSignal): Promise<void> {
    const version = this.journal.readLast ? (await this.journal.readLast(streamID))?.version ?? 0 : (await this.journal.read(streamID)).length;
    const { write, bytes } = prepareJournalWrite(streamID, ownerID, version, "document", value);
    while (true) {
      if (this.#closed) throw new AppBridgeError("unavailable");
      try { await this.journal.append(write, bytes, signal); this.onPending(null); return; }
      catch (error) {
        if (error instanceof AppBridgeError && ["cancelled", "integrity_locked", "invalid_request"].includes(error.code)) throw error;
        if (this.#closed) throw new AppBridgeError("unavailable");
        // Terminal metadata still gets one normal write after cancellation.
        // If storage fails, cancellation must not wait forever for Retry Save.
        // Staged bytes stay in the journal for safe, explicit recovery.
        if (stopWaiting?.aborted) throw new AppBridgeError("cancelled");
        await new Promise<void>((resolve, reject) => {
          const clear = () => { this.#pending.delete(write.operationID); signal?.removeEventListener("abort", retry); stopWaiting?.removeEventListener("abort", stop); };
          const retry = () => { clear(); resolve(); };
          const stop = () => { clear(); reject(new AppBridgeError("cancelled")); };
          signal?.addEventListener("abort", retry, { once: true });
          stopWaiting?.addEventListener("abort", stop, { once: true });
          this.#pending.set(write.operationID, { resolve: retry, reject: error => { clear(); reject(error); } });
          this.onPending(write.operationID);
          // Abort may precede listener installation while append is rejecting.
          // Re-enter append once to reconcile the durable commit/cancel winner.
          if (signal?.aborted) retry();
          if (stopWaiting?.aborted) stop();
        });
      }
    }
  }
}
