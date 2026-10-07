mod table;
pub mod tcp;
pub mod types;
pub mod udp;

use crate::error::AppResult;
use types::{EndpointIdentity, IpVersion, Protocol};

/// 只读取指定协议族的原始端点所有权，不进行 PID 到进程详情的解析。
pub(crate) fn scan_endpoint_scope(endpoint: &EndpointIdentity) -> AppResult<Vec<EndpointIdentity>> {
    match (endpoint.protocol, endpoint.ip_version) {
        (Protocol::Tcp, IpVersion::V4) => tcp::scan_tcp_v4_identities(),
        (Protocol::Tcp, IpVersion::V6) => tcp::scan_tcp_v6_identities(),
        (Protocol::Udp, IpVersion::V4) => udp::scan_udp_v4_identities(),
        (Protocol::Udp, IpVersion::V6) => udp::scan_udp_v6_identities(),
    }
}
