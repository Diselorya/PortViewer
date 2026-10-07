use std::collections::{HashSet, VecDeque};
use std::ffi::c_void;
use std::fs;
use std::net::IpAddr;
use std::path::{Component, Path, PathBuf, Prefix};

use regex::Regex;
use windows::Win32::System::Com::CoTaskMemFree;
use windows::Win32::UI::Shell::{FOLDERID_ProgramFiles, SHGetKnownFolderPath, KF_FLAG_DEFAULT};

use super::runtime::tokenize;
use super::system::{fact, SystemSnapshot};
use crate::network::types::{
    AttributionConfidence, AttributionKind, PortEntry, Protocol, ServiceAttribution,
};

const MAX_FILE_SIZE: u64 = 2 * 1024 * 1024;
const MAX_TOTAL_SIZE: u64 = 10 * 1024 * 1024;
const MAX_FILES: usize = 100;

#[derive(Debug, Clone, Default)]
pub struct NginxSnapshot {
    sites: Vec<NginxSite>,
    process_ids: HashSet<u32>,
}

#[derive(Debug, Clone, Default)]
struct NginxSite {
    names: Vec<String>,
    listeners: Vec<NginxListener>,
    source: PathBuf,
}

#[derive(Debug, Clone)]
struct NginxListener {
    address: String,
    port: u16,
    ip_version: crate::network::types::IpVersion,
}

impl NginxSnapshot {
    pub fn collect(
        system: Option<&SystemSnapshot>,
        entries: &[PortEntry],
    ) -> Result<Option<Self>, String> {
        let mut roots = HashSet::new();
        let mut process_ids = HashSet::new();
        if let Some(system) = system {
            for process in system
                .processes
                .values()
                .filter(|process| is_nginx_name(process.name.as_deref()))
            {
                process_ids.insert(process.process_id);
                if let Some(root) = nginx_config_path(
                    process.executable_path.as_deref(),
                    process.command_line.as_deref(),
                ) {
                    roots.insert(root);
                }
            }
        }
        for entry in entries
            .iter()
            .filter(|entry| is_nginx_name(entry.process_name.as_deref()))
        {
            process_ids.insert(entry.pid);
            if let Some(root) = nginx_config_path(entry.process_path.as_deref(), None) {
                roots.insert(root);
            }
        }
        if process_ids.is_empty() {
            return Ok(None);
        }
        if roots.is_empty() {
            return Err("已发现 nginx 进程，但无法定位 nginx.conf".to_string());
        }
        let mut sites = Vec::new();
        let mut errors = Vec::new();
        for (root, allowed_root) in roots {
            match parse_config_graph(&root, &allowed_root) {
                Ok(mut parsed) => sites.append(&mut parsed),
                Err(error) => errors.push(error),
            }
        }
        if sites.is_empty() && !errors.is_empty() {
            return Err(errors.join("；"));
        }
        Ok(Some(Self { sites, process_ids }))
    }

    pub fn matches(&self, entry: &PortEntry) -> Vec<ServiceAttribution> {
        if entry.protocol != Protocol::Tcp || !self.process_ids.contains(&entry.pid) {
            return Vec::new();
        }
        self.sites
            .iter()
            .flat_map(|site| {
                site.listeners.iter().filter_map(move |listener| {
                    if listener.port != entry.local_port
                        || !listener_matches(listener, &entry.local_address, entry.ip_version)
                    {
                        return None;
                    }
                    let names: Vec<String> = site
                        .names
                        .iter()
                        .filter(|name| name.as_str() != "_")
                        .cloned()
                        .collect();
                    let name = names
                        .first()
                        .cloned()
                        .unwrap_or_else(|| format!("Nginx 默认站点 :{}", listener.port));
                    let mut facts = vec![
                        fact(
                            "监听",
                            format!(
                                "{}:{}",
                                if listener.address.is_empty() {
                                    "*"
                                } else {
                                    &listener.address
                                },
                                listener.port
                            ),
                        ),
                        fact("配置来源", site.source.to_string_lossy()),
                    ];
                    if !names.is_empty() {
                        facts.push(fact("server_name", names.join("、")));
                    }
                    Some(ServiceAttribution {
                        kind: AttributionKind::NginxSite,
                        name,
                        description: Some(if names.len() > 1 {
                            format!("Nginx 虚拟主机 · 另有 {} 个名称", names.len() - 1)
                        } else {
                            "Nginx 虚拟主机".to_string()
                        }),
                        confidence: AttributionConfidence::High,
                        source: "nginx.conf server/listen/server_name".to_string(),
                        facts,
                    })
                })
            })
            .collect()
    }
}

fn is_nginx_name(name: Option<&str>) -> bool {
    name.is_some_and(|name| {
        name.eq_ignore_ascii_case("nginx.exe") || name.eq_ignore_ascii_case("nginx")
    })
}

fn nginx_config_path(
    executable: Option<&str>,
    command: Option<&str>,
) -> Option<(PathBuf, PathBuf)> {
    let executable = Path::new(executable?);
    let install_root = executable.parent()?.to_path_buf();
    if !is_local_disk_path(executable) || !is_local_disk_path(&install_root) {
        return None;
    }
    let protected_root = program_files_directory().ok()?;
    if !is_lexically_within(&install_root, &protected_root) {
        return None;
    }
    let mut prefix = install_root.clone();
    let mut config: Option<PathBuf> = None;
    if let Some(command) = command {
        let tokens = tokenize(command);
        let mut index = 1;
        while index < tokens.len() {
            match tokens[index].as_str() {
                "-p" if index + 1 < tokens.len() => {
                    prefix = PathBuf::from(&tokens[index + 1]);
                    index += 2;
                }
                "-c" if index + 1 < tokens.len() => {
                    config = Some(PathBuf::from(&tokens[index + 1]));
                    index += 2;
                }
                value if value.starts_with("-p") && value.len() > 2 => {
                    prefix = PathBuf::from(&value[2..]);
                    index += 1;
                }
                value if value.starts_with("-c") && value.len() > 2 => {
                    config = Some(PathBuf::from(&value[2..]));
                    index += 1;
                }
                _ => index += 1,
            }
        }
    }
    if !prefix.is_absolute() {
        prefix = install_root.join(prefix);
    }
    if !is_local_disk_path(&prefix) || !is_lexically_within(&prefix, &install_root) {
        return None;
    }
    let config = config.unwrap_or_else(|| PathBuf::from("conf").join("nginx.conf"));
    let candidate = if config.is_absolute() {
        config
    } else {
        prefix.join(config)
    };
    if !is_local_disk_path(&candidate) || !is_lexically_within(&candidate, &install_root) {
        return None;
    }
    Some((candidate, install_root))
}

fn parse_config_graph(root: &Path, allowed_root: &Path) -> Result<Vec<NginxSite>, String> {
    if !is_local_disk_path(root) || !is_local_disk_path(allowed_root) {
        return Err("Nginx 配置必须位于本机磁盘路径".to_string());
    }
    let canonical_allowed_root = fs::canonicalize(allowed_root)
        .map_err(|error| format!("无法校验 Nginx 安装目录：{error}"))?;
    let mut queue = VecDeque::from([root.to_path_buf()]);
    let mut visited = HashSet::new();
    let mut total_size = 0_u64;
    let mut sites = Vec::new();
    while let Some(path) = queue.pop_front() {
        if visited.len() >= MAX_FILES {
            return Err(format!("Nginx include 超过 {MAX_FILES} 个文件上限"));
        }
        let canonical = fs::canonicalize(&path)
            .map_err(|error| format!("无法读取 Nginx 配置 {}：{error}", path.display()))?;
        if !canonical.starts_with(&canonical_allowed_root) {
            return Err(format!(
                "Nginx 配置路径超出受信安装目录：{}",
                canonical.display()
            ));
        }
        if !visited.insert(canonical.clone()) {
            continue;
        }
        let metadata = fs::metadata(&canonical)
            .map_err(|error| format!("无法读取 Nginx 配置元数据：{error}"))?;
        if metadata.len() > MAX_FILE_SIZE {
            return Err(format!(
                "Nginx 配置 {} 超过 2 MiB 上限",
                canonical.display()
            ));
        }
        total_size = total_size.saturating_add(metadata.len());
        if total_size > MAX_TOTAL_SIZE {
            return Err("Nginx 配置及 include 总计超过 10 MiB 上限".to_string());
        }
        let contents = fs::read_to_string(&canonical)
            .or_else(|_| {
                fs::read(&canonical).map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            })
            .map_err(|error| format!("无法读取 Nginx 配置 {}：{error}", canonical.display()))?;
        let parsed = parse_tokens(&lex(&contents), canonical.clone());
        sites.extend(parsed.sites);
        for include in parsed.includes {
            let include = if include.is_absolute() {
                include
            } else {
                canonical.parent().unwrap_or(Path::new(".")).join(include)
            };
            for expanded in expand_pattern(&include, &canonical_allowed_root)? {
                queue.push_back(expanded);
            }
        }
    }
    Ok(sites)
}

#[derive(Default)]
struct ParsedConfig {
    sites: Vec<NginxSite>,
    includes: Vec<PathBuf>,
}

fn parse_tokens(tokens: &[String], source: PathBuf) -> ParsedConfig {
    let mut result = ParsedConfig::default();
    let mut depth = 0_usize;
    let mut server_depth: Option<usize> = None;
    let mut current = NginxSite {
        source,
        ..Default::default()
    };
    let mut index = 0;
    while index < tokens.len() {
        let token = tokens[index].as_str();
        if token == "server" && tokens.get(index + 1).is_some_and(|value| value == "{") {
            depth += 1;
            server_depth = Some(depth);
            current = NginxSite {
                source: current.source.clone(),
                ..Default::default()
            };
            index += 2;
            continue;
        }
        if token == "{" {
            depth += 1;
            index += 1;
            continue;
        }
        if token == "}" {
            if server_depth == Some(depth) {
                if !current.listeners.is_empty() {
                    result.sites.push(std::mem::take(&mut current));
                    current.source = result.sites.last().unwrap().source.clone();
                }
                server_depth = None;
            }
            depth = depth.saturating_sub(1);
            index += 1;
            continue;
        }
        if token == "include" {
            let (values, next) = directive_values(tokens, index + 1);
            result
                .includes
                .extend(values.into_iter().map(PathBuf::from));
            index = next;
            continue;
        }
        if server_depth.is_some() && (token == "listen" || token == "server_name") {
            let (values, next) = directive_values(tokens, index + 1);
            if token == "listen" {
                if let Some(listener) = values.first().and_then(|value| parse_listener(value)) {
                    current.listeners.push(listener);
                }
            } else {
                current
                    .names
                    .extend(values.into_iter().filter(|value| !value.is_empty()));
            }
            index = next;
            continue;
        }
        index += 1;
    }
    result
}

fn directive_values(tokens: &[String], mut index: usize) -> (Vec<String>, usize) {
    let mut values = Vec::new();
    while index < tokens.len()
        && tokens[index] != ";"
        && tokens[index] != "{"
        && tokens[index] != "}"
    {
        values.push(tokens[index].clone());
        index += 1;
    }
    if tokens.get(index).is_some_and(|value| value == ";") {
        index += 1;
    }
    (values, index)
}

fn parse_listener(value: &str) -> Option<NginxListener> {
    if value.starts_with("unix:") {
        return None;
    }
    if let Ok(port) = value.parse::<u16>() {
        return Some(NginxListener {
            address: String::new(),
            port,
            ip_version: crate::network::types::IpVersion::V4,
        });
    }
    let (address, port) = value.rsplit_once(':')?;
    Some(NginxListener {
        address: address.trim_matches(['[', ']']).to_string(),
        port: port.parse().ok()?,
        ip_version: if address.contains(':') {
            crate::network::types::IpVersion::V6
        } else {
            crate::network::types::IpVersion::V4
        },
    })
}

fn listener_matches(
    listener: &NginxListener,
    local: &str,
    ip_version: crate::network::types::IpVersion,
) -> bool {
    if listener.ip_version != ip_version {
        return false;
    }
    let binding = listener.address.as_str();
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

fn expand_pattern(pattern: &Path, allowed_root: &Path) -> Result<Vec<PathBuf>, String> {
    if !is_internal_local_disk_path(pattern) || !is_internal_within(pattern, allowed_root) {
        return Err("Nginx include 必须位于本机磁盘路径".to_string());
    }
    let text = pattern.to_string_lossy();
    if !text.contains(['*', '?']) {
        return Ok(vec![pattern.to_path_buf()]);
    }
    let parent = pattern.parent().unwrap_or(Path::new("."));
    let canonical_parent = fs::canonicalize(parent)
        .map_err(|error| format!("无法校验 Nginx include 目录：{error}"))?;
    if !canonical_parent.starts_with(allowed_root) {
        return Err(format!(
            "Nginx include 超出受信安装目录：{}",
            canonical_parent.display()
        ));
    }
    let file_pattern = pattern
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("*");
    let regex = Regex::new(&format!(
        "^{}$",
        regex::escape(file_pattern)
            .replace("\\*", ".*")
            .replace("\\?", ".")
    ))
    .map_err(|error| format!("Nginx include 通配符无效：{error}"))?;
    let mut result = fs::read_dir(&canonical_parent)
        .map_err(|error| format!("无法展开 Nginx include {}：{error}", pattern.display()))?
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
        .filter(|entry| regex.is_match(&entry.file_name().to_string_lossy()))
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    result.sort();
    Ok(result)
}

fn is_local_disk_path(path: &Path) -> bool {
    matches!(
        path.components().next(),
        Some(Component::Prefix(prefix)) if matches!(prefix.kind(), Prefix::Disk(_))
    ) && path.is_absolute()
}

fn is_internal_local_disk_path(path: &Path) -> bool {
    matches!(
        path.components().next(),
        Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_))
    ) && path.is_absolute()
}

fn normalized_internal_path(path: &Path) -> Option<Vec<String>> {
    if !is_internal_local_disk_path(path) {
        return None;
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => match prefix.kind() {
                Prefix::Disk(drive) | Prefix::VerbatimDisk(drive) => {
                    parts.push(format!("{}:", (drive as char).to_ascii_lowercase()));
                }
                _ => return None,
            },
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                if parts.len() <= 1 {
                    return None;
                }
                parts.pop();
            }
            Component::Normal(value) => parts.push(value.to_string_lossy().to_ascii_lowercase()),
        }
    }
    Some(parts)
}

fn is_internal_within(candidate: &Path, root: &Path) -> bool {
    let (Some(candidate), Some(root)) = (
        normalized_internal_path(candidate),
        normalized_internal_path(root),
    ) else {
        return false;
    };
    candidate.starts_with(&root)
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

fn normalized_local_path(path: &Path) -> Option<Vec<String>> {
    if !is_local_disk_path(path) {
        return None;
    }
    let mut parts = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                let Prefix::Disk(drive) = prefix.kind() else {
                    return None;
                };
                parts.push(format!("{}:", (drive as char).to_ascii_lowercase()));
            }
            Component::RootDir | Component::CurDir => {}
            Component::ParentDir => {
                if parts.len() <= 1 {
                    return None;
                }
                parts.pop();
            }
            Component::Normal(value) => parts.push(value.to_string_lossy().to_ascii_lowercase()),
        }
    }
    Some(parts)
}

fn is_lexically_within(candidate: &Path, root: &Path) -> bool {
    let (Some(candidate), Some(root)) = (
        normalized_local_path(candidate),
        normalized_local_path(root),
    ) else {
        return false;
    };
    candidate.starts_with(&root)
}

fn lex(contents: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut current = String::new();
    let mut quote = '\0';
    let mut comment = false;
    for character in contents.chars() {
        if comment {
            if character == '\n' {
                comment = false;
            }
            continue;
        }
        if quote != '\0' {
            if character == quote {
                quote = '\0';
            } else {
                current.push(character);
            }
            continue;
        }
        match character {
            '#' => comment = true,
            '"' | '\'' => quote = character,
            '{' | '}' | ';' => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
                tokens.push(character.to_string());
            }
            value if value.is_whitespace() => {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            }
            value => current.push(value),
        }
    }
    if !current.is_empty() {
        tokens.push(current);
    }
    tokens
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multiple_virtual_hosts_without_collapsing_them() {
        let parsed = parse_tokens(
            &lex(
                r#"http { server { listen 80; server_name api.test api.local; } server { listen 127.0.0.1:80; server_name admin.test; } }"#,
            ),
            PathBuf::from("nginx.conf"),
        );
        assert_eq!(parsed.sites.len(), 2);
        assert_eq!(parsed.sites[0].names, ["api.test", "api.local"]);
        assert_eq!(parsed.sites[1].listeners[0].address, "127.0.0.1");
    }

    #[test]
    fn ignores_comments_and_unix_sockets() {
        let parsed = parse_tokens(
            &lex("server { # listen 99;\n listen unix:/tmp/nginx.sock; listen [::]:443 ssl; server_name _; }"),
            PathBuf::from("site.conf"),
        );
        assert_eq!(parsed.sites.len(), 1);
        assert_eq!(parsed.sites[0].listeners.len(), 1);
        assert_eq!(parsed.sites[0].listeners[0].port, 443);
    }

    #[test]
    fn resolves_command_line_prefix_and_config() {
        let protected = program_files_directory().unwrap();
        let executable = protected.join(r#"nginx\nginx.exe"#);
        let prefix = protected.join(r#"nginx\runtime"#);
        let root = nginx_config_path(
            executable.to_str(),
            Some(&format!(
                r#"nginx.exe -p "{}" -c conf\custom.conf"#,
                prefix.display()
            )),
        )
        .unwrap();
        assert_eq!(root.0, prefix.join(r#"conf\custom.conf"#));
        assert_eq!(root.1, protected.join("nginx"));
    }

    #[test]
    fn rejects_network_device_and_out_of_tree_config_paths_without_io() {
        for executable in [
            r#"\\server\share\nginx.exe"#,
            r#"\\?\C:\nginx\nginx.exe"#,
            r#"\\.\C:\nginx\nginx.exe"#,
        ] {
            assert!(nginx_config_path(Some(executable), None).is_none());
        }
        assert!(nginx_config_path(
            Some(r#"C:\nginx\nginx.exe"#),
            Some(r#"nginx.exe -c C:\Windows\win.ini"#),
        )
        .is_none());
        assert!(nginx_config_path(
            Some(r#"C:\nginx\nginx.exe"#),
            Some(r#"nginx.exe -p \\server\share -c nginx.conf"#),
        )
        .is_none());
    }

    #[test]
    fn compares_disk_and_verbatim_disk_paths_as_the_same_internal_root() {
        let disk_root = Path::new(r#"C:\Program Files\nginx"#);
        let verbatim_root = Path::new(r#"\\?\C:\Program Files\nginx"#);
        let disk_child = Path::new(r#"C:\Program Files\nginx\conf\sites\api.conf"#);
        let verbatim_child = Path::new(r#"\\?\C:\Program Files\nginx\conf\sites\api.conf"#);

        assert!(is_internal_within(disk_child, verbatim_root));
        assert!(is_internal_within(verbatim_child, disk_root));
    }

    #[test]
    fn rejects_internal_paths_on_another_drive_or_in_a_sibling_directory() {
        let root = Path::new(r#"C:\Program Files\nginx"#);

        assert!(!is_internal_within(
            Path::new(r#"D:\Program Files\nginx\conf\nginx.conf"#),
            root,
        ));
        assert!(!is_internal_within(
            Path::new(r#"C:\Program Files\nginx-malicious\nginx.conf"#),
            root,
        ));
    }

    #[test]
    fn wildcard_listeners_do_not_cross_ip_families() {
        use crate::network::types::IpVersion;
        let v4 = parse_listener("80").unwrap();
        let v6 = parse_listener("[::]:80").unwrap();
        assert!(listener_matches(&v4, "127.0.0.1", IpVersion::V4));
        assert!(!listener_matches(&v4, "::1", IpVersion::V6));
        assert!(listener_matches(&v6, "::1", IpVersion::V6));
        assert!(!listener_matches(&v6, "127.0.0.1", IpVersion::V4));
        assert_eq!(
            parse_ip_without_scope("0:0:0:0:0:0:0:1"),
            parse_ip_without_scope("::1")
        );
    }
}
