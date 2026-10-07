use rmcp::{
    handler::server::wrapper::Parameters, schemars, tool, tool_router, transport::stdio, ServiceExt,
};

use crate::client::ApiClient;
use crate::formatting::{format_check, format_free, OutputFormat};
use crate::ports::{ProtocolSelector, DEFAULT_FREE_END, DEFAULT_FREE_START};

#[derive(Clone)]
struct PortViewerMcp {
    client: ApiClient,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct CheckPortsArgs {
    /// Port expression such as "3000", "80,443,8080", or "3000-3010".
    ports: String,
    /// tcp, udp, or both. Defaults to tcp.
    protocol: Option<String>,
    /// Request authenticated endpoint/process details. Requires PORTVIEWER_API_TOKEN.
    details: Option<bool>,
    /// json or markdown. Defaults to markdown.
    response_format: Option<String>,
}

#[derive(Debug, serde::Deserialize, schemars::JsonSchema)]
#[serde(deny_unknown_fields)]
struct FindFreePortArgs {
    /// tcp, udp, or both. Defaults to tcp.
    protocol: Option<String>,
    /// Inclusive lower bound. Must be at least 30001.
    min_port: Option<u16>,
    /// Inclusive upper bound. Defaults to 49151.
    max_port: Option<u16>,
    /// json or markdown. Defaults to markdown.
    response_format: Option<String>,
}

#[tool_router(server_handler)]
impl PortViewerMcp {
    fn new(client: ApiClient) -> Self {
        Self { client }
    }

    #[tool(
        name = "portviewer_check_ports",
        description = "Check one port, a comma-separated list, or ranges on the configured LAN PortViewer host. Basic calls return only occupied/available/indeterminate. Set details=true only when PORTVIEWER_API_TOKEN is configured to receive listener address, TCP state, PID, process, and workload attribution. An indeterminate result must never be treated as available.",
        annotations(
            title = "Check LAN ports",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = true,
            open_world_hint = true
        )
    )]
    async fn check_ports(
        &self,
        Parameters(args): Parameters<CheckPortsArgs>,
    ) -> Result<String, String> {
        let protocol = parse_protocol(args.protocol.as_deref())?;
        let output = parse_output(args.response_format.as_deref())?;
        let response = self
            .client
            .check_ports(&args.ports, protocol, args.details.unwrap_or(false))
            .await?;
        format_check(&response, output)
    }

    #[tool(
        name = "portviewer_find_free_port",
        description = "Ask the configured LAN PortViewer host for a randomly selected currently bindable port. The default range is 30001 through 49151. The result is advisory, not a reservation; start and bind the service immediately, then retry this tool if binding loses a race.",
        annotations(
            title = "Find a free LAN service port",
            read_only_hint = true,
            destructive_hint = false,
            idempotent_hint = false,
            open_world_hint = true
        )
    )]
    async fn find_free_port(
        &self,
        Parameters(args): Parameters<FindFreePortArgs>,
    ) -> Result<String, String> {
        let protocol = parse_protocol(args.protocol.as_deref())?;
        let output = parse_output(args.response_format.as_deref())?;
        let response = self
            .client
            .find_free_port(
                protocol,
                args.min_port.unwrap_or(DEFAULT_FREE_START),
                args.max_port.unwrap_or(DEFAULT_FREE_END),
            )
            .await?;
        format_free(&response, output)
    }
}

pub async fn serve(client: ApiClient) -> Result<(), String> {
    tracing::info!("PortViewer MCP stdio 服务已启动");
    let service = PortViewerMcp::new(client)
        .serve(stdio())
        .await
        .map_err(|error| format!("MCP stdio 初始化失败：{error}"))?;
    service
        .waiting()
        .await
        .map_err(|error| format!("MCP stdio 异常结束：{error}"))?;
    Ok(())
}

fn parse_protocol(value: Option<&str>) -> Result<ProtocolSelector, String> {
    value.unwrap_or("tcp").parse()
}

fn parse_output(value: Option<&str>) -> Result<OutputFormat, String> {
    value.unwrap_or("markdown").parse()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mcp_argument_defaults_are_agent_friendly() {
        assert_eq!(parse_protocol(None).unwrap(), ProtocolSelector::Tcp);
        assert_eq!(parse_output(None).unwrap(), OutputFormat::Markdown);
        assert!(parse_protocol(Some("icmp")).is_err());
    }
}
