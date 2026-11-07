import Foundation

@main struct ProviderLoadingChecks {
    static func main() async throws {
        let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
        let source = try String(contentsOf: directory.appendingPathComponent("alma-tah.js"), encoding: .utf8)
        for selected in ["codex", "kimi", "zcode"] {
            let host = try await AlmaTAHJavaScriptHost(bundle: source, platform: { _, _ in
                throw AlmaTAHJavaScriptHost.HostError.unavailable
            }, providerDirectory: directory)
            try await host.evaluate("""
                const loaded = [];
                const install = AlmaInstallProviderChunk;
                AlmaInstallProviderChunk = function(id, factories, links) { loaded.push(id); return install(id, factories, links); };
                const selected = AlmaLoadProvider('\(selected)');
                if (selected.id !== '\(selected)' || loaded.length !== 1 || loaded[0] !== '\(selected)') throw new Error('eager provider');
                if (AlmaLoadProvider('\(selected)') !== selected || loaded.length !== 1) throw new Error('duplicate provider');
                for (const id of ['codex', 'kimi', 'zcode']) if (AlmaLoadProvider(id).id !== id) throw new Error('provider switch');
                if (loaded.length !== 3) throw new Error('provider chunk count');
                """)
            await host.shutdown()
        }
        print("{\"passed\":true,\"freshJavaScriptCoreContexts\":3,\"providers\":3}")
    }
}
