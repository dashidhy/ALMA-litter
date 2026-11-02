//! Build capabilities; independent of network reachability or account state.
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
