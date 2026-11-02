import CryptoKit
import Darwin
import Foundation
import SQLite3

public struct TAHJournalWrite: Codable, Sendable, Equatable {
    public let operationID: String
    public let streamID: String
    public let ownerID: String
    public let expectedVersion: Int
    public let kind: String
    public let publicationRevision: Int?
    public let byteLength: Int
    public let sha256: String
    public init(operationID: String, streamID: String, ownerID: String, expectedVersion: Int, kind: String, publicationRevision: Int?, byteLength: Int, sha256: String) {
        self.operationID = operationID; self.streamID = streamID; self.ownerID = ownerID; self.expectedVersion = expectedVersion
        self.kind = kind; self.publicationRevision = publicationRevision; self.byteLength = byteLength; self.sha256 = sha256
    }
}

public struct TAHJournalHead: Codable, Sendable, Equatable {
    public let version: Int
    public let acceptedRevision: Int
    public let deleted: Bool
}

public struct TAHJournalEntry: Codable, Sendable, Equatable {
    public let operationID: String
    public let version: Int
    public let kind: String
    public let byteLength: Int
    public let sha256: String
}

/// Owns only TAH data, never the App's transcript database. All database access
/// is actor-confined and each transaction is synchronous (no reentrant awaits).
public actor TAHJournalStore {
    public static let maximumPayloadBytes = 64 * 1024 * 1024
    public static let chunkBytes = 64 * 1024
    private let database: TAHSQLiteConnection
    private let directory: URL
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    public init(directory: URL) throws {
        self.directory = directory
        database = try TAHSQLiteConnection(directory: directory)
    }

    /// One owner-authorized pre-release cutover, before Node/VM startup. Never
    /// marks a transcript deleted or touches auth, materials, Raw receipts or STT.
    @discardableResult
    public func prepareLanguageCutover() throws -> Int {
        try prepareActionCutover(migration: "interaction-language-v1-2026-09-20", backupPrefix: "before-language")
    }

    /// Owner-authorized prompt cutover, once before starting the production runtime.
    /// Keep transcript materials, Raw receipts, consent, auth and all non-TAH data.
    @discardableResult
    public func preparePromptCutover() throws -> Int {
        try prepareActionCutover(migration: "common-prompts-v1-2026-09-30", backupPrefix: "before-prompts")
    }

    /// Owner explicitly chose to replace all old Actions instead of migrating
    /// ambiguous pre-v0 slots. Transcript/Raw/auth ownership is untouched.
    @discardableResult
    public func prepareActionIdentityCutover() throws -> Int {
        try prepareActionCutover(migration: "action-draft-identity-v2-2026-10-01", backupPrefix: "before-action-identity")
    }

    private func prepareActionCutover(migration: String, backupPrefix: String) throws -> Int {
        if !(try database.query("SELECT id FROM app_migrations WHERE id=?", [.text(migration)])).isEmpty { return 0 }
        var actions: [String: String] = [:]
        func collect(_ stream: String, _ owner: String) throws {
            let parts = stream.split(separator: "/", omittingEmptySubsequences: false)
            guard let prefix = parts.first, ["meta", "action", "operation"].contains(String(prefix)) else { return }
            guard parts.count == 2, let id = UUID(uuidString: String(parts[1])),
                  owner.hasPrefix("transcript/"), UUID(uuidString: String(owner.dropFirst(11))) != nil else { throw TAHRuntimeError.integrity_locked }
            let key = id.uuidString.lowercased()
            guard String(parts[1]) == key, actions[key] == nil || actions[key] == owner else { throw TAHRuntimeError.integrity_locked }
            actions[key] = owner
        }
        for row in try database.query("SELECT id,owner_id FROM streams WHERE deleted=0") {
            try collect(row[0].string(), row[1].string())
        }
        for write in try pendingWrites() { try collect(write.streamID, write.ownerID) }
        var backup: String? = nil
        if !actions.isEmpty {
            let destination = directory.appendingPathComponent("\(backupPrefix)-\(UUID().uuidString.lowercased()).sqlite")
            try database.backup(to: destination)
            backup = destination.lastPathComponent
        }
        try database.transaction {
            for (id, owner) in actions { try deleteActionContents(actionID: id, ownerID: owner) }
            try database.execute("INSERT INTO app_migrations(id,backup,affected_actions) VALUES(?,?,?)",
                [.text(migration), backup.map(TAHSQLValue.text) ?? .null, .int(actions.count)])
        }
        return actions.count
    }

    public func head(streamID: String) throws -> TAHJournalHead {
        try identifier(streamID)
        let rows = try database.query("SELECT version, accepted_revision, deleted FROM streams WHERE id=?", [.text(streamID)])
        guard let row = rows.first else { return .init(version: 0, acceptedRevision: -1, deleted: false) }
        return .init(version: try row[0].integer(), acceptedRevision: try row[1].integer(), deleted: try row[2].integer() == 1)
    }

    /// The immutable upload header is durable before any content is sent. Complete
    /// uploads survive restart and can be committed without invoking a model again.
    public func begin(_ write: TAHJournalWrite) throws {
        try validate(write)
        let header = try encoder.encode(write)
        try database.transaction {
            if let row = try database.query("SELECT header FROM events WHERE operation_id=?", [.text(write.operationID)]).first {
                guard try decoder.decode(TAHJournalWrite.self, from: row[0].data()) == write else { throw TAHRuntimeError.integrity_locked }
                return
            }
            try requireNotCancelled(write.operationID)
            if let row = try database.query("SELECT header FROM pending WHERE operation_id=?", [.text(write.operationID)]).first {
                guard try decoder.decode(TAHJournalWrite.self, from: row[0].data()) == write else { throw TAHRuntimeError.integrity_locked }
                return
            }
            let current = try head(streamID: write.streamID)
            guard !current.deleted, current.version == write.expectedVersion else { throw TAHRuntimeError.integrity_locked }
            let tombstones = try database.query("SELECT id FROM deleted_owners WHERE id=?", [.text(write.ownerID)])
            guard tombstones.isEmpty else { throw TAHRuntimeError.integrity_locked }
            if let row = try database.query("SELECT owner_id FROM streams WHERE id=?", [.text(write.streamID)]).first {
                guard try row[0].string() == write.ownerID else { throw TAHRuntimeError.integrity_locked }
            }
            guard try database.query("SELECT operation_id FROM pending").count < 16 else { throw TAHRuntimeError.busy }
            try database.execute("INSERT INTO pending(operation_id,stream_id,header) VALUES(?,?,?)", [.text(write.operationID), .text(write.streamID), .blob(header)])
        }
    }

    public func putChunk(operationID: String, index: Int, bytes: Data) throws {
        guard UUID(uuidString: operationID) != nil, index >= 0, !bytes.isEmpty, bytes.count <= Self.chunkBytes else { throw TAHRuntimeError.invalid_request }
        try database.transaction {
            if !(try database.query("SELECT operation_id FROM events WHERE operation_id=?", [.text(operationID)])).isEmpty { return }
            try requireNotCancelled(operationID)
            let write = try pendingWrite(operationID)
            let offset = index.multipliedReportingOverflow(by: Self.chunkBytes)
            guard !offset.overflow, offset.partialValue < write.byteLength,
                  bytes.count == min(Self.chunkBytes, write.byteLength - offset.partialValue) else { throw TAHRuntimeError.invalid_request }
            if let row = try database.query("SELECT bytes FROM chunks WHERE operation_id=? AND part=?", [.text(operationID), .int(index)]).first {
                guard try row[0].data() == bytes else { throw TAHRuntimeError.integrity_locked }
                return
            }
            try database.execute("INSERT INTO chunks(operation_id,part,bytes) VALUES(?,?,?)", [.text(operationID), .int(index), .blob(bytes)])
        }
    }

    /// Event payload (including both outcome files), commit identity and accepted
    /// pointer have one linearization point. A lost reply can replay this exact ID.
    public func commit(operationID: String, requireTranscriptMaterial: Bool = false) throws -> Int {
        guard UUID(uuidString: operationID) != nil else { throw TAHRuntimeError.invalid_request }
        return try database.transaction {
            if let row = try database.query("SELECT version FROM events WHERE operation_id=?", [.text(operationID)]).first { return try row[0].integer() }
            try requireNotCancelled(operationID)
            let write = try pendingWrite(operationID)
            let current = try head(streamID: write.streamID)
            guard !current.deleted, current.version == write.expectedVersion else { throw TAHRuntimeError.integrity_locked }
            guard try database.query("SELECT id FROM deleted_owners WHERE id=?", [.text(write.ownerID)]).isEmpty else { throw TAHRuntimeError.integrity_locked }
            if let revision = write.publicationRevision {
                guard revision == current.acceptedRevision + 1 else { throw TAHRuntimeError.integrity_locked }
            }
            let parts = try database.query("SELECT part,bytes FROM chunks WHERE operation_id=? ORDER BY part", [.text(operationID)])
            guard parts.count == (write.byteLength + Self.chunkBytes - 1) / Self.chunkBytes else { throw TAHRuntimeError.unavailable }
            var payload = Data()
            payload.reserveCapacity(write.byteLength)
            for (index, row) in parts.enumerated() {
                guard try row[0].integer() == index else { throw TAHRuntimeError.integrity_locked }
                payload.append(try row[1].data())
            }
            guard payload.count == write.byteLength, TAHRuntimeResources.digest(payload) == write.sha256 else { throw TAHRuntimeError.integrity_locked }
            // Encoding validity is structural; TAH semantics are validated by the shared TS state machine.
            guard String(data: payload, encoding: .utf8) != nil,
                  (try? JSONSerialization.jsonObject(with: payload, options: [.fragmentsAllowed])) != nil else { throw TAHRuntimeError.integrity_locked }
            if requireTranscriptMaterial {
                guard let material = try JSONSerialization.jsonObject(with: payload) as? [String: Any],
                      Set(material.keys) == Set(["transcriptID", "title", "rawTranscript"]),
                      let transcriptID = material["transcriptID"] as? String, UUID(uuidString: transcriptID) != nil,
                      write.ownerID == "transcript/\(transcriptID)", write.streamID == "material/\(operationID)",
                      let title = material["title"] as? String, title.count <= 512,
                      let transcript = material["rawTranscript"] as? String, !transcript.isEmpty,
                      transcript.utf8.count <= 32 * 1024 * 1024 else { throw TAHRuntimeError.integrity_locked }
            }
            let version = current.version + 1
            try database.execute("INSERT INTO streams(id,owner_id,version,accepted_revision,deleted) VALUES(?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET version=excluded.version,accepted_revision=excluded.accepted_revision", [
                .text(write.streamID), .text(write.ownerID), .int(version), .int(write.publicationRevision ?? current.acceptedRevision),
            ])
            try database.execute("INSERT INTO events(operation_id,stream_id,version,kind,header,payload,sha256) VALUES(?,?,?,?,?,?,?)", [
                .text(operationID), .text(write.streamID), .int(version), .text(write.kind), .blob(try encoder.encode(write)), .blob(payload), .text(write.sha256),
            ])
            try database.execute("DELETE FROM pending WHERE operation_id=?", [.text(operationID)])
            return version
        }
    }

    public func entries(streamID: String, afterVersion: Int, limit: Int = 16) throws -> [TAHJournalEntry] {
        try identifier(streamID)
        guard afterVersion >= 0, (1...32).contains(limit) else { throw TAHRuntimeError.invalid_request }
        return try database.query("SELECT operation_id,version,kind,length(payload),sha256 FROM events WHERE stream_id=? AND version>? ORDER BY version LIMIT ?", [.text(streamID), .int(afterVersion), .int(limit)]).map { row in
            .init(operationID: try row[0].string(), version: try row[1].integer(), kind: try row[2].string(), byteLength: try row[3].integer(), sha256: try row[4].string())
        }
    }

    public func cancel(operationID: String) throws -> Int? {
        guard UUID(uuidString: operationID) != nil else { throw TAHRuntimeError.invalid_request }
        return try database.transaction {
            if let row = try database.query("SELECT version FROM events WHERE operation_id=?", [.text(operationID)]).first {
                return try row[0].integer() // The already committed result wins.
            }
            try database.execute("INSERT OR IGNORE INTO cancelled_operations(id) VALUES(?)", [.text(operationID)])
            try database.execute("DELETE FROM pending WHERE operation_id=?", [.text(operationID)])
            return nil
        }
    }

    public func readChunk(operationID: String, index: Int) throws -> Data {
        guard UUID(uuidString: operationID) != nil, index >= 0, index < Self.maximumPayloadBytes / Self.chunkBytes else { throw TAHRuntimeError.invalid_request }
        guard let row = try database.query("SELECT substr(payload,?,?) FROM events WHERE operation_id=?", [.int(index * Self.chunkBytes + 1), .int(Self.chunkBytes), .text(operationID)]).first else { throw TAHRuntimeError.invalid_request }
        return try row[0].data()
    }

    public func pendingWrites() throws -> [TAHJournalWrite] {
        try database.query("SELECT header FROM pending ORDER BY rowid", []).map { try decoder.decode(TAHJournalWrite.self, from: $0[0].data()) }
    }
    /// Called only when a new exclusive Service writer starts, before accepting
    /// uploads. Material staging has no Action/AI authority until its commit;
    /// dropping it cannot delete the App-owned original transcript or a result.
    @discardableResult public func discardInterruptedMaterialUploads() throws -> Int {
        var count = 0
        for write in try pendingWrites() where write.streamID == "material/\(write.operationID)"
            && write.kind == "document" && write.expectedVersion == 0 && write.publicationRevision == nil {
            _ = try cancel(operationID: write.operationID)
            count += 1
        }
        return count
    }
    public func pendingIsComplete(operationID: String) throws -> Bool {
        guard UUID(uuidString: operationID) != nil else { throw TAHRuntimeError.invalid_request }
        let write = try pendingWrite(operationID)
        let parts = try database.query("SELECT part,length(bytes) FROM chunks WHERE operation_id=? ORDER BY part", [.text(operationID)])
        guard parts.count == (write.byteLength + Self.chunkBytes - 1) / Self.chunkBytes else { return false }
        for (index, part) in parts.enumerated() {
            guard try part[0].integer() == index, try part[1].integer() == min(Self.chunkBytes, write.byteLength - index * Self.chunkBytes) else { return false }
        }
        return true // Identity/digest and semantic validation still happen before commit.
    }
    public func pendingChunk(operationID: String, index: Int) throws -> Data {
        guard UUID(uuidString: operationID) != nil, index >= 0, index < Self.maximumPayloadBytes / Self.chunkBytes else { throw TAHRuntimeError.invalid_request }
        guard let row = try database.query("SELECT bytes FROM chunks WHERE operation_id=? AND part=?", [.text(operationID), .int(index)]).first else { throw TAHRuntimeError.unavailable }
        return try row[0].data()
    }

    public func streams(ownerID: String) throws -> [String] {
        try identifier(ownerID)
        return try database.query("SELECT id FROM streams WHERE owner_id=? AND deleted=0 ORDER BY id LIMIT 1024", [.text(ownerID)]).map { try $0[0].string() }
    }
    public struct ActionStream: Codable, Sendable, Equatable { public let streamID: String; public let position: Int }
    public func actionStreams(ownerID: String, before: Int, limit: Int) throws -> [ActionStream] {
        try identifier(ownerID)
        guard before > 0, (1...33).contains(limit) else { throw TAHRuntimeError.invalid_request }
        return try database.query("SELECT id,rowid FROM streams WHERE owner_id=? AND id LIKE 'meta/%' AND deleted=0 AND rowid<? ORDER BY rowid DESC LIMIT ?",
            [.text(ownerID), .int(before), .int(limit)]).map { .init(streamID: try $0[0].string(), position: try $0[1].integer()) }
    }

    /// Durable deletion intent survives removal of the content and prevents a late
    /// Node/VM result from resurrecting the transcript's Actions.
    public func deleteOwner(_ ownerID: String) throws {
        try identifier(ownerID)
        try database.transaction {
            try database.execute("INSERT OR IGNORE INTO deleted_owners(id) VALUES(?)", [.text(ownerID)])
            for write in try pendingWrites() where write.ownerID == ownerID {
                try database.execute("DELETE FROM pending WHERE operation_id=?", [.text(write.operationID)])
            }
            try database.execute("DELETE FROM events WHERE stream_id IN (SELECT id FROM streams WHERE owner_id=?)", [.text(ownerID)])
            try database.execute("UPDATE streams SET deleted=1 WHERE owner_id=?", [.text(ownerID)])
        }
    }

    public func deleteAction(actionID: String, ownerID: String) throws {
        guard UUID(uuidString: actionID) != nil else { throw TAHRuntimeError.invalid_request }
        try identifier(ownerID)
        try database.transaction {
            try deleteActionContents(actionID: actionID, ownerID: ownerID)
        }
    }
    private func deleteActionContents(actionID: String, ownerID: String) throws {
        for stream in ["meta/\(actionID)", "action/\(actionID)", "operation/\(actionID)"] {
                if let row = try database.query("SELECT owner_id FROM streams WHERE id=?", [.text(stream)]).first {
                    guard try row[0].string() == ownerID else { throw TAHRuntimeError.integrity_locked }
                }
                try database.execute("INSERT INTO streams(id,owner_id,version,accepted_revision,deleted) VALUES(?,?,0,-1,1) ON CONFLICT(id) DO UPDATE SET deleted=1", [.text(stream), .text(ownerID)])
                try database.execute("DELETE FROM pending WHERE stream_id=?", [.text(stream)])
                try database.execute("DELETE FROM events WHERE stream_id=?", [.text(stream)])
        }
    }
    public func pendingTranscriptDeletions() throws -> [String] {
        try database.query("SELECT id FROM deleted_owners WHERE id LIKE 'transcript/%' AND id NOT IN (SELECT id FROM completed_deletions) ORDER BY rowid LIMIT 128")
            .map { String(try $0[0].string().dropFirst("transcript/".count)) }
    }
    public func acknowledgeTranscriptDeletion(_ id: String) throws {
        guard UUID(uuidString: id) != nil else { throw TAHRuntimeError.invalid_request }
        try database.execute("INSERT OR IGNORE INTO completed_deletions(id) SELECT id FROM deleted_owners WHERE id=?", [.text("transcript/\(id)")])
    }
    public func close() { database.close() }

    private func pendingWrite(_ operationID: String) throws -> TAHJournalWrite {
        guard let row = try database.query("SELECT header FROM pending WHERE operation_id=?", [.text(operationID)]).first else { throw TAHRuntimeError.invalid_request }
        return try decoder.decode(TAHJournalWrite.self, from: row[0].data())
    }
    private func requireNotCancelled(_ operationID: String) throws {
        guard try database.query("SELECT id FROM cancelled_operations WHERE id=?", [.text(operationID)]).isEmpty else { throw TAHRuntimeError.cancelled }
    }
    private func identifier(_ value: String) throws {
        guard value.range(of: "^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$", options: .regularExpression) != nil else { throw TAHRuntimeError.invalid_request }
    }
    private func validate(_ write: TAHJournalWrite) throws {
        try identifier(write.streamID); try identifier(write.ownerID)
        guard UUID(uuidString: write.operationID) != nil, write.expectedVersion >= 0,
              write.expectedVersion < 1_000_000, write.byteLength > 0, write.byteLength <= Self.maximumPayloadBytes,
              TAHRuntimeResources.isDigest(write.sha256),
              ["proposal", "publication", "release", "retry_retain", "retry_claim", "checkpoint", "document", "raw_receipt"].contains(write.kind),
              (write.kind == "publication") == (write.publicationRevision != nil),
              write.publicationRevision.map({ $0 >= 0 && $0 < 128 }) ?? true else { throw TAHRuntimeError.invalid_request }
    }
}

private enum TAHSQLValue {
    case text(String), int(Int), blob(Data), null
    func integer() throws -> Int { guard case .int(let value) = self else { throw TAHRuntimeError.integrity_locked }; return value }
    func string() throws -> String { guard case .text(let value) = self else { throw TAHRuntimeError.integrity_locked }; return value }
    func data() throws -> Data { guard case .blob(let value) = self else { throw TAHRuntimeError.integrity_locked }; return value }
}

/// Only owned/used by TAHJournalStore's actor; never transferred across isolation.
private final class TAHSQLiteConnection {
    private var handle: OpaquePointer?
    private var lockFD: Int32 = -1
    init(directory: URL) throws {
        let path = directory
        try FileManager.default.createDirectory(at: path, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        guard try TAHRuntimeResources.canonicalPath(path.path) == path.path else { throw TAHRuntimeError.integrity_locked }
        var status = stat()
        guard lstat(path.path, &status) == 0, status.st_mode & S_IFMT == S_IFDIR, status.st_uid == geteuid(), status.st_mode & 0o077 == 0 else { throw TAHRuntimeError.integrity_locked }
        let lockPath = path.appendingPathComponent("writer.lock").path
        lockFD = open(lockPath, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard lockFD >= 0, flock(lockFD, LOCK_EX | LOCK_NB) == 0 else {
            if lockFD >= 0 { Darwin.close(lockFD); lockFD = -1 }
            throw TAHRuntimeError.busy
        }
        let url = path.appendingPathComponent("tah.sqlite3")
        for suffix in ["", "-wal", "-shm"] {
            var file = stat()
            if lstat(url.path + suffix, &file) == 0 {
                guard file.st_mode & S_IFMT == S_IFREG, file.st_uid == geteuid(), file.st_nlink == 1,
                      file.st_mode & 0o077 == 0 else { close(); throw TAHRuntimeError.integrity_locked }
            }
        }
        let descriptor = open(url.path, O_RDWR | O_CREAT | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { close(); throw TAHRuntimeError.unavailable }
        Darwin.close(descriptor)
        guard sqlite3_open_v2(url.path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_NOFOLLOW, nil) == SQLITE_OK else { close(); throw TAHRuntimeError.unavailable }
        do {
            try execute("PRAGMA foreign_keys=ON")
            try execute("PRAGMA journal_mode=WAL")
            try execute("PRAGMA synchronous=FULL")
            try execute("PRAGMA secure_delete=ON")
            try execute("PRAGMA fullfsync=ON")
            sqlite3_busy_timeout(handle, 1500)
            let version = try query("PRAGMA user_version").first?[0].integer() ?? 0
            guard version == 0 || version == 1 else { throw TAHRuntimeError.integrity_locked }
            try transaction {
                try execute("CREATE TABLE IF NOT EXISTS streams(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,version INTEGER NOT NULL,accepted_revision INTEGER NOT NULL,deleted INTEGER NOT NULL)")
                try execute("CREATE TABLE IF NOT EXISTS events(operation_id TEXT PRIMARY KEY,stream_id TEXT NOT NULL REFERENCES streams(id),version INTEGER NOT NULL,kind TEXT NOT NULL,header BLOB NOT NULL,payload BLOB NOT NULL,sha256 TEXT NOT NULL,UNIQUE(stream_id,version))")
                try execute("CREATE TABLE IF NOT EXISTS pending(operation_id TEXT PRIMARY KEY,stream_id TEXT NOT NULL,header BLOB NOT NULL)")
                try execute("CREATE TABLE IF NOT EXISTS chunks(operation_id TEXT NOT NULL REFERENCES pending(operation_id) ON DELETE CASCADE,part INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(operation_id,part))")
                try execute("CREATE TABLE IF NOT EXISTS deleted_owners(id TEXT PRIMARY KEY)")
                try execute("CREATE TABLE IF NOT EXISTS completed_deletions(id TEXT PRIMARY KEY)")
                try execute("CREATE TABLE IF NOT EXISTS cancelled_operations(id TEXT PRIMARY KEY)")
                try execute("CREATE TABLE IF NOT EXISTS app_migrations(id TEXT PRIMARY KEY,backup TEXT,affected_actions INTEGER NOT NULL)")
                try execute("CREATE INDEX IF NOT EXISTS streams_owner ON streams(owner_id)")
                try execute("PRAGMA user_version=1")
            }
        } catch { close(); throw error }
    }
    deinit { close() }
    func backup(to url: URL) throws {
        guard let handle else { throw TAHRuntimeError.unavailable }
        let fd = open(url.path, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard fd >= 0 else { throw TAHRuntimeError.unavailable }
        Darwin.close(fd)
        var destination: OpaquePointer?
        guard sqlite3_open_v2(url.path, &destination, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_NOFOLLOW, nil) == SQLITE_OK,
              let destination else { if let destination { sqlite3_close_v2(destination) }; throw TAHRuntimeError.unavailable }
        defer { sqlite3_close_v2(destination) }
        guard let backup = sqlite3_backup_init(destination, "main", handle, "main") else { throw TAHRuntimeError.unavailable }
        let copied = sqlite3_backup_step(backup, -1)
        let finished = sqlite3_backup_finish(backup)
        guard copied == SQLITE_DONE, finished == SQLITE_OK else { throw TAHRuntimeError.unavailable }
        let syncFD = open(url.path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC)
        guard syncFD >= 0 else { throw TAHRuntimeError.unavailable }
        defer { Darwin.close(syncFD) }
        guard fsync(syncFD) == 0 else { throw TAHRuntimeError.unavailable }
    }
    func close() {
        if let handle { sqlite3_close_v2(handle); self.handle = nil }
        if lockFD >= 0 { flock(lockFD, LOCK_UN); Darwin.close(lockFD); lockFD = -1 }
    }
    func transaction<T>(_ body: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE")
        do { let value = try body(); try execute("COMMIT"); return value }
        catch { try? execute("ROLLBACK"); throw error }
    }
    func execute(_ sql: String, _ values: [TAHSQLValue] = []) throws { _ = try query(sql, values) }
    func query(_ sql: String, _ values: [TAHSQLValue] = []) throws -> [[TAHSQLValue]] {
        guard let handle else { throw TAHRuntimeError.unavailable }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw TAHRuntimeError.unavailable }
        defer { sqlite3_finalize(statement) }
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        for (offset, value) in values.enumerated() {
            let index = Int32(offset + 1)
            let result: Int32
            switch value {
            case .text(let text): result = text.withCString { sqlite3_bind_text(statement, index, $0, -1, transient) }
            case .int(let number): result = sqlite3_bind_int64(statement, index, Int64(number))
            case .blob(let data): result = data.withUnsafeBytes { sqlite3_bind_blob(statement, index, $0.baseAddress, Int32($0.count), transient) }
            case .null: result = sqlite3_bind_null(statement, index)
            }
            guard result == SQLITE_OK else { throw TAHRuntimeError.unavailable }
        }
        var rows: [[TAHSQLValue]] = []
        while true {
            let result = sqlite3_step(statement)
            if result == SQLITE_DONE { return rows }
            guard result == SQLITE_ROW else {
                if result == SQLITE_CORRUPT || result == SQLITE_NOTADB || result == SQLITE_CONSTRAINT { throw TAHRuntimeError.integrity_locked }
                throw TAHRuntimeError.unavailable
            }
            rows.append((0..<sqlite3_column_count(statement)).map { index in
                switch sqlite3_column_type(statement, index) {
                case SQLITE_INTEGER: .int(Int(sqlite3_column_int64(statement, index)))
                case SQLITE_TEXT: .text(String(cString: sqlite3_column_text(statement, index)))
                case SQLITE_BLOB:
                    if let bytes = sqlite3_column_blob(statement, index) { .blob(Data(bytes: bytes, count: Int(sqlite3_column_bytes(statement, index)))) }
                    else { .blob(Data()) }
                default: .null
                }
            })
        }
    }
}
