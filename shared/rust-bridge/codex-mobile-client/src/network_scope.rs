//! Build capabilities; independent of network reachability or account state.
pub const fn alma_local() -> bool {
    !cfg!(any(feature = "remote-cli", feature = "remote-alleycat", feature = "remote-pairing"))
}
pub const ALLEYCAT_UNSUPPORTED: &str =
    "unsupported: remote Alleycat/Iroh is not included in this local build";
pub const PAIRING_UNSUPPORTED: &str =
    "unsupported: remote pairing is not included in this local build";
pub const REMOTE_CLI_UNSUPPORTED: &str =
    "unsupported: remote CLI transport is not included in this ALMA local build";

pub const fn remote_cli_available() -> bool {
    cfg!(feature = "remote-cli")
}

pub const fn remote_alleycat_available() -> bool {
    cfg!(feature = "remote-alleycat")
}
pub const fn pairing_available() -> bool {
    cfg!(feature = "remote-pairing")
}
