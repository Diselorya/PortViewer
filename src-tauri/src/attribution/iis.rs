use std::collections::HashSet;
use std::fs;
use std::net::IpAddr;
use std::path::PathBuf;

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use windows::Win32::System::SystemInformation::GetWindowsDirectoryW;

use super::runtime::tokenize;
use super::system::{fact, SystemSnapshot};
use crate::network::types::{
    AttributionConfidence, AttributionKind, PortEntry, Protocol, ServiceAttribution,
};

const MAX_CONFIG_SIZE: u64 = 8 * 1024 * 1024;

#[derive(Debug, Clone, Default)]
pub struct IisSnapshot {
    sites: Vec<IisSite>,
    config_path: PathBuf,
}

#[derive(Debug, Clone, Default)]
struct IisSite {
    name: String,
    id: Option<String>,
    bindings: Vec<IisBinding>,
    app_pools: HashSet<String>,
}

#[derive(Debug, Clone)]
struct IisBinding {
    protocol: String,
    ip: String,
    port: u16,
    host: String,
}

impl IisSnapshot {
    pub fn collect() -> Result<Option<Self>, String> {
        let path = windows_directory()?
            .join("System32")
            .join("inetsrv")
            .join("config")
            .join("applicationHost.config");
        if !path.is_file() {
            return Ok(None);
        }
        let metadata =
            fs::metadata(&path).map_err(|error| format!("无法读取 IIS 配置元数据：{error}"))?;
        if metadata.len() > MAX_CONFIG_SIZE {
            return Err("IIS 配置超过 8 MiB 安全上限".to_string());
        }
        let contents = fs::read(&path).map_err(|error| format!("无法读取 IIS 配置：{error}"))?;
        Self::parse(&contents, path).map(Some)
    }

    fn parse(contents: &[u8], config_path: PathBuf) -> Result<Self, String> {
        let mut reader = Reader::from_reader(contents);
        reader.config_mut().trim_text(true);
        let mut current: Option<IisSite> = None;
        let mut sites = Vec::new();
        loop {
            match reader.read_event() {
                Ok(Event::Start(event)) if event.name().as_ref() == b"site" => {
                    current = Some(IisSite {
                        name: attribute(&event, b"name")
                            .unwrap_or_else(|| "未命名 IIS 站点".to_string()),
                        id: attribute(&event, b"id"),
                        ..Default::default()
                    });
                }
                Ok(Event::Empty(event)) | Ok(Event::Start(event))
                    if event.name().as_ref() == b"binding" =>
                {
                    if let Some(site) = current.as_mut() {
                        if let Some(binding) = parse_binding(&event) {
                            site.bindings.push(binding);
                        }
                    }
                }
                Ok(Event::Empty(event)) | Ok(Event::Start(event))
                    if event.name().as_ref() == b"application" =>
                {
                    if let (Some(site), Some(pool)) =
                        (current.as_mut(), attribute(&event, b"applicationPool"))
                    {
                        if !pool.is_empty() {
                            site.app_pools.insert(pool);
                        }
                    }
                }
                Ok(Event::End(event)) if event.name().as_ref() == b"site" => {
                    if let Some(site) = current.take() {
                        sites.push(site);
                    }
                }
                Ok(Event::Eof) => break,
                Ok(_) => {}
                Err(error) => return Err(format!("IIS applicationHost.config XML 无效：{error}")),
            }
        }
        Ok(Self { sites, config_path })
    }

    pub fn matches(
        &self,
        entry: &PortEntry,
        system: Option<&SystemSnapshot>,
    ) -> Vec<ServiceAttribution> {
        if entry.protocol != Protocol::Tcp {
            return Vec::new();
        }
        let process_name = entry
            .process_name
            .as_deref()
            .unwrap_or_default()
            .to_ascii_lowercase();
        let app_pool = system
            .and_then(|snapshot| snapshot.process(entry.pid))
            .filter(|process| {
                process
                    .name
                    .as_deref()
                    .unwrap_or_default()
                    .eq_ignore_ascii_case("w3wp.exe")
            })
            .and_then(|process| {
                app_pool_from_command(process.command_line.as_deref().unwrap_or_default())
            });
        let is_http_sys = entry.pid == 4 || process_name == "system";
        if !is_http_sys && app_pool.is_none() {
            return Vec::new();
        }
        let mut result = Vec::new();
        if let Some(pool) = &app_pool {
            let related_sites: Vec<String> = self
                .sites
                .iter()
                .filter(|site| site.app_pools.contains(pool))
                .map(|site| site.name.clone())
                .collect();
            result.push(ServiceAttribution {
                kind: AttributionKind::IisAppPool,
                name: pool.clone(),
                description: Some("IIS Application Pool".to_string()),
                confidence: AttributionConfidence::Exact,
                source: "w3wp.exe -ap 参数".to_string(),
                facts: if related_sites.is_empty() {
                    vec![fact("应用池", pool)]
                } else {
                    vec![
                        fact("应用池", pool),
                        fact("关联站点", related_sites.join("、")),
                    ]
                },
            });
        }
        if is_http_sys {
            for site in &self.sites {
                for binding in site.bindings.iter().filter(|binding| {
                    (binding.protocol.eq_ignore_ascii_case("http")
                        || binding.protocol.eq_ignore_ascii_case("https"))
                        && binding.port == entry.local_port
                        && binding_ip_matches(&binding.ip, &entry.local_address, entry.ip_version)
                }) {
                    let mut facts = vec![
                        fact("协议", &binding.protocol),
                        fact("绑定", binding_label(binding)),
                        fact("配置", self.config_path.to_string_lossy()),
                    ];
                    if let Some(id) = &site.id {
                        facts.push(fact("站点 ID", id));
                    }
                    if !site.app_pools.is_empty() {
                        facts.push(fact(
                            "应用池",
                            site.app_pools
                                .iter()
                                .cloned()
                                .collect::<Vec<_>>()
                                .join("、"),
                        ));
                    }
                    result.push(ServiceAttribution {
                        kind: AttributionKind::IisSite,
                        name: site.name.clone(),
                        description: Some(if binding.host.is_empty() {
                            format!("IIS {} 站点", binding.protocol.to_ascii_uppercase())
                        } else {
                            format!("IIS 站点 · {}", binding.host)
                        }),
                        confidence: AttributionConfidence::High,
                        source: "IIS applicationHost.config binding + HTTP.sys PID".to_string(),
                        facts,
                    });
                }
            }
        }
        result
    }
}

fn windows_directory() -> Result<PathBuf, String> {
    let mut buffer = vec![0_u16; 32_768];
    let length = unsafe { GetWindowsDirectoryW(Some(&mut buffer)) } as usize;
    if length == 0 || length >= buffer.len() {
        return Err("无法从 Windows API 读取系统目录".to_string());
    }
    let path = PathBuf::from(String::from_utf16_lossy(&buffer[..length]));
    if !path.is_absolute() || path.to_string_lossy().starts_with("\\\\") {
        return Err("Windows API 返回了不受信的系统目录".to_string());
    }
    Ok(path)
}

fn attribute(event: &BytesStart<'_>, name: &[u8]) -> Option<String> {
    event
        .attributes()
        .with_checks(false)
        .flatten()
        .find(|attribute| attribute.key.as_ref() == name)
        .map(|attribute| String::from_utf8_lossy(attribute.value.as_ref()).into_owned())
}

fn parse_binding(event: &BytesStart<'_>) -> Option<IisBinding> {
    let protocol = attribute(event, b"protocol")?;
    let information = attribute(event, b"bindingInformation")?;
    let mut parts = information.rsplitn(3, ':');
    let host = parts.next()?.to_string();
    let port = parts.next()?.parse::<u16>().ok()?;
    let ip = parts.next()?.trim_matches(['[', ']']).to_string();
    Some(IisBinding {
        protocol,
        ip,
        port,
        host,
    })
}

fn binding_ip_matches(
    binding: &str,
    local: &str,
    ip_version: crate::network::types::IpVersion,
) -> bool {
    let binding_is_v6 = binding.contains(':');
    let local_is_v6 = local.contains(':');
    if binding_is_v6 != local_is_v6 && !binding.is_empty() && binding != "*" {
        return false;
    }
    if (binding == "0.0.0.0" && ip_version != crate::network::types::IpVersion::V4)
        || (binding == "::" && ip_version != crate::network::types::IpVersion::V6)
    {
        return false;
    }
    if binding.is_empty() || binding == "*" || binding == "0.0.0.0" || binding == "::" {
        return true;
    }
    parse_ip_without_scope(binding)
        .is_some_and(|binding| parse_ip_without_scope(local).is_some_and(|local| binding == local))
}

fn parse_ip_without_scope(value: &str) -> Option<IpAddr> {
    value
        .trim_matches(['[', ']'])
        .split('%')
        .next()
        .and_then(|value| value.parse().ok())
}

fn binding_label(binding: &IisBinding) -> String {
    format!(
        "{}:{}{}",
        if binding.ip.is_empty() {
            "*"
        } else {
            &binding.ip
        },
        binding.port,
        if binding.host.is_empty() {
            String::new()
        } else {
            format!(":{}", binding.host)
        }
    )
}

fn app_pool_from_command(command: &str) -> Option<String> {
    let tokens = tokenize(command);
    tokens
        .windows(2)
        .find(|pair| pair[0].eq_ignore_ascii_case("-ap"))
        .map(|pair| pair[1].clone())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::network::types::{IpVersion, ProcessStatus};

    const CONFIG: &[u8] = br#"<configuration><system.applicationHost><sites><site name="Default Web Site" id="1"><application path="/" applicationPool="DefaultAppPool"/><bindings><binding protocol="http" bindingInformation="*:80:"/><binding protocol="https" bindingInformation="*:443:example.test"/></bindings></site><site name="Admin" id="2"><application path="/" applicationPool="AdminPool"/><bindings><binding protocol="http" bindingInformation="127.0.0.1:80:admin.test"/></bindings></site></sites></system.applicationHost></configuration>"#;

    fn system_entry(port: u16) -> PortEntry {
        PortEntry {
            protocol: Protocol::Tcp,
            ip_version: IpVersion::V4,
            local_address: "127.0.0.1".to_string(),
            local_port: port,
            remote_address: None,
            remote_port: None,
            state: None,
            pid: 4,
            process_name: Some("System".to_string()),
            process_path: None,
            process_created_at: None,
            process_status: ProcessStatus::System,
            process_status_message: None,
            attributions: Vec::new(),
        }
    }

    #[test]
    fn keeps_all_iis_virtual_hosts_on_the_same_port() {
        let snapshot = IisSnapshot::parse(CONFIG, PathBuf::from("applicationHost.config")).unwrap();
        let result = snapshot.matches(&system_entry(80), None);
        assert_eq!(result.len(), 2);
        assert_eq!(result[0].name, "Default Web Site");
        assert_eq!(result[1].name, "Admin");
    }

    #[test]
    fn extracts_w3wp_application_pool() {
        assert_eq!(
            app_pool_from_command(r#"w3wp.exe -ap "DefaultAppPool" -v v4.0"#).as_deref(),
            Some("DefaultAppPool")
        );
    }

    #[test]
    fn system_directory_comes_from_windows_api_not_environment() {
        let path = windows_directory().unwrap();
        assert!(path.is_absolute());
        assert!(!path.to_string_lossy().starts_with("\\\\"));
    }

    #[test]
    fn wildcard_bindings_do_not_cross_ip_families() {
        use crate::network::types::IpVersion;
        assert!(binding_ip_matches("0.0.0.0", "127.0.0.1", IpVersion::V4));
        assert!(!binding_ip_matches("0.0.0.0", "::1", IpVersion::V6));
        assert!(binding_ip_matches("::", "::1", IpVersion::V6));
        assert!(!binding_ip_matches("::", "127.0.0.1", IpVersion::V4));
        assert!(binding_ip_matches("0:0:0:0:0:0:0:1", "::1", IpVersion::V6));
    }
}
