import Foundation

public enum TAHRuntimeError: String, Error, Sendable {
    case unavailable, invalid_request, busy, cancelled, integrity_locked
}

/// Private bridge values, not untyped Provider payloads in the App-facing protocol.
public enum TAHRuntimeValue: Codable, Equatable, Sendable {
    case null, bool(Bool), integer(Int), number(Double), string(String)
    case array([Self]), object([String: Self])

    public init(from decoder: any Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() { self = .null }
        else if let value = try? container.decode(Bool.self) { self = .bool(value) }
        else if let value = try? container.decode(Int.self) { self = .integer(value) }
        else if let value = try? container.decode(Double.self), value.isFinite { self = .number(value) }
        else if let value = try? container.decode(String.self) { self = .string(value) }
        else if let value = try? container.decode([String: Self].self) { self = .object(value) }
        else { self = .array(try container.decode([Self].self)) }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .null: try container.encodeNil()
        case .bool(let value): try container.encode(value)
        case .integer(let value): try container.encode(value)
        case .number(let value): try container.encode(value)
        case .string(let value): try container.encode(value)
        case .array(let value): try container.encode(value)
        case .object(let value): try container.encode(value)
        }
    }

    public subscript(key: String) -> Self? {
        guard case .object(let object) = self else { return nil }
        return object[key]
    }

    public func string() throws -> String {
        guard case .string(let value) = self else { throw TAHRuntimeError.invalid_request }
        return value
    }

    func requireKeys(_ keys: Set<String>) throws {
        guard case .object(let object) = self, Set(object.keys) == keys else {
            throw TAHRuntimeError.invalid_request
        }
    }
}

struct TAHRuntimeFrame: Codable, Sendable {
    let version: Int
    let kind: String
    let id: String
    var method: String?
    var value: TAHRuntimeValue?
    var code: String?

    func validated() throws -> Self {
        guard version == 1, UUID(uuidString: id) != nil else { throw TAHRuntimeError.invalid_request }
        switch kind {
        case "request":
            guard let method, method.range(of: "^[a-z][a-zA-Z.]{0,63}$", options: .regularExpression) != nil,
                  value != nil, code == nil else { throw TAHRuntimeError.invalid_request }
        case "response":
            guard method == nil, value != nil, code == nil else { throw TAHRuntimeError.invalid_request }
        case "failure":
            guard method == nil, value == nil, let code, TAHRuntimeError(rawValue: code) != nil else {
                throw TAHRuntimeError.invalid_request
            }
        default: throw TAHRuntimeError.invalid_request
        }
        return self
    }
}

struct TAHRuntimeFrameDecoder {
    static let maximumBytes = 128 * 1024
    private var buffer = Data()

    mutating func push(_ bytes: Data) throws -> [TAHRuntimeFrame] {
        var frames: [TAHRuntimeFrame] = []
        for byte in bytes {
            if byte == 10 {
                guard let object = try JSONSerialization.jsonObject(with: buffer) as? [String: Any],
                      let kind = object["kind"] as? String else {
                    throw TAHRuntimeError.invalid_request
                }
                let keys: Set<String>
                switch kind {
                case "request": keys = ["version", "kind", "id", "method", "value"]
                case "response": keys = ["version", "kind", "id", "value"]
                case "failure": keys = ["version", "kind", "id", "code"]
                default: throw TAHRuntimeError.invalid_request
                }
                guard Set(object.keys) == keys else { throw TAHRuntimeError.invalid_request }
                // JSON null must remain a present value, not decodeIfPresent's missing value.
                var frame = try JSONDecoder().decode(TAHRuntimeFrame.self, from: buffer)
                if object["value"] is NSNull { frame.value = .null }
                frames.append(try frame.validated())
                buffer.resetBytes(in: buffer.startIndex ..< buffer.endIndex)
                buffer.removeAll(keepingCapacity: true)
            } else {
                guard buffer.count < Self.maximumBytes else { throw TAHRuntimeError.invalid_request }
                buffer.append(byte)
            }
        }
        return frames
    }
}
