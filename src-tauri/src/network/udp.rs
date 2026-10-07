use std::net::{Ipv4Addr, Ipv6Addr};

use windows::Win32::NetworkManagement::IpHelper::{
    GetExtendedUdpTable, MIB_UDP6ROW_OWNER_PID, MIB_UDPROW_OWNER_PID, UDP_TABLE_OWNER_PID,
};
use windows::Win32::Networking::WinSock::{AF_INET, AF_INET6};

use super::table::{query_rows, TableRow};
use super::types::{EndpointIdentity, IpVersion, PortEntry, Protocol};
use crate::error::AppResult;
use crate::process::resolver::{ProcessInfo, ProcessResolver};

unsafe impl TableRow for MIB_UDPROW_OWNER_PID {}
unsafe impl TableRow for MIB_UDP6ROW_OWNER_PID {}

pub fn scan_udp_v4(resolver: &ProcessResolver) -> AppResult<Vec<PortEntry>> {
    let rows = query_udp_v4_rows()?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let process = resolver.resolve(row.dwOwningPid);
            make_entry(udp_v4_identity(&row), process)
        })
        .collect())
}

fn query_udp_v4_rows() -> AppResult<Vec<MIB_UDPROW_OWNER_PID>> {
    query_rows("IPv4 UDP 扫描", |buffer, size| unsafe {
        GetExtendedUdpTable(
            Some(buffer),
            size,
            false,
            AF_INET.0 as u32,
            UDP_TABLE_OWNER_PID,
            0,
        )
    })
}

pub fn scan_udp_v6(resolver: &ProcessResolver) -> AppResult<Vec<PortEntry>> {
    let rows = query_udp_v6_rows()?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let process = resolver.resolve(row.dwOwningPid);
            make_entry(udp_v6_identity(&row), process)
        })
        .collect())
}

fn query_udp_v6_rows() -> AppResult<Vec<MIB_UDP6ROW_OWNER_PID>> {
    query_rows("IPv6 UDP 扫描", |buffer, size| unsafe {
        GetExtendedUdpTable(
            Some(buffer),
            size,
            false,
            AF_INET6.0 as u32,
            UDP_TABLE_OWNER_PID,
            0,
        )
    })
}

fn make_entry(identity: EndpointIdentity, process: ProcessInfo) -> PortEntry {
    PortEntry {
        protocol: identity.protocol,
        ip_version: identity.ip_version,
        local_address: identity.local_address,
        local_port: identity.local_port,
        remote_address: identity.remote_address,
        remote_port: identity.remote_port,
        state: None,
        pid: identity.pid,
        process_name: process.name,
        process_path: process.path,
        process_created_at: process.created_at,
        process_status: process.status,
        process_status_message: process.status_message,
        attributions: Vec::new(),
    }
}

pub(crate) fn scan_udp_v4_identities() -> AppResult<Vec<EndpointIdentity>> {
    query_udp_v4_rows().map(|rows| rows.iter().map(udp_v4_identity).collect())
}

pub(crate) fn scan_udp_v6_identities() -> AppResult<Vec<EndpointIdentity>> {
    query_udp_v6_rows().map(|rows| rows.iter().map(udp_v6_identity).collect())
}

fn udp_v4_identity(row: &MIB_UDPROW_OWNER_PID) -> EndpointIdentity {
    EndpointIdentity {
        protocol: Protocol::Udp,
        ip_version: IpVersion::V4,
        local_address: Ipv4Addr::from(u32::from_be(row.dwLocalAddr)).to_string(),
        local_port: network_port(row.dwLocalPort),
        remote_address: None,
        remote_port: None,
        pid: row.dwOwningPid,
    }
}

fn udp_v6_identity(row: &MIB_UDP6ROW_OWNER_PID) -> EndpointIdentity {
    EndpointIdentity {
        protocol: Protocol::Udp,
        ip_version: IpVersion::V6,
        local_address: ipv6_to_string(row.ucLocalAddr, row.dwLocalScopeId),
        local_port: network_port(row.dwLocalPort),
        remote_address: None,
        remote_port: None,
        pid: row.dwOwningPid,
    }
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
    fn udp_entries_use_absent_remote_and_state_fields() {
        let process = ProcessInfo {
            name: None,
            path: None,
            created_at: None,
            status: super::super::types::ProcessStatus::Exited,
            status_message: Some("exited".to_string()),
        };
        let entry = make_entry(
            EndpointIdentity {
                protocol: Protocol::Udp,
                ip_version: IpVersion::V6,
                local_address: "::".to_string(),
                local_port: 53,
                remote_address: None,
                remote_port: None,
                pid: 100,
            },
            process,
        );
        assert_eq!(entry.remote_address, None);
        assert_eq!(entry.remote_port, None);
        assert_eq!(entry.state, None);
    }
}
