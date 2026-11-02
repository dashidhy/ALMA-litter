#!/usr/bin/env python3
"""Type-check complete production auth/provider Swift files against iOS SDK.

Generated binding signatures and the logger are stand-ins; no code executes.
"""
from pathlib import Path
import subprocess,json
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[2];BUILD=HERE/'.build/swift';BUILD.mkdir(parents=True,exist_ok=True)
stubs='''import Foundation
struct ChatgptAuthRefreshRequest: Sendable { let previousAccountId: String?; let timeoutMs: UInt32 }
struct ChatgptAuthRefreshTokens: Sendable { let accessToken: String; let accountId: String; let planType: String? }
enum ChatgptAuthRefreshError: Error { case Unavailable, TimedOut, AccountChanged, RefreshFailed, UnsupportedServer }
protocol ChatgptAuthRefreshProvider: Sendable { func refresh(request: ChatgptAuthRefreshRequest) async throws -> ChatgptAuthRefreshTokens }
enum LLog {
    static func info(_ category: String, _ message: String, fields: [String: Any] = [:]) {}
    static func warn(_ category: String, _ message: String, fields: [String: Any] = [:]) {}
}
'''
p=BUILD/'IOSBindingSignatures.swift';p.write_text(stubs)
sdk=subprocess.check_output(['xcrun','--sdk','iphoneos','--show-sdk-path'],text=True).strip()
models=ROOT/'apps/ios/Sources/Litter/Models'
command=['/usr/bin/swiftc','-typecheck','-target','arm64-apple-ios18.0','-sdk',sdk,'-swift-version','5','-strict-concurrency=targeted','-warnings-as-errors','-module-cache-path',str(BUILD/'module-cache'),str(models/'ChatGPTOAuth.swift'),str(models/'ChatGPTAuthRefreshProvider.swift'),str(p)]
r=subprocess.run(command,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
(HERE/'swift-ios-typecheck.txt').write_text(r.stdout or 'PASS: complete production auth/provider Swift files type-check for iOS, Swift 5 targeted; binding/logger signatures substituted; no code executed.\n')
(HERE/'swift-ios-evidence.json').write_text(json.dumps({'command':command,'exit_code':r.returncode,'scope':'whole auth/provider Swift files, actual iOS SDK, generated binding signatures/logging stubs; not app link or regenerated bindings'},indent=2)+'\n')
print(r.stdout or 'PASS complete production Swift auth/provider iOS typecheck');raise SystemExit(r.returncode)
