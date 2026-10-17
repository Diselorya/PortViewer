use super::{clean, timestamp, HostContext};
use std::net::{IpAddr, SocketAddr};
fn canonical(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(value) => value.to_ipv4_mapped().map(IpAddr::V4).unwrap_or(ip),
        _ => ip,
    }
}
pub fn classify(ip: IpAddr) -> &'static str {
    let ip = canonical(ip);
    if ip.is_unspecified() {
        return "wildcard";
    }
    if ip.is_loopback() {
        return "loopback";
    }
    if ip.is_multicast() {
        return "multicast";
    }
    match ip {
        IpAddr::V4(v) if v.is_link_local() => "link_local",
        IpAddr::V4(v) if v.is_private() => "private",
        IpAddr::V6(v) if (v.segments()[0] & 0xffc0) == 0xfe80 => "link_local",
        IpAddr::V6(v) if (v.segments()[0] & 0xfe00) == 0xfc00 => "private",
        _ => "public",
    }
}
pub fn initial(address: Option<IpAddr>, observed: &[String]) -> HostContext {
    let is_local = address.is_none()
        || address.is_some_and(|ip| {
            canonical(ip).is_loopback()
                || observed
                    .iter()
                    .filter_map(|address| address.parse::<IpAddr>().ok())
                    .any(|observed| canonical(observed) == canonical(ip))
        });
    let machine_name = is_local.then(machine_name).flatten();
    HostContext {
        address: address
            .map(|ip| ip.to_string())
            .unwrap_or_else(|| "local".to_owned()),
        kind: address.map(classify).unwrap_or("local").to_owned(),
        is_local,
        hostname: machine_name.clone(),
        machine_name,
        hostname_source: is_local.then(|| "system".to_owned()),
        dns_status: if is_local { "ready" } else { "not_applicable" }.to_owned(),
        os: is_local.then(|| std::env::consts::OS.to_owned()),
        observed_addresses: if is_local {
            observed.to_vec()
        } else {
            Vec::new()
        },
        resolved_at: is_local.then(timestamp),
    }
}
#[cfg(windows)]
fn machine_name() -> Option<String> {
    #[link(name = "Kernel32")]
    extern "system" {
        fn GetComputerNameW(buffer: *mut u16, size: *mut u32) -> i32;
    }
    let mut value = [0u16; 256];
    let mut length = value.len() as u32;
    let ok = unsafe { GetComputerNameW(value.as_mut_ptr(), &mut length) };
    (ok != 0)
        .then(|| clean(&String::from_utf16_lossy(&value[..length as usize]), 253))
        .filter(|v| !v.is_empty())
}
#[cfg(not(windows))]
fn machine_name() -> Option<String> {
    let mut value = [0u8; 256];
    if unsafe { libc::gethostname(value.as_mut_ptr().cast(), value.len()) } != 0 {
        return None;
    }
    let end = value.iter().position(|c| *c == 0).unwrap_or(value.len());
    let result = clean(&String::from_utf8_lossy(&value[..end]), 253);
    (!result.is_empty()).then_some(result)
}
pub fn reverse(ip: IpAddr) -> Option<String> {
    let address = socket2::SockAddr::from(SocketAddr::new(ip, 0));
    #[cfg(windows)]
    {
        use std::ffi::c_void;
        #[link(name = "Ws2_32")]
        extern "system" {
            fn WSAStartup(version: u16, data: *mut c_void) -> i32;
            fn WSACleanup() -> i32;
            fn GetNameInfoW(
                address: *const c_void,
                length: i32,
                node: *mut u16,
                node_length: u32,
                service: *mut u16,
                service_length: u32,
                flags: i32,
            ) -> i32;
        }
        let mut data = [0usize; 64];
        if unsafe { WSAStartup(0x0202, data.as_mut_ptr().cast()) } != 0 {
            return None;
        }
        let mut result = [0u16; 1025];
        let code = unsafe {
            GetNameInfoW(
                address.as_ptr().cast(),
                address.len(),
                result.as_mut_ptr(),
                result.len() as u32,
                std::ptr::null_mut(),
                0,
                4,
            )
        };
        unsafe {
            WSACleanup();
        }
        if code != 0 {
            return None;
        }
        let end = result.iter().position(|v| *v == 0).unwrap_or(result.len());
        valid_hostname(&String::from_utf16_lossy(&result[..end]))
    }
    #[cfg(not(windows))]
    {
        let mut result = [0u8; 1025];
        let code = unsafe {
            libc::getnameinfo(
                address.as_ptr().cast(),
                address.len(),
                result.as_mut_ptr().cast(),
                result.len() as u32,
                std::ptr::null_mut(),
                0,
                libc::NI_NAMEREQD,
            )
        };
        if code != 0 {
            return None;
        }
        let end = result.iter().position(|v| *v == 0).unwrap_or(result.len());
        valid_hostname(&String::from_utf8_lossy(&result[..end]))
    }
}
fn valid_hostname(value: &str) -> Option<String> {
    let value = value.trim_end_matches('.');
    (value.len() <= 253
        && !value.is_empty()
        && value.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
        }))
    .then(|| value.to_owned())
}
