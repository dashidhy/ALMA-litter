import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import { AuthOperationError, MAX_CREDENTIAL_BYTES, providerIDSchema, type AuthProviderID } from "./protocol.js";

const recordSchema = z.strictObject({
  version: z.literal(1), providerID: providerIDSchema.nullable(),
  state: z.enum(["unauthed", "valid", "invalid"]), credential: z.string().nullable(),
  account: z.string().max(256).nullable(), checkedAt: z.string().datetime().nullable(),
}).superRefine((record, context) => {
  const bytes = record.credential === null ? null : Buffer.from(record.credential, "base64");
  if ((record.state === "unauthed" && (record.credential !== null || record.account !== null))
    || (record.state !== "unauthed" && (record.providerID === null || bytes === null))
    || (bytes !== null && (bytes.byteLength === 0 || bytes.byteLength > MAX_CREDENTIAL_BYTES
      || bytes.toString("base64") !== record.credential))) {
    context.addIssue({ code: "custom", message: "Inconsistent auth state" });
  }
  bytes?.fill(0);
});
export type AuthRecord = z.infer<typeof recordSchema>;
export function emptyAuthRecord(providerID: AuthProviderID | null = null): AuthRecord {
  return { version: 1, providerID, state: "unauthed", credential: null, account: null, checkedAt: null };
}

export interface AuthStorage {
  load(): Promise<AuthRecord>;
  save(record: AuthRecord): Promise<void>;
  reset(providerID: AuthProviderID | null): Promise<void>;
  close(): Promise<void>;
}

/** Prototype vault: one private atomic record, never an ambient Provider credential file. */
export class FileAuthStorage implements AuthStorage {
  #root = "";
  #locked = false;
  public constructor(private readonly directory: string) {}

  public async acquire(): Promise<void> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
      || (process.getuid && metadata.uid !== process.getuid())) throw new AuthOperationError("storage");
    this.#root = await realpath(this.directory);
    const lockPath = join(this.#root, "auth.lock");
    for (let attempt = 0; attempt < 2; attempt++) {
      let lock;
      try {
        lock = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      } catch (error) {
        if (!isCode(error, "EEXIST")) throw new AuthOperationError("storage");
        const bytes = await this.#read("auth.lock", 32);
        const pid = Number(bytes?.toString("utf8"));
        if (!Number.isSafeInteger(pid) || pid < 1) throw new AuthOperationError("storage");
        try { process.kill(pid, 0); throw new AuthOperationError("storage"); }
        catch (failure) { if (!isCode(failure, "ESRCH")) throw new AuthOperationError("storage"); }
        await unlink(lockPath);
        continue;
      }
      // Once O_EXCL succeeds, every initialization failure must release our
      // own lock. Never unlink a live lock rejected in the acquisition branch.
      this.#locked = true;
      try {
        try { await lock.writeFile(String(process.pid)); await lock.sync(); }
        finally { await lock.close(); }
        await this.#removeTemps();
        return;
      } catch {
        try { await this.close(); }
        finally { throw new AuthOperationError("storage"); }
      }
    }
    throw new AuthOperationError("storage");
  }

  public async load(): Promise<AuthRecord> {
    this.#requireLock();
    const bytes = await this.#read("auth-state.json", MAX_CREDENTIAL_BYTES * 2);
    if (bytes === null) return emptyAuthRecord();
    try { return recordSchema.parse(JSON.parse(bytes.toString("utf8"))); }
    catch { throw new AuthOperationError("storage"); }
    finally { bytes.fill(0); }
  }

  public async save(record: AuthRecord): Promise<void> {
    this.#requireLock();
    const temporary = join(this.#root, `auth-state-${randomUUID()}.tmp`);
    const bytes = Buffer.from(JSON.stringify(recordSchema.parse(record)));
    try {
      const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(bytes); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, join(this.#root, "auth-state.json"));
      await this.#syncDirectory();
    } catch { throw new AuthOperationError("storage"); }
    finally {
      bytes.fill(0);
      await unlink(temporary).catch((error: unknown) => {
        if (!isCode(error, "ENOENT")) throw new AuthOperationError("storage");
      });
    }
  }

  public async reset(providerID: AuthProviderID | null): Promise<void> {
    await this.save(emptyAuthRecord(providerID));
    await this.#removeTemps();
    const record = await this.load();
    if (record.credential !== null || record.state !== "unauthed") throw new AuthOperationError("storage");
  }

  public async close(): Promise<void> {
    if (!this.#locked) return;
    await unlink(join(this.#root, "auth.lock"));
    this.#locked = false;
  }

  async #read(name: string, maximumBytes: number): Promise<Buffer | null> {
    let file;
    try { file = await open(join(this.#root, name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) {
      if (isCode(error, "ENOENT")) return null;
      throw new AuthOperationError("storage");
    }
    try {
      const before = await file.stat();
      if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximumBytes
        || (before.mode & 0o777) !== 0o600 || (process.getuid && before.uid !== process.getuid())) {
        throw new AuthOperationError("storage");
      }
      const bytes = Buffer.alloc(before.size);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
        if (!bytesRead) { bytes.fill(0); throw new AuthOperationError("storage"); }
        offset += bytesRead;
      }
      const after = await file.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
        bytes.fill(0); throw new AuthOperationError("storage");
      }
      return bytes;
    } finally { await file.close(); }
  }

  async #removeTemps(): Promise<void> {
    for (const name of await readdir(this.#root)) {
      if (!/^auth-state-[0-9a-f-]{36}\.tmp$/u.test(name)) continue;
      const path = join(this.#root, name);
      const metadata = await lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
        || (process.getuid && metadata.uid !== process.getuid())) throw new AuthOperationError("storage");
      await unlink(path);
    }
    await this.#syncDirectory();
  }
  async #syncDirectory(): Promise<void> {
    const directory = await open(this.#root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  #requireLock(): void { if (!this.#locked) throw new AuthOperationError("storage"); }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
