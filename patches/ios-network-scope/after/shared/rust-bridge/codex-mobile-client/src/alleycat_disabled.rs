//! Capability boundary for builds without the remote transport.
pub use crate::alleycat_types::*;

pub fn parse_pair_payload(_json: &str) -> Result<ParsedPairPayload, AlleycatError> {
    Err(AlleycatError::Transport(crate::network_scope::ALLEYCAT_UNSUPPORTED.into()))
}
