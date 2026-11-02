// Local qualification storage only. Trusted caller owns root and its parent topology.
import * as fs from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { journalWriteSchema, JOURNAL_MAX_BYTES } from "../../../../ALMA/app/TAH/src/app-runtime/journal.js";
import type { JournalPort, JournalRecord, JournalWrite } from "../../../../ALMA/app/TAH/src/app-runtime/journal.js";
import { AppBridgeError } from "../../../../ALMA/app/TAH/src/app-runtime/bridge.js";

export type FileJournal = JournalPort & { close(): void };
const FORMAT = "ALMA_TAH_FILE_JOURNAL_V1\n";
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const utf8 = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const fail = (): never => { throw new AppBridgeError("integrity_locked"); };
const filename = (write: JournalWrite) => `${sha(write.streamID)}.${String(write.expectedVersion + 1).padStart(7, "0")}.json`;
const syncDirectory = (path: string) => {
  const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
};
interface Stored { write: JournalWrite; bytes: Buffer; version: number; hash: string; value: unknown }

/** Synchronous open/lock; asynchronous JournalPort methods perform serialized sync I/O.
 * Use a dedicated caller-owned lab .cache/results directory. close() releases the
 * lifetime lock; stale locks are NEVER removed automatically after a crash.
 */
export function createFileJournal(root: string): FileJournal {
  if (!isAbsolute(root)) fail();
  root = resolve(root);
  try { fs.mkdirSync(root, { mode: 0o700 }); syncDirectory(dirname(root)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) fail();
  const lock = join(root, ".writer.lock");
  let lockFD: number;
  try { lockFD = fs.openSync(lock, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600); }
  catch { throw new AppBridgeError("busy"); }
  const lockStat = fs.fstatSync(lockFD);
  let closed = false;
  let uncertain = false;
  function guard() {
    if (closed || uncertain) fail();
    const now = fs.lstatSync(lock);
    if (now.dev !== lockStat.dev || now.ino !== lockStat.ino || !now.isFile()) fail();
  }
  function close() {
    if (closed) return;
    const now = fs.lstatSync(lock);
    if (now.dev !== lockStat.dev || now.ino !== lockStat.ino) fail();
    closed = true;
    fs.unlinkSync(lock);
    syncDirectory(root);
  }
  function readBytes(path: string): Buffer {
    const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const info = fs.fstatSync(fd);
      if (!info.isFile() || info.size > Math.ceil(JOURNAL_MAX_BYTES * 4 / 3) + 8192) fail();
      const bytes = fs.readFileSync(fd);
      if (bytes.length !== info.size) fail();
      return bytes;
    } finally { fs.closeSync(fd); }
  }
  function publish(name: string, bytes: Buffer) {
    const temp = join(root, `.pending-${randomUUID()}`);
    let fd: number | undefined;
    try {
      fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      fs.writeFileSync(fd, bytes);
      fs.fchmodSync(fd, 0o400);
      fs.fsyncSync(fd);
      fs.closeSync(fd); fd = undefined;
      // Atomic create-if-absent publication; rename could overwrite a version.
      fs.linkSync(temp, join(root, name));
      fs.unlinkSync(temp);
      syncDirectory(root);
    } catch {
      uncertain = true;
      if (fd !== undefined) fs.closeSync(fd);
      // Retain any pending file for manual recovery; never claim an unknown commit.
      fail();
    }
  }
  function scan(): Stored[] {
    guard();
    if (readBytes(join(root, "journal-v1")).toString() !== FORMAT) fail();
    const records: Stored[] = [];
    const last = new Map<string, Stored>();
    const operations = new Set<string>();
    for (const name of fs.readdirSync(root).sort()) {
      if (name === ".writer.lock" || name === "journal-v1") continue;
      if (!/^[a-f0-9]{64}\.\d{7}\.json$/u.test(name)) fail();
      const encoded = readBytes(join(root, name));
      const record = JSON.parse(utf8(encoded));
      if (!record || Object.keys(record).sort().join(",") !== "bytes,checksum,format,previous,version,write" || record.format !== 1) fail();
      const { checksum, ...body } = record;
      if (sha(JSON.stringify(body)) !== checksum || !encoded.equals(Buffer.from(JSON.stringify(record)))) fail();
      const write = journalWriteSchema.parse(record.write);
      const prior = last.get(write.streamID);
      if (name !== filename(write) || record.version !== write.expectedVersion + 1
        || write.expectedVersion !== (prior?.version ?? 0) || record.previous !== (prior?.hash ?? null)
        || (prior && prior.write.ownerID !== write.ownerID) || operations.has(write.operationID)) fail();
      if (typeof record.bytes !== "string") fail();
      const bytes = Buffer.from(record.bytes, "base64");
      if (bytes.toString("base64") !== record.bytes || bytes.length !== write.byteLength || sha(bytes) !== write.sha256) fail();
      const stored = { write, bytes, version: record.version as number, hash: sha(encoded), value: JSON.parse(utf8(bytes)) as unknown };
      records.push(stored); last.set(write.streamID, stored); operations.add(write.operationID);
    }
    return records;
  }
  try {
    try { fs.writeFileSync(lockFD, JSON.stringify({ pid: process.pid, nonce: randomUUID() })); fs.fsyncSync(lockFD); }
    finally { fs.closeSync(lockFD); }
    const names = fs.readdirSync(root);
    if (!names.includes("journal-v1")) {
      if (names.some(name => name !== ".writer.lock")) fail();
      publish("journal-v1", Buffer.from(FORMAT));
    }
    scan();
  } catch { close(); fail(); }
  return {
    close,
    async read(streamID): Promise<readonly JournalRecord[]> {
      try {
        journalWriteSchema.shape.streamID.parse(streamID);
        return scan().filter(record => record.write.streamID === streamID).map(record => ({
          version: record.version, operationID: record.write.operationID, kind: record.write.kind, value: record.value,
        }));
      } catch { fail(); }
    },
    async append(input, source, signal): Promise<number> {
      try {
        const write = journalWriteSchema.parse(input);
        const bytes = Buffer.from(source); // Snapshot caller bytes before committing.
        if (bytes.length !== write.byteLength || sha(bytes) !== write.sha256) fail();
        JSON.parse(utf8(bytes));
        const records = scan();
        const existing = records.find(record => record.write.operationID === write.operationID);
        if (existing) {
          if (JSON.stringify(existing.write) !== JSON.stringify(write) || !existing.bytes.equals(bytes)) fail();
          return existing.version; // Reconcile an already committed operation, even if now aborted.
        }
        if (signal?.aborted) throw new AppBridgeError("cancelled");
        const prior = records.filter(record => record.write.streamID === write.streamID).at(-1);
        if (write.expectedVersion !== (prior?.version ?? 0) || (prior && prior.write.ownerID !== write.ownerID)) fail();
        const version = write.expectedVersion + 1;
        const body = { format: 1, write, version,
          previous: prior?.hash ?? null, bytes: bytes.toString("base64") };
        publish(filename(write), Buffer.from(JSON.stringify({ ...body, checksum: sha(JSON.stringify(body)) })));
        return version;
      } catch (error) {
        if (error instanceof AppBridgeError && error.code === "cancelled") throw error;
        fail();
      }
    },
  };
}
