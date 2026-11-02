import Foundation

@main struct WorkerChecks {
    @MainActor static func main() async throws {
        var checks: [String] = []
        func expect(_ good: Bool, _ name: String) throws {
            guard good else { throw NSError(domain: "WorkerChecks", code: 1, userInfo: [NSLocalizedDescriptionKey: name]) }
            checks.append(name)
        }
        let script = #"""
        globalThis.AlmaMobileRuntime = {async invoke(method, value) {
          if (method === 'echo') return await __almaPlatformCall('echo', value);
          if (method === 'timer') return await new Promise(resolve => setTimeout(() => resolve(value), 15));
          if (method === 'timer-cancel') return await new Promise(resolve => {
            const unwanted=setTimeout(() => resolve('wrong'), 10); clearTimeout(unwanted);
            setTimeout(() => resolve('right'), 20);
          });
          if (method === 'burn') { const start=Date.now(); while(Date.now()-start < 240) {} return value; }
          if (method === 'fail') throw new Error('expected');
          if (method === 'never') return await new Promise(()=>{});
          if (method === 'native-wait') return await __almaPlatformCall('wait', value);
          return value;
        }};
        """#
        var platformWasMain = false
        let host = try await AlmaTAHJavaScriptHost(bundle: script) { method, json in
            MainActor.assertIsolated(); platformWasMain = true
            if method == "wait" { try await Task.sleep(for: .seconds(5)) }
            return json
        }
        let echo = try await host.invoke("echo", json: #"{"text":"中文 😀"}"#)
        try expect(echo.contains("中文 😀") && platformWasMain, "immutable UTF-8 bridge and MainActor platform callback")
        try expect(try await host.invoke("timer", json: "123") == "123", "timer resumes on worker")
        try expect(try await host.invoke("timer-cancel", json: "null") == #""right""#, "timer cancellation")
        do { _ = try await host.invoke("fail", json: "null"); try expect(false, "JS rejection") }
        catch AlmaTAHJavaScriptHost.HostError.javascript { checks.append("JS rejection") }
        var gaps: [Double] = []
        let heart = Task { @MainActor in
            var prior = ContinuousClock.now
            for _ in 0..<35 {
                try await Task.sleep(for: .milliseconds(10))
                let now = ContinuousClock.now, parts = prior.duration(to: now).components
                gaps.append(Double(parts.seconds)*1000 + Double(parts.attoseconds)/1e15); prior = now
            }
        }
        try expect(try await host.invoke("burn", json: "42") == "42", "long JS computation returns exact output")
        try await heart.value
        try expect((gaps.max() ?? 1000) < 150, "MainActor heartbeat survives 240ms JS job")
        for _ in 0..<40 {
            let pending = Task { try await host.invoke("never", json: "null") }
            try await Task.sleep(for: .milliseconds(2)); pending.cancel()
            do { _ = try await pending.value; try expect(false, "cancelled call") } catch is CancellationError {}
        }
        try expect(try await host.invoke("echo", json: "7") == "7", "cancelled calls release bounded capacity")
        let waiting = Task { try await host.invoke("native-wait", json: "null") }
        try await Task.sleep(for: .milliseconds(20)); await host.shutdown()
        do { _ = try await waiting.value; try expect(false, "shutdown resolves pending calls") }
        catch AlmaTAHJavaScriptHost.HostError.unavailable { checks.append("shutdown resolves pending calls") }
        do { _ = try await host.invoke("echo", json: "null"); try expect(false, "shutdown rejects work") }
        catch AlmaTAHJavaScriptHost.HostError.unavailable { checks.append("shutdown rejects work") }
        print(String(decoding: try JSONSerialization.data(withJSONObject: ["passed":true,"checks":checks,"heartbeatMaxGapMs":gaps.max() ?? 0], options:[.sortedKeys]),as:UTF8.self))
    }
}
