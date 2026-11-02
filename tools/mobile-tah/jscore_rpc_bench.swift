// Offline read-only benchmark. Compile with the UNMODIFIED production host/store.
import CryptoKit
import Darwin
import Foundation

private func milliseconds() -> Double { Double(DispatchTime.now().uptimeNanoseconds) / 1_000_000 }
private func cpuMilliseconds() -> Double {
    var usage = rusage(); getrusage(RUSAGE_SELF, &usage)
    return Double(usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * 1000
        + Double(usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1000
}
private func json(_ value: Any) throws -> String {
    String(decoding: try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys, .fragmentsAllowed]), as: UTF8.self)
}
private func object(_ value: String) throws -> [String: Any] {
    guard let result = try JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any] else {
        throw TAHRuntimeError.invalid_request
    }
    return result
}
// Never report exception descriptions: JS errors could contain private payloads.
private func fail(_ code: String) -> Never {
    FileHandle.standardError.write(Data("{\"error\":\"\(code)\"}\n".utf8)); exit(1)
}

@MainActor private final class PlatformMeter {
    let store: TAHJournalStore
    let operationStreams: [String: String]
    var initializing = true
    var closing = false
    var credentialLoads = 0
    var counts: [String: Int] = [:]
    var responses: [String: Int] = [:]
    var requests: [String: Int] = [:]
    var durations: [String: Double] = [:]
    var streamBytes: [String: Int] = [:]
    var streamCalls: [String: Int] = [:]
    init(store: TAHJournalStore, operationStreams: [String: String]) {
        self.store = store; self.operationStreams = operationStreams
    }
    func reset() { counts = [:]; responses = [:]; requests = [:]; durations = [:]; streamBytes = [:]; streamCalls = [:] }
    func call(_ method: String, _ input: String) async throws -> String {
        let allowed: Set<String> = ["store.head", "store.entries", "store.readChunk", "store.pending",
            "store.pendingChunk", "store.pendingIsComplete", "store.streams", "store.actionStreams"]
        let result: String
        let start = milliseconds()
        if allowed.contains(method) {
            result = try await store.handleJSONRPC(method, json: input)
        } else if initializing && method == "credential.load" && credentialLoads == 0 {
            credentialLoads += 1
            result = #"{"version":1,"providerID":null,"state":"unauthed","credential":null,"account":null,"checkedAt":null}"#
        } else if (initializing || closing) && method == "ui.auth" {
            result = "null"
        } else {
            // Exit, rather than throw: the runtime may intentionally swallow platform errors.
            let name = method.count < 80 && method.allSatisfy({ $0.isASCII && ($0.isLetter || $0 == ".") }) ? method.replacingOccurrences(of: ".", with: "_") : "redacted"
            fail("unexpected_platform_call_" + name + "_during_" + JSCoreRPCBench.stage)
        }
        let elapsed = milliseconds() - start
        counts[method, default: 0] += 1
        requests[method, default: 0] += input.utf8.count
        durations[method, default: 0] += elapsed
        responses[method, default: 0] += result.utf8.count
        if method == "store.readChunk" {
            let fields = try object(input)
            guard let operation = fields["operationID"] as? String,
                  let stream = operationStreams[operation],
                  let data = try object(result)["data"] as? String else { fail("unknown_journal_chunk") }
            // Canonical base64 length -> payload bytes; avoid allocating another decoded payload.
            let size = data.utf8.count / 4 * 3 - (data.hasSuffix("==") ? 2 : data.hasSuffix("=") ? 1 : 0)
            streamBytes[stream, default: 0] += size
            streamCalls[stream, default: 0] += 1
        }
        return result
    }
    func snapshot() -> [String: Any] {
        ["calls": counts.values.reduce(0, +), "responseBytes": responses.values.reduce(0, +),
         "requestBytes": requests.values.reduce(0, +), "requestBytesByMethod": requests,
         "wallMs": durations.values.reduce(0, +), "byMethod": counts.mapValues { $0 },
         "responseBytesByMethod": responses, "wallMsByMethod": durations,
         "journalPayloadBytes": streamBytes.values.reduce(0, +),
         "journalBytesByStream": streamBytes, "journalChunkCallsByStream": streamCalls]
    }
}

@main struct JSCoreRPCBench {
    @MainActor static var stage = "startup"
    // Wrappers preserve receiver, arguments, return values and thrown exceptions.
    // Inclusive and exclusive time are separate; nested costs must NOT be summed.
    // String sizes are UTF-16 units, not alleged UTF-8 bytes; buffer sizes are bytes.
    static let instrumentation = #"""
    (()=>{
      let enabled=false,stats=Object.create(null),stack=[];
      const now=Date.now.bind(Date), apply=Reflect.apply;
      function wrap(owner,key,label,size){
        const original=owner[key];if(typeof original!=='function')return;
        owner[key]=function(...args){
          if(!enabled)return apply(original,this,args);
          const name=label(args),frame={start:now(),child:0};stack.push(frame);
          let value,ok=false;
          try{value=apply(original,this,args);ok=true;return value;}
          finally{
            const elapsed=now()-frame.start;stack.pop();if(stack.length)stack[stack.length-1].child+=elapsed;
            const row=stats[name]??(stats[name]={calls:0,inclusiveMs:0,selfMs:0,bufferBytes:0,stringUTF16Units:0});
            row.calls++;row.inclusiveMs+=elapsed;row.selfMs+=elapsed-frame.child;
            if(ok&&size)size(row,args,value,this);
          }
        };
      }
      const bufferSize=(s,a,v)=>{s.bufferBytes+=v.byteLength;};
      const stringSize=(s,a,v,self)=>{s.stringUTF16Units+=v.length;s.bufferBytes+=self.byteLength??0;};
      wrap(Buffer,'from',a=>'Buffer.from/'+(typeof a[0]==='string'?(a[1]??'utf8'):'bytes'),bufferSize);
      wrap(Buffer.prototype,'toString',a=>'Buffer.toString/'+(a[0]??'utf8'),stringSize);
      wrap(Buffer,'concat',()=> 'Buffer.concat',bufferSize);
      wrap(Buffer,'byteLength',()=> 'Buffer.byteLength',(s,a,v)=>{s.bufferBytes+=v;});
      wrap(Buffer.prototype,'fill',()=> 'Buffer.fill',bufferSize);
      wrap(TextEncoder.prototype,'encode',()=> 'TextEncoder.encode',bufferSize);
      wrap(TextDecoder.prototype,'decode',()=> 'TextDecoder.decode',(s,a,v)=>{s.bufferBytes+=a[0]?.byteLength??0;s.stringUTF16Units+=v.length;});
      wrap(globalThis,'structuredClone',()=> 'structuredClone',null); // no extra traversal/allocation to count object bytes
      wrap(JSON,'parse',()=> 'JSON.parse',(s,a)=>{if(typeof a[0]==='string')s.stringUTF16Units+=a[0].length;});
      wrap(JSON,'stringify',()=> 'JSON.stringify',(s,a,v)=>{if(typeof v==='string')s.stringUTF16Units+=v.length;});
      wrap(globalThis,'__almaSHA256',()=> 'nativeSHA256',(s,a)=>{s.bufferBytes+=a[0].length/4*3-(a[0].endsWith('==')?2:a[0].endsWith('=')?1:0);});
      wrap(globalThis,'__almaSHA256Bytes',()=> 'nativeSHA256.bytes',(s,a)=>{s.bufferBytes+=a[0].byteLength;});
      for(const [name,module] of [['classic',globalThis.__benchZodClassic],['core',globalThis.__benchZodCore]]) {
        if(!module)throw new Error('Missing benchmark Zod module');
        for(const key of ['parse','safeParse'])wrap(module,key,()=> 'Zod.'+name+'.'+key,null);
      }
      const runtime=AlmaMobileRuntime;
      globalThis.AlmaMobileRuntime={invoke(method,input){
        if(method==='bench.start'){stats=Object.create(null);enabled=true;return {};}
        if(method==='bench.stop'){enabled=false;return stats;}
        return runtime.invoke(method,input);
      }};
    })();
    """#

    @MainActor static func main() async {
        do { try await run() } catch {
            let message = String(describing: error)
            let known = ["invalid_request", "integrity_locked", "unavailable", "busy", "journal digest mismatch", "ZodError", "ReferenceError", "TypeError"]
            let code = known.first(where: { message.contains($0) })?.replacingOccurrences(of: " ", with: "_") ?? "unknown"
            fail(stage + "_" + code)
        }
    }
    @MainActor static func run() async throws {
        let args = CommandLine.arguments
        guard args.count == 5 else { fail("arguments") }
        let plan = try object(String(contentsOfFile: args[2], encoding: .utf8))
        let repetitions = plan["repetitions"] as! Int
        let maxPages = plan["maxPages"] as! Int
        let instrument = plan["instrument"] as! Bool
        guard let nativeBytes = plan["nativeBytes"] as? Bool else { fail("native_bytes_option_required") }
        guard (1...5).contains(repetitions), (1...4).contains(maxPages) else { fail("bounds") }
        stage = "store_init"
        let store = try TAHJournalStore(directory: URL(fileURLWithPath: args[3]))
        let meter = PlatformMeter(store: store, operationStreams: plan["operationStreams"] as! [String: String])
        var bundle = try String(contentsOfFile: args[1], encoding: .utf8)
        if instrument {
            // Expose existing module exports ONLY in the in-memory instrumented bundle.
            // Baselines execute the original bytes. No implementation is replaced.
            let anchor = "globalThis.AlmaTAH=__require('/platform/exports.ts');"
            guard bundle.components(separatedBy: anchor).count == 2 else { fail("bundle_instrumentation_anchor") }
            bundle = bundle.replacingOccurrences(of: anchor, with:
                "globalThis.__benchZodClassic=__require('/vendor/zod/v4/classic/parse.cjs');" +
                "globalThis.__benchZodCore=__require('/vendor/zod/v4/core/parse.cjs');" + anchor)
        }
        let bootStart = milliseconds()
        stage = "host_init"
        let host = try await AlmaTAHJavaScriptHost(bundle: bundle, platform: { method, input in
            try await meter.call(method, input)
        }, enableNativeBytePrimitives: nativeBytes)
        let bootMs = milliseconds() - bootStart
        stage = "native_bytes_install_verify"
        let primitiveNames = ["__almaUTF8Encode", "__almaUTF8ByteLength", "__almaUTF8Decode",
                              "__almaBase64Encode", "__almaBase64DecodeCanonical", "__almaSHA256Bytes"]
        try await host.evaluate("if (!\(try json(primitiveNames)).every(name => (typeof globalThis[name] === 'function') === \(nativeBytes))) throw new Error('native_bytes_install_mismatch');")
        stage = "instrument_init"
        if instrument { try await host.evaluate(instrumentation) }
        let initStart = milliseconds()
        stage = "runtime_initialize"
        _ = try await host.invoke("runtime.initialize", json: json(plan["config"]!))
        let initialization: [String: Any] = ["bundleWallMs": bootMs, "initializeWallMs": milliseconds() - initStart,
            "platform": meter.snapshot()]
        meter.initializing = false
        var samples: [[String: Any]] = []
        let allowed: Set<String> = ["auth.snapshot", "raw.status", "action.list", "action.snapshot",
            "action.conversation", "action.conversationText"]
        func measure(_ method: String, _ fields: [String: Any], caseID: String, iteration: Int,
                     variant: String = "default") async throws -> [String: Any] {
            guard allowed.contains(method) else { fail("unexpected_runtime_call") }
            stage = method.replacingOccurrences(of: ".", with: "_")
            let input = try json(fields)
            let requestFingerprint = SHA256.hash(data: Data(input.utf8)).map { String(format: "%02x", $0) }.joined()
            if instrument { _ = try await host.invoke("bench.start", json: "{}") }
            meter.reset()
            let cpu = cpuMilliseconds(), start = milliseconds()
            let reply = try await host.invoke(method, json: input)
            let wall = milliseconds() - start, cpuMs = cpuMilliseconds() - cpu
            let platform = meter.snapshot()
            var hooks: [String: Any] = [:]
            if instrument { hooks = try object(await host.invoke("bench.stop", json: "{}")) }
            var comparable = try object(reply)
            for key in ["sourceID", "sourceRevision", "progressSourceID", "progressRevision"] { comparable.removeValue(forKey: key) }
            let fingerprint = SHA256.hash(data: Data(try json(comparable).utf8)).map { String(format: "%02x", $0) }.joined()
            samples.append(["requestFingerprint": requestFingerprint, "requestBytes": input.utf8.count,
                "replyFingerprint": fingerprint, "method": method, "variant": variant, "caseID": caseID, "iteration": iteration,
                "wallMs": wall, "cpuMs": cpuMs, "replyBytes": reply.utf8.count, "platform": platform, "js": hooks])
            return try object(reply) // result parsing/retention excluded from the timed RPC
        }
        for i in 0..<repetitions { _ = try await measure("auth.snapshot", [:], caseID: "global", iteration: i) }
        var historySummaries: [[String: Any]] = []
        for item in plan["cases"] as! [[String: Any]] {
            let id = item["actionID"] as! String
            for i in 0..<repetitions {
                _ = try await measure("raw.status", ["materialID": item["materialID"]!], caseID: id, iteration: i)
                _ = try await measure("action.list", ["transcriptID": item["transcriptID"]!, "cursor": NSNull()], caseID: id, iteration: i)
                _ = try await measure("action.snapshot", ["actionID": id], caseID: id, iteration: i)
            }
            // Exact loadHistory(reset:true) RPC loop: first load stops after one page;
            // subsequent refreshes compare the prior newest position. SwiftUI/Markdown excluded.
            var historyHead: Int? = nil
            var textPosition: Int? = nil
            for i in 0..<repetitions {
                var cursor: Any = NSNull(), pages = 0, newest = historyHead, truncated = false
                let sampleStart = samples.count
                repeat {
                    let page = try await measure("action.conversation", ["actionID": id, "cursor": cursor],
                        caseID: id, iteration: i, variant: "controller.loadHistory.reset")
                    pages += 1
                    let rows = page["items"] as! [[String: Any]]
                    for row in rows {
                        let position = row["position"] as! Int
                        newest = max(newest ?? 0, position)
                        if textPosition == nil || row["isFinalAnswer"] as? Bool == true { textPosition = position }
                    }
                    cursor = page["nextCursor"] ?? NSNull()
                    if historyHead == nil || ((rows.last?["position"] as? Int) ?? 0) <= historyHead! + 1 || cursor is NSNull { break }
                    if pages >= maxPages { truncated = true; break }
                } while true
                historyHead = newest
                let reads = samples[sampleStart...]
                historySummaries.append(["caseID": id, "iteration": i, "pages": pages, "boundedEarly": truncated,
                    "wallMs": reads.reduce(0.0) { $0 + ($1["wallMs"] as! Double) },
                    "replyBytes": reads.reduce(0) { $0 + ($1["replyBytes"] as! Int) }])
            }
            if let position = textPosition {
                for i in 0..<repetitions {
                    _ = try await measure("action.conversationText", ["actionID": id, "position": position, "offset": 0],
                        caseID: id, iteration: i, variant: "firstChunk")
                }
            }
        }
        stage = "runtime_shutdown"
        meter.closing = true
        _ = try await host.invoke("runtime.shutdown", json: "{}")
        await host.shutdown(); await store.close()
        let output: [String: Any] = ["passed": true, "instrumented": instrument, "nativeBytes": nativeBytes, "nativeByteInstallationVerified": true,
            "JSC_useJIT": ProcessInfo.processInfo.environment["JSC_useJIT"] ?? "default",
            "modelCalls": 0, "providerCalls": 0, "realCredentialsRead": false, "credentialLoadsStubbed": meter.credentialLoads,
            "initialization": initialization, "samples": samples, "controllerLoadHistory": historySummaries]
        // No RPC result body ever reaches disk/stdout.
        try Data(json(output).utf8).write(to: URL(fileURLWithPath: args[4]))
        print("{\"passed\":true}")
    }
}
