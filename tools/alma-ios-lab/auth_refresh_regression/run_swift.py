#!/usr/bin/env python3
"""Offline Swift 5 targeted-concurrency verification; no network or Keychain."""
from pathlib import Path
import sys,os,json,hashlib,subprocess,re
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[2];BUILD=HERE/'.build/swift';BUILD.mkdir(parents=True,exist_ok=True)
sys.path.insert(0,str(HERE.parent/'thread_item_regression'));from run import block
source_path=ROOT/'apps/ios/Sources/Litter/Models/ChatGPTOAuth.swift';source=source_path.read_text()
provider=ROOT/'apps/ios/Sources/Litter/Models/ChatGPTAuthRefreshProvider.swift'
def extract(needle):return block(source,source.index(needle))
# Ensure the real Keychain mutation paths invalidate suspended refreshes. The
# executable fixture substitutes memory for Security APIs, never actual accounts.
for signature in ['func save(_ tokens:', 'func clear()']:
 body=extract(signature);assert 'generation &+= 1' in body
 assert source[source.index(signature)-20:source.index(signature)].strip().endswith('@MainActor')
derived='import Foundation\nimport Security\n'+extract('struct ChatGPTOAuthTokenBundle:')+'\n'+extract('enum ChatGPTOAuthError:')+'\n@MainActor enum ChatGPTOAuth {\n'+extract('private struct RefreshFlight {')+'\nprivate static var refreshFlight: RefreshFlight?\n'+extract('static func refreshStoredTokens(')+'\n'+extract('static func loadStoredOrRefreshedTokens()')+'\n}\n'
without_comments = re.sub(r'//[^\n]*', '', derived)
for forbidden in ['URLSession','SecItem','LLog.']:assert forbidden not in without_comments
(BUILD/'Production.swift').write_text(derived)
for d in ['module-cache','tmp']:(BUILD/d).mkdir(exist_ok=True)
env=dict(os.environ,TMPDIR=str(BUILD/'tmp'),CLANG_MODULE_CACHE_PATH=str(BUILD/'module-cache'))
runs=[]
for version,strict in [('5','targeted'),('6','complete')]:
 binary=BUILD/('swift-'+version)
 command=['/usr/bin/swiftc','-parse-as-library','-swift-version',version,'-strict-concurrency='+strict,'-warnings-as-errors','-module-cache-path',str(BUILD/'module-cache'),str(BUILD/'Production.swift'),str(provider),str(HERE/'SwiftHarness.swift'),'-o',str(binary)]
 compiled=subprocess.run(command,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 (HERE/f'swift-{version}-compile.txt').write_text(compiled.stdout)
 if compiled.returncode:print(compiled.stdout);raise SystemExit(compiled.returncode)
 result=subprocess.run([str(binary)],env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,timeout=15)
 (HERE/f'swift-{version}-output.txt').write_text(result.stdout)
 assert not any(secret in result.stdout for secret in ['DUMMY','dummy-A','dummy-B'])
 print('Swift '+version+': '+result.stdout.strip())
 runs.append({'swift_mode':version,'strict_concurrency':strict,'command':command,'exit_code':result.returncode})
 if result.returncode:raise SystemExit(result.returncode)
(HERE/'swift-evidence.json').write_text(json.dumps({'source_sha256':hashlib.sha256(source_path.read_bytes()).hexdigest(),'provider_sha256':hashlib.sha256(provider.read_bytes()).hexdigest(),'runs':runs,'scope':'actual refresh/coordinator/provider source, dummy Keychain/network, binding signature stubs'},indent=2)+'\n')
