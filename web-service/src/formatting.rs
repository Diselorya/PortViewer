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
                let pid = endpoint
                    .get("pid")
                    .and_then(serde_json::Value::as_u64)
                    .filter(|value| *value > 0);
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
                    markdown_text(process),
                    state
                ));
                if let Some(path) = endpoint
                    .get("process_path")
                    .and_then(serde_json::Value::as_str)
                {
                    output.push_str(&format!("  程序路径：{}\n", markdown_text(path)));
                }
                if let Some(attributions) = endpoint
                    .get("attributions")
                    .and_then(serde_json::Value::as_array)
                {
                    for attribution in attributions {
                        let name = attribution
                            .get("name")
                            .and_then(serde_json::Value::as_str)
                            .unwrap_or("归属未知");
                        output.push_str(&format!("\n  归属：{}\n", markdown_text(name)));
                        if let Some(description) = attribution
                            .get("description")
                            .and_then(serde_json::Value::as_str)
                        {
                            output.push_str(&format!("  用途：{}\n", markdown_text(description)));
                        }
                        if let Some(facts) = attribution
                            .get("facts")
                            .and_then(serde_json::Value::as_array)
                        {
                            for fact in facts {
                                if let (Some(label), Some(value)) = (
                                    fact.get("label").and_then(serde_json::Value::as_str),
                                    fact.get("value").and_then(serde_json::Value::as_str),
                                ) {
                                    output.push_str(&format!(
                                        "  {}：{}\n",
                                        markdown_text(label),
                                        markdown_text(value)
                                    ));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    if !value.scan_complete {
        output.push_str("\n扫描范围不完整；`无法确定` 不得解释为空闲。\n");
    }
    output
}

fn markdown_text(value: &str) -> String {
    let mut result = String::new();
    for character in value.chars().take(4096) {
        if character.is_control() {
            result.push(' ');
        } else {
            if matches!(
                character,
                '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '|' | '#'
            ) {
                result.push('\\');
            }
            result.push(character);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ports::{DetailLevel, OccupancyStatus, PortProtocol, PortStatus, ProtocolSelector};

    fn detailed_response(endpoint: serde_json::Value) -> CheckResponse {
        CheckResponse {
            api_version: 1,
            detail_level: DetailLevel::Detailed,
            checked_at: "now".to_string(),
            scan_complete: true,
            requested_ports: vec![3000],
            requested_protocol: ProtocolSelector::Tcp,
            results: vec![PortStatus {
                port: 3000,
                protocol: PortProtocol::Tcp,
                status: OccupancyStatus::Occupied,
                occupied: Some(true),
                endpoint_count: Some(1),
                is_listening: Some(true),
                endpoints: Some(vec![endpoint]),
            }],
            scan_warnings: None,
        }
    }

    fn project_endpoint() -> serde_json::Value {
        serde_json::json!({
            "pid": 42,
            "process_name": "node",
            "process_path": "/usr/bin/node",
            "local_address": "127.0.0.1",
            "state": "Listen",
            "attributions": [{
                "kind": "NodeApplication",
                "name": "orders-api",
                "description": "Order processing service",
                "facts": [
                    { "label": "运行模式", "value": "development" },
                    { "label": "项目路径", "value": "/srv/orders" }
                ]
            }]
        })
    }

    #[test]
    fn markdown_shows_the_actual_workload_name_and_purpose() {
        let response = detailed_response(project_endpoint());

        let output = format_check(&response, OutputFormat::Markdown).unwrap();

        assert!(output.contains("  归属：orders-api\n  用途：Order processing service\n"));
    }

    #[test]
    fn markdown_includes_the_runtime_mode_and_project_path() {
        let response = detailed_response(project_endpoint());

        let output = format_check(&response, OutputFormat::Markdown).unwrap();

        assert!(output.contains("  运行模式：development\n  项目路径：/srv/orders\n"));
    }

    #[test]
    fn markdown_includes_the_executable_path() {
        let response = detailed_response(project_endpoint());

        let output = format_check(&response, OutputFormat::Markdown).unwrap();

        assert!(output.contains("  程序路径：/usr/bin/node\n"));
    }

    #[test]
    fn markdown_escapes_links_and_html_from_workload_metadata() {
        let response = detailed_response(serde_json::json!({
            "attributions": [{
                "name": "[fake](https://evil.invalid)",
                "description": "<script>alert(1)</script>",
                "facts": [{ "label": "path", "value": "[open](https://evil.invalid)<img>" }]
            }]
        }));

        let output = format_check(&response, OutputFormat::Markdown).unwrap();

        assert!(output.contains("归属：\\[fake\\](https://evil.invalid)"));
        assert!(output.contains("用途：\\<script\\>alert(1)\\</script\\>"));
        assert!(output.contains("path：\\[open\\](https://evil.invalid)\\<img\\>"));
    }

    #[test]
    fn markdown_keeps_control_characters_inside_a_single_metadata_line() {
        let response = detailed_response(serde_json::json!({
            "attributions": [{
                "name": "orders\n# fake heading",
                "description": "normal\r\n- fake item\u{001b}",
                "facts": [{ "label": "mode\t# injected", "value": "dev\n|fake|row|" }]
            }]
        }));

        let output = format_check(&response, OutputFormat::Markdown).unwrap();

        assert!(output.contains("  归属：orders \\# fake heading\n"));
        assert!(output.contains("  用途：normal  - fake item \n"));
        assert!(output.contains("  mode \\# injected：dev \\|fake\\|row\\|\n"));
    }

    #[test]
    fn markdown_tolerates_missing_or_malformed_optional_metadata() {
        let response = detailed_response(serde_json::json!({
            "process_path": null,
            "attributions": [{
                "name": null,
                "description": null,
                "facts": [
                    { "label": "missing-value" },
                    { "label": 12, "value": "not-a-label" }
                ]
            }]
        }));

        let output = format_check(&response, OutputFormat::Markdown).unwrap();

        assert!(output.contains("归属：归属未知"));
        assert!(!output.contains("missing-value"));
        assert!(!output.contains("not-a-label"));
        assert!(!output.contains("程序路径"));
    }

    #[test]
    fn markdown_bounds_workload_descriptions_to_4096_characters() {
        let response = detailed_response(serde_json::json!({
            "attributions": [{ "name": "orders", "description": "界".repeat(5000), "facts": [] }]
        }));

        let output = format_check(&response, OutputFormat::Markdown).unwrap();
        let description = output
            .lines()
            .find(|line| line.starts_with("  用途："))
            .unwrap();

        assert_eq!(
            description.trim_start_matches("  用途：").chars().count(),
            4096
        );
    }

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
