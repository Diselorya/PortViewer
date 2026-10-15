use std::collections::HashMap;
use std::time::{Instant, SystemTime};

use crate::service_manager::ServiceManager;
use netstat2::{get_sockets_info, AddressFamilyFlags, ProtocolFlags, ProtocolSocketInfo, TcpState};
use serde::Serialize;
use serde_json::to_value;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

mod attribution;
use attribution::{Attribution, Docker, Process, Report, Systemd};

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
    Unavailable,
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
    service_manager: ServiceManager,
    attributions: Vec<Attribution>,
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
struct ScanResult {
    entries: Vec<Entry>,
    total_count: usize,
    timestamp: String,
    scan_duration_ms: u64,
    is_partial: bool,
    scopes: Vec<Scope>,
    warnings: Vec<serde_json::Value>,
    attribution_reports: Vec<Report>,
    attribution_deferred: bool,
}

struct ProcessIdentity {
    name: String,
    path: Option<String>,
    created_at: String,
}

pub fn scan() -> Result<serde_json::Value, String> {
    scan_internal(true)
}

pub fn scan_basic() -> Result<serde_json::Value, String> {
    scan_internal(false)
}

fn scan_internal(advanced: bool) -> Result<serde_json::Value, String> {
    let started = Instant::now();
    let sockets = get_sockets_info(
        AddressFamilyFlags::IPV4 | AddressFamilyFlags::IPV6,
        ProtocolFlags::TCP | ProtocolFlags::UDP,
    )
    .map_err(|error| format!("Linux 端口扫描失败：{error}；若使用 systemd，请检查 RestrictAddressFamilies 包含 AF_NETLINK；也请检查网络命名空间与权限"))?;
    // Only the identity fields needed by this endpoint are refreshed. The full
    // sysinfo snapshot also reads process environments and task/CPU data.
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing()
            .without_tasks()
            .with_exe(UpdateKind::OnlyIfNotSet),
    );
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
                    ProcessStatus::Unavailable
                } else if identity.is_some() {
                    ProcessStatus::Available
                } else {
                    ProcessStatus::Partial
                },
                process_status_message: if pid == 0 {
                    Some("socket 已枚举，但没有可读取的关联 PID；可能是 /proc 权限限制或进程已退出，不能判定为系统进程".to_string())
                } else if identity.is_none() {
                    Some("无法读取进程详情；进程可能已退出或受到 /proc 权限限制".to_string())
                } else {
                    None
                },
                service_manager: ServiceManager::Unknown,
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
    let limited = entries
        .iter()
        .filter(|entry| entry.pid == 0 || entry.process_name.is_none())
        .count();
    let limited_listeners = entries
        .iter()
        .filter(|entry| {
            (entry.pid == 0 || entry.process_name.is_none())
                && (matches!(entry.protocol, Protocol::Udp) || entry.state == Some("Listen"))
        })
        .count();
    let mut warnings = Vec::new();
    if limited > 0 {
        warnings.push(serde_json::json!({
            "code": "attribution_limited",
            "message": format!("端口枚举已完成，但 {limited} 条记录（其中 {limited_listeners} 条监听/UDP 端点）无法读取进程归属。/proc 权限限制、容器 PID/网络命名空间或进程退出都可能造成缺失；TIME_WAIT 等关闭连接可能没有存活进程。{}", if limited_listeners > 0 { "以宿主 root 运行可能改善监听端口归属；单独授予 CAP_SYS_PTRACE 不保证有效。" } else { "缺失记录不代表可通过提权恢复归属。" })
        }));
    }
    let mut reports = vec![Report {
        resolver: "Linux 进程",
        status: if limited > 0 { "Partial" } else { "Complete" },
        matched_count: matched,
        message: (limited > 0)
            .then(|| format!("{limited} 条端点无法关联进程；端口枚举与归属完整性分别报告")),
        elevation_may_help: limited_listeners > 0,
    }];
    if advanced {
        let mut processes = HashMap::<u32, Process>::new();
        for entry in &entries {
            if entry.pid == 0 || processes.contains_key(&entry.pid) {
                continue;
            }
            processes.insert(
                entry.pid,
                attribution::read_process(
                    entry.pid,
                    entry.process_name.as_deref().unwrap_or_default(),
                    entry.process_path.as_deref(),
                ),
            );
        }
        let mut docker = Docker::collect();
        let mut systemd = Systemd::collect(&processes);
        // A PID can own many endpoints. Read project metadata and resolve the
        // program identity once per PID, then reuse the sanitized results.
        let runtimes: HashMap<_, _> = processes
            .iter()
            .map(|(pid, process)| (*pid, attribution::runtime(process)))
            .collect();
        let programs: HashMap<_, _> = processes
            .iter()
            .filter(|(_, process)| !process.name.is_empty() || process.exe.is_some())
            .map(|(pid, process)| (*pid, attribution::program(process)))
            .collect();
        let mut runtime_matches = 0;
        let mut program_matches = 0;
        for entry in &mut entries {
            let process = processes.get(&entry.pid);
            let protocol = if matches!(entry.protocol, Protocol::Tcp) {
                "tcp"
            } else {
                "udp"
            };
            // Published TCP ports describe listeners, not arbitrary outgoing
            // connections that happen to reuse the same local port number.
            if matches!(entry.protocol, Protocol::Udp) || entry.state == Some("Listen") {
                entry.attributions.extend(docker.matches(
                    protocol,
                    &entry.local_address,
                    entry.local_port,
                    process,
                ));
            }
            if let Some(process) = process {
                if let Some(Some(runtime)) = runtimes.get(&entry.pid) {
                    runtime_matches += 1;
                    entry.attributions.push(runtime.clone());
                }
                entry.attributions.extend(systemd.matches(
                    protocol,
                    &entry.local_address,
                    entry.local_port,
                    process,
                ));
                if let Some(program) = programs.get(&entry.pid) {
                    entry.attributions.push(program.clone());
                    program_matches += 1;
                }
            }
            entry.service_manager =
                ServiceManager::from_kinds(entry.attributions.iter().map(|item| item.kind));
            docker.report.matched_count += entry
                .attributions
                .iter()
                .filter(|a| a.kind == "DockerContainer")
                .count();
            systemd.report.matched_count += entry
                .attributions
                .iter()
                .filter(|a| a.kind == "SystemdService")
                .count();
        }
        let proc_limited = processes.values().filter(|p| p.limited).count();
        reports.push(docker.report);
        reports.push(systemd.report);
        reports.push(Report {
            resolver: "Node.js / Python 项目",
            status: if limited > 0 || proc_limited > 0 {
                "Partial"
            } else {
                "Complete"
            },
            matched_count: runtime_matches,
            message: (limited > 0 || proc_limited > 0)
                .then(|| "部分进程没有可读命令行或工作目录，项目归属可能缺失".to_owned()),
            elevation_may_help: limited_listeners > 0 || proc_limited > 0,
        });
        reports.push(Report {
            resolver: "系统程序",
            status: if limited > 0 { "Partial" } else { "Complete" },
            matched_count: program_matches,
            message: (limited > 0)
                .then(|| "仅对已知 PID 提供程序身份；未映射 PID 不会标为系统程序".to_owned()),
            elevation_may_help: limited_listeners > 0,
        });
    } else {
        reports.push(Report {
            resolver: "Docker / systemd / 项目",
            status: "Skipped",
            matched_count: 0,
            message: Some("基础扫描仅枚举端口与进程；详细扫描再解析容器、服务和项目".to_owned()),
            elevation_may_help: false,
        });
    }
    let total_count = entries.len();
    to_value(ScanResult {
        entries,
        total_count,
        timestamp: utc_now(),
        scan_duration_ms: started.elapsed().as_millis() as u64,
        is_partial: false,
        scopes,
        warnings,
        attribution_reports: reports,
        attribution_deferred: !advanced,
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
