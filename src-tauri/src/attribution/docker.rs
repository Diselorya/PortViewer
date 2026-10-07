use std::collections::HashMap;
use std::ffi::c_void;
use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{FOLDERID_ProgramFiles, SHGetKnownFolderPath, KF_FLAG_DEFAULT};

use super::command::{run_limited, utf8};
use super::system::{fact, truncate};
use crate::network::types::{
    AttributionConfidence, AttributionKind, PortEntry, Protocol, ServiceAttribution,
};

#[derive(Debug, Clone, Default)]
pub struct DockerSnapshot {
    mappings: Vec<DockerMapping>,
}

#[derive(Debug, Clone)]
struct DockerMapping {
    host_ip: String,
    host_port: u16,
    container_port: u16,
    protocol: Protocol,
    container_id: String,
    container_name: String,
    image: String,
    compose_project: Option<String>,
    compose_service: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct InspectContainer {
    id: String,
    name: String,
    config: InspectConfig,
    network_settings: InspectNetworkSettings,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct InspectConfig {
    image: String,
    #[serde(default)]
    labels: Option<HashMap<String, String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct InspectNetworkSettings {
    #[serde(default)]
    ports: Option<HashMap<String, Option<Vec<InspectBinding>>>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "PascalCase")]
struct InspectBinding {
    #[serde(default)]
    host_ip: String,
    host_port: String,
}

impl DockerSnapshot {
    pub fn collect() -> Result<Self, String> {
        if let Some(host) = std::env::var_os("DOCKER_HOST") {
            let host = host.to_string_lossy();
            if is_remote_engine(&host) {
                return Err("远端 Docker Engine 不映射为本机归属，已跳过".to_string());
            }
        }

        let docker = docker_cli_path()?;
        let context = run_limited(
            &docker,
            &[
                "context",
                "inspect",
                "--format",
                "{{json .Endpoints.docker.Host}}",
            ],
            Duration::from_secs(3),
        )?;
        if !context.success {
            return Err(command_error("无法读取 Docker context", &context.stderr));
        }
        let context_host: String = serde_json::from_slice(&context.stdout)
            .map_err(|error| format!("Docker context 地址格式无效：{error}"))?;
        if is_remote_engine(&context_host) {
            return Err("当前 Docker context 是远端 Engine，不映射为本机归属，已跳过".to_string());
        }

        let list = run_limited(&docker, &["ps", "-q", "--no-trunc"], Duration::from_secs(3))?;
        if !list.success {
            return Err(command_error("无法读取 Docker 容器", &list.stderr));
        }
        let ids: Vec<String> = utf8(&list.stdout)
            .lines()
            .map(str::trim)
            .filter(|id| {
                id.len() >= 12 && id.len() <= 64 && id.chars().all(|c| c.is_ascii_hexdigit())
            })
            .map(str::to_string)
            .collect();
        if ids.is_empty() {
            return Ok(Self::default());
        }
        let mut arguments = vec!["inspect".to_string()];
        arguments.extend(ids);
        let argument_refs: Vec<&str> = arguments.iter().map(String::as_str).collect();
        let inspect = run_limited(&docker, &argument_refs, Duration::from_secs(5))?;
        // A container can disappear between `ps` and `inspect`. Docker then exits
        // non-zero while still returning valid JSON for the surviving IDs. Keep
        // those results instead of dropping attribution for every container.
        let containers: Vec<InspectContainer> =
            serde_json::from_slice(&inspect.stdout).map_err(|error| {
                if inspect.success {
                    format!("Docker inspect 结果格式无效：{error}")
                } else {
                    command_error("无法读取 Docker 容器详情", &inspect.stderr)
                }
            })?;
        Ok(Self::from_inspect(containers))
    }

    fn from_inspect(containers: Vec<InspectContainer>) -> Self {
        let mut mappings = Vec::new();
        for container in containers {
            let compose_project = container
                .config
                .labels
                .as_ref()
                .and_then(|labels| labels.get("com.docker.compose.project").cloned());
            let compose_service = container
                .config
                .labels
                .as_ref()
                .and_then(|labels| labels.get("com.docker.compose.service").cloned());
            for (container_endpoint, bindings) in container
                .network_settings
                .ports
                .as_ref()
                .into_iter()
                .flatten()
            {
                let Some((container_port, protocol)) = parse_container_endpoint(container_endpoint)
                else {
                    continue;
                };
                for binding in bindings.iter().flatten() {
                    let Ok(host_port) = binding.host_port.parse::<u16>() else {
                        continue;
                    };
                    mappings.push(DockerMapping {
                        host_ip: binding.host_ip.clone(),
                        host_port,
                        container_port,
                        protocol,
                        container_id: container.id.clone(),
                        container_name: container.name.trim_start_matches('/').to_string(),
                        image: container.config.image.clone(),
                        compose_project: compose_project.clone(),
                        compose_service: compose_service.clone(),
                    });
                }
            }
        }
        Self { mappings }
    }

    pub fn matches(&self, entry: &PortEntry) -> Vec<ServiceAttribution> {
        self.mappings
            .iter()
            .filter(|mapping| {
                mapping.protocol == entry.protocol
                    && mapping.host_port == entry.local_port
                    && host_matches(&mapping.host_ip, &entry.local_address)
            })
            .map(|mapping| {
                let compose = match (&mapping.compose_project, &mapping.compose_service) {
                    (Some(project), Some(service)) => Some(format!("{project}/{service}")),
                    _ => None,
                };
                let name = compose
                    .as_ref()
                    .map(|compose| format!("{} · {compose}", mapping.container_name))
                    .unwrap_or_else(|| mapping.container_name.clone());
                let mut facts = vec![
                    fact("容器 ID", truncate(&mapping.container_id, 12)),
                    fact("镜像", &mapping.image),
                    fact(
                        "端口映射",
                        format!(
                            "{}:{} → {}/{}",
                            if mapping.host_ip.is_empty() {
                                "*"
                            } else {
                                &mapping.host_ip
                            },
                            mapping.host_port,
                            mapping.container_port,
                            protocol_name(mapping.protocol)
                        ),
                    ),
                ];
                if let Some(compose) = compose {
                    facts.push(fact("Compose", compose));
                }
                ServiceAttribution {
                    kind: AttributionKind::DockerContainer,
                    name,
                    description: Some(format!("Docker 容器 · {}", mapping.image)),
                    confidence: AttributionConfidence::Exact,
                    source: "本地 Docker Engine published port".to_string(),
                    facts,
                }
            })
            .collect()
    }
}

fn docker_cli_path() -> Result<PathBuf, String> {
    let program_files = program_files_directory()?;
    let trusted = program_files.join("Docker/Docker/resources/bin/docker.exe");
    if trusted.is_file() {
        let canonical_program_files = std::fs::canonicalize(&program_files)
            .map_err(|error| format!("无法校验 Program Files 目录：{error}"))?;
        let canonical_docker = std::fs::canonicalize(&trusted)
            .map_err(|error| format!("无法校验 Docker CLI 路径：{error}"))?;
        if !canonical_docker.starts_with(&canonical_program_files) {
            return Err(
                "Docker CLI 最终路径不在受保护的 Program Files 目录，已拒绝执行".to_string(),
            );
        }
        return Ok(canonical_docker);
    }

    Err(
        "未在受保护的 Docker Desktop 安装目录找到 docker.exe；为防止搜索路径劫持，已跳过 Docker 归属识别"
            .to_string(),
    )
}

fn program_files_directory() -> Result<PathBuf, String> {
    let path = unsafe { SHGetKnownFolderPath(&FOLDERID_ProgramFiles, KF_FLAG_DEFAULT, None) }
        .map_err(|error| format!("无法读取 Windows Program Files 已知目录：{error}"))?;
    let text = unsafe { path.to_string() }
        .map_err(|error| format!("Program Files 目录不是有效 Unicode：{error}"));
    unsafe {
        CoTaskMemFree(Some(path.0.cast::<c_void>()));
    }
    text.map(PathBuf::from)
}

fn parse_container_endpoint(value: &str) -> Option<(u16, Protocol)> {
    let (port, protocol) = value.split_once('/')?;
    let protocol = match protocol.to_ascii_lowercase().as_str() {
        "tcp" => Protocol::Tcp,
        "udp" => Protocol::Udp,
        _ => return None,
    };
    Some((port.parse().ok()?, protocol))
}

fn host_matches(host: &str, local: &str) -> bool {
    let host = host.trim_matches(['[', ']']);
    let local = local.split('%').next().unwrap_or(local);
    host.is_empty()
        || (host == "0.0.0.0" && !local.contains(':'))
        || (host == "::" && local.contains(':'))
        || host == local
}

fn is_remote_engine(host: &str) -> bool {
    let host = host.trim_matches('"').to_ascii_lowercase();
    host.starts_with("tcp://")
        || host.starts_with("ssh://")
        || host.starts_with("http://")
        || host.starts_with("https://")
}

fn command_error(prefix: &str, stderr: &[u8]) -> String {
    let _ = stderr;
    prefix.to_string()
}

fn protocol_name(protocol: Protocol) -> &'static str {
    match protocol {
        Protocol::Tcp => "tcp",
        Protocol::Udp => "udp",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::types::{IpVersion, ProcessStatus};

    fn entry(protocol: Protocol, port: u16) -> PortEntry {
        PortEntry {
            protocol,
            ip_version: IpVersion::V4,
            local_address: "0.0.0.0".to_string(),
            local_port: port,
            remote_address: None,
            remote_port: None,
            state: None,
            pid: 1,
            process_name: Some("com.docker.backend.exe".to_string()),
            process_path: None,
            process_created_at: None,
            process_status: ProcessStatus::Partial,
            process_status_message: None,
            attributions: Vec::new(),
        }
    }

    #[test]
    fn maps_published_port_to_named_compose_container() {
        let json = br#"[{"Id":"abcdef1234567890","Name":"/api-1","Config":{"Image":"demo/api:1","Labels":{"com.docker.compose.project":"demo","com.docker.compose.service":"api"}},"NetworkSettings":{"Ports":{"8000/tcp":[{"HostIp":"0.0.0.0","HostPort":"18000"}]}}}]"#;
        let containers: Vec<InspectContainer> = serde_json::from_slice(json).unwrap();
        let result = DockerSnapshot::from_inspect(containers).matches(&entry(Protocol::Tcp, 18000));
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "api-1 · demo/api");
        assert_eq!(result[0].confidence, AttributionConfidence::Exact);
    }

    #[test]
    fn never_cross_matches_tcp_and_udp() {
        let json = br#"[{"Id":"abcdef123456","Name":"/dns","Config":{"Image":"dns","Labels":{}},"NetworkSettings":{"Ports":{"53/udp":[{"HostIp":"0.0.0.0","HostPort":"53"}]}}}]"#;
        let containers: Vec<InspectContainer> = serde_json::from_slice(json).unwrap();
        let snapshot = DockerSnapshot::from_inspect(containers);
        assert!(snapshot.matches(&entry(Protocol::Tcp, 53)).is_empty());
        assert_eq!(snapshot.matches(&entry(Protocol::Udp, 53)).len(), 1);
    }

    #[test]
    fn accepts_null_optional_docker_inspect_maps_and_keeps_ip_families_separate() {
        let json = br#"[{"Id":"abcdef123456","Name":"/empty","Config":{"Image":"demo","Labels":null},"NetworkSettings":{"Ports":null}}]"#;
        let containers: Vec<InspectContainer> = serde_json::from_slice(json).unwrap();
        assert!(DockerSnapshot::from_inspect(containers).mappings.is_empty());
        assert!(!host_matches("::", "0.0.0.0"));
        assert!(!host_matches("0.0.0.0", "::"));
    }

    #[test]
    fn program_files_lookup_returns_an_absolute_protected_root() {
        let path = program_files_directory().unwrap();
        assert!(path.is_absolute());
        assert!(path
            .to_string_lossy()
            .to_ascii_lowercase()
            .contains("program files"));
    }

    #[test]
    fn docker_cli_never_falls_back_to_a_bare_program_name() {
        if let Ok(path) = docker_cli_path() {
            assert!(path.is_absolute());
            assert_ne!(path, PathBuf::from("docker.exe"));
        }
    }
}
