#!/usr/bin/env python3
"""Generate review-only changes from current sources; never applies to the repo."""
import difflib
import hashlib
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
BEFORE, AFTER = HERE / 'before', HERE / 'after'
CHANGES = {}
BASE = 'shared/rust-bridge/codex-mobile-client/'

def put(rel, text):
    old = (ROOT / rel).read_text() if (ROOT / rel).exists() else ''
    for directory, content in [(BEFORE, old), (AFTER, text)]:
        path = directory / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
    CHANGES[rel] = {'before': hashlib.sha256(old.encode()).hexdigest() if old else None,
                    'after': hashlib.sha256(text.encode()).hexdigest()}

def read(rel):
    return (ROOT / rel).read_text()

def replace(text, old, new, count=1):
    assert text.count(old) == count, (old, text.count(old))
    return text.replace(old, new)

def bounds(text, name, indent=4):
    pattern = r'^' + ' '*indent + r'(?:pub(?:\(crate\))? )?(?:async )?fn '+name+r'\('
    m = re.search(pattern, text, re.M)
    assert m, name
    opening = text.index('{', m.start())
    end = re.search(r'^'+' '*indent+r'}$', text[opening:], re.M)
    assert end, name
    return m.start(), opening, opening + end.end()

def gate_fn(text, name, feature, disabled, indent=4):
    start, opening, end = bounds(text, name, indent)
    signature = text[start:opening+1]
    pad = ' '*indent
    stub = pad+f'#[cfg(not(feature = "{feature}"))]\n'+signature+'\n'+''.join(pad+'    '+line+'\n' for line in disabled.splitlines())+pad+'}'
    return text[:start]+pad+f'#[cfg(feature = "{feature}")]\n'+text[start:end]+'\n\n'+stub+text[end:]

# Cargo keeps the current desktop/Android behavior by default.
p=BASE+'Cargo.toml'; s=read(p)
s=replace(s, 'iroh = "1.0.3"', 'iroh = { version = "1.0.3", optional = true }')
s=replace(s, '[features]\nrpc-trace = []', '[features]\ndefault = ["remote-alleycat", "remote-pairing"]\nremote-alleycat = ["dep:iroh"]\nremote-pairing = []\nrpc-trace = []')
put(p,s)

# Share pure protocol/domain types; only the real transport depends on Iroh.
p=BASE+'src/alleycat.rs'; s=read(p)
start=s.index('pub const ALLEYCAT_PROTOCOL_VERSION:')
end=s.index('/// Reconnect strategy for an alleycat-backed session.')
types=s[start:end].replace('pub(crate) const MAX_FRAME_BYTES: usize = 1024 * 1024;\n','')
es=s.index('#[derive(Debug, thiserror::Error)]\npub enum AlleycatError')
ee=s.index('\n#[derive(Debug, Deserialize)]\nstruct PairPayloadWire',es)
errors=s[es:ee]
s=s[:es]+s[ee:]
s=s[:start]+'pub use crate::alleycat_types::*;\npub(crate) const MAX_FRAME_BYTES: usize = 1024 * 1024;\n\n'+s[end:]
s=s.replace('use crate::types::AgentRuntimeKind;\n','')
put(p,s)
put(BASE+'src/alleycat_types.rs', '//! Transport-independent records and runtime-name normalization.\nuse crate::types::AgentRuntimeKind;\n\n'+types+errors+'\n')
put(BASE+'src/alleycat_disabled.rs', '''//! Capability boundary for builds without the remote transport.
pub use crate::alleycat_types::*;

pub fn parse_pair_payload(_json: &str) -> Result<ParsedPairPayload, AlleycatError> {
    Err(AlleycatError::Transport(crate::network_scope::ALLEYCAT_UNSUPPORTED.into()))
}
''')
put(BASE+'src/network_scope.rs', '''//! Build capabilities; independent of network reachability or account state.
pub const ALLEYCAT_UNSUPPORTED: &str =
    "unsupported: remote Alleycat/Iroh is not included in this local build";
pub const PAIRING_UNSUPPORTED: &str =
    "unsupported: remote pairing is not included in this local build";

pub const fn remote_alleycat_available() -> bool {
    cfg!(feature = "remote-alleycat")
}
pub const fn pairing_available() -> bool {
    cfg!(feature = "remote-pairing")
}
''')
p=BASE+'src/lib.rs'; s=read(p)
s=replace(s,'pub mod alleycat;', '''mod alleycat_types;
pub mod network_scope;
#[cfg(feature = "remote-alleycat")]
pub mod alleycat;
#[cfg(not(feature = "remote-alleycat"))]
#[path = "alleycat_disabled.rs"]
pub mod alleycat;''')
put(p,s)

p=BASE+'src/mobile_client/mod.rs'; s=read(p)
s=replace(s,'AgentInfo as AlleycatAgentInfo, AgentWire as AlleycatAgentWire, AlleycatReconnectTransport,','AgentInfo as AlleycatAgentInfo, AgentWire as AlleycatAgentWire,')
s=replace(s,'use crate::session::connection::InProcessConfig;', '#[cfg(feature = "remote-alleycat")]\nuse crate::alleycat::AlleycatReconnectTransport;\nuse crate::session::connection::InProcessConfig;')
s=replace(s,'    alleycat_endpoint: Arc<tokio::sync::OnceCell<iroh::Endpoint>>,','    #[cfg(feature = "remote-alleycat")]\n    alleycat_endpoint: Arc<tokio::sync::OnceCell<iroh::Endpoint>>,')
s=replace(s,'            alleycat_endpoint: Arc::new(tokio::sync::OnceCell::new()),','            #[cfg(feature = "remote-alleycat")]\n            alleycat_endpoint: Arc::new(tokio::sync::OnceCell::new()),')
s=gate_fn(s,'alleycat_secret_key','remote-alleycat','None')
start,_,_=bounds(s,'alleycat_endpoint'); s=s[:start]+'    #[cfg(feature = "remote-alleycat")]\n'+s[start:]
s=replace(s,'            crate::alleycat::set_direct_addr_cache_directory(&directory);','            #[cfg(feature = "remote-alleycat")]\n            crate::alleycat::set_direct_addr_cache_directory(&directory);')
s=gate_fn(s,'list_alleycat_agents','remote-alleycat','let _ = (params, wait_for_registration);\nErr(TransportError::ConnectionFailed(crate::network_scope::ALLEYCAT_UNSUPPORTED.into()))')
s=gate_fn(s,'connect_remote_over_alleycat','remote-alleycat','let _ = (server_id, display_name, params, agent_name, selected_agent_names, wire);\n// Fail before inserting a server, persisting credentials, or publishing health.\nErr(TransportError::ConnectionFailed(crate::network_scope::ALLEYCAT_UNSUPPORTED.into()))')
s=gate_fn(s,'shutdown_alleycat_endpoint','remote-alleycat','// No endpoint can exist in this build; cleanup has no resource to close.')
s=replace(s,'        if let Some(target) = alleycat_restart_target {','        #[cfg(feature = "remote-alleycat")]\n        if let Some(target) = alleycat_restart_target {')
s=replace(s,'        let alleycat_restart_target = match self.alleycat_restart_targets.lock() {','        #[cfg(feature = "remote-alleycat")]\n        let alleycat_restart_target = match self.alleycat_restart_targets.lock() {')
# Reject stale remote records rather than attempting a different transport or changing health.
needle='    pub async fn restart_app_server(&self, server_id: &str) -> Result<(), TransportError> {\n'
s=replace(s,needle,needle+'''        #[cfg(not(feature = "remote-alleycat"))]
        if server_id.starts_with("alleycat:") {
            return Err(TransportError::ConnectionFailed(crate::network_scope::ALLEYCAT_UNSUPPORTED.into()));
        }
''')
put(p,s)

p=BASE+'src/ffi/client.rs'; s=read(p)
start,opening,end=bounds(s,'ensure_alleycat_endpoint')
body='\n'.join('    '+line if line else '' for line in s[opening+1:end-1].strip('\n').rstrip().splitlines())
s=s[:opening+1]+'''\n        #[cfg(feature = "remote-alleycat")]
        {
'''+body+'''
        }
        #[cfg(not(feature = "remote-alleycat"))]
        {
            tracing::warn!("{}", crate::network_scope::ALLEYCAT_UNSUPPORTED);
            None
        }
    }'''+s[end:]
start,_,_=bounds(s,'ensure_alleycat_endpoint')
start=s.rindex('    /// Force the shared alleycat',0,start)
s=s[:start]+'''    /// Compile-time capability, independent of temporary network failures.
    pub fn remote_alleycat_available(&self) -> bool {
        crate::network_scope::remote_alleycat_available()
    }

    pub fn pairing_available(&self) -> bool {
        crate::network_scope::pairing_available()
    }

'''+s[start:]
put(p,s)

p=BASE+'src/terminal/mod.rs'; s=read(p)
s=replace(s,'mod remote_alleycat;', '#[cfg(feature = "remote-alleycat")]\nmod remote_alleycat;')
put(p,s)
p=BASE+'src/terminal/backend.rs'; s=read(p)
needle='        TerminalBackendKind::RemoteAlleycat {\n'
s=replace(s,needle,'''        #[cfg(not(feature = "remote-alleycat"))]
        TerminalBackendKind::RemoteAlleycat { .. } => Err(TerminalError::Unsupported {
            detail: crate::network_scope::ALLEYCAT_UNSUPPORTED.into(),
        }),
        #[cfg(feature = "remote-alleycat")]
'''+needle)
put(p,s)

p=BASE+'src/pair/mod.rs'; s=read(p)
s=gate_fn(s,'start_pair_host','remote-pairing','let _ = (device_name, mac_id, codex_port);\nErr(PairError::Transport(crate::network_scope::PAIRING_UNSUPPORTED.into()))',0)
s=gate_fn(s,'pair_from_iphone','remote-pairing','let _ = (host, port, device_name, ni_discovery_token_b64);\nErr(PairError::Transport(crate::network_scope::PAIRING_UNSUPPORTED.into()))',0)
put(p,s)

p=BASE+'src/android_context.rs'; s=read(p)
start=s.index('        let _resolver = iroh::dns::DnsResolver::new();')
end=s.index('        Ok::<String, String>("ok".to_string())',start)
s=s[:start]+'''        #[cfg(feature = "remote-alleycat")]
        {
'''+''.join('    '+line if line.strip() else line for line in s[start:end].splitlines(True))+'''        }
        #[cfg(not(feature = "remote-alleycat"))]
        return Err::<String, String>(crate::network_scope::ALLEYCAT_UNSUPPORTED.into());

'''+s[end:]
put(p,s)

p=BASE+'src/reconnect.rs'; s=read(p)
needle='    // 2. Stable Alleycat pairing wins before legacy tunnel/direct transports.\n'
s=replace(s,needle,'    // Disabled remote records must not fall through to another transport.\n    if !crate::network_scope::remote_alleycat_available()\n        && server.alleycat_node_id.is_some()\n    {\n        return None;\n    }\n\n'+needle)
put(p,s)

# Feature profile must match in device/simulator archives and host UniFFI metadata.
p='apps/ios/scripts/build-rust.sh'; s=read(p)
s=replace(s,'CARGO_FEATURES=""','CARGO_FEATURES=()\nALMA_LOCAL="${LITTER_ALMA_LOCAL:-0}"')
s=replace(s,'      CARGO_FEATURES="--features rpc-trace"','      CARGO_FEATURES+=(--features rpc-trace)')
s=replace(s,'    --rpc-trace)\n','    --alma-local)\n      ALMA_LOCAL=1\n      ;;\n    --rpc-trace)\n')
s=s.replace('[--rpc-trace]"','[--rpc-trace] [--alma-local]"')
s=replace(s,'done\n\nPATCHES_WERE_APPLIED=()', '''done

export LITTER_ALMA_LOCAL="$ALMA_LOCAL"
if [ "$ALMA_LOCAL" = "1" ]; then
  CARGO_FEATURES+=(--no-default-features)
  export LITTER_SKIP_ALLEYCAT_UPDATE=1
fi

PATCHES_WERE_APPLIED=()''')
s=s.replace('$CARGO_FEATURES','${CARGO_FEATURES[@]+"${CARGO_FEATURES[@]}"}')
put(p,s)
p='shared/rust-bridge/generate-bindings.sh'; s=read(p)
s=replace(s,'"$WORKSPACE_DIR/../../tools/scripts/update-alleycat-main.sh" --shared\n','')
s=replace(s,'PROFILE="debug"','PROFILE="debug"\nCARGO_FEATURES=()\nALMA_LOCAL="${LITTER_ALMA_LOCAL:-0}"')
s=replace(s,'        --release)\n','        --alma-local)\n            ALMA_LOCAL=1\n            ;;\n        --release)\n')
s=s.replace('[--kotlin-only]"','[--kotlin-only] [--alma-local]"')
s=replace(s,'done\n\nif [[', '''done

export LITTER_ALMA_LOCAL="$ALMA_LOCAL"
if [[ "$ALMA_LOCAL" == "1" ]]; then
    CARGO_FEATURES+=(--no-default-features)
    export LITTER_SKIP_ALLEYCAT_UPDATE=1
fi
"$WORKSPACE_DIR/../../tools/scripts/update-alleycat-main.sh" --shared

if [[''')
s=s.replace('cargo build -p codex-mobile-client --release','cargo build -p codex-mobile-client --release "${CARGO_FEATURES[@]}"').replace('cargo build -p codex-mobile-client\n','cargo build -p codex-mobile-client "${CARGO_FEATURES[@]}"\n')
s=s.replace('"${CARGO_FEATURES[@]}"','${CARGO_FEATURES[@]+"${CARGO_FEATURES[@]}"}')
put(p,s)
p='tools/scripts/uniffi-bindings-input-hash.sh'; s=read(p)
s=replace(s, "bindings_inputs | while IFS= read -r file; do", "{\nprintf 'LITTER_ALMA_LOCAL=%s\\n' \"${LITTER_ALMA_LOCAL:-0}\"\nbindings_inputs | while IFS= read -r file; do")
s=replace(s,"done | shasum -a 256 | awk '{print $1}'", "done\n} | shasum -a 256 | awk '{print $1}'")
put(p,s)

patch=[]
for rel in sorted(CHANGES):
    before=(BEFORE/rel).read_text(); after=(AFTER/rel).read_text()
    patch += difflib.unified_diff(before.splitlines(True),after.splitlines(True),fromfile='a/'+rel if before else '/dev/null',tofile='b/'+rel)
(HERE/'proposal.patch').write_text(''.join(patch))
(HERE/'source-hashes.json').write_text(json.dumps(CHANGES,indent=2)+'\n')
print(f'Prepared {len(CHANGES)} review-only files. Shared sources were not changed.')
