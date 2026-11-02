use rustix::fd::OwnedFd;
use rustix::net::{ipproto, socket, AddressFamily, SocketType};

// Compile real net APIs, including an Apple constant that must stay available.
pub const SYSTEM: AddressFamily = AddressFamily::SYSTEM;

pub fn tcp_socket() -> rustix::io::Result<OwnedFd> {
    socket(AddressFamily::INET, SocketType::STREAM, Some(ipproto::TCP))
}

// These assertions compile on the host, proving macOS keeps the real libc values.
#[cfg(target_os = "macos")]
const _: () = {
    assert!(AddressFamily::SYS_CONTROL.as_raw() as i32 == libc::AF_SYS_CONTROL);
    assert!(rustix::net::sysproto::EVENT.as_raw().get() as i32 == libc::SYSPROTO_EVENT);
    assert!(rustix::net::sysproto::CONTROL.as_raw().get() as i32 == libc::SYSPROTO_CONTROL);
};
