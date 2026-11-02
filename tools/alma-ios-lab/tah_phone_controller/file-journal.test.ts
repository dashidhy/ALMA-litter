import { afterEach, describe, expect, it } from "../../../../ALMA/app/TAH/node_modules/vitest/dist/index.js";
import * as fs from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { createFileJournal } from "./file-journal.js";
import type { FileJournal } from "./file-journal.js";
import { prepareJournalWrite } from "../../../../ALMA/app/TAH/src/app-runtime/journal.js";
import { DurableTahPersistence } from "../../../../ALMA/app/TAH/src/app-runtime/durable-persistence.js";
import { persistenceFixture } from "../../../../ALMA/app/TAH/src/qualification/persistence-fixture.js";

// Own temporary fixtures only, all beneath the permitted controller directory.
const base = new URL(".test-cache/journal-fixtures/", import.meta.url);
fs.mkdirSync(base, { recursive: true });
const roots: string[] = [];
const handles: FileJournal[] = [];
function root() { const p = fs.mkdtempSync(new URL("case-", base).pathname); roots.push(p); return p; }
function open(path: string) { const j = createFileJournal(path); handles.push(j); return j; }
const records = (path: string) => fs.readdirSync(path).filter(name => name.endsWith(".json")).sort();
const write = (stream = "action/fixture:one", version = 0, value: unknown = { text: "Café 中文" }) =>
  prepareJournalWrite(stream, "qualification/fixture", version, "document", value);
afterEach(() => {
  for (const j of handles.splice(0)) j.close();
  for (const p of roots.splice(0)) fs.rmSync(p, { recursive: true, force: true });
});

describe("real local JournalPort; no phone/model or acceptance mocks", () => {
  it("stores immutable hashed-path versions and exact UTF-8 JSON bytes", async () => {
    const p = root(), j = open(p), a = write(), b = write(a.write.streamID, 1, ["next"]);
    expect(await j.read("empty/stream")).toEqual([]);
    expect(await j.append(a.write, a.bytes)).toBe(1);
    const first = fs.readFileSync(join(p, records(p)[0]!));
    expect(await j.append(b.write, b.bytes)).toBe(2);
    expect(fs.readFileSync(join(p, records(p)[0]!))).toEqual(first);
    expect(records(p).every(name => /^[a-f0-9]{64}\.\d{7}\.json$/u.test(name))).toBe(true);
    const disk = JSON.parse(first.toString());
    expect(Buffer.from(disk.bytes, "base64")).toEqual(a.bytes);
    const read = await j.read(a.write.streamID);
    expect(read.map(r => [r.version, r.value])).toEqual([[1, { text: "Café 中文" }], [2, ["next"]]]);
    (read[0]!.value as { text: string }).text = "caller mutation";
    expect((await j.read(a.write.streamID))[0]!.value).toEqual({ text: "Café 中文" });
  });
  it("replays exact operation IDs after reopen and rejects conflicting payload/metadata globally", async () => {
    const p = root(), j = open(p), a = write();
    await j.append(a.write, a.bytes); j.close();
    const restored = open(p);
    expect(await restored.append(a.write, a.bytes)).toBe(1);
    const changed = write(a.write.streamID, 0, { text: "different" });
    changed.write.operationID = a.write.operationID;
    await expect(restored.append(changed.write, changed.bytes)).rejects.toMatchObject({ code: "integrity_locked" });
    await expect(restored.append({ ...a.write, streamID: "another/stream" }, a.bytes)).rejects.toMatchObject({ code: "integrity_locked" });
    expect(records(p)).toHaveLength(1);
  });
  it("enforces expectedVersion and stable stream ownership without overwriting records", async () => {
    const p = root(), j = open(p), a = write(); await j.append(a.write, a.bytes);
    const before = fs.readFileSync(join(p, records(p)[0]!));
    const stale = write();
    await expect(j.append(stale.write, stale.bytes)).rejects.toMatchObject({ code: "integrity_locked" });
    const future = write(a.write.streamID, 2);
    await expect(j.append(future.write, future.bytes)).rejects.toThrow();
    const next = write(a.write.streamID, 1);
    await expect(j.append({ ...next.write, ownerID: "other" }, next.bytes)).rejects.toThrow();
    expect(fs.readFileSync(join(p, records(p)[0]!))).toEqual(before);
    expect(records(p)).toHaveLength(1);
  });
  it("holds an exclusive lifetime lock, requires close, and never steals a stale lock", () => {
    const p = root(), j = open(p);
    expect(() => createFileJournal(p)).toThrow("busy");
    j.close(); open(p).close();
    fs.writeFileSync(join(p, ".writer.lock"), '{"pid":99999999,"nonce":"stale fixture"}');
    expect(() => createFileJournal(p)).toThrow("busy");
    expect(fs.readFileSync(join(p, ".writer.lock"), "utf8")).toContain("stale fixture");
  });
  it("rejects payload/metadata corruption, broken chains and orphaned pending data on reopen", async () => {
    for (const corruption of ["bytes", "metadata", "gap", "pending"] as const) {
      const p = root(), j = open(p), a = write(), b = write(a.write.streamID, 1);
      await j.append(a.write, a.bytes); await j.append(b.write, b.bytes); j.close();
      const first = join(p, records(p)[0]!);
      if (corruption === "gap") fs.unlinkSync(first);
      else if (corruption === "pending") fs.writeFileSync(join(p, ".pending-orphan"), "incomplete");
      else {
        const value = JSON.parse(fs.readFileSync(first, "utf8"));
        if (corruption === "bytes") value.bytes = Buffer.from("{}").toString("base64");
        else value.write.operationID = randomUUID();
        fs.chmodSync(first, 0o600); fs.writeFileSync(first, JSON.stringify(value));
      }
      expect(() => createFileJournal(p)).toThrow("integrity_locked");
    }
  });
  it("refuses a non-journal directory and invalid schema/hash/length/JSON, honoring aborts", async () => {
    const foreign = root(); fs.writeFileSync(join(foreign, "keep.txt"), "owned fixture");
    expect(() => createFileJournal(foreign)).toThrow();
    expect(fs.readFileSync(join(foreign, "keep.txt"), "utf8")).toBe("owned fixture");
    const p = root(), j = open(p), a = write();
    await expect(j.append({ ...a.write, expectedVersion: -1 }, a.bytes)).rejects.toThrow();
    await expect(j.append(a.write, Buffer.from("wrong"))).rejects.toThrow();
    const invalid = Buffer.from([0xff]);
    await expect(j.append({ ...a.write, byteLength: 1,
      sha256: createHash("sha256").update(invalid).digest("hex") }, invalid)).rejects.toThrow();
    const aborted = AbortSignal.abort();
    await expect(j.append(a.write, a.bytes, aborted)).rejects.toMatchObject({ code: "cancelled" });
    expect(records(p)).toEqual([]);
    await j.append(a.write, a.bytes);
    expect(await j.append(a.write, a.bytes, aborted)).toBe(1);
  });
  it("reopens ORIGINAL DurableTahPersistence publications and preserves actual receipt idempotency", async () => {
    const p = root(), j = open(p), fixture = persistenceFixture();
    const first = new DurableTahPersistence(j, () => "qualification/fixture");
    await first.commitProposal(fixture.proposal);
    const receipt = await first.publishRevision(fixture.publication);
    first.close(); j.close();
    const restoredJournal = open(p);
    const restored = new DurableTahPersistence(restoredJournal, () => "qualification/fixture");
    expect(await restored.acceptedPublications(fixture.proposal.actionInstanceID)).toEqual([fixture.publication]);
    expect(await restored.publishRevision(fixture.publication)).toEqual(receipt);
    expect(await restoredJournal.read(`action/${fixture.proposal.actionInstanceID}`)).toHaveLength(2);
    restored.close();
  });
  it("lets ORIGINAL durable validation reject changed inference and forged stored transition receipts", async () => {
    const p = root(), j = open(p), fixture = persistenceFixture();
    const first = new DurableTahPersistence(j, () => "qualification/fixture");
    await first.commitProposal(fixture.proposal);
    await expect(first.publishRevision({ ...fixture.publication, actorAttempts: [{
      ...fixture.publication.actorAttempts[0]!, inference: { modelID: "changed", reasoningEffortID: null },
    }] })).rejects.toThrow();
    first.close(); j.close();
    // Recompute storage checksums to prove the *framework* also rejects a forged semantic receipt.
    const recordPath = join(p, records(p)[0]!);
    const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
    const transition = JSON.parse(Buffer.from(record.bytes, "base64").toString());
    transition.result = { commitID: "forged" };
    const bytes = Buffer.from(JSON.stringify(transition));
    record.bytes = bytes.toString("base64"); record.write.byteLength = bytes.length;
    record.write.sha256 = createHash("sha256").update(bytes).digest("hex");
    const { checksum: _, ...body } = record;
    record.checksum = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    fs.chmodSync(recordPath, 0o600); fs.writeFileSync(recordPath, JSON.stringify(record));
    const restored = new DurableTahPersistence(open(p), () => "qualification/fixture");
    await expect(restored.acceptedPublications(fixture.proposal.actionInstanceID)).rejects.toThrow();
    restored.close();
  });
});
