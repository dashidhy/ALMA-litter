import Foundation

extension TAHJournalStore {
    /// Parse/encode store envelopes on the journal actor, not the UI actor.
    func handleJSONRPC(_ method: String, json: String) throws -> String {
        let value = try JSONDecoder().decode(TAHRuntimeValue.self, from: Data(json.utf8))
        let result = try handleRPC(method, value: value)
        return String(decoding: try JSONEncoder().encode(result), as: UTF8.self)
    }
    /// Private Node bridge only. Paths and SQLite statements are never accepted.
    func handleRPC(_ method: String, value: TAHRuntimeValue) throws -> TAHRuntimeValue {
        switch method {
        case "store.begin":
            try value.requireKeys(["operationID", "streamID", "ownerID", "expectedVersion", "kind", "publicationRevision", "byteLength", "sha256"])
            try begin(try decode(TAHJournalWrite.self, value))
            return .object([:])
        case "store.putChunk":
            try value.requireKeys(["operationID", "index", "data"])
            let encoded = try field("data", value)
            guard encoded.utf8.count <= 87384, let bytes = Data(base64Encoded: encoded), bytes.base64EncodedString() == encoded else { throw TAHRuntimeError.invalid_request }
            try putChunk(operationID: field("operationID", value), index: integer("index", value), bytes: bytes)
            return .object([:])
        case "store.commit":
            try value.requireKeys(["operationID"])
            return .object(["version": .integer(try commit(operationID: field("operationID", value)))])
        case "store.cancel":
            try value.requireKeys(["operationID"])
            let version = try cancel(operationID: field("operationID", value))
            return .object(["version": version.map(TAHRuntimeValue.integer) ?? .null])
        case "store.head":
            try value.requireKeys(["streamID"])
            return try encode(head(streamID: field("streamID", value)))
        case "store.entries":
            try value.requireKeys(["streamID", "afterVersion", "limit"])
            return try encode(entries(streamID: field("streamID", value), afterVersion: integer("afterVersion", value), limit: integer("limit", value)))
        case "store.readChunk":
            try value.requireKeys(["operationID", "index"])
            return .object(["data": .string(try readChunk(operationID: field("operationID", value), index: integer("index", value)).base64EncodedString())])
        case "store.pending":
            try value.requireKeys([])
            return try encode(pendingWrites())
        case "store.pendingChunk":
            try value.requireKeys(["operationID", "index"])
            return .object(["data": .string(try pendingChunk(operationID: field("operationID", value), index: integer("index", value)).base64EncodedString())])
        case "store.pendingIsComplete":
            try value.requireKeys(["operationID"])
            return .bool(try pendingIsComplete(operationID: field("operationID", value)))
        case "store.streams":
            try value.requireKeys(["ownerID"])
            return try encode(streams(ownerID: field("ownerID", value)))
        case "store.actionStreams":
            try value.requireKeys(["ownerID", "before", "limit"])
            return try encode(actionStreams(ownerID: field("ownerID", value), before: integer("before", value), limit: integer("limit", value)))
        case "store.deleteOwner":
            try value.requireKeys(["ownerID"])
            try deleteOwner(field("ownerID", value))
            return .object([:])
        case "store.deleteAction":
            try value.requireKeys(["actionID", "ownerID"])
            try deleteAction(actionID: field("actionID", value), ownerID: field("ownerID", value))
            return .object([:])
        default: throw TAHRuntimeError.invalid_request
        }
    }

    private func field(_ key: String, _ value: TAHRuntimeValue) throws -> String {
        guard let field = value[key] else { throw TAHRuntimeError.invalid_request }
        return try field.string()
    }
    private func integer(_ key: String, _ value: TAHRuntimeValue) throws -> Int {
        guard case .integer(let integer) = value[key] else { throw TAHRuntimeError.invalid_request }
        return integer
    }
    private func encode<T: Encodable>(_ value: T) throws -> TAHRuntimeValue {
        try JSONDecoder().decode(TAHRuntimeValue.self, from: JSONEncoder().encode(value))
    }
    private func decode<T: Decodable>(_ type: T.Type, _ value: TAHRuntimeValue) throws -> T {
        try JSONDecoder().decode(type, from: JSONEncoder().encode(value))
    }
}
