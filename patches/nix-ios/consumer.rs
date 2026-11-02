use nix::sys::socket::{
    bind, getsockname, getsockopt, setsockopt, socket, socketpair, sockopt,
    AddressFamily, SockFlag, SockProtocol, SockType, SockaddrIn, UnixAddr,
};
use std::os::fd::AsRawFd;

// Local sockets only: compile for iOS, execute on macOS. No external connection.
pub fn normal_sockets() -> nix::Result<()> {
    let tcp = socket(AddressFamily::Inet, SockType::Stream, SockFlag::empty(), SockProtocol::Tcp)?;
    setsockopt(&tcp, sockopt::TcpNoDelay, &true)?;
    assert!(getsockopt(&tcp, sockopt::TcpNoDelay)?);
    bind(tcp.as_raw_fd(), &SockaddrIn::new(127, 0, 0, 1, 0))?;
    let address: SockaddrIn = getsockname(tcp.as_raw_fd())?;
    assert_ne!(address.port(), 0);
    let (left, right) = socketpair(AddressFamily::Unix, SockType::Stream, None, SockFlag::empty())?;
    assert_eq!(getsockopt(&left, sockopt::SockType)?, SockType::Stream);
    assert_eq!(getsockopt(&right, sockopt::SockType)?, SockType::Stream);
    let _: UnixAddr = getsockname(left.as_raw_fd())?;
    assert_eq!(AddressFamily::System as i32, libc::AF_SYSTEM);
    Ok(())
}

#[cfg(target_os = "macos")]
const _: () = assert!(SockProtocol::KextControl as i32 == libc::SYSPROTO_CONTROL);

// Check type/trait availability only; do not open a kernel-control/utun socket.
#[cfg(all(target_os = "macos", feature = "has-utun"))]
pub fn macos_utun_option(fd: &std::os::fd::OwnedFd) -> nix::Result<std::ffi::CString> {
    getsockopt(fd, sockopt::UtunIfname)
}

#[cfg(all(target_os = "macos", feature = "with-ioctl"))]
pub fn macos_control_address() {
    use nix::sys::socket::{SockaddrLike, SockaddrStorage, SysControlAddr};
    let address = SysControlAddr::new(1, 0);
    let raw: &libc::sockaddr_ctl = address.as_ref();
    assert_eq!(raw.ss_sysaddr, libc::AF_SYS_CONTROL as u16);
    // The pointer/length describe the live, initialized SysControlAddr above.
    let stored = unsafe { SockaddrStorage::from_raw(address.as_ptr(), Some(address.len())) }.unwrap();
    assert!(stored.as_sys_control_addr().is_some());
}

#[test]
fn tcp_and_unix_are_preserved() {
    normal_sockets().unwrap();
    #[cfg(all(target_os = "macos", feature = "with-ioctl"))]
    macos_control_address();
}
