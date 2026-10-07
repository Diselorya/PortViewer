use std::str::FromStr;

use crate::ports::{CheckResponse, FreePortResponse, OccupancyStatus};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OutputFormat {
    Json,
    Markdown,
}

impl FromStr for OutputFormat {
    type Err = String;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value.trim().to_ascii_lowercase().as_str() {
            "json" => Ok(Self::Json),
            "markdown" | "md" => Ok(Self::Markdown),
            _ => Err("output 必须是 json 或 markdown".to_string()),
        }
    }
}

pub fn format_check(value: &CheckResponse, format: OutputFormat) -> Result<String, String> {
    match format {
        OutputFormat::Json => serde_json::to_string_pretty(value)
            .map_err(|error| format!("无法序列化端口查询结果：{error}")),
        OutputFormat::Markdown => Ok(check_markdown(value)),
    }
}

pub fn format_free(value: &FreePortResponse, format: OutputFormat) -> Result<String, String> {
    match format {
        OutputFormat::Json => serde_json::to_string_pretty(value)
            .map_err(|error| format!("无法序列化空闲端口结果：{error}")),
        OutputFormat::Markdown => Ok(format!(
            "可用端口：**{}**\n\n- 协议：{}\n- 探测范围：{}..{}\n- 检查时间：{}\n- 尝试次数：{}\n- 注意：{}",
            value.port,
            value.protocol,
            value.min_port,
            value.max_port,
            value.checked_at,
            value.attempts,
            value.advisory
        )),
    }
}

fn check_markdown(value: &CheckResponse) -> String {
    let mut output = format!(
        "端口查询结果（{:?}，检查时间 {}）\n\n| 端口 | 协议 | 结论 | 端点数 | 监听 |\n|---:|:---:|:---:|---:|:---:|\n",
        value.detail_level, value.checked_at
    );
    for item in &value.results {
        let status = match item.status {
            OccupancyStatus::Occupied => "已占用",
            OccupancyStatus::Available => "空闲",
            OccupancyStatus::Indeterminate => "无法确定",
        };
        let endpoint_count = item
            .endpoint_count
            .map(|count| count.to_string())
            .unwrap_or_else(|| "-".to_string());
        let listening = item
            .is_listening
            .map(|value| if value { "是" } else { "否" })
            .unwrap_or("-");
        output.push_str(&format!(
            "| {} | {:?} | {} | {} | {} |\n",
            item.port, item.protocol, status, endpoint_count, listening
        ));

        if let Some(endpoints) = &item.endpoints {
            for endpoint in endpoints {
                let pid = endpoint.get("pid").and_then(serde_json::Value::as_u64);
                let process = endpoint
                    .get("process_name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("未知进程");
                let address = endpoint
                    .get("local_address")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("?");
                let state = endpoint
                    .get("state")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("-");
                output.push_str(&format!(
                    "\n- `{address}:{}`：PID {}，{}，状态 {}\n",
                    item.port,
                    pid.map(|value| value.to_string())
                        .unwrap_or_else(|| "?".to_string()),
                    process.replace(['\r', '\n'], " "),
                    state
                ));
            }
        }
    }
    if !value.scan_complete {
        output.push_str("\n扫描范围不完整；`无法确定` 不得解释为空闲。\n");
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::{DetailLevel, OccupancyStatus, PortProtocol, PortStatus, ProtocolSelector};

    #[test]
    fn markdown_calls_out_indeterminate_results() {
        let response = CheckResponse {
            api_version: 1,
            detail_level: DetailLevel::Basic,
            checked_at: "now".to_string(),
            scan_complete: false,
            requested_ports: vec![80],
            requested_protocol: ProtocolSelector::Tcp,
            results: vec![PortStatus {
                port: 80,
                protocol: PortProtocol::Tcp,
                status: OccupancyStatus::Indeterminate,
                occupied: None,
                endpoint_count: None,
                is_listening: None,
                endpoints: None,
            }],
            scan_warnings: None,
        };
        let output = format_check(&response, OutputFormat::Markdown).unwrap();
        assert!(output.contains("无法确定"));
        assert!(output.contains("不得解释为空闲"));
    }
}
