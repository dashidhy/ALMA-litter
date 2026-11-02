import CryptoKit
import Dispatch
import Foundation
import JavaScriptCore

/// Synchronous byte fastpaths for the trusted application VM, not a Buffer polyfill.
/// The owner MUST call install and every hook on its existing serial JSC executor.
/// Install before application code can replace the standard ArrayBuffer intrinsics.
/// Native callbacks retain no context/value and never send one to an actor/task.
/// The non-main precondition is only a guardrail; the owner enforces serial isolation.
///
/// Inputs: real TypedArrays (raw bytes, including offsets) or ArrayBuffers. DataView,
/// Shared/resizable ArrayBuffers and proxies are intentionally unsupported (the
/// shim must skip them). C pointer access pins storage, so reads first make a
/// native JSC snapshot to preserve the original buffer's transfer behavior. Strings/booleans
/// must already be normalized by the caller; these hooks do not perform JS coercion.
/// UTF8Decode preserves BOM, like Buffer.toString('utf8') / TextDecoder(ignoreBOM:true).
/// A TextDecoder shim must handle its own BOM/stream state. Invalid UTF-16 is repaired
/// from JS code units, not NSString bridging, matching TextEncoder / Buffer.from.
/// Base64DecodeCanonical returns null for noncanonical input so the existing
/// polyfill can handle permissive Node semantics. Other invalid inputs throw.
/// The cap is 32 MiB (not 64). Oversized work throws RangeError, never null.
/// To preserve Buffer's original range, the integrating shim must skip these
/// optional hooks for larger data. Guard byte inputs by byteLength; UTF8Encode
/// may conservatively guard string.length <= floor(maximumByteLength / 3).
/// UTF8ByteLength accepts up to 32 Mi UTF-16 code units and returns the full
/// repaired UTF-8 byte count (possibly >32 MiB), without allocating byte output.
/// Canonical base64 needs both encoded-length and decoded-length guards (the
/// latter is length / 4 * 3 minus trailing padding). Fatal UTF-8 TypeError must
/// propagate; it is a decoding error, not a fastpath miss.
enum TAHJavaScriptBytePrimitives {
    static let maximumByteLength = 32 * 1024 * 1024
    private static let maximumBase64Length = ((maximumByteLength + 2) / 3) * 4

    static func install(on context: JSContext) {
        dispatchPrecondition(condition: .notOnQueue(.main))
        // The public C type enum treats shared and ordinary ArrayBuffers alike.
        // Capture this standard built-in brand check inside the JS heap, not in a
        // Swift closure. It rejects shared storage without invoking user getters.
        guard let brandCheck = context.evaluateScript(
            "Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'byteLength').get"
        ), context.exception == nil else { return }
        guard let resizableCheck = context.evaluateScript(
            "Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, 'resizable')?.get"
        ), context.exception == nil else { return }
        guard let typedArraySet = context.evaluateScript("Uint8Array.prototype.set"),
              context.exception == nil else { return }
        let intrinsics = [("__almaArrayBufferBrand", brandCheck),
                          ("__almaArrayBufferResizable", resizableCheck),
                          ("__almaTypedArraySet", typedArraySet)]
        let ctx = context.jsGlobalContextRef!
        let hooks: [(String, JSObjectCallAsFunctionCallback)] = [
            ("__almaUTF8Encode", { ctx, function, _, count, args, exception in
                TAHJavaScriptBytePrimitives.invoke(ctx, function, exception) { call in
                    let text = try call.string(call.argument(0, count, args), limit: TAHJavaScriptBytePrimitives.maximumByteLength)
                    guard text.utf8.count <= TAHJavaScriptBytePrimitives.maximumByteLength else { throw Failure.range }
                    return try call.uint8Array(Data(text.utf8))
                }
            }),
            ("__almaUTF8ByteLength", { ctx, function, _, count, args, exception in
                TAHJavaScriptBytePrimitives.invoke(ctx, function, exception) { call in
                    let text = try call.string(call.argument(0, count, args),
                                               limit: TAHJavaScriptBytePrimitives.maximumByteLength)
                    return JSValueMakeNumber(call.ctx, Double(text.utf8.count))
                }
            }),
            ("__almaUTF8Decode", { ctx, function, _, count, args, exception in
                TAHJavaScriptBytePrimitives.invoke(ctx, function, exception) { call in
                    let fatal = try call.argument(1, count, args)
                    guard JSValueIsBoolean(call.ctx, fatal) else { throw Failure.type("Expected boolean fatal flag") }
                    let isFatal = JSValueToBoolean(call.ctx, fatal)
                    let bytes = try call.bytes(call.argument(0, count, args))
                    if isFatal {
                        // Foundation String(data:encoding:) strips a leading BOM.
                        // Swift's validating decoder preserves it, like Buffer.
                        guard let text = String(validating: bytes, as: UTF8.self) else {
                            throw Failure.type("Invalid UTF-8")
                        }
                        return call.jsString(text)
                    }
                    return call.jsString(String(decoding: bytes, as: UTF8.self))
                }
            }),
            ("__almaBase64Encode", { ctx, function, _, count, args, exception in
                TAHJavaScriptBytePrimitives.invoke(ctx, function, exception) { call in
                    try call.jsString(call.bytes(call.argument(0, count, args)).base64EncodedString())
                }
            }),
            ("__almaBase64DecodeCanonical", { ctx, function, _, count, args, exception in
                TAHJavaScriptBytePrimitives.invoke(ctx, function, exception) { call in
                    let text = try call.string(call.argument(0, count, args), limit: TAHJavaScriptBytePrimitives.maximumBase64Length)
                    // Round-trip equality rejects missing/excess padding, whitespace,
                    // URL alphabet and nonzero pad bits, even if Foundation accepts them.
                    guard text.utf8.count % 4 == 0,
                          let bytes = Data(base64Encoded: text),
                          bytes.base64EncodedString().utf8.elementsEqual(text.utf8) else {
                        return JSValueMakeNull(call.ctx)
                    }
                    guard bytes.count <= TAHJavaScriptBytePrimitives.maximumByteLength else { throw Failure.range }
                    return try call.uint8Array(bytes)
                }
            }),
            ("__almaSHA256Bytes", { ctx, function, _, count, args, exception in
                TAHJavaScriptBytePrimitives.invoke(ctx, function, exception) { call in
                    let digest = SHA256.hash(data: try call.bytes(call.argument(0, count, args)))
                    let hex = Array("0123456789abcdef".utf8)
                    return call.jsString(String(decoding: digest.flatMap { [hex[Int($0 >> 4)], hex[Int($0 & 15)]] }, as: UTF8.self))
                }
            })
        ]
        for (name, callback) in hooks {
            let key = JSStringCreateWithUTF8CString(name)!
            defer { JSStringRelease(key) }
            let function = JSObjectMakeFunctionWithCallback(ctx, key, callback)
            JSValueProtect(ctx, function)
            defer { JSValueUnprotect(ctx, function) }
            var exception: JSValueRef?
            for (name, intrinsic) in intrinsics {
                let key = JSStringCreateWithUTF8CString(name)!
                defer { JSStringRelease(key) }
                JSObjectSetProperty(ctx, function, key, intrinsic.jsValueRef,
                                    JSPropertyAttributes(kJSPropertyAttributeDontEnum | kJSPropertyAttributeReadOnly |
                                                         kJSPropertyAttributeDontDelete), &exception)
                if let exception {
                    context.exception = JSValue(jsValueRef: exception, in: context)
                    return
                }
            }
            JSObjectSetProperty(ctx, JSContextGetGlobalObject(ctx), key, function,
                                JSPropertyAttributes(kJSPropertyAttributeDontEnum), &exception)
            if let exception {
                context.exception = JSValue(jsValueRef: exception, in: context)
                return
            }
        }
    }

    private enum Failure: Error { case type(String), range, pending }

    private static func invoke(
        _ ctx: JSContextRef?, _ function: JSObjectRef?, _ exception: UnsafeMutablePointer<JSValueRef?>?,
        _ body: (Call) throws -> JSValueRef?
    ) -> JSValueRef? {
        guard let ctx, let function else { return nil }
        dispatchPrecondition(condition: .notOnQueue(.main))
        var pending: JSValueRef?
        let result = withUnsafeMutablePointer(to: &pending) { pending in
            let call = Call(ctx: ctx, function: function, exception: pending)
            do { return try body(call) }
            catch Failure.pending { return JSValueMakeUndefined(ctx) }
            catch Failure.range {
                call.raise("RangeError", "Byte primitive exceeds 32 MiB limit")
            } catch Failure.type(let message) {
                call.raise("TypeError", message)
            } catch { call.raise("TypeError", "Byte primitive failed") }
            return JSValueMakeUndefined(ctx)
        }
        exception?.pointee = pending
        return result
    }

    /// Stack-scoped C handles only. Never stored by a hook or its owning JSContext.
    private struct Call {
        let ctx: JSContextRef
        let function: JSObjectRef
        let exception: UnsafeMutablePointer<JSValueRef?>

        func check() throws {
            if exception.pointee != nil { throw Failure.pending }
        }

        func argument(_ index: Int, _ count: Int, _ args: UnsafePointer<JSValueRef?>?) throws -> JSValueRef {
            guard index < count, let value = args?[index] else { throw Failure.type("Missing argument") }
            return value
        }

        func string(_ value: JSValueRef, limit: Int) throws -> String {
            guard JSValueIsString(ctx, value) else { throw Failure.type("Expected string") }
            guard let text = JSValueToStringCopy(ctx, value, exception) else {
                try check(); throw Failure.type("Cannot read string")
            }
            defer { JSStringRelease(text) }
            try check()
            let count = JSStringGetLength(text)
            guard count >= 0, count <= limit else { throw Failure.range }
            if count == 0 { return "" }
            guard let pointer = JSStringGetCharactersPtr(text) else { throw Failure.type("Cannot read UTF-16") }
            // Immediately copy borrowed UTF-16; no intervening JSC call. Swift's
            // repairing decoder maps each unpaired surrogate to U+FFFD (WHATWG).
            let units = Array(UnsafeBufferPointer(start: pointer, count: count))
            return String(decoding: units, as: UTF16.self)
        }

        func bytes(_ value: JSValueRef) throws -> Data {
            let type = JSValueGetTypedArrayType(ctx, value, exception)
            try check()
            guard type != kJSTypedArrayTypeNone, let object = JSValueToObject(ctx, value, exception) else {
                try check(); throw Failure.type("Expected TypedArray or ArrayBuffer")
            }
            try check()
            let buffer: JSObjectRef
            let offset: Int
            let length: Int
            if type == kJSTypedArrayTypeArrayBuffer {
                buffer = object
                offset = 0
                length = JSObjectGetArrayBufferByteLength(ctx, buffer, exception)
                try check()
            } else {
                offset = JSObjectGetTypedArrayByteOffset(ctx, object, exception)
                try check()
                length = JSObjectGetTypedArrayByteLength(ctx, object, exception)
                try check()
                guard let backing = JSObjectGetTypedArrayBuffer(ctx, object, exception) else {
                    try check(); throw Failure.type("Missing TypedArray backing buffer")
                }
                try check()
                buffer = backing
            }
            let bufferType = JSValueGetTypedArrayType(ctx, buffer, exception)
            try check()
            guard bufferType == kJSTypedArrayTypeArrayBuffer else { throw Failure.type("Invalid backing buffer") }
            try requireFixedUnsharedBuffer(buffer)
            let bufferLength = JSObjectGetArrayBufferByteLength(ctx, buffer, exception)
            try check()
            // Subtraction avoids offset + length overflow; sizes use C size_t/Swift Int.
            guard offset >= 0, length >= 0, bufferLength >= 0,
                  offset <= bufferLength, length <= bufferLength - offset else {
                throw Failure.type("Invalid byte range")
            }
            guard length <= maximumByteLength else { throw Failure.range }
            // Zero length alone cannot distinguish a detached buffer from a valid
            // empty one. This public C constructor validates detachment even at 0.
            guard let source = JSObjectMakeTypedArrayWithArrayBufferAndOffset(ctx, kJSTypedArrayTypeUint8Array,
                                                                             buffer, offset, length, exception) else {
                try check(); throw Failure.type("Detached ArrayBuffer")
            }
            try check()
            if length == 0 { return Data() }
            let snapshot = try copyArray(source, length: length)
            JSValueProtect(ctx, snapshot)
            defer { JSValueUnprotect(ctx, snapshot) }
            guard let pointer = JSObjectGetTypedArrayBytesPtr(ctx, snapshot, exception) else {
                try check(); throw Failure.type("Unavailable byte snapshot storage")
            }
            try check() // Reads the local exception slot only, not the JSC API.
            return Data(bytes: pointer, count: length)
        }

        func copyArray(_ source: JSObjectRef, length: Int) throws -> JSObjectRef {
            JSValueProtect(ctx, source)
            defer { JSValueUnprotect(ctx, source) }
            guard let snapshot = JSObjectMakeTypedArray(ctx, kJSTypedArrayTypeUint8Array, length, exception) else {
                try check(); throw Failure.type("Cannot allocate byte snapshot")
            }
            try check()
            JSValueProtect(ctx, snapshot)
            defer { JSValueUnprotect(ctx, snapshot) }
            let key = JSStringCreateWithUTF8CString("__almaTypedArraySet")!
            defer { JSStringRelease(key) }
            let setter = JSObjectGetProperty(ctx, function, key, exception)
            try check()
            guard let setter, let object = JSValueToObject(ctx, setter, exception) else {
                try check(); throw Failure.type("Missing TypedArray copy intrinsic")
            }
            try check()
            var argument: JSValueRef? = source
            // The captured built-in set performs a native bulk copy. Both operands
            // are real C-created Uint8Arrays: no JS indexing, species or user getters.
            // GetBytesPtr can permanently pin its target. Copy on either side of
            // that boundary so caller-owned inputs and returned arrays stay normal.
            _ = JSObjectCallAsFunction(ctx, object, snapshot, 1, &argument, exception)
            try check()
            return snapshot
        }

        func requireFixedUnsharedBuffer(_ buffer: JSObjectRef) throws {
            let key = JSStringCreateWithUTF8CString("__almaArrayBufferBrand")!
            defer { JSStringRelease(key) }
            let getter = JSObjectGetProperty(ctx, function, key, exception)
            try check()
            guard let getter, let object = JSValueToObject(ctx, getter, exception) else {
                try check(); throw Failure.type("Missing ArrayBuffer brand check")
            }
            try check()
            _ = JSObjectCallAsFunction(ctx, object, buffer, 0, nil, exception)
            try check()
            let resizableKey = JSStringCreateWithUTF8CString("__almaArrayBufferResizable")!
            defer { JSStringRelease(resizableKey) }
            let resizable = JSObjectGetProperty(ctx, function, resizableKey, exception)
            try check()
            if let resizable, !JSValueIsUndefined(ctx, resizable) {
                guard let getter = JSValueToObject(ctx, resizable, exception) else {
                    try check(); throw Failure.type("Missing resizable buffer check")
                }
                try check()
                let result = JSObjectCallAsFunction(ctx, getter, buffer, 0, nil, exception)
                try check()
                if let result, JSValueToBoolean(ctx, result) {
                    throw Failure.type("Resizable ArrayBuffers are unsupported")
                }
            }
            // Only a brand check; all sizes/offsets still come from the C API.
            // This runs before any borrowed pointer is obtained.
        }

        func uint8Array(_ data: Data) throws -> JSValueRef {
            guard data.count <= maximumByteLength else { throw Failure.range }
            guard let array = JSObjectMakeTypedArray(ctx, kJSTypedArrayTypeUint8Array, data.count, exception) else {
                try check(); throw Failure.type("Cannot allocate Uint8Array")
            }
            try check()
            // Keep the newly allocated object rooted across the next C API call.
            JSValueProtect(ctx, array)
            defer { JSValueUnprotect(ctx, array) }
            if !data.isEmpty {
                guard let pointer = JSObjectGetTypedArrayBytesPtr(ctx, array, exception) else {
                    try check(); throw Failure.type("Cannot access Uint8Array storage")
                }
                try check()
                data.copyBytes(to: pointer.assumingMemoryBound(to: UInt8.self), count: data.count)
            }
            // Borrowed pointer scope ended above. Do not expose pinned storage.
            return data.isEmpty ? array : try copyArray(array, length: data.count)
        }

        func jsString(_ text: String) -> JSValueRef {
            let units = Array(text.utf16)
            let string = units.withUnsafeBufferPointer { JSStringCreateWithCharacters($0.baseAddress, $0.count)! }
            defer { JSStringRelease(string) }
            return JSValueMakeString(ctx, string)
        }

        func raise(_ name: String, _ message: String) {
            let key = JSStringCreateWithUTF8CString(name)!
            defer { JSStringRelease(key) }
            var argument: JSValueRef? = jsString(message)
            // Trusted VM intrinsics. No borrowed storage remains when calling JS.
            let constructor = JSObjectGetProperty(ctx, JSContextGetGlobalObject(ctx), key, exception)
            if exception.pointee == nil, let constructor, JSValueIsObject(ctx, constructor),
               let object = JSValueToObject(ctx, constructor, exception), JSObjectIsConstructor(ctx, object) {
                let error = JSObjectCallAsConstructor(ctx, object, 1, &argument, exception)
                if exception.pointee == nil { exception.pointee = error }
            }
            if exception.pointee == nil { exception.pointee = JSObjectMakeError(ctx, 1, &argument, nil) }
        }
    }
}
