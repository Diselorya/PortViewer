use std::collections::HashMap;
use std::time::{Instant, SystemTime};

use netstat2::{get_sockets_info, AddressFamilyFlags, ProtocolFlags, ProtocolSocketInfo, TcpState};
use serde::Serialize;
use serde_json::to_value;
use sysinfo::System;

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
enum Protocol {
    Tcp,
    Udp,
}

#[derive(Serialize)]
enum IpVersion {
    V4,
    V6,
}

#[derive(Serialize)]
enum ProcessStatus {
    Available,
    Partial,
    System,
}

#[derive(Serialize)]
struct Entry {
    protocol: Protocol,
    ip_version: IpVersion,
    local_address: String,
    local_port: u16,
    remote_address: Option<String>,
    remote_port: Option<u16>,
    state: Option<&'static str>,
    pid: u32,
    process_name: Option<String>,
    process_path: Option<String>,
    process_created_at: Option<String>,
    process_status: ProcessStatus,
    process_status_message: Option<String>,
    attributions: Vec<serde_json::Value>,
}

#[derive(Serialize)]
struct Scope {
    protocol: Protocol,
    ip_version: IpVersion,
    status: &'static str,
    entry_count: usize,
    message: Option<String>,
}

#[derive(Serialize)]
struct ResolverReport {
    resolver: &'static str,
    status: &'static str,
    matched_count: usize,
    message: Option<&'static str>,
    elevation_may_help: bool,
}

#[derive(Serialize)]
struct ScanResult {
    entries: Vec<Entry>,
    total_count: usize,
    timestamp: String,
    scan_duration_ms: u64,
    is_partial: bool,
    scopes: Vec<Scope>,
    warnings: Vec<serde_json::Value>,
    attribution_reports: Vec<ResolverReport>,
    attribution_deferred: bool,
}

struct ProcessIdentity {
    name: String,
    path: Option<String>,
    created_at: String,
}

pub fn scan() -> Result<serde_json::Value, String> {
    let started = Instant::now();
    let sockets = get_sockets_info(
        AddressFamilyFlags::IPV4 | AddressFamilyFlags::IPV6,
        ProtocolFlags::TCP | ProtocolFlags::UDP,
    )
    .map_err(|error| format!("Linux 端口扫描失败：{error}"))?;
    let system = System::new_all();
    let identities = system
        .processes()
        .iter()
        .map(|(pid, process)| {
            (
                pid.as_u32(),
                ProcessIdentity {
                    name: process.name().to_string_lossy().into_owned(),
                    path: process
                        .exe()
                        .map(|path| path.to_string_lossy().into_owned()),
                    created_at: unix_seconds_to_iso8601(process.start_time()),
                },
            )
        })
        .collect::<HashMap<_, _>>();

    let mut entries = Vec::new();
    for socket in sockets {
        let is_ipv4 = socket.local_addr().is_ipv4();
        let pids = if socket.associated_pids.is_empty() {
            vec![0]
        } else {
            socket.associated_pids
        };
        for pid in pids {
            let identity = identities.get(&pid);
            let (protocol, local_address, local_port, remote_address, remote_port, state) =
                match &socket.protocol_socket_info {
                    ProtocolSocketInfo::Tcp(tcp) => {
                        let listening = tcp.state == TcpState::Listen;
                        (
                            Protocol::Tcp,
                            tcp.local_addr.to_string(),
                            tcp.local_port,
                            (!listening).then(|| tcp.remote_addr.to_string()),
                            (!listening).then_some(tcp.remote_port),
                            Some(tcp_state(tcp.state)),
                        )
                    }
                    ProtocolSocketInfo::Udp(udp) => (
                        Protocol::Udp,
                        udp.local_addr.to_string(),
                        udp.local_port,
                        None,
                        None,
                        None,
                    ),
                };
            let ip_version = if is_ipv4 {
                IpVersion::V4
            } else {
                IpVersion::V6
            };
            entries.push(Entry {
                protocol,
                ip_version,
                local_address,
                local_port,
                remote_address,
                remote_port,
                state,
                pid,
                process_name: identity.map(|value| value.name.clone()),
                process_path: identity.and_then(|value| value.path.clone()),
                process_created_at: identity.map(|value| value.created_at.clone()),
                process_status: if pid == 0 {
                    ProcessStatus::System
                } else if identity.is_some() {
                    ProcessStatus::Available
                } else {
                    ProcessStatus::Partial
                },
                process_status_message: (pid != 0 && identity.is_none())
                    .then(|| "无法读取进程详情；以 root 运行可补充部分受限进程信息".to_string()),
                attributions: Vec::new(),
            });
        }
    }
    entries.sort_by(|left, right| {
        left.local_port
            .cmp(&right.local_port)
            .then(left.pid.cmp(&right.pid))
    });
    let scopes = [
        (Protocol::Tcp, IpVersion::V4),
        (Protocol::Tcp, IpVersion::V6),
        (Protocol::Udp, IpVersion::V4),
        (Protocol::Udp, IpVersion::V6),
    ]
    .into_iter()
    .map(|(protocol, ip_version)| {
        let count = entries
            .iter()
            .filter(|entry| same_protocol(&entry.protocol, &protocol))
            .filter(|entry| same_version(&entry.ip_version, &ip_version))
            .count();
        Scope {
            protocol,
            ip_version,
            status: "Complete",
            entry_count: count,
            message: None,
        }
    })
    .collect();
    let matched = entries
        .iter()
        .filter(|entry| entry.process_name.is_some())
        .count();
    let total_count = entries.len();
    to_value(ScanResult {
        entries,
        total_count,
        timestamp: utc_now(),
        scan_duration_ms: started.elapsed().as_millis() as u64,
        is_partial: false,
        scopes,
        warnings: Vec::new(),
        attribution_reports: vec![
            ResolverReport {
                resolver: "Linux 进程",
                status: "Complete",
                matched_count: matched,
                message: None,
                elevation_may_help: false,
            },
            ResolverReport {
                resolver: "Docker / systemd / runtime",
                status: "Skipped",
                matched_count: 0,
                message: Some("Linux WebGUI 当前提供端口与进程归属；高级服务归属将在后续版本提供"),
                elevation_may_help: false,
            },
        ],
        attribution_deferred: false,
    })
    .map_err(|error| format!("无法序列化 Linux 扫描结果：{error}"))
}

fn same_protocol(left: &Protocol, right: &Protocol) -> bool {
    matches!(
        (left, right),
        (Protocol::Tcp, Protocol::Tcp) | (Protocol::Udp, Protocol::Udp)
    )
}

fn same_version(left: &IpVersion, right: &IpVersion) -> bool {
    matches!(
        (left, right),
        (IpVersion::V4, IpVersion::V4) | (IpVersion::V6, IpVersion::V6)
    )
}

fn tcp_state(state: TcpState) -> &'static str {
    match state {
        TcpState::Closed => "Closed",
        TcpState::Listen => "Listen",
        TcpState::SynSent => "SynSent",
        TcpState::SynReceived => "SynRcvd",
        TcpState::Established => "Established",
        TcpState::FinWait1 => "FinWait1",
        TcpState::FinWait2 => "FinWait2",
        TcpState::CloseWait => "CloseWait",
        TcpState::Closing => "Closing",
        TcpState::LastAck => "LastAck",
        TcpState::TimeWait => "TimeWait",
        TcpState::DeleteTcb => "DeleteTcb",
        TcpState::Unknown => "Unknown",
    }
}

fn utc_now() -> String {
    let seconds = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    unix_seconds_to_iso8601(seconds)
}

fn unix_seconds_to_iso8601(seconds: u64) -> String {
    let days = (seconds / 86_400) as i64;
    let seconds_of_day = seconds % 86_400;
    let (year, month, day) = days_to_date(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        seconds_of_day / 3_600,
        (seconds_of_day % 3_600) / 60,
        seconds_of_day % 60
    )
}

fn days_to_date(mut days: i64) -> (i64, u32, u32) {
    days += 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_position = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_position + 2) / 5 + 1;
    let month = if month_position < 10 {
        month_position + 3
    } else {
        month_position - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    (year, month as u32, day as u32)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_contract_state_names() {
        assert_eq!(tcp_state(TcpState::SynReceived), "SynRcvd");
        assert_eq!(tcp_state(TcpState::DeleteTcb), "DeleteTcb");
    }

    #[test]
    fn formats_epoch_as_rfc3339() {
        assert_eq!(unix_seconds_to_iso8601(0), "1970-01-01T00:00:00Z");
    }
}
