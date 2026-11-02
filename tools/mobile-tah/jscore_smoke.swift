import Foundation

@main struct Smoke {
    @MainActor static func main() async throws {
        let args = CommandLine.arguments
        let host = try await AlmaTAHJavaScriptHost(bundle: String(contentsOfFile: args[1], encoding: .utf8)) { method, json in
            guard method == "proof.echo" else { throw AlmaTAHJavaScriptHost.HostError.unavailable }
            return json
        }
        try await host.evaluate(String(contentsOfFile: args[2], encoding: .utf8))
        let result = try await host.invoke("proof", json: String(contentsOfFile: args[3], encoding: .utf8))
        print(result)
        await host.shutdown()
    }
}
