#!/usr/bin/env python3
"""Compile only the adopted journal; exercise real SQLite in a fresh host temp directory.

No app entry is added to the source target: the smoke executable source lives only
in the temporary directory. No credentials, model, phone, cutover or JSCore calls.
"""
import hashlib
import json
from pathlib import Path
import sqlite3
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
SWIFT = r'''
import Foundation

enum SmokeFailure: Error { case check(String) }

@main struct JournalSmoke {
    static func require(_ condition: Bool, _ name: String) throws {
        if !condition { throw SmokeFailure.check(name) }
    }
    static func header(_ write: TAHJournalWrite) -> TAHRuntimeValue {
        // Match TS store.begin exactly: this key must be present even when null.
        .object(["operationID": .string(write.operationID), "streamID": .string(write.streamID),
            "ownerID": .string(write.ownerID), "expectedVersion": .integer(write.expectedVersion),
            "kind": .string(write.kind), "publicationRevision": write.publicationRevision.map(TAHRuntimeValue.integer) ?? .null,
            "byteLength": .integer(write.byteLength), "sha256": .string(write.sha256)])
    }
    static func stage(_ store: TAHJournalStore, _ write: TAHJournalWrite, _ bytes: Data) async throws {
        _ = try await store.handleRPC("store.begin", value: header(write))
        for offset in stride(from: 0, to: bytes.count, by: TAHJournalStore.chunkBytes) {
            let chunk = bytes.subdata(in: offset..<min(offset + TAHJournalStore.chunkBytes, bytes.count))
            _ = try await store.handleRPC("store.putChunk", value: .object([
                "operationID": .string(write.operationID), "index": .integer(offset / TAHJournalStore.chunkBytes),
                "data": .string(chunk.base64EncodedString())]))
        }
        let complete = try await store.handleRPC("store.pendingIsComplete", value: .object(["operationID": .string(write.operationID)]))
        try require(complete == .bool(true), "complete staged upload")
    }
    static func read(_ store: TAHJournalStore, _ write: TAHJournalWrite) async throws -> Data {
        var bytes = Data()
        for offset in stride(from: 0, to: write.byteLength, by: TAHJournalStore.chunkBytes) {
            let result = try await store.handleRPC("store.readChunk", value: .object([
                "operationID": .string(write.operationID), "index": .integer(offset / TAHJournalStore.chunkBytes)]))
            guard let encoded = try result["data"]?.string(), let chunk = Data(base64Encoded: encoded) else {
                throw SmokeFailure.check("chunk decoding")
            }
            bytes.append(chunk)
        }
        return bytes
    }
    static func main() async throws {
        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let store = try TAHJournalStore(directory: directory)
        let transcriptID = UUID().uuidString.lowercased(), materialID = UUID().uuidString.lowercased()
        let owner = "transcript/\(transcriptID)", actionID = UUID().uuidString.lowercased()
        let raw = String(repeating: "Synthetic journal-only text 中文.\n", count: 2400)
        let material = try JSONEncoder().encode(TAHRuntimeValue.object([
            "transcriptID": .string(transcriptID), "title": .string("Journal smoke"), "rawTranscript": .string(raw)]))
        let materialWrite = TAHJournalWrite(operationID: materialID, streamID: "material/\(materialID)", ownerID: owner,
            expectedVersion: 0, kind: "document", publicationRevision: nil, byteLength: material.count,
            sha256: TAHRuntimeResources.digest(material))
        try require(material.count > TAHJournalStore.chunkBytes, "multi-chunk input")
        try await stage(store, materialWrite, material)
        let materialVersion = try await store.commit(operationID: materialID, requireTranscriptMaterial: true)
        try require(materialVersion == 1, "transcript structural commit")
        try require(try await read(store, materialWrite) == material, "transcript bytes")

        // Structural publication payloads exercise the journal, not a fake TAH workflow.
        var writes: [TAHJournalWrite] = []
        for revision in 0...1 {
            let bytes = try JSONEncoder().encode(TAHRuntimeValue.object(["journalSmokeRevision": .integer(revision)]))
            let write = TAHJournalWrite(operationID: UUID().uuidString.lowercased(), streamID: "action/\(actionID)",
                ownerID: owner, expectedVersion: revision, kind: "publication", publicationRevision: revision,
                byteLength: bytes.count, sha256: TAHRuntimeResources.digest(bytes))
            try await stage(store, write, bytes)
            let result = try await store.handleRPC("store.commit", value: .object(["operationID": .string(write.operationID)]))
            try require(result["version"] == .integer(revision + 1), "RPC publication version")
            try require(try await read(store, write) == bytes, "publication bytes")
            writes.append(write)
        }
        let head = try await store.handleRPC("store.head", value: .object(["streamID": .string("action/\(actionID)")]))
        try require(head["version"] == .integer(2) && head["acceptedRevision"] == .integer(1), "accepted pointer")
        let pending = try await store.handleRPC("store.pending", value: .object([:]))
        try require(pending == .array([]), "pending cleared")
        await store.close()

        let reopened = try TAHJournalStore(directory: directory)
        try require(try await read(reopened, materialWrite) == material, "reopen preserves material")
        for write in writes {
            _ = try await reopened.handleRPC("store.begin", value: header(write))
            let replay = try await reopened.handleRPC("store.commit", value: .object(["operationID": .string(write.operationID)]))
            try require(replay["version"] == .integer(write.expectedVersion + 1), "idempotent replay")
            let bytes = try await read(reopened, write)
            try require(TAHRuntimeResources.digest(bytes) == write.sha256, "reopen publication digest")
        }
        let entries = try await reopened.entries(streamID: "action/\(actionID)", afterVersion: 0)
        try require(entries.count == 2, "no duplicate publication events")
        await reopened.close()
        let report: [String: Any] = ["passed": true, "materialBytes": material.count,
            "publicationCount": entries.count, "acceptedRevision": 1, "cutoversInvoked": false,
            "checks": ["RPC begin/putChunk/pendingIsComplete", "strict transcript commit/read",
                "RPC publication commit/head/read", "pending cleared", "close/reopen bytes and digests",
                "same-ID idempotent replay without duplicate events"]]
        print(String(data: try JSONSerialization.data(withJSONObject: report, options: [.sortedKeys]), encoding: .utf8)!)
    }
}
'''


def run(argv, timeout=60):
    result = subprocess.run(argv, text=True, capture_output=True, timeout=timeout)
    if result.returncode:
        raise RuntimeError(json.dumps({"command": argv, "exit": result.returncode,
                                       "stdout": result.stdout, "stderr": result.stderr}))
    return result


def main():
    root = Path(tempfile.mkdtemp(prefix="alma-original-journal-smoke-")).resolve()
    fixture = root / "JournalSmoke.swift"
    fixture.write_text(SWIFT)
    swiftc = run(["xcrun", "--find", "swiftc"]).stdout.strip()
    sdk = run(["xcrun", "--sdk", "macosx", "--show-sdk-path"]).stdout.strip()
    sources = [HERE / name for name in ("TAHJournalStore.swift", "TAHJournalRPC.swift",
                                        "TAHRuntimeWire.swift", "TAHRuntimeResources.swift")]
    command = [swiftc, "-swift-version", "6", "-strict-concurrency=complete", "-parse-as-library",
               "-sdk", sdk, "-module-cache-path", str(root / "module-cache"),
               *map(str, sources), str(fixture), "-lsqlite3", "-o", str(root / "journal-smoke")]
    compiled = run(command)
    result = json.loads(run([str(root / "journal-smoke"), str(root / "database")]).stdout)
    database = root / "database" / "tah.sqlite3"
    with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as connection:
        result["sqlite"] = {
            "header": database.read_bytes()[:16].decode("ascii"),
            "userVersion": connection.execute("PRAGMA user_version").fetchone()[0],
            "journalMode": connection.execute("PRAGMA journal_mode").fetchone()[0],
            "eventCount": connection.execute("SELECT count(*) FROM events").fetchone()[0],
            "cutoverRecords": connection.execute("SELECT count(*) FROM app_migrations").fetchone()[0],
        }
    assert result["sqlite"]["header"] == "SQLite format 3\u0000"
    assert result["sqlite"]["eventCount"] == 3 and result["sqlite"]["cutoverRecords"] == 0
    result.update({"hostOnly": True, "compiler": run([swiftc, "--version"]).stdout.strip(),
                   "command": command, "compilerDiagnostics": compiled.stderr,
                   "artifacts": str(root), "sourceSHA256": {
                       p.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in sources},
                   "fixtureSHA256": hashlib.sha256(fixture.read_bytes()).hexdigest()})
    (HERE / "host-smoke-result.json").write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
