use serde::{Deserialize, Serialize};

/// 网络协议类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Protocol {
    Tcp,
    Udp,
}

/// 端点所属的 IP 协议族。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum IpVersion {
    V4,
    V6,
}

impl std::fmt::Display for Protocol {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Protocol::Tcp => write!(f, "Tcp"),
            Protocol::Udp => write!(f, "Udp"),
        }
    }
}

/// TCP 连接状态
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConnectionState {
    Closed,
    Listen,
    SynSent,
    SynRcvd,
    Established,
    FinWait1,
    FinWait2,
    CloseWait,
    Closing,
    LastAck,
    TimeWait,
    DeleteTcb,
    Unknown,
}

/// 进程身份信息的可用状态。前端不得用空字符串推断权限或生命周期状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProcessStatus {
    Available,
    Partial,
    AccessDenied,
    Exited,
    System,
    Unavailable,
}

/// 高于 OS 进程层的工作负载归属。一个端口可能同时存在多个候选，例如同端口的虚拟主机。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AttributionKind {
    DockerContainer,
    NginxSite,
    IisSite,
    IisAppPool,
    NssmService,
    WindowsService,
    NodeApplication,
    PythonApplication,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AttributionConfidence {
    Exact,
    High,
    Medium,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttributionFact {
    pub label: String,
    pub value: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ServiceAttribution {
    pub kind: AttributionKind,
    pub name: String,
    pub description: Option<String>,
    pub confidence: AttributionConfidence,
    pub source: String,
    pub facts: Vec<AttributionFact>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AttributionScanStatus {
    Complete,
    Partial,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttributionResolverReport {
    pub resolver: String,
    pub status: AttributionScanStatus,
    pub matched_count: usize,
    pub message: Option<String>,
    /// 提升权限是否可能改善该解析器；前端只据此显示管理员重试入口。
    pub elevation_may_help: bool,
}

impl ConnectionState {
    /// 将 Windows MIB_TCP_STATE 枚举值映射为 ConnectionState
    pub fn from_mib_state(state: u32) -> Self {
        match state {
            1 => ConnectionState::Closed,
            2 => ConnectionState::Listen,
            3 => ConnectionState::SynSent,
            4 => ConnectionState::SynRcvd,
            5 => ConnectionState::Established,
            6 => ConnectionState::FinWait1,
            7 => ConnectionState::FinWait2,
            8 => ConnectionState::CloseWait,
            9 => ConnectionState::Closing,
            10 => ConnectionState::LastAck,
            11 => ConnectionState::TimeWait,
            12 => ConnectionState::DeleteTcb,
            _ => ConnectionState::Unknown,
        }
    }
}

/// 单个端口条目的完整信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortEntry {
    pub protocol: Protocol,
    pub ip_version: IpVersion,
    pub local_address: String,
    pub local_port: u16,
    /// UDP 没有远端端点，使用 null 而不是伪造 `0.0.0.0:0`。
    pub remote_address: Option<String>,
    pub remote_port: Option<u16>,
    /// UDP 没有 TCP 状态，使用 null 而不是 `Unknown`。
    pub state: Option<ConnectionState>,
    pub pid: u32,
    pub process_name: Option<String>,
    pub process_path: Option<String>,
    pub process_created_at: Option<String>,
    pub process_status: ProcessStatus,
    pub process_status_message: Option<String>,
    /// 按可信度和产品优先级排序；第一个为表格主归属，其余候选在详情中完整展示。
    pub attributions: Vec<ServiceAttribution>,
}

/// 危险操作使用的稳定端点身份，不包含易变的 TCP 状态或展示型进程字段。
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct EndpointIdentity {
    pub protocol: Protocol,
    pub ip_version: IpVersion,
    pub local_address: String,
    pub local_port: u16,
    pub remote_address: Option<String>,
    pub remote_port: Option<u16>,
    pub pid: u32,
}

impl From<&PortEntry> for EndpointIdentity {
    fn from(entry: &PortEntry) -> Self {
        Self {
            protocol: entry.protocol,
            ip_version: entry.ip_version,
            local_address: entry.local_address.clone(),
            local_port: entry.local_port,
            remote_address: entry.remote_address.clone(),
            remote_port: entry.remote_port,
            pid: entry.pid,
        }
    }
}

/// 一个独立扫描范围（协议 × IP 版本）的执行状态。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanScope {
    pub protocol: Protocol,
    pub ip_version: IpVersion,
    pub status: ScanScopeStatus,
    pub entry_count: usize,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScanScopeStatus {
    Complete,
    Failed,
}

/// 非致命扫描问题。至少一个范围成功时，命令仍返回可用条目和警告。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ScanWarning {
    pub code: String,
    pub protocol: Protocol,
    pub ip_version: IpVersion,
    pub message: String,
}

/// 扫描结果
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScanResult {
    pub entries: Vec<PortEntry>,
    pub total_count: usize,
    pub timestamp: String,
    pub scan_duration_ms: u64,
    pub is_partial: bool,
    pub scopes: Vec<ScanScope>,
    pub warnings: Vec<ScanWarning>,
    pub attribution_reports: Vec<AttributionResolverReport>,
    pub attribution_deferred: bool,
}

/// Optional higher-level attribution is returned separately so the authoritative
/// OS endpoint snapshot can reach the UI without waiting for external tools or
/// configuration parsing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AttributionResult {
    pub entries: Vec<PortEntry>,
    pub reports: Vec<AttributionResolverReport>,
    pub duration_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_all_documented_tcp_states() {
        let expected = [
            ConnectionState::Closed,
            ConnectionState::Listen,
            ConnectionState::SynSent,
            ConnectionState::SynRcvd,
            ConnectionState::Established,
            ConnectionState::FinWait1,
            ConnectionState::FinWait2,
            ConnectionState::CloseWait,
            ConnectionState::Closing,
            ConnectionState::LastAck,
            ConnectionState::TimeWait,
            ConnectionState::DeleteTcb,
        ];

        for (offset, state) in expected.into_iter().enumerate() {
            assert_eq!(ConnectionState::from_mib_state(offset as u32 + 1), state);
        }
        assert_eq!(ConnectionState::from_mib_state(0), ConnectionState::Unknown);
        assert_eq!(
            ConnectionState::from_mib_state(99),
            ConnectionState::Unknown
        );
    }
}
