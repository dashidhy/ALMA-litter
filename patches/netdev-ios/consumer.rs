use netdev::Interface;
use std::net::IpAddr;

// Match netwatch's parallel-vector contract without compiling Iroh or Codex.
pub fn addresses(iface: &Interface) -> Vec<IpAddr> {
    assert_eq!(iface.ipv6.len(), iface.ipv6_scope_ids.len());
    assert_eq!(iface.ipv6.len(), iface.ipv6_addr_flags.len());
    iface.ipv4.iter().map(|net| IpAddr::V4(net.addr())).chain(
        iface.ipv6.iter().zip(&iface.ipv6_scope_ids).zip(&iface.ipv6_addr_flags)
            .map(|((net, _scope), _flags)| IpAddr::V6(net.addr())),
    ).collect()
}

pub fn enumerate() -> Vec<Interface> {
    let interfaces = netdev::get_interfaces();
    for iface in &interfaces {
        assert_eq!(addresses(iface).len(), iface.ipv4.len() + iface.ipv6.len());
    }
    interfaces
}

#[cfg(feature = "patched")]
pub fn flags(ifname: &str, addr: &std::net::Ipv6Addr)
    -> std::io::Result<netdev::interface::ipv6_addr_flags::Ipv6AddrFlags>
{
    netdev::interface::ipv6_addr_flags::query_ipv6_addr_flags(ifname, addr)
}

#[test]
fn ordinary_address_enumeration_and_alignment() {
    let interfaces = enumerate();
    assert!(!interfaces.is_empty());
    let all: Vec<_> = interfaces.iter().flat_map(addresses).collect();
    assert!(all.contains(&IpAddr::V4(std::net::Ipv4Addr::LOCALHOST)));
    assert!(all.contains(&IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)));
    println!("Enumerated {} interfaces and {} IPv4/IPv6 addresses", interfaces.len(), all.len());
}

#[cfg(all(feature = "patched", target_os = "macos"))]
#[test]
fn macos_retains_real_query_and_errors() {
    let lo = flags("lo0", &std::net::Ipv6Addr::LOCALHOST).expect("macOS loopback flag query");
    assert!(!lo.duplicated);
    assert!(!lo.tentative);
    let error = flags("alma_noif0", &std::net::Ipv6Addr::LOCALHOST).unwrap_err();
    assert!(error.raw_os_error().is_some(), "preserve the actual ioctl failure");
}

#[cfg(all(feature = "patched", target_os = "ios"))]
#[test]
fn ios_flags_are_explicitly_unsupported_without_dropping_addresses() {
    assert_eq!(flags("lo0", &std::net::Ipv6Addr::LOCALHOST).unwrap_err().kind(),
               std::io::ErrorKind::Unsupported);
    for iface in enumerate() {
        assert!(iface.ipv6_addr_flags.iter().all(|f| *f == Default::default()));
    }
}
