//! Explicit unavailable transport for the local-only qualification build.
//! No wire, RPC worker, or successful connection is manufactured here.

use codex_app_server_client::{RemoteAppServerClient, RemoteAppServerConnectArgs};
use tokio::io::{AsyncRead, AsyncWrite};

pub async fn connect_json_line_stream<S>(
    _stream: S,
    _args: RemoteAppServerConnectArgs,
    _label: String,
) -> std::io::Result<RemoteAppServerClient>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported,
        "remote CLI transport is not included in this ALMA local build"))
}
