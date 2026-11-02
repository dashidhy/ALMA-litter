#!/usr/bin/env python3
"""Execute actual pure boundary helpers with cached serde; no protocol or transport doubles."""
from pathlib import Path
import subprocess,json,hashlib,re
HERE=Path(__file__).resolve().parent;ROOT=HERE.parents[2];BUILD=HERE/'.build';BUILD.mkdir(exist_ok=True)
s=(ROOT/'shared/rust-bridge/codex-mobile-client/src/tah_runner.rs').read_text()
# Function regions are deliberately exact, including the bounded Write implementation.
code='use std::io::Write; use serde::Serialize; use serde_json::Value;\ntype Result<T> = std::result::Result<T, &\'static str>;\n'
code+=s[s.index('fn digest('):s.index('fn context(')]
code+=s[s.index('struct Bounded('):s.index('async fn rpc<')]
code+='''
#[test] fn fingerprint_shape() { assert!(digest(&"a".repeat(64))); assert!(!digest(&"A".repeat(64))); assert!(!digest("raw-account-id")); }
#[test] fn ids_are_bounded() { assert!(identifier("gpt-5.4")); assert!(!identifier("")); assert!(!identifier("email@example.com")); assert!(!identifier(&"a".repeat(257))); }
#[test] fn serialized_bytes_include_quotes() { assert_eq!(bounded(&"123",5).unwrap().1,5); assert!(bounded(&"123",4).is_err()); }
#[test] fn multibyte_bound() { assert!(bounded(&"世界",7).is_err()); assert_eq!(bounded(&"世界",8).unwrap().1,8); }
#[test] fn nested_bound() { assert!(bounded(&serde_json::json!({"notifications":["x".repeat(1024)]}),64).is_err()); }
#[test] fn writer_does_not_cross_limit() { let mut b=Bounded(Vec::new(),4); b.write_all(b"abc").unwrap(); assert!(b.write_all(b"de").is_err()); assert_eq!(b.0,b"abc"); }
'''
p=BUILD/'host.rs';p.write_text(code)
deps=ROOT/'shared/rust-bridge/target/ios-dev/deps'
rustc=ROOT.parent/'ALMA/.build/tauri-toolchain/rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc'
cmd=[str(rustc),'--edition=2024','--test',str(p),'-L','dependency='+str(deps),'-o',str(BUILD/'host-tests')]
artifact=max(deps.glob('libserde_json-*.rlib'),key=lambda p:p.stat().st_mtime_ns)
cmd+=['--extern','serde_json='+str(artifact)]
base=list(cmd)
# Cached host builds have several serde feature hashes; select a compatible
# existing artifact by compilation, never rebuild or substitute the trait.
for serde in sorted(deps.glob('libserde-*.rlib'))[:8]:
 cmd=base+['--extern','serde='+str(serde)]
 r=subprocess.run(cmd,text=True,capture_output=True,timeout=30)
 if not r.returncode: break
output=r.stdout+r.stderr
if not r.returncode:
 r=subprocess.run([str(BUILD/'host-tests')],text=True,capture_output=True,timeout=15);output+=r.stdout+r.stderr
(HERE/'host-output.txt').write_text(output)
(HERE/'host-evidence.json').write_text(json.dumps({'command':cmd,'exit_code':r.returncode,'runner_sha256':hashlib.sha256(s.encode()).hexdigest(),'scope':'six pure boundary helper tests only, no transport or model'},indent=2)+'\n')
print(output);raise SystemExit(r.returncode)
