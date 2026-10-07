use std::net::{Ipv4Addr, Ipv6Addr};

use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedTcpTable, MIB_TCP6ROW_OWNER_PID, MIB_TCPROW_OWNER_PID, TCP_TABLE_OWNER_PID_ALL,
};
use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};

use super::table::{query_rows, TableRow};
use super::types::{ConnectionState, EndpointIdentity, IpVersion, PortEntry, Protocol};
use crate::error::AppResult;
use crate::process::resolver::{ProcessInfo, ProcessResolver};

unsafe impl TableRow for MIB_TCPROW_OWNER_PID {}
unsafe impl TableRow for MIB_TCP6ROW_OWNER_PID {}

pub fn scan_tcp_v4(resolver: &ProcessResolver) -> AppResult<Vec<PortEntry>> {
    let rows = query_tcp_v4_rows()?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let process = resolver.resolve(row.dwOwningPid);
            make_entry(tcp_v4_identity(&row), row.dwState, process)
        })
        .collect())
}

fn query_tcp_v4_rows() -> AppResult<Vec<MIB_TCPROW_OWNER_PID>> {
    query_rows("IPv4 TCP 扫描", |buffer, size| unsafe {
        GetExtendedTcpTable(
            Some(buffer),
            size,
            false,
            AF_INET.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    })
}

pub fn scan_tcp_v6(resolver: &ProcessResolver) -> AppResult<Vec<PortEntry>> {
    let rows = query_tcp_v6_rows()?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let process = resolver.resolve(row.dwOwningPid);
            make_entry(tcp_v6_identity(&row), row.dwState, process)
        })
        .collect())
}

fn query_tcp_v6_rows() -> AppResult<Vec<MIB_TCP6ROW_OWNER_PID>> {
    query_rows("IPv6 TCP 扫描", |buffer, size| unsafe {
        GetExtendedTcpTable(
            Some(buffer),
            size,
            false,
            AF_INET6.0 as u32,
            TCP_TABLE_OWNER_PID_ALL,
            0,
        )
    })
}

fn make_entry(identity: EndpointIdentity, raw_state: u32, process: ProcessInfo) -> PortEntry {
    PortEntry {
        protocol: identity.protocol,
        ip_version: identity.ip_version,
        local_address: identity.local_address,
        local_port: identity.local_port,
        remote_address: identity.remote_address,
        remote_port: identity.remote_port,
        state: Some(ConnectionState::from_mib_state(raw_state)),
        pid: identity.pid,
        process_name: process.name,
        process_path: process.path,
        process_created_at: process.created_at,
        process_status: process.status,
        process_status_message: process.status_message,
        attributions: Vec::new(),
    }
}

pub(crate) fn scan_tcp_v4_identities() -> AppResult<Vec<EndpointIdentity>> {
    query_tcp_v4_rows().map(|rows| rows.iter().map(tcp_v4_identity).collect())
}

pub(crate) fn scan_tcp_v6_identities() -> AppResult<Vec<EndpointIdentity>> {
    query_tcp_v6_rows().map(|rows| rows.iter().map(tcp_v6_identity).collect())
}

fn tcp_v4_identity(row: &MIB_TCPROW_OWNER_PID) -> EndpointIdentity {
    let listening = ConnectionState::from_mib_state(row.dwState) == ConnectionState::Listen;
    EndpointIdentity {
        protocol: Protocol::Tcp,
        ip_version: IpVersion::V4,
        local_address: ipv4_to_string(row.dwLocalAddr),
        local_port: network_port(row.dwLocalPort),
        remote_address: (!listening).then(|| ipv4_to_string(row.dwRemoteAddr)),
        remote_port: (!listening).then(|| network_port(row.dwRemotePort)),
        pid: row.dwOwningPid,
    }
}

fn tcp_v6_identity(row: &MIB_TCP6ROW_OWNER_PID) -> EndpointIdentity {
    let listening = ConnectionState::from_mib_state(row.dwState) == ConnectionState::Listen;
    EndpointIdentity {
        protocol: Protocol::Tcp,
        ip_version: IpVersion::V6,
        local_address: ipv6_to_string(row.ucLocalAddr, row.dwLocalScopeId),
        local_port: network_port(row.dwLocalPort),
        remote_address: (!listening).then(|| ipv6_to_string(row.ucRemoteAddr, row.dwRemoteScopeId)),
        remote_port: (!listening).then(|| network_port(row.dwRemotePort)),
        pid: row.dwOwningPid,
    }
}

fn ipv4_to_string(network_order: u32) -> String {
    Ipv4Addr::from(u32::from_be(network_order)).to_string()
}

fn ipv6_to_string(bytes: [u8; 16], scope_id: u32) -> String {
    let address = Ipv6Addr::from(bytes);
    if scope_id == 0 {
        address.to_string()
    } else {
        format!("{address}%{scope_id}")
    }
}

fn network_port(value: u32) -> u16 {
    u16::from_be(value as u16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_ipv4_network_order() {
        assert_eq!(ipv4_to_string(0x0100_007f), "127.0.0.1");
        assert_eq!(network_port(0xb80b), 3000);
    }

    #[test]
    fn formats_ipv6_with_optional_scope() {
        assert_eq!(ipv6_to_string(Ipv6Addr::LOCALHOST.octets(), 0), "::1");
        assert_eq!(
            ipv6_to_string("fe80::1".parse::<Ipv6Addr>().unwrap().octets(), 12),
            "fe80::1%12"
        );
    }
}
