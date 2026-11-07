"""Verify diagnostic stripping/privacy using the production Swift collector."""
from pathlib import Path
import subprocess
import tempfile

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
source = ROOT / 'apps/ios/Sources/AlmaTAH/Runtime/TAHLoadProfile.swift'
fixture = r'''
import Foundation
@main struct Check {
    static func main() async throws {
        let root = URL(fileURLWithPath: CommandLine.arguments[1])
        let owner = TAHLoadProfile(directory: root, enabled: true)
        let raw = #"{"done":true,"terminal":{"kind":"end_turn","almaLoadTiming":{"cacheStatus":"prepared","preparationMs":12.5,"sdkLoadMs":99.2,"totalMs":111.7,"token":"NEVER_STORE"}}}"#
        let projected = try await owner.project(method: "provider.kimi.nextEvent", result: raw, hostMs: 30)
        let value = try JSONSerialization.jsonObject(with: Data(projected.utf8)) as! [String: Any]
        let terminal = value["terminal"] as! [String: Any]
        precondition(terminal.count == 1 && terminal["kind"] as? String == "end_turn")
        let file = root.appendingPathComponent("provider-load-profile.json")
        let data = try Data(contentsOf: file)
        let rows = try JSONSerialization.jsonObject(with: data) as! [[String: Any]]
        precondition(rows.count == 1 && rows[0]["sdkLoadMs"] as? Double == 99.2)
        precondition(!String(decoding: data, as: UTF8.self).contains("NEVER_STORE"))
        _ = try await owner.project(method: "provider.kimi.close", result: raw, hostMs: 1)
        let afterClose = try Data(contentsOf: file)
        precondition(afterClose == data)
        let off = TAHLoadProfile(directory: root.appendingPathComponent("absent"), enabled: false)
        let offResult = try await off.project(method: "provider.zcode.nextEvent", result: raw, hostMs: 30)
        precondition(!offResult.contains("almaLoadTiming"))
        for _ in 0..<40 {
            _ = try await owner.project(method: "provider.kimi.start", result: "null", hostMs: 1)
        }
        let bounded = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as! [[String: Any]]
        precondition(bounded.count == 32)
        print("profile: terminal preserved, diagnostic removed, secrets excluded, close deduped, disabled IO absent, bounded rows")
    }
}
'''
with tempfile.TemporaryDirectory(prefix='alma-profile-check-') as folder:
    root = Path(folder)
    (root / 'main.swift').write_text(fixture)
    subprocess.run(['swiftc', '-swift-version', '6', '-strict-concurrency=complete', '-parse-as-library',
                    str(source), str(root / 'main.swift'), '-o', str(root / 'check')], check=True)
    subprocess.run([str(root / 'check'), str(root)], check=True)
