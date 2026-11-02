import Foundation

@main struct CoreReplay {
    @MainActor static func main() async throws {
        let args=CommandLine.arguments
        let journal=try TAHJournalStore(directory: URL(fileURLWithPath: args[4]))
        var auth="{\"version\":1,\"providerID\":null,\"state\":\"unauthed\",\"credential\":null,\"account\":null,\"checkedAt\":null}"
        let host=try await AlmaTAHJavaScriptHost(bundle:String(contentsOfFile:args[1],encoding:.utf8)){method,json in
            if method.hasPrefix("store."){
                return try await journal.handleJSONRPC(method,json:json)
            }
            if method.hasPrefix("ui."){return "null"}
            if method=="credential.load"{return auth}
            if method=="credential.save"{
                let value=try JSONDecoder().decode(TAHRuntimeValue.self,from:Data(json.utf8))
                auth=String(decoding:try JSONEncoder().encode(value["record"]!),as:UTF8.self);return "null"
            }
            throw AlmaTAHJavaScriptHost.HostError.unavailable
        }
        try await host.evaluate(String(contentsOfFile:args[2],encoding:.utf8))
        do {
            print(try await host.invoke("proof",json:String(contentsOfFile:args[3],encoding:.utf8)))
        } catch { fputs("Core replay failed: \(error)\n",stderr); await host.shutdown();await journal.close();exit(1) }
        await host.shutdown();await journal.close()
    }
}
