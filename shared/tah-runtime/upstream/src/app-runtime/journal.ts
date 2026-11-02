import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { AppBridgeError, type AppRuntimeBridge } from "./bridge.js";

export const JOURNAL_CHUNK_BYTES = 64 * 1024;
export const JOURNAL_MAX_BYTES = 64 * 1024 * 1024;
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const key = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u);
const kindSchema = z.enum(["proposal", "publication", "release", "retry_retain", "retry_claim", "checkpoint", "document", "raw_receipt"]);
export const journalWriteSchema = z.strictObject({
  operationID: z.uuid(), streamID: key, ownerID: key,
  expectedVersion: z.number().int().min(0).max(999_999),
  kind: kindSchema,
  publicationRevision: z.number().int().min(0).max(127).nullable().default(null),
  byteLength: z.number().int().positive().max(JOURNAL_MAX_BYTES), sha256: digest,
}).refine(value => (value.kind === "publication") === (value.publicationRevision !== null));
export type JournalWrite = z.infer<typeof journalWriteSchema>;
export interface JournalRecord { readonly version: number; readonly operationID: string; readonly kind: JournalWrite["kind"]; readonly value: unknown }
export interface JournalPort {
  read(streamID: string): Promise<readonly JournalRecord[]>;
  readLast?(streamID: string): Promise<JournalRecord | undefined>;
  append(write: JournalWrite, bytes: Uint8Array, signal?: AbortSignal): Promise<number>;
}

export function prepareJournalWrite(streamID: string, ownerID: string, expectedVersion: number,
  kind: JournalWrite["kind"], value: unknown, publicationRevision: number | null = null,
): { write: JournalWrite; bytes: Buffer } {
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  const write = journalWriteSchema.parse({ operationID: randomUUID(), streamID, ownerID, expectedVersion,
    kind, publicationRevision, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
  return { write, bytes };
}

/** All disk I/O and commit authority remain in Swift. No Node SQLite dependency. */
export class ServiceJournal implements JournalPort {
  public constructor(private readonly bridge: Pick<AppRuntimeBridge, "call">) {}
  public async pending(): Promise<readonly JournalWrite[]> {
    return z.array(journalWriteSchema).max(16).parse(await this.bridge.call("store.pending", {}));
  }
  public async readPending(write: JournalWrite): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for (let start = 0; start < write.byteLength; start += JOURNAL_CHUNK_BYTES) {
      const { data } = z.strictObject({ data: z.string().max(87384) }).parse(await this.bridge.call("store.pendingChunk", { operationID: write.operationID, index: start / JOURNAL_CHUNK_BYTES }));
      const bytes = Buffer.from(data, "base64");
      if (bytes.toString("base64") !== data || bytes.length !== Math.min(JOURNAL_CHUNK_BYTES, write.byteLength - start)) throw new AppBridgeError("integrity_locked");
      chunks.push(bytes);
    }
    const bytes = Buffer.concat(chunks);
    if (createHash("sha256").update(bytes).digest("hex") !== write.sha256) throw new AppBridgeError("integrity_locked");
    return bytes;
  }

  public async append(write: JournalWrite, bytes: Uint8Array, signal?: AbortSignal): Promise<number> {
    journalWriteSchema.parse(write);
    if (bytes.byteLength !== write.byteLength || createHash("sha256").update(bytes).digest("hex") !== write.sha256) throw new Error("journal identity mismatch");
    let cancellation: Promise<{ version: number | null }> | undefined;
    const cancel = () => {
      cancellation ??= this.bridge.call("store.cancel", { operationID: write.operationID }).then(value =>
        z.strictObject({ version: z.number().int().positive().nullable() }).parse(value));
      void cancellation.catch(() => {});
    };
    const reconcileCancellation = async (): Promise<number> => {
      cancel();
      const { version } = await cancellation!;
      if (version === null) throw new AppBridgeError("cancelled");
      if (version !== write.expectedVersion + 1) throw new AppBridgeError("integrity_locked");
      return version;
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (signal?.aborted) return await reconcileCancellation();
      await this.bridge.call("store.begin", write);
      for (let start = 0; start < bytes.byteLength; start += JOURNAL_CHUNK_BYTES) {
        if (signal?.aborted) return await reconcileCancellation();
        await this.bridge.call("store.putChunk", { operationID: write.operationID, index: start / JOURNAL_CHUNK_BYTES,
          data: Buffer.from(bytes.subarray(start, start + JOURNAL_CHUNK_BYTES)).toString("base64") });
      }
      if (signal?.aborted) return await reconcileCancellation();
      const result = z.strictObject({ version: z.number().int().positive() }).parse(await this.bridge.call("store.commit", { operationID: write.operationID }));
      if (result.version !== write.expectedVersion + 1) throw new AppBridgeError("integrity_locked");
      return result.version;
    } catch (error) {
      if (signal?.aborted) return await reconcileCancellation();
      throw error;
    } finally { signal?.removeEventListener("abort", cancel); }
  }

  public async head(streamID: string) {
    key.parse(streamID);
    const head = z.strictObject({ version: z.number().int().nonnegative().max(1_000_000), acceptedRevision: z.number().int().min(-1).max(127), deleted: z.boolean() })
      .parse(await this.bridge.call("store.head", { streamID }));
    if (head.deleted) throw new AppBridgeError("invalid_request");
    return head;
  }
  public async readLast(streamID: string): Promise<JournalRecord | undefined> {
    const head = await this.head(streamID);
    return head.version === 0 ? undefined : (await this.readRange(streamID, head.version - 1, head.version))[0];
  }
  public async read(streamID: string): Promise<readonly JournalRecord[]> {
    return this.readRange(streamID, 0, (await this.head(streamID)).version);
  }
  public async readRange(streamID: string, afterVersion: number, throughVersion: number): Promise<readonly JournalRecord[]> {
    key.parse(streamID);
    if (!Number.isSafeInteger(afterVersion) || !Number.isSafeInteger(throughVersion) || afterVersion < 0 || throughVersion < afterVersion || throughVersion > 1_000_000) throw new AppBridgeError("invalid_request");
    const records: JournalRecord[] = [];
    while (records.length + afterVersion < throughVersion) {
      const entries = z.array(z.strictObject({ operationID: z.uuid(), version: z.number().int().positive(),
        kind: kindSchema,
        byteLength: z.number().int().positive().max(JOURNAL_MAX_BYTES), sha256: digest })).min(1).max(16)
        .parse(await this.bridge.call("store.entries", { streamID, afterVersion: records.length + afterVersion, limit: Math.min(16, throughVersion - afterVersion - records.length) }));
      for (const entry of entries) {
        if (entry.version > throughVersion) break;
        if (entry.version !== records.length + afterVersion + 1) throw new Error("journal has a sequence gap");
        const parts: Buffer[] = [];
        for (let start = 0; start < entry.byteLength; start += JOURNAL_CHUNK_BYTES) {
          const { data } = z.strictObject({ data: z.string().max(87384) }).parse(await this.bridge.call("store.readChunk", {
            operationID: entry.operationID, index: start / JOURNAL_CHUNK_BYTES,
          }));
          const bytes = Buffer.from(data, "base64");
          if (bytes.toString("base64") !== data || bytes.length !== Math.min(JOURNAL_CHUNK_BYTES, entry.byteLength - start)) throw new Error("invalid journal chunk");
          parts.push(bytes);
        }
        const bytes = Buffer.concat(parts);
        if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("journal digest mismatch");
        records.push({ version: entry.version, operationID: entry.operationID, kind: entry.kind,
          value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown });
      }
    }
    return records;
  }
}
