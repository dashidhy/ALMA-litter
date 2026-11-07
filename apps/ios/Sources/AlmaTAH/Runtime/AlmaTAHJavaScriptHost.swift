import CryptoKit
import Dispatch
import Foundation
import JavaScriptCore

/// Private Provider-to-Adapter categories carried as immutable values.
enum TAHProviderPlatformError: String, Error, Sendable {
    case unavailable, timeout, cleanup
    var wireCode: String { "provider_" + rawValue }
}

/// A system-managed serial queue keeps long JS jobs off both the UI actor and
/// Swift's cooperative pool. The actor retains the executor for its entire life.
/// JavaScriptCore serializes at VM granularity, not at a particular OS thread.
private final class TAHJavaScriptExecutor: SerialExecutor {
    private let queue = DispatchQueue(label: "com.alma.tah.javascript", qos: .userInitiated,
                                      autoreleaseFrequency: .workItem)
    func enqueue(_ job: consuming ExecutorJob) {
        let job = UnownedJob(job)
        queue.async { job.runSynchronously(on: self.asUnownedSerialExecutor()) }
    }
    func checkIsolated() { dispatchPrecondition(condition: .onQueue(queue)) }
}

/// Trusted TAH application code only. Provider/model tool JavaScript never enters this VM.
/// All JS values, callbacks and timers stay on this actor. Only immutable strings
/// cross to the platform bridge; only the platform's UI work returns to MainActor.
actor AlmaTAHJavaScriptHost {
    typealias PlatformCall = @MainActor @Sendable (String, String) async throws -> String
    private nonisolated let executor = TAHJavaScriptExecutor()
    nonisolated var unownedExecutor: UnownedSerialExecutor { executor.asUnownedSerialExecutor() }
    enum HostError: Error { case unavailable, invalidJSON, javascript(String), capacity }
    private var context: JSContext?
    private let platform: PlatformCall
    private var calls: [String: CheckedContinuation<String, Error>] = [:]
    private var timers: [Int: Task<Void, Never>] = [:]
    private var operations: [String: Task<Void, Never>] = [:]
    private var stopped = false

    init(bundle: String, platform: @escaping PlatformCall, enableNativeBytePrimitives: Bool = true,
         providerDirectory: URL? = nil) async throws {
        self.platform = platform
        try initialize(bundle, enableNativeBytePrimitives: enableNativeBytePrimitives, providerDirectory: providerDirectory)
    }

    private func initialize(_ bundle: String, enableNativeBytePrimitives: Bool, providerDirectory: URL?) throws {
        dispatchPrecondition(condition: .notOnQueue(.main))
        guard let context = JSContext() else { throw HostError.unavailable }
        self.context = context
        if enableNativeBytePrimitives {
            TAHJavaScriptBytePrimitives.install(on: context)
            if let exception = context.exception {
                throw HostError.javascript(exception.toString() ?? "Byte primitive initialization failed")
            }
        }
        let uuid: @convention(block) () -> String = { UUID().uuidString.lowercased() }
        let hash: @convention(block) (String) -> String = { encoded in
            guard let data = Data(base64Encoded: encoded) else { return "" }
            return SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        }
        let url: @convention(block) (String, String) -> String = { relative, base in
            guard let result = URL(string: relative, relativeTo: URL(string: base)) else { return "" }
            return result.absoluteURL.absoluteString
        }
        let request: @convention(block) (String, String, String) -> Void = { [weak self] id, method, json in
            self?.assumeIsolated { $0.request(id: id, method: method, json: json) }
        }
        let reply: @convention(block) (String, String, String) -> Void = { [weak self] id, json, error in
            self?.assumeIsolated { owner in
                guard let continuation = owner.calls.removeValue(forKey: id) else { return }
                if error.isEmpty { continuation.resume(returning: json) }
                else { continuation.resume(throwing: HostError.javascript(error)) }
            }
        }
        let timer: @convention(block) (Int, Double) -> Void = { [weak self] id, delay in self?.assumeIsolated { $0.schedule(id, delay) } }
        let cancelTimer: @convention(block) (Int) -> Void = { [weak self] id in self?.assumeIsolated { $0.timers.removeValue(forKey: id)?.cancel() } }
        context.setObject(uuid, forKeyedSubscript: "__almaUUID" as NSString)
        context.setObject(hash, forKeyedSubscript: "__almaSHA256" as NSString)
        context.setObject(url, forKeyedSubscript: "__almaURL" as NSString)
        context.setObject(request, forKeyedSubscript: "__almaNativeRequest" as NSString)
        context.setObject(reply, forKeyedSubscript: "__almaNativeReply" as NSString)
        context.setObject(timer, forKeyedSubscript: "__almaNativeTimer" as NSString)
        context.setObject(cancelTimer, forKeyedSubscript: "__almaNativeCancelTimer" as NSString)
        // Only signed App resources are evaluated. Each chunk is read on this
        // actor's serial executor at first provider use, never on the UI actor.
        let loadProvider: @convention(block) (String) -> Bool = { [weak context] provider in
            guard let context, let directory = providerDirectory,
                  ["codex", "kimi", "zcode"].contains(provider),
                  let manifestData = try? Data(contentsOf: directory.appendingPathComponent("bundle-manifest.json")),
                  let manifest = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
                  let chunks = manifest["chunks"] as? [String: [String: Any]],
                  let expected = chunks[provider],
                  let data = try? Data(contentsOf: directory.appendingPathComponent("alma-provider-\(provider).js")),
                  data.count == expected["bytes"] as? Int,
                  SHA256.hash(data: data).map({ String(format: "%02x", $0) }).joined() == expected["sha256"] as? String,
                  let source = String(data: data, encoding: .utf8) else { return false }
            context.evaluateScript(source)
            return context.exception == nil
        }
        context.setObject(loadProvider, forKeyedSubscript: "__almaLoadProviderChunk" as NSString)
        try evaluate(Self.bootstrap)
        try evaluate(bundle)
    }

    func invoke(_ method: String, json: String) async throws -> String {
        try Task.checkCancellation()
        guard !stopped, let context else { throw HostError.unavailable }
        guard calls.count < 32 else { throw HostError.capacity }
        let id = UUID().uuidString
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                calls[id] = continuation
                context.exception = nil
                context.objectForKeyedSubscript("__almaInvoke")?.call(withArguments: [id, method, json])
                if let exception = context.exception {
                    calls.removeValue(forKey: id)?.resume(throwing: HostError.javascript(exception.toString()))
                    context.exception = nil
                }
            }
        } onCancel: {
            Task { await self.cancelCall(id) }
        }
    }

    /// Evaluate only bundled application modules and test-owned scripts, never transcript text.
    func evaluate(_ source: String) throws {
        dispatchPrecondition(condition: .notOnQueue(.main))
        guard !stopped, let context else { throw HostError.unavailable }
        context.exception = nil
        context.evaluateScript(source)
        if let exception = context.exception {
            let detail = exception.toString() ?? "JavaScript exception"
            context.exception = nil
            throw HostError.javascript(detail)
        }
    }

    func shutdown() {
        stopped = true
        for task in timers.values { task.cancel() }; timers.removeAll()
        for task in operations.values { task.cancel() }; operations.removeAll()
        let pending = calls; calls.removeAll()
        for continuation in pending.values { continuation.resume(throwing: HostError.unavailable) }
        context = nil
    }

    private func cancelCall(_ id: String) {
        calls.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }

    private func request(id: String, method: String, json: String) {
        guard !stopped, operations[id] == nil, operations.count < 64,
              json.utf8.count <= 16 * 1024 * 1024 else {
            receive(id, json: "null", error: "unavailable"); return
        }
        let platform = self.platform
        operations[id] = Task { [weak self] in
            do {
                let result = try await Self.performPlatform(platform, method: method, json: json)
                if !Task.isCancelled { await self?.completeOperation(id, json: result, error: "") }
            } catch {
                let code = (error as? TAHProviderPlatformError)?.wireCode ?? "unavailable"
                if !Task.isCancelled { await self?.completeOperation(id, json: "null", error: code) }
            }
        }
    }

    @MainActor private static func performPlatform(_ platform: PlatformCall, method: String, json: String) async throws -> String {
        // A shutdown may cancel this task while its hop to MainActor is queued.
        try Task.checkCancellation()
        return try await platform(method, json)
    }

    private func completeOperation(_ id: String, json: String, error: String) {
        receive(id, json: json, error: error)
        operations.removeValue(forKey: id)
    }

    private func receive(_ id: String, json: String, error: String) {
        guard !stopped, let context else { return }
        context.objectForKeyedSubscript("__almaPlatformReceive")?.call(withArguments: [id, json, error])
    }

    private func schedule(_ id: Int, _ delay: Double) {
        guard !stopped, delay.isFinite, timers.count < 256 else { return }
        timers[id]?.cancel()
        timers[id] = Task { [weak self] in
            do { try await Task.sleep(for: .milliseconds(min(max(0, delay), 2_147_483_647))) }
            catch { return }
            await self?.fireTimer(id)
        }
    }

    private func fireTimer(_ id: Int) {
        guard !stopped, !Task.isCancelled, let context, timers.removeValue(forKey: id) != nil else { return }
        context.objectForKeyedSubscript("__almaFireTimer")?.call(withArguments: [id])
    }

    private static let bootstrap = #"""
    (()=>{
      const pending=new Map(), timers=new Map(); let timerID=0;
      globalThis.__almaPlatformCall=(method,value)=>new Promise((resolve,reject)=>{
        if(pending.size>=64)throw new Error('platform capacity');
        const id=__almaUUID();pending.set(id,{resolve,reject});
        __almaNativeRequest(id,method,JSON.stringify(value));
      });
      globalThis.__almaPlatformReceive=(id,json,error)=>{
        const p=pending.get(id);if(!p)return;pending.delete(id);
        if(error){const e=new Error(error);e.code=error;p.reject(e);}
        else {try{p.resolve(JSON.parse(json));}catch(e){p.reject(e);}}
      };
      globalThis.__almaInvoke=(id,method,json)=>Promise.resolve().then(()=>{
        if(!globalThis.AlmaMobileRuntime)throw new Error('mobile runtime not initialized');
        return AlmaMobileRuntime.invoke(method,JSON.parse(json));
      }).then(value=>__almaNativeReply(id,JSON.stringify(value),''),error=>__almaNativeReply(id,'null',String(error)));
      // JSCore's lifetime is owned by the App, not by a Node event-loop refcount.
      globalThis.setTimeout=(fn,ms=0,...args)=>{if(timers.size>=256)throw new Error('timer capacity');const id=++timerID;timers.set(id,()=>fn(...args));__almaNativeTimer(id,Number(ms));return {id,ref(){return this;},unref(){return this;},[Symbol.toPrimitive](){return id;}};};
      globalThis.clearTimeout=timer=>{const id=Number(timer);timers.delete(id);__almaNativeCancelTimer(id);};
      globalThis.__almaFireTimer=id=>{const fn=timers.get(id);timers.delete(id);if(fn)fn();};
      globalThis.queueMicrotask=fn=>Promise.resolve().then(fn);
      globalThis.URL=class {constructor(value,base=''){this.href=__almaURL(String(value),String(base));if(!this.href)throw new TypeError('Invalid URL');}toString(){return this.href;}};
    })();
    """#
}
