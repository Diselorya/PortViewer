use std::collections::{BTreeSet, HashSet};
use std::io;
use std::net::{Ipv4Addr, Ipv6Addr, SocketAddr, SocketAddrV4, SocketAddrV6};
use std::str::FromStr;

use rand::seq::SliceRandom;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use socket2::{Domain, Protocol as SocketProtocol, Socket, Type};

pub const DEFAULT_FREE_START: u16 = 30_001;
pub const DEFAULT_FREE_END: u16 = 49_151;
pub const MAX_PORTS_PER_QUERY: usize = 1_024;
const MAX_EXPRESSION_LENGTH: usize = 4_096;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProtocolSelector {
    Tcp,
    Udp,
    Both,
}

impl ProtocolSelector {
    pub fn protocols(self) -> &'static [PortProtocol] {
        match self {
            Self::Tcp => &[PortProtocol::Tcp],
            Self::Udp => &[PortProtocol::Udp],
            Self::Both => &[PortProtocol::Tcp, PortProtocol::Udp],
        }
    }
}

impl FromStr for ProtocolSelector {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "tcp" => Ok(Self::Tcp),
            "udp" => Ok(Self::Udp),
            "both" => Ok(Self::Both),
            _ => Err("protocol 必须是 tcp、udp 或 both".to_string()),
        }
    }
}

impl std::fmt::Display for ProtocolSelector {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::Tcp => "tcp",
            Self::Udp => "udp",
            Self::Both => "both",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PortProtocol {
    Tcp,
    Udp,
}

impl PortProtocol {
    fn contract_name(self) -> &'static str {
        match self {
            Self::Tcp => "Tcp",
            Self::Udp => "Udp",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum OccupancyStatus {
    Occupied,
    Available,
    Indeterminate,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResponse {
    pub api_version: u8,
    pub detail_level: DetailLevel,
    pub checked_at: String,
    pub scan_complete: bool,
    pub requested_ports: Vec<u16>,
    pub requested_protocol: ProtocolSelector,
    pub results: Vec<PortStatus>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scan_warnings: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DetailLevel {
    Basic,
    Detailed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortStatus {
    pub port: u16,
    pub protocol: PortProtocol,
    pub status: OccupancyStatus,
    pub occupied: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_listening: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoints: Option<Vec<Value>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub struct FreePortRequest {
    #[serde(default = "default_protocol")]
    pub protocol: ProtocolSelector,
    #[serde(default = "default_free_start")]
    pub min_port: u16,
    #[serde(default = "default_free_end")]
    pub max_port: u16,
}

impl Default for FreePortRequest {
    fn default() -> Self {
        Self {
            protocol: default_protocol(),
            min_port: default_free_start(),
            max_port: default_free_end(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FreePortResponse {
    pub api_version: u8,
    pub port: u16,
    pub protocol: ProtocolSelector,
    pub min_port: u16,
    pub max_port: u16,
    pub checked_at: String,
    pub attempts: usize,
    pub advisory_only: bool,
    pub advisory: String,
}

#[derive(Debug, Deserialize)]
pub struct Snapshot {
    pub entries: Vec<Value>,
    pub timestamp: String,
    pub is_partial: bool,
    #[serde(default)]
    pub scopes: Vec<SnapshotScope>,
    #[serde(default)]
    pub warnings: Vec<Value>,
}

#[derive(Debug, Deserialize)]
pub struct SnapshotScope {
    pub protocol: String,
    pub status: String,
}

pub fn parse_ports(expression: &str) -> Result<Vec<u16>, String> {
    if expression.is_empty() || expression.len() > MAX_EXPRESSION_LENGTH {
        return Err(format!(
            "ports 表达式不能为空且不能超过 {MAX_EXPRESSION_LENGTH} 字节"
        ));
    }
    let mut ports = BTreeSet::new();
    for item in expression.split(',') {
        let item = item.trim();
        if item.is_empty() {
            return Err("ports 表达式包含空项目".to_string());
        }
        if let Some((start, end)) = item.split_once('-') {
            if end.contains('-') {
                return Err(format!("端口区间格式无效：{item}"));
            }
            let start = parse_port(start, item)?;
            let end = parse_port(end, item)?;
            if start > end {
                return Err(format!("端口区间起点不能大于终点：{item}"));
            }
            for port in start..=end {
                ports.insert(port);
                if ports.len() > MAX_PORTS_PER_QUERY {
                    return Err(format!("每次最多查询 {MAX_PORTS_PER_QUERY} 个端口"));
                }
            }
        } else {
            ports.insert(parse_port(item, item)?);
        }
        if ports.len() > MAX_PORTS_PER_QUERY {
            return Err(format!("每次最多查询 {MAX_PORTS_PER_QUERY} 个端口"));
        }
    }
    Ok(ports.into_iter().collect())
}

pub fn parse_snapshot(value: Value) -> Result<Snapshot, String> {
    serde_json::from_value(value).map_err(|error| format!("系统扫描结果不符合接口契约：{error}"))
}

pub fn check_ports(
    snapshot: &Snapshot,
    ports: Vec<u16>,
    selector: ProtocolSelector,
    detailed: bool,
) -> CheckResponse {
    let mut results = Vec::with_capacity(ports.len() * selector.protocols().len());
    for port in &ports {
        for protocol in selector.protocols() {
            let endpoints = snapshot
                .entries
                .iter()
                .filter(|entry| entry_matches(entry, *port, *protocol))
                .cloned()
                .collect::<Vec<_>>();
            let complete = protocol_is_complete(snapshot, *protocol);
            let status = if !endpoints.is_empty() {
                OccupancyStatus::Occupied
            } else if complete {
                OccupancyStatus::Available
            } else {
                OccupancyStatus::Indeterminate
            };
            let is_listening = (detailed && status != OccupancyStatus::Indeterminate).then(|| {
                *protocol == PortProtocol::Udp
                    || endpoints
                        .iter()
                        .any(|entry| entry.get("state").and_then(Value::as_str) == Some("Listen"))
            });
            results.push(PortStatus {
                port: *port,
                protocol: *protocol,
                status,
                occupied: match status {
                    OccupancyStatus::Occupied => Some(true),
                    OccupancyStatus::Available => Some(false),
                    OccupancyStatus::Indeterminate => None,
                },
                endpoint_count: detailed.then_some(endpoints.len()),
                is_listening,
                endpoints: detailed.then_some(endpoints),
            });
        }
    }

    CheckResponse {
        api_version: 1,
        detail_level: if detailed {
            DetailLevel::Detailed
        } else {
            DetailLevel::Basic
        },
        checked_at: snapshot.timestamp.clone(),
        scan_complete: !snapshot.is_partial
            && selector
                .protocols()
                .iter()
                .all(|protocol| protocol_is_complete(snapshot, *protocol)),
        requested_ports: ports,
        requested_protocol: selector,
        results,
        scan_warnings: detailed.then(|| snapshot.warnings.clone()),
    }
}

pub fn validate_free_request(request: &FreePortRequest) -> Result<(), String> {
    if request.min_port < DEFAULT_FREE_START {
        return Err(format!("minPort 不能小于 {DEFAULT_FREE_START}"));
    }
    if request.min_port > request.max_port {
        return Err("minPort 不能大于 maxPort".to_string());
    }
    Ok(())
}

pub fn find_free_port(
    snapshot: &Snapshot,
    request: &FreePortRequest,
) -> Result<FreePortResponse, String> {
    find_free_port_with(snapshot, request, port_can_bind)
}

fn find_free_port_with<F>(
    snapshot: &Snapshot,
    request: &FreePortRequest,
    mut probe: F,
) -> Result<FreePortResponse, String>
where
    F: FnMut(u16, ProtocolSelector) -> bool,
{
    validate_free_request(request)?;
    if request
        .protocol
        .protocols()
        .iter()
        .any(|protocol| !protocol_is_complete(snapshot, *protocol))
    {
        return Err("目标协议的系统扫描不完整，拒绝把未知端口误报为空闲".to_string());
    }

    let occupied = snapshot
        .entries
        .iter()
        .filter_map(entry_port_and_protocol)
        .collect::<HashSet<_>>();
    let mut candidates = (request.min_port..=request.max_port).collect::<Vec<_>>();
    candidates.shuffle(&mut rand::rng());

    for (index, port) in candidates.into_iter().enumerate() {
        let attempts = index + 1;
        if request
            .protocol
            .protocols()
            .iter()
            .any(|protocol| occupied.contains(&(port, *protocol)))
        {
            continue;
        }
        if probe(port, request.protocol) {
            return Ok(FreePortResponse {
                api_version: 1,
                port,
                protocol: request.protocol,
                min_port: request.min_port,
                max_port: request.max_port,
                checked_at: snapshot.timestamp.clone(),
                attempts,
                advisory_only: true,
                advisory: "该端口仅在检查时未被占用；服务绑定前仍可能被其他进程抢占。".to_string(),
            });
        }
    }
    Err(format!(
        "在 {}..{} 中未找到可绑定端口",
        request.min_port, request.max_port
    ))
}

fn parse_port(value: &str, source: &str) -> Result<u16, String> {
    value
        .trim()
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .ok_or_else(|| format!("端口必须在 1..65535 范围内：{source}"))
}

fn entry_matches(entry: &Value, port: u16, protocol: PortProtocol) -> bool {
    entry.get("local_port").and_then(Value::as_u64) == Some(u64::from(port))
        && entry.get("protocol").and_then(Value::as_str) == Some(protocol.contract_name())
}

fn entry_port_and_protocol(entry: &Value) -> Option<(u16, PortProtocol)> {
    let port = u16::try_from(entry.get("local_port")?.as_u64()?).ok()?;
    let protocol = match entry.get("protocol")?.as_str()? {
        "Tcp" => PortProtocol::Tcp,
        "Udp" => PortProtocol::Udp,
        _ => return None,
    };
    Some((port, protocol))
}

fn protocol_is_complete(snapshot: &Snapshot, protocol: PortProtocol) -> bool {
    let scopes = snapshot
        .scopes
        .iter()
        .filter(|scope| scope.protocol == protocol.contract_name())
        .collect::<Vec<_>>();
    scopes.len() >= 2 && scopes.iter().all(|scope| scope.status == "Complete")
}

fn port_can_bind(port: u16, selector: ProtocolSelector) -> bool {
    let mut sockets = Vec::new();
    for protocol in selector.protocols() {
        for domain in [Domain::IPV4, Domain::IPV6] {
            match bind_probe_socket(port, *protocol, domain) {
                Ok(socket) => sockets.push(socket),
                Err(error) if ipv6_is_unavailable(domain, &error) => continue,
                Err(_) => return false,
            }
        }
    }
    !sockets.is_empty()
}

fn bind_probe_socket(port: u16, protocol: PortProtocol, domain: Domain) -> io::Result<Socket> {
    let (socket_type, socket_protocol) = match protocol {
        PortProtocol::Tcp => (Type::STREAM, SocketProtocol::TCP),
        PortProtocol::Udp => (Type::DGRAM, SocketProtocol::UDP),
    };
    let socket = Socket::new(domain, socket_type, Some(socket_protocol))?;
    if domain == Domain::IPV6 {
        socket.set_only_v6(true)?;
    }
    let address = if domain == Domain::IPV4 {
        SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port))
    } else {
        SocketAddr::V6(SocketAddrV6::new(Ipv6Addr::UNSPECIFIED, port, 0, 0))
    };
    socket.bind(&address.into())?;
    if protocol == PortProtocol::Tcp {
        socket.listen(1)?;
    }
    Ok(socket)
}

fn ipv6_is_unavailable(domain: Domain, error: &io::Error) -> bool {
    domain == Domain::IPV6
        && matches!(
            error.kind(),
            io::ErrorKind::Unsupported | io::ErrorKind::AddrNotAvailable
        )
}

const fn default_protocol() -> ProtocolSelector {
    ProtocolSelector::Tcp
}

const fn default_free_start() -> u16 {
    DEFAULT_FREE_START
}

const fn default_free_end() -> u16 {
    DEFAULT_FREE_END
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn snapshot(entries: Vec<Value>, tcp_v6_status: &str) -> Snapshot {
        parse_snapshot(json!({
            "entries": entries,
            "timestamp": "2026-08-29T00:00:00Z",
            "is_partial": tcp_v6_status != "Complete",
            "scopes": [
                {"protocol":"Tcp", "status":"Complete"},
                {"protocol":"Tcp", "status":tcp_v6_status},
                {"protocol":"Udp", "status":"Complete"},
                {"protocol":"Udp", "status":"Complete"}
            ],
            "warnings": []
        }))
        .unwrap()
    }

    #[test]
    fn parses_single_list_and_range_without_duplicates() {
        assert_eq!(
            parse_ports("80,443,3000-3002,80").unwrap(),
            vec![80, 443, 3000, 3001, 3002]
        );
        assert_eq!(parse_ports("1-1024,1-1024").unwrap().len(), 1024);
    }

    #[test]
    fn rejects_invalid_or_excessive_ranges() {
        assert!(parse_ports("0").is_err());
        assert!(parse_ports("10-1").is_err());
        assert!(parse_ports("1-2000").is_err());
        assert!(parse_ports("80,").is_err());
    }

    #[test]
    fn basic_results_do_not_leak_endpoint_details() {
        let snapshot = snapshot(
            vec![json!({
                "protocol":"Tcp",
                "local_port":3000,
                "state":"Listen",
                "pid":123,
                "process_name":"secret.exe"
            })],
            "Complete",
        );
        let result = check_ports(&snapshot, vec![3000], ProtocolSelector::Tcp, false);
        assert_eq!(result.results[0].status, OccupancyStatus::Occupied);
        assert!(result.results[0].endpoints.is_none());
        assert!(result.results[0].endpoint_count.is_none());
    }

    #[test]
    fn incomplete_scope_returns_indeterminate_instead_of_available() {
        let snapshot = snapshot(Vec::new(), "Failed");
        let result = check_ports(&snapshot, vec![3000], ProtocolSelector::Tcp, false);
        assert_eq!(result.results[0].status, OccupancyStatus::Indeterminate);
        assert_eq!(result.results[0].occupied, None);
    }

    #[test]
    fn detailed_result_reports_listener_and_endpoint() {
        let snapshot = snapshot(
            vec![json!({"protocol":"Tcp", "local_port":8080, "state":"Listen", "pid":42})],
            "Complete",
        );
        let result = check_ports(&snapshot, vec![8080], ProtocolSelector::Tcp, true);
        assert_eq!(result.detail_level, DetailLevel::Detailed);
        assert_eq!(result.results[0].is_listening, Some(true));
        assert_eq!(result.results[0].endpoint_count, Some(1));
    }

    #[test]
    fn free_port_skips_snapshot_occupancy_and_uses_probe() {
        let snapshot = snapshot(
            vec![json!({"protocol":"Tcp", "local_port":30001, "state":"Listen"})],
            "Complete",
        );
        let request = FreePortRequest {
            protocol: ProtocolSelector::Tcp,
            min_port: 30001,
            max_port: 30002,
        };
        let result = find_free_port_with(&snapshot, &request, |port, _| port == 30002).unwrap();
        assert_eq!(result.port, 30002);
        assert!(result.advisory_only);
    }
}
