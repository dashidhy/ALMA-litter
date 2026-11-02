#!/usr/bin/env python3
"""Generate isolated Swift interface from compiled production UniFFI metadata.

No full app binding generation, shared target, credentials, or network requests.
"""
from pathlib import Path
import json,os,subprocess,hashlib
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[2];BUILD=HERE/'.build';TC=ROOT.parent/'ALMA/.build/tauri-toolchain'
fixture=BUILD/'rust';manifest=fixture/'Cargo.toml'
s=manifest.read_text()
if 'crate-type' not in s:s=s.replace('[lib]\npath="lib.rs"','[lib]\npath="lib.rs"\ncrate-type=["rlib", "cdylib"]')
manifest.write_text(s)
tool=BUILD/'bindgen';tool.mkdir(exist_ok=True)
(tool/'Cargo.toml').write_text('''[package]
name="auth-refresh-bindgen-evidence"
version="0.0.0"
edition="2024"
[workspace]
[[bin]]
name="auth-refresh-bindgen-evidence"
path="main.rs"
[dependencies]
uniffi={version="=0.31.0",features=["cli"]}
''')
(tool/'main.rs').write_text('fn main() { uniffi::uniffi_bindgen_main(); }\n')
env=dict(os.environ,CARGO_HOME=str(TC/'cargo'),RUSTUP_HOME=str(TC/'rustup'),RUSTUP_TOOLCHAIN='stable-aarch64-apple-darwin',CARGO_TARGET_DIR=str(fixture/'target'),CARGO_NET_OFFLINE='true')
env['PATH']=str(TC/'cargo/bin')+os.pathsep+env['PATH']
for k in ['RUSTC','RUSTC_WRAPPER','RUSTC_WORKSPACE_WRAPPER','RUSTFLAGS','CARGO_ENCODED_RUSTFLAGS']:env.pop(k,None)
cargo=str(TC/'cargo/bin/cargo');generated=BUILD/'generated';generated.mkdir(exist_ok=True)
commands=[
 [cargo,'build','--offline','--manifest-path',str(manifest),'--lib','-j','2'],
 [cargo,'run','--offline','--manifest-path',str(tool/'Cargo.toml'),'-j','2','--','generate','--library',str(fixture/'target/debug/libalma_auth_refresh_regression.dylib'),'--language','swift','--out-dir',str(generated)],
]
logs=[]
for command in commands:
 r=subprocess.run(command,env=env,cwd=fixture,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 logs.append(r.stdout)
 (HERE/'generated-callback-build.txt').write_text('\n'.join(logs))
 if r.returncode:print(r.stdout);raise SystemExit(r.returncode)
files=[p for p in generated.glob('*.swift') if not p.name.endswith('Stub.swift')];assert len(files)==1,files
swift=files[0];text=swift.read_text();start=text.index('public enum ChatgptAuthRefreshError');end=text.index('\n}',start)+2
error=text[start:end]
(HERE/'generated-error-enum.swift.txt').write_text(error+'\n')
expected=['Unavailable','TimedOut','AccountChanged','RefreshFailed','UnsupportedServer']
for case in expected:assert 'case '+case+'\n' in error,case
assert '(message:' not in error
provider=ROOT/'apps/ios/Sources/Litter/Models/ChatGPTAuthRefreshProvider.swift'
# The actual generated Swift interface is compiled with the production provider;
# only the OAuth store boundary is stubbed to avoid involving UIKit/network work.
stub=generated/'AuthOwnerStub.swift'
stub.write_text('''import Foundation
struct ChatGPTOAuthTokenBundle: Sendable { let accessToken: String; let accountID: String; let planType: String? }
enum ChatGPTOAuthError: Error { case refreshAccountMismatch, staleRefresh, refreshTimedOut, missingStoredTokens, missingRefreshToken }
@MainActor enum ChatGPTOAuth {
    static func refreshStoredTokens(previousAccountID: String?, deadline: Date?) async throws -> ChatGPTOAuthTokenBundle { throw ChatGPTOAuthError.missingStoredTokens }
}
''')
modulemaps=list(generated.glob('*.modulemap'));assert len(modulemaps)==1,modulemaps
command=['/usr/bin/swiftc','-typecheck','-swift-version','5','-strict-concurrency=targeted','-warnings-as-errors','-I',str(generated),'-Xcc','-fmodule-map-file='+str(modulemaps[0]),'-module-cache-path',str(BUILD/'swift/module-cache'),str(swift),str(provider),str(stub)]
r=subprocess.run(command,env=env,cwd=fixture,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
(HERE/'generated-provider-typecheck.txt').write_text(r.stdout or 'PASS: production native provider type-checks against actual generated UniFFI Swift interface.\n')
evidence={'generation_commands':commands,'generator':'uniffi-bindgen 0.31.0','source_module_sha256':hashlib.sha256((ROOT/'shared/rust-bridge/codex-mobile-client/src/auth_refresh.rs').read_bytes()).hexdigest(),'generated_swift_path':str(swift.relative_to(ROOT)),'generated_swift_sha256':hashlib.sha256(swift.read_bytes()).hexdigest(),'error_enum_cases':expected,'cases_have_associated_message':False,'native_provider_typecheck_command':command,'native_provider_typecheck_exit_code':r.returncode,'scope':'isolated production callback metadata; not full app binding generation'}
(HERE/'generated-callback-evidence.json').write_text(json.dumps(evidence,indent=2)+'\n')
print(r.stdout or 'PASS: exact generated error cases are unit cases; native provider type-checks against generated interface.')
raise SystemExit(r.returncode)
