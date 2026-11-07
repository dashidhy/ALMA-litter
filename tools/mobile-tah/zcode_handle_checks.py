"""Exercise the production handle-registry methods against an opaque auth fixture."""
from pathlib import Path
import hashlib
import json
import os
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
source = (ROOT / 'shared/rust-bridge/codex-mobile-client/src/mobile_zcode.rs').read_text()

def method(start, end):
    return source[source.index(start):source.index(end, source.index(start))]

clear = method('    pub(crate) fn clear_handles(', '    async fn owner(')
handles = method('    fn authorization(', '    pub(crate) async fn call(')
# Binding creation stays at restore, and prepare consumes that stored binding.
prepare = source[source.index('"provider.zcode.prepare" =>'):source.index('    async fn scope_call')]
assert 'let authorization = self.authorization(value)?;' in prepare
assert 'owner.authorization()' not in prepare
assert re.search(r'prepared\s*\.dispose_before_start\(\)', prepare)
assert source.count('self.clear_handles()?;') >= 3
fixture = r'''
use std::{collections::HashMap, sync::{Arc,Mutex}};
#[derive(Debug)]enum MobileTahError { Cleanup, Invalid, Unavailable }
type Result<T> = std::result::Result<T,MobileTahError>;
fn invalid()->MobileTahError{MobileTahError::Invalid}
fn unavailable<T>(_:T)->MobileTahError{MobileTahError::Unavailable}
type Value=HashMap<String,String>;
fn text<'a>(value:&'a Value,key:&str)->Result<&'a str>{value.get(key).map(|v|v.as_str()).ok_or_else(invalid)}
struct BoundAuthorization{generation:u64}
struct ZCodeHost{handle:Mutex<Option<(String,Arc<BoundAuthorization>)>>,entries:Mutex<HashMap<String,()>>}
impl ZCodeHost {
''' + clear + handles + r'''
}
#[test]fn bound_generation_never_rebinds_and_revocation_rejects_old_handle(){
 let old=Arc::new(BoundAuthorization{generation:1});
 let host=ZCodeHost{handle:Mutex::new(Some(("old".into(),old.clone()))),entries:Mutex::new(HashMap::new())};
 let request=HashMap::from([("credentialHandle".into(),"old".into())]);
 assert!(Arc::ptr_eq(&host.authorization(&request).unwrap(),&old));
 host.entries.lock().unwrap().insert("active".into(),());
 assert!(matches!(host.clear_handles(),Err(MobileTahError::Cleanup)));
 assert!(host.validate_handle(&request).is_ok());
 host.entries.lock().unwrap().clear();
 host.clear_handles().unwrap();
 assert!(host.validate_handle(&request).is_err());
 let new=Arc::new(BoundAuthorization{generation:2});
 *host.handle.lock().unwrap()=Some(("new".into(),new.clone()));
 assert!(host.authorization(&request).is_err());
 let request=HashMap::from([("credentialHandle".into(),"new".into())]);
 assert!(Arc::ptr_eq(&host.authorization(&request).unwrap(),&new));
 assert_eq!(old.generation,1);
 assert_eq!(new.generation,2);
}
'''
with tempfile.TemporaryDirectory(prefix='zcode-handles-') as temporary:
    file = Path(temporary) / 'handles.rs'
    file.write_text(fixture)
    rustc = Path(os.environ.get('ALMA_RUST_TOOLCHAIN_ROOT', ROOT.parent / 'ALMA/.build/tauri-toolchain')) / 'rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc'
    subprocess.run([str(rustc), '--edition', '2024', '--test', str(file), '-o', str(file.with_suffix(''))], check=True, timeout=30)
    subprocess.run([str(file.with_suffix(''))], check=True, timeout=10)
print(json.dumps({'passed': True, 'hostSourceSHA256': hashlib.sha256(source.encode()).hexdigest(),
                  'scope': 'production registry methods with opaque BoundAuthorization substitute; native owner generation rejection is separately tested'}))
