//! Read-only workload attribution. Raw command lines, environments and arbitrary
//! Docker labels are intentionally never placed in the API response.
#![cfg_attr(not(target_os = "linux"), allow(dead_code))]

use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::{self, Read};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{mpsc, OnceLock};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const FILE_LIMIT: u64 = 256 * 1024;
const OUTPUT_LIMIT: u64 = 1024 * 1024;
const MAX_ITEMS: usize = 128;

#[derive(Clone, Debug, Serialize)]
pub struct Fact {
    pub label: String,
    pub value: String,
}

#[derive(Clone, Debug, Serialize)]
pub struct Attribution {
    pub kind: &'static str,
    pub name: String,
    pub description: Option<String>,
    pub confidence: &'static str,
    pub source: String,
    pub facts: Vec<Fact>,
}

#[derive(Clone, Debug, Serialize)]
pub struct Report {
    pub resolver: &'static str,
    pub status: &'static str,
    pub matched_count: usize,
    pub message: Option<String>,
    pub elevation_may_help: bool,
}

impl Report {
    fn new(resolver: &'static str, status: &'static str, message: Option<&str>) -> Self {
        Self {
            resolver,
            status,
            matched_count: 0,
            message: message.map(str::to_owned),
            elevation_may_help: false,
        }
    }
}

fn fact(label: &str, value: impl Into<String>) -> Fact {
    Fact {
        label: label.to_owned(),
        value: clean(&value.into()),
    }
}

fn clean(value: &str) -> String {
    value
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(2048)
        .collect::<String>()
        .trim()
        .to_owned()
}

#[derive(Clone, Debug, Default)]
pub struct Process {
    pub pid: u32,
    pub name: String,
    pub exe: Option<PathBuf>,
    pub cwd: Option<PathBuf>,
    /// Reader root in the target process's mount namespace. Displayed project
    /// paths remain namespace paths, never this /proc implementation path.
    pub root: Option<PathBuf>,
    pub args: Vec<String>,
    pub service: Option<String>,
    pub user_service: bool,
    pub container_id: Option<String>,
    pub user_home: Option<PathBuf>,
    pub npm_script: Option<String>,
    pub limited: bool,
}

pub fn read_process(pid: u32, name: &str, exe: Option<&str>) -> Process {
    let base = PathBuf::from(format!("/proc/{pid}"));
    let command = read_limited(&base.join("cmdline"), FILE_LIMIT);
    let cgroup = read_limited(&base.join("cgroup"), FILE_LIMIT);
    let (service, user_service, container_id) = cgroup
        .as_ref()
        .map(|bytes| parse_cgroup(&String::from_utf8_lossy(bytes)))
        .unwrap_or_default();
    let cwd = fs::read_link(base.join("cwd")).ok();
    let root_path = base.join("root");
    let root = fs::read_link(&root_path).ok().map(|_| root_path);
    let proc_exe = fs::read_link(base.join("exe")).ok();
    let status = read_limited(&base.join("status"), FILE_LIMIT).ok();
    let status = status.as_ref().map(|bytes| String::from_utf8_lossy(bytes));
    let property = |key: &str| {
        status
            .as_ref()?
            .lines()
            .find_map(|line| line.strip_prefix(key))?
            .split_whitespace()
            .next()?
            .parse::<u32>()
            .ok()
    };
    let parent_pid = property("PPid:").unwrap_or_default();
    let user_home = property("Uid:").and_then(user_home);
    let npm_script = npm_script_from_ancestors(parent_pid);
    let limited = command.is_err()
        || cgroup.is_err()
        || cwd.is_none()
        || proc_exe.is_none()
        || root.is_none();
    Process {
        pid,
        name: name.to_owned(),
        exe: proc_exe.or_else(|| exe.map(PathBuf::from)),
        cwd,
        root,
        args: command
            .as_ref()
            .map(|bytes| {
                bytes
                    .split(|byte| *byte == 0)
                    .filter(|part| !part.is_empty())
                    .take(256)
                    .map(|part| String::from_utf8_lossy(part).into_owned())
                    .collect()
            })
            .unwrap_or_default(),
        service,
        user_service,
        container_id,
        user_home,
        npm_script,
        limited,
    }
}

fn parse_cgroup(value: &str) -> (Option<String>, bool, Option<String>) {
    let mut service = None;
    let mut user_service = false;
    let mut container = None;
    for line in value.lines() {
        let Some(path) = line.splitn(3, ':').nth(2) else {
            continue;
        };
        for component in path.split('/') {
            if component.ends_with(".service")
                && !component.starts_with("user@")
                && valid_unit(component)
            {
                service = Some(component.to_owned());
                user_service = path.contains("/user.slice/");
            }
            let candidate = component
                .strip_prefix("docker-")
                .and_then(|v| v.strip_suffix(".scope"))
                .or_else(|| {
                    component
                        .strip_prefix("cri-containerd-")
                        .and_then(|v| v.strip_suffix(".scope"))
                })
                .unwrap_or(component);
            if candidate.len() == 64 && candidate.bytes().all(|c| c.is_ascii_hexdigit()) {
                container = Some(candidate.to_owned());
            }
        }
    }
    (service, user_service, container)
}

fn user_home(uid: u32) -> Option<PathBuf> {
    static HOMES: OnceLock<HashMap<u32, PathBuf>> = OnceLock::new();
    HOMES
        .get_or_init(|| {
            read_limited(Path::new("/etc/passwd"), FILE_LIMIT)
                .ok()
                .map(|bytes| {
                    String::from_utf8_lossy(&bytes)
                        .lines()
                        .filter_map(|line| {
                            let parts: Vec<_> = line.split(':').collect();
                            let uid = parts.get(2)?.parse().ok()?;
                            let home = PathBuf::from(*parts.get(5)?);
                            home.is_absolute().then_some((uid, home))
                        })
                        .collect()
                })
                .unwrap_or_default()
        })
        .get(&uid)
        .cloned()
}

fn npm_script_from_args(args: &[String]) -> Option<String> {
    // npm rewrites process.title, which Linux exposes as a single cmdline
    // token. Recognize only its fixed grammar and a safe script identifier.
    if args.len() == 1 {
        let tokens: Vec<_> = args[0].split_whitespace().take(4).collect();
        if tokens.first() == Some(&"npm") {
            if tokens
                .get(1)
                .is_some_and(|command| matches!(*command, "run" | "run-script"))
            {
                return tokens.get(2).and_then(|script| safe_identifier(script));
            }
            if let Some(command) = tokens
                .get(1)
                .filter(|command| matches!(**command, "start" | "test" | "stop" | "restart"))
            {
                return Some((*command).to_owned());
            }
        }
        return None;
    }
    let npm = args.iter().take(2).position(|arg| {
        matches!(
            arg.rsplit('/').next().unwrap_or(arg),
            "npm" | "npm-cli.js" | "pnpm" | "pnpm.cjs" | "yarn" | "yarn.js"
        )
    })?;
    let command = args.get(npm + 1)?;
    if matches!(command.as_str(), "run" | "run-script") {
        return args.get(npm + 2).and_then(|value| safe_identifier(value));
    }
    matches!(command.as_str(), "start" | "test" | "stop" | "restart").then(|| command.clone())
}

fn npm_script_from_ancestors(mut pid: u32) -> Option<String> {
    for _ in 0..4 {
        if pid <= 1 {
            break;
        }
        let base = PathBuf::from(format!("/proc/{pid}"));
        let bytes = read_limited(&base.join("cmdline"), FILE_LIMIT).ok()?;
        let args: Vec<_> = bytes
            .split(|b| *b == 0)
            .filter(|p| !p.is_empty())
            .take(128)
            .map(|p| String::from_utf8_lossy(p).into_owned())
            .collect();
        if let Some(script) = npm_script_from_args(&args) {
            return Some(script);
        }
        let status = read_limited(&base.join("status"), FILE_LIMIT).ok()?;
        pid = String::from_utf8_lossy(&status)
            .lines()
            .find_map(|line| line.strip_prefix("PPid:"))?
            .trim()
            .parse()
            .ok()?;
    }
    None
}

fn valid_unit(value: &str) -> bool {
    !value.is_empty()
        && value.len() < 256
        && !value.starts_with('-')
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"@._-\\:".contains(&c))
}

fn read_limited(path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    #[cfg(target_os = "linux")]
    let file = {
        use std::os::unix::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            // O_PATH obtains identity without invoking a device's open method.
            .custom_flags(libc::O_PATH | libc::O_CLOEXEC)
            .open(path)?
    };
    #[cfg(not(target_os = "linux"))]
    let file = {
        if !fs::metadata(path)?.is_file() {
            return Err(io::Error::other("metadata target is not a regular file"));
        }
        File::open(path)?
    };
    read_regular_handle(file, limit)
}

fn read_regular_handle(file: File, limit: u64) -> io::Result<Vec<u8>> {
    if !file.metadata()?.is_file() {
        return Err(io::Error::other(
            "opened metadata target is not a regular file",
        ));
    }
    #[cfg(target_os = "linux")]
    let file = {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::OpenOptionsExt;
        // Hold the O_PATH descriptor across reopen: this process-owned magic
        // link names the verified regular inode even if its pathname changes.
        let opened = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NONBLOCK | libc::O_NOCTTY | libc::O_CLOEXEC)
            .open(format!("/proc/self/fd/{}", file.as_raw_fd()))?;
        if !opened.metadata()?.is_file() {
            return Err(io::Error::other("reopened metadata is not regular"));
        }
        opened
    };
    // Metadata size is not useful for /proc, so enforce the bound while reading.
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > limit {
        return Err(io::Error::other("metadata limit exceeded"));
    }
    Ok(bytes)
}

#[derive(Debug)]
enum CommandError {
    Missing,
    Failed,
    Timeout,
    TooLarge,
}

// Only standard protected install directories are searched. In particular a
// privileged scanner never runs a docker/systemctl from a project's PATH.
fn command_path(name: &str) -> Option<PathBuf> {
    ["/usr/bin", "/usr/local/bin", "/bin", "/usr/sbin"]
        .into_iter()
        .map(|directory| Path::new(directory).join(name))
        .find(|path| path.is_file())
}

fn run(name: &str, args: &[String]) -> Result<Vec<u8>, CommandError> {
    let path = command_path(name).ok_or(CommandError::Missing)?;
    run_path(&path, args)
}

fn run_path(path: &Path, args: &[String]) -> Result<Vec<u8>, CommandError> {
    let mut child = Command::new(path)
        .args(args)
        .env("LC_ALL", "C")
        .env("SYSTEMD_PAGER", "")
        .env("SYSTEMD_COLORS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| CommandError::Failed)?;
    let stdout = child.stdout.take().ok_or(CommandError::Failed)?;
    let (sender, receiver) = mpsc::channel();
    thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(OUTPUT_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = sender.send(result);
    });
    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status),
            Ok(None) if started.elapsed() < Duration::from_millis(1500) => {
                thread::sleep(Duration::from_millis(15));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                break Err(CommandError::Timeout);
            }
        }
    };
    let status = status?;
    // A successful CLI may have spawned a child that inherited stdout. Include
    // pipe draining in the same deadline instead of joining indefinitely.
    let remaining = Duration::from_millis(1500).saturating_sub(started.elapsed());
    let bytes = receiver
        .recv_timeout(remaining)
        .map_err(|_| CommandError::Timeout)?
        .map_err(|_| CommandError::Failed)?;
    if bytes.len() as u64 > OUTPUT_LIMIT {
        return Err(CommandError::TooLarge);
    }
    if !status.success() {
        return Err(CommandError::Failed);
    }
    Ok(bytes)
}

fn strings(args: &[&str]) -> Vec<String> {
    args.iter().map(|v| (*v).to_owned()).collect()
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default)]
struct Container {
    id: String,
    name: String,
    image: String,
    ports: Option<HashMap<String, Option<Vec<Binding>>>>,
    working_dir: String,
    compose_project: Option<String>,
    compose_service: Option<String>,
    compose_dir: Option<String>,
    compose_files: Option<String>,
    description: Option<String>,
    source_url: Option<String>,
    title: Option<String>,
    version: Option<String>,
    mounts: Vec<Mount>,
}

#[derive(Clone, Debug, Deserialize)]
struct Binding {
    #[serde(rename = "HostIp")]
    host_ip: String,
    #[serde(rename = "HostPort")]
    host_port: String,
}

#[derive(Clone, Debug, Deserialize)]
struct Mount {
    source: String,
    target: String,
}

pub struct Docker {
    containers: Vec<Container>,
    pub report: Report,
}

// Project environments, raw commands, unrelated labels and volume driver
// options can contain secrets; they are excluded at the Docker CLI boundary.
const INSPECT_TEMPLATE: &str = r#"{"id":{{json .Id}},"name":{{json .Name}},"image":{{json .Config.Image}},"ports":{{json .NetworkSettings.Ports}},"working_dir":{{json .Config.WorkingDir}},"compose_project":{{json (index .Config.Labels "com.docker.compose.project")}},"compose_service":{{json (index .Config.Labels "com.docker.compose.service")}},"compose_dir":{{json (index .Config.Labels "com.docker.compose.project.working_dir")}},"compose_files":{{json (index .Config.Labels "com.docker.compose.project.config_files")}},"description":{{json (index .Config.Labels "org.opencontainers.image.description")}},"source_url":{{json (index .Config.Labels "org.opencontainers.image.source")}},"title":{{json (index .Config.Labels "org.opencontainers.image.title")}},"version":{{json (index .Config.Labels "org.opencontainers.image.version")}},"mounts":[{{range $i,$m := .Mounts}}{{if $i}},{{end}}{"source":{{json $m.Source}},"target":{{json $m.Destination}}}{{end}}]}"#;

impl Docker {
    pub fn collect() -> Self {
        let empty = |status, message| Self {
            containers: Vec::new(),
            report: Report::new("Docker", status, Some(message)),
        };
        if command_path("docker").is_none() {
            return empty("Skipped", "未安装本机 Docker CLI");
        }
        // DOCKER_CONTEXT overrides DOCKER_HOST. Check the effective context,
        // rather than guessing that a docker CLI always targets this host.
        let host = std::env::var("DOCKER_HOST").ok();
        let context = std::env::var("DOCKER_CONTEXT")
            .ok()
            .filter(|v| !v.is_empty());
        if context.is_none() && host.as_deref().is_some_and(|v| !local_docker_host(v)) {
            return empty("Skipped", "Docker 指向远端 Engine；不能归因为本机端口");
        }
        if context.is_some() || host.is_none() {
            let mut args = strings(&[
                "context",
                "inspect",
                "--format",
                "{{json .Endpoints.docker.Host}}",
            ]);
            if let Some(context) = context {
                args.push(context);
            }
            let endpoint = run("docker", &args)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<String>(&bytes).ok());
            match endpoint {
                Some(endpoint) if local_docker_host(&endpoint) => {}
                Some(_) => {
                    return empty(
                        "Skipped",
                        "Docker context 指向远端 Engine；不能归因为本机端口",
                    )
                }
                None => {
                    return empty(
                        "Failed",
                        "无法核对 Docker context 的本机连接；已保留端口数据",
                    )
                }
            }
        }
        let ids = match run("docker", &strings(&["ps", "--quiet", "--no-trunc"])) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(_) => {
                let mut result = empty(
                    "Failed",
                    "本机 Docker Engine 不可访问或命令超时；请检查 socket 权限与服务状态",
                );
                result.report.elevation_may_help = true;
                return result;
            }
        };
        let ids: Vec<_> = ids
            .lines()
            .filter(|v| v.len() == 64 && v.bytes().all(|c| c.is_ascii_hexdigit()))
            .collect();
        if ids.is_empty() {
            return Self {
                containers: Vec::new(),
                report: Report::new("Docker", "Complete", None),
            };
        }
        let truncated = ids.len() > MAX_ITEMS;
        let mut args = strings(&[
            "inspect",
            "--type",
            "container",
            "--format",
            INSPECT_TEMPLATE,
        ]);
        args.extend(ids.into_iter().take(MAX_ITEMS).map(str::to_owned));
        let bytes = match run("docker", &args) {
            Ok(bytes) => bytes,
            Err(_) => return empty("Failed", "Docker 容器元数据读取失败、超时或超过大小限制"),
        };
        let mut containers = Vec::new();
        let mut invalid = false;
        for line in bytes.split(|b| *b == b'\n').filter(|line| !line.is_empty()) {
            match serde_json::from_slice::<Container>(line) {
                Ok(container) => containers.push(container),
                Err(_) => invalid = true,
            }
        }
        Self {
            containers,
            report: Report::new(
                "Docker",
                if truncated || invalid {
                    "Partial"
                } else {
                    "Complete"
                },
                (truncated || invalid).then_some("部分容器超过扫描上限或元数据不完整"),
            ),
        }
    }

    pub fn matches(
        &self,
        protocol: &str,
        address: &str,
        port: u16,
        process: Option<&Process>,
    ) -> Vec<Attribution> {
        let mut result = Vec::new();
        for container in &self.containers {
            let by_process = process
                .and_then(|p| p.container_id.as_ref())
                .is_some_and(|id| id == &container.id);
            let mut mapping = None;
            if let Some(ports) = &container.ports {
                for (internal, bindings) in ports {
                    let Some((container_port, binding_protocol)) = internal.split_once('/') else {
                        continue;
                    };
                    if binding_protocol != protocol {
                        continue;
                    }
                    for binding in bindings.iter().flatten() {
                        if binding.host_port.parse::<u16>().ok() == Some(port)
                            && host_matches(&binding.host_ip, address)
                        {
                            mapping = Some(format!(
                                "{}:{} → {}/{}",
                                binding.host_ip, port, container_port, protocol
                            ));
                        }
                    }
                }
            }
            if mapping.is_none() && !by_process {
                continue;
            }
            let by_proxy = process.is_some_and(|process| {
                let name = process
                    .exe
                    .as_ref()
                    .and_then(|path| path.file_name())
                    .and_then(|name| name.to_str())
                    .unwrap_or(&process.name);
                matches!(name, "docker-proxy" | "dockerd" | "rootlesskit")
            });
            let owner_known =
                process.is_some_and(|process| !process.name.is_empty() || process.exe.is_some());
            // Publishing is NAT configuration, not proof of the socket owner.
            // Never replace a known host project's identity with that mapping.
            if !by_process && !by_proxy && owner_known {
                continue;
            }
            let name = container.name.trim_start_matches('/');
            let mut facts = vec![
                fact("容器 ID", container.id.chars().take(12).collect::<String>()),
                fact("镜像", &container.image),
            ];
            if let Some(mapping) = mapping {
                facts.push(fact("端口映射", mapping));
            }
            for (label, value) in [
                ("Compose 项目", container.compose_project.as_deref()),
                ("Compose 服务", container.compose_service.as_deref()),
                ("项目路径", container.compose_dir.as_deref()),
                ("配置路径", container.compose_files.as_deref()),
                ("容器路径", Some(container.working_dir.as_str())),
            ] {
                if let Some(value) = value.filter(|v| !v.is_empty()) {
                    facts.push(fact(label, value));
                }
            }
            for mount in container.mounts.iter().take(16) {
                facts.push(fact("挂载", format!("{} → {}", mount.source, mount.target)));
                if !mount.source.is_empty() {
                    facts.push(fact("宿主路径", &mount.source));
                }
            }
            for (label, value) in [
                ("OCI source", &container.source_url),
                ("OCI title", &container.title),
                ("OCI version", &container.version),
            ] {
                if let Some(value) = value.as_deref().filter(|v| !v.is_empty()) {
                    facts.push(fact(label, value));
                }
            }
            let description = container
                .description
                .as_deref()
                .filter(|v| !v.trim().is_empty())
                .map(clean);
            if description.is_some() {
                facts.push(fact("简介来源", "OCI image description label"));
            } else {
                facts.push(fact(
                    "用途",
                    "未配置容器简介；请结合镜像和 Compose 服务识别用途",
                ));
            }
            result.push(Attribution {
                kind: "DockerContainer",
                name: clean(name),
                description,
                confidence: if by_process || by_proxy {
                    "Exact"
                } else {
                    "High"
                },
                source: if by_process {
                    "本机 Docker inspect + /proc cgroup"
                } else if by_proxy {
                    "Docker 代理进程 + 本机已发布端口（协议/地址/端口）"
                } else {
                    "本机端口发布配置候选；未核对 socket PID 归属"
                }
                .to_owned(),
                facts,
            });
        }
        result
    }
}

fn local_docker_host(host: &str) -> bool {
    host.strip_prefix("unix://").is_some_and(|path| {
        // This describes a Linux Engine endpoint even when its pure parser is
        // tested on Windows. Host-platform Path semantics would reject /var/.
        path.starts_with('/')
            && !path.starts_with("//")
            && path.len() > 1
            && !path.bytes().any(|byte| byte.is_ascii_control())
    })
}

fn host_matches(host: &str, local: &str) -> bool {
    let host = host.trim_matches(['[', ']']).parse::<IpAddr>();
    let local = local.trim_matches(['[', ']']).parse::<IpAddr>();
    match (host, local) {
        (Ok(host), Ok(local)) => {
            host.is_ipv4() == local.is_ipv4() && (host.is_unspecified() || host == local)
        }
        _ => false,
    }
}

#[derive(Debug, Clone, Default)]
struct Unit {
    name: String,
    description: String,
    path: String,
    directory: String,
    triggers: Vec<String>,
    listens: Vec<(String, String, u16)>,
    live: bool,
    active: bool,
}

pub struct Systemd {
    units: HashMap<String, Unit>,
    user_units: HashMap<u32, Unit>,
    pub report: Report,
}

impl Systemd {
    pub fn collect(processes: &HashMap<u32, Process>) -> Self {
        let mut report = Report::new("systemd", "Complete", None);
        let mut user_units = HashMap::new();
        for process in processes.values().filter(|p| p.user_service) {
            let Some(name) = &process.service else {
                continue;
            };
            let unit =
                read_user_unit_file(name, process.user_home.as_deref()).unwrap_or_else(|| Unit {
                    name: name.clone(),
                    ..Unit::default()
                });
            user_units.insert(process.pid, unit);
        }
        if !Path::new("/run/systemd/system").exists() || command_path("systemctl").is_none() {
            let units: HashMap<_, _> = processes
                .values()
                .filter(|p| !p.user_service)
                .filter_map(|process| {
                    let name = process.service.as_ref()?;
                    Some((
                        name.clone(),
                        read_unit_file(name).unwrap_or_else(|| Unit {
                            name: name.clone(),
                            ..Unit::default()
                        }),
                    ))
                })
                .collect();
            let status = if units.is_empty() && user_units.is_empty() {
                "Skipped"
            } else {
                "Partial"
            };
            return Self {
                units,
                user_units,
                report: Report::new(
                    "systemd",
                    status,
                    Some("systemd 管理器不可访问；仅根据可读 cgroup 和本地单元文件识别服务"),
                ),
            };
        }
        let mut names: BTreeSet<String> = processes
            .values()
            .filter(|p| !p.user_service)
            .filter_map(|p| p.service.clone())
            .collect();
        if processes.values().any(|p| p.user_service || p.limited) {
            report.status = "Partial";
            report.message = Some("部分 /proc 元数据或用户级 systemd 服务不可访问".to_owned());
            report.elevation_may_help = processes.values().any(|p| p.limited);
        }
        // PID 1 may hold many socket-activated units. Discover socket names and
        // then match their Listen property against this precise endpoint.
        if processes.contains_key(&1) {
            match run(
                "systemctl",
                &strings(&[
                    "list-sockets",
                    "--all",
                    "--no-legend",
                    "--no-pager",
                    "--plain",
                ]),
            ) {
                Ok(bytes) => {
                    for line in String::from_utf8_lossy(&bytes).lines() {
                        for token in line
                            .split_whitespace()
                            .filter(|t| t.ends_with(".socket") || t.ends_with(".service"))
                        {
                            if valid_unit(token) {
                                names.insert(token.to_owned());
                            }
                        }
                    }
                }
                Err(_) => {
                    report.status = "Partial";
                    report.message = Some(
                        "socket activation 单元查询失败或超时；PID 1 不会被猜测成某个服务"
                            .to_owned(),
                    );
                }
            }
        }
        if names.is_empty() {
            return Self {
                units: HashMap::new(),
                user_units,
                report,
            };
        }
        if names.len() > MAX_ITEMS {
            report.status = "Partial";
            report.message = Some("systemd 单元超过本次扫描上限".to_owned());
        }
        let selected: Vec<_> = names.into_iter().take(MAX_ITEMS).collect();
        let mut args = strings(&[
            "show",
            "--no-pager",
            "--property=Id,Description,FragmentPath,WorkingDirectory,Triggers,Listen,LoadState,ActiveState",
        ]);
        args.extend(selected.iter().cloned());
        let mut units = match run("systemctl", &args) {
            Ok(bytes) => parse_units(&String::from_utf8_lossy(&bytes)),
            Err(_) => {
                report.status = "Failed";
                report.message =
                    Some("systemd 元数据查询失败或超时；将尝试读取本地单元文件".to_owned());
                HashMap::new()
            }
        };
        for name in selected {
            if let std::collections::hash_map::Entry::Vacant(entry) = units.entry(name.clone()) {
                let unit = read_unit_file(&name).unwrap_or_else(|| Unit {
                    name: name.clone(),
                    ..Unit::default()
                });
                entry.insert(unit);
                report.status = "Partial";
                report.message =
                    Some("部分单元仅能读取 cgroup/配置文件，运行时属性不可用".to_owned());
            }
        }
        Self {
            units,
            user_units,
            report,
        }
    }

    pub fn matches(
        &self,
        protocol: &str,
        address: &str,
        port: u16,
        process: &Process,
    ) -> Vec<Attribution> {
        let mut units = Vec::new();
        if process.user_service {
            if let Some(unit) = self.user_units.get(&process.pid) {
                units.push((unit, None));
            }
        } else {
            if let Some(unit) = process
                .service
                .as_ref()
                .and_then(|name| self.units.get(name))
            {
                units.push((unit, None));
            }
        }
        if process.pid == 1 {
            for socket in self
                .units
                .values()
                .filter(|unit| unit.name.ends_with(".socket") && unit.active)
            {
                if socket.listens.iter().any(|(proto, host, p)| {
                    proto == protocol && *p == port && host_matches(host, address)
                }) {
                    let services: Vec<_> = socket
                        .triggers
                        .iter()
                        .filter_map(|name| self.units.get(name))
                        .collect();
                    if services.is_empty() {
                        units.push((socket, None));
                    } else {
                        for service in services {
                            units.push((service, Some(socket)));
                        }
                    }
                }
            }
        }
        let mut result = Vec::new();
        for (unit, socket) in units {
            let mut facts = vec![fact("服务名", &unit.name)];
            if !unit.path.is_empty() {
                facts.push(fact("配置路径", &unit.path));
            }
            if !unit.directory.is_empty() {
                facts.push(fact("工作目录", &unit.directory));
            }
            if let Some(socket) = socket {
                facts.push(fact("Socket 单元", &socket.name));
                if !socket.path.is_empty() {
                    facts.push(fact("Socket 配置", &socket.path));
                }
                facts.push(fact(
                    "运行模式",
                    "systemd socket activation；监听描述符由 PID 1 持有",
                ));
            } else {
                facts.push(fact(
                    "运行模式",
                    if process.user_service {
                        "systemd 用户级服务（未连接用户管理器）"
                    } else {
                        "systemd 服务"
                    },
                ));
            }
            if !unit.live {
                facts.push(fact(
                    "配置范围",
                    "只读单元文件或 cgroup；动态属性、实例替换和 drop-in 尚未确认",
                ));
            }
            if unit.description.is_empty() {
                facts.push(fact("用途", "单元未提供 Description"));
            } else {
                facts.push(fact("简介来源", "systemd Unit Description"));
            }
            let source = if socket.is_some() {
                "systemctl Listen/Triggers + 端点匹配"
            } else if unit.live {
                "/proc cgroup + systemctl show"
            } else {
                "/proc cgroup + 本地单元文件（未连接管理器）"
            };
            result.push(Attribution {
                kind: "SystemdService",
                name: clean(&unit.name),
                description: (!unit.description.is_empty()).then(|| clean(&unit.description)),
                confidence: if unit.live { "Exact" } else { "High" },
                source: source.to_owned(),
                facts,
            });
        }
        result.sort_by(|a, b| a.name.cmp(&b.name));
        result.dedup_by(|a, b| a.name == b.name);
        result
    }
}

fn parse_units(text: &str) -> HashMap<String, Unit> {
    let mut result = HashMap::new();
    for block in text.split("\n\n") {
        let properties: HashMap<_, _> = block
            .lines()
            .filter_map(|line| line.split_once('='))
            .collect();
        let name = properties.get("Id").copied().unwrap_or_default();
        if !valid_unit(name) || properties.get("LoadState") == Some(&"not-found") {
            continue;
        }
        result.insert(
            name.to_owned(),
            Unit {
                name: name.to_owned(),
                description: properties
                    .get("Description")
                    .copied()
                    .unwrap_or_default()
                    .to_owned(),
                path: properties
                    .get("FragmentPath")
                    .copied()
                    .unwrap_or_default()
                    .to_owned(),
                directory: properties
                    .get("WorkingDirectory")
                    .copied()
                    .unwrap_or_default()
                    .to_owned(),
                triggers: properties
                    .get("Triggers")
                    .copied()
                    .unwrap_or_default()
                    .split_whitespace()
                    .filter(|v| valid_unit(v))
                    .map(str::to_owned)
                    .collect(),
                listens: parse_listens(properties.get("Listen").copied().unwrap_or_default()),
                live: true,
                active: properties.get("ActiveState") == Some(&"active"),
            },
        );
    }
    result
}

fn parse_listens(value: &str) -> Vec<(String, String, u16)> {
    let mut result = Vec::new();
    for item in value.split(") ") {
        let item = item.trim_end_matches(')');
        let Some((endpoint, kind)) = item.rsplit_once(" (") else {
            continue;
        };
        let protocol = match kind {
            "Stream" => "tcp",
            "Datagram" => "udp",
            _ => continue,
        };
        let Some((address, port)) = endpoint.rsplit_once(':') else {
            continue;
        };
        let address = address.trim_matches(['[', ']']);
        if address.parse::<IpAddr>().is_err() {
            continue;
        }
        if let Ok(port) = port.parse::<u16>() {
            result.push((protocol.to_owned(), address.to_owned(), port));
        }
    }
    result
}

fn read_unit_file(name: &str) -> Option<Unit> {
    if !valid_unit(name) {
        return None;
    }
    read_unit_in(
        name,
        &[
            PathBuf::from("/run/systemd/transient"),
            PathBuf::from("/etc/systemd/system"),
            PathBuf::from("/run/systemd/system"),
            PathBuf::from("/usr/lib/systemd/system"),
            PathBuf::from("/lib/systemd/system"),
        ],
    )
}

fn read_user_unit_file(name: &str, home: Option<&Path>) -> Option<Unit> {
    if !valid_unit(name) {
        return None;
    }
    let mut directories = Vec::new();
    if let Some(home) = home {
        directories.push(home.join(".config/systemd/user"));
    }
    directories.extend([
        PathBuf::from("/etc/systemd/user"),
        PathBuf::from("/usr/lib/systemd/user"),
        PathBuf::from("/lib/systemd/user"),
    ]);
    read_unit_in(name, &directories)
}

fn read_unit_in(name: &str, directories: &[PathBuf]) -> Option<Unit> {
    for directory in directories {
        let path = directory.join(name);
        let path = if path.exists() {
            path
        } else if let Some((base, instance)) = name.split_once('@') {
            let suffix = instance.rsplit_once('.')?.1;
            directory.join(format!("{base}@.{suffix}"))
        } else {
            path
        };
        let Ok(bytes) = read_limited(&path, FILE_LIMIT) else {
            continue;
        };
        let text = String::from_utf8_lossy(&bytes);
        let mut unit = Unit {
            name: name.to_owned(),
            path: path.to_string_lossy().into_owned(),
            ..Unit::default()
        };
        let mut section = "";
        for line in text.lines().map(str::trim) {
            if line.starts_with('[') && line.ends_with(']') {
                section = line;
            } else if let Some((key, value)) = line.split_once('=') {
                match (section, key.trim()) {
                    ("[Unit]", "Description") => unit.description = value.trim().to_owned(),
                    ("[Service]", "WorkingDirectory") => unit.directory = value.trim().to_owned(),
                    _ => {}
                }
            }
        }
        return Some(unit);
    }
    None
}

#[derive(Debug, Default)]
struct Project {
    name: Option<String>,
    description: Option<String>,
    root: PathBuf,
    metadata: PathBuf,
}

fn node_project(text: &[u8], path: &Path) -> Option<Project> {
    let value: serde_json::Value = serde_json::from_slice(text).ok()?;
    Some(Project {
        name: value.get("name").and_then(|v| v.as_str()).map(clean),
        description: value.get("description").and_then(|v| v.as_str()).map(clean),
        root: path.parent()?.to_path_buf(),
        metadata: path.to_path_buf(),
    })
}

// Parse static metadata only. Dynamic Python build hooks, setup.py, npm scripts
// and README code are never executed to discover a project's description.
fn python_project(text: &[u8], path: &Path) -> Option<Project> {
    let value: toml::Value = toml::from_str(std::str::from_utf8(text).ok()?).ok()?;
    let metadata = value
        .get("project")
        .or_else(|| value.get("tool").and_then(|tool| tool.get("poetry")))?
        .as_table()?;
    Some(Project {
        name: metadata
            .get("name")
            .and_then(toml::Value::as_str)
            .map(clean),
        description: metadata
            .get("description")
            .and_then(toml::Value::as_str)
            .map(clean),
        root: path.parent()?.to_path_buf(),
        metadata: path.to_path_buf(),
    })
}

fn project_from(process: &Process, node: bool, entry: Option<&str>) -> Option<Project> {
    let mut starts = Vec::new();
    if let Some(cwd) = &process.cwd {
        starts.push(cwd.clone());
    }
    if let Some(entry) = entry {
        let path = resolve_path(entry, process.cwd.as_deref());
        // With an unreadable cwd, a relative argv path has no trustworthy root;
        // never search the scanner's own project as though it were the target.
        if namespace_absolute(&path) {
            if let Some(parent) = path.parent() {
                starts.push(parent.to_path_buf());
            }
        }
    }
    let filename = if node {
        "package.json"
    } else {
        "pyproject.toml"
    };
    let mut visited = BTreeSet::new();
    for start in starts {
        for directory in start.ancestors().take(7) {
            // Runtime dependencies are not the hosting project's package.
            if node
                && directory
                    .components()
                    .any(|part| part.as_os_str() == "node_modules")
            {
                continue;
            }
            if !visited.insert(directory.to_path_buf()) {
                continue;
            }
            let path = directory.join(filename);
            if let Ok(bytes) = read_project_file(process, &path, FILE_LIMIT) {
                let project = if node {
                    node_project(&bytes, &path)
                } else {
                    python_project(&bytes, &path)
                };
                if project.is_some() {
                    return project;
                }
            }
        }
    }
    None
}

fn resolve_path(value: &str, cwd: Option<&Path>) -> PathBuf {
    let path = PathBuf::from(value);
    if namespace_absolute(&path) {
        path
    } else {
        cwd.map(|cwd| cwd.join(&path)).unwrap_or(path)
    }
}

fn namespace_absolute(path: &Path) -> bool {
    path.to_string_lossy().starts_with('/')
}

fn namespace_relative(path: &Path) -> io::Result<PathBuf> {
    if !namespace_absolute(path) {
        return Err(io::Error::other("project path has no known root"));
    }
    #[cfg(target_os = "linux")]
    {
        // Preserve parent components: /srv/link/.. must be resolved after the
        // symlink by the kernel. RESOLVE_IN_ROOT contains traversal safely.
        path.strip_prefix("/")
            .map(Path::to_path_buf)
            .map_err(|_| io::Error::other("invalid namespace path"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let mut result = PathBuf::new();
        let value = path.to_string_lossy();
        #[cfg(not(target_os = "linux"))]
        let value = value.replace('\\', "/");
        for component in value.split('/') {
            match component {
                ".." => {
                    result.pop();
                }
                "" | "." => {}
                name => {
                    #[cfg(not(target_os = "linux"))]
                    if name.contains(':') {
                        return Err(io::Error::other("unsupported fixture path"));
                    }
                    result.push(name);
                }
            }
        }
        Ok(result)
    }
}

fn read_project_file(process: &Process, path: &Path, limit: u64) -> io::Result<Vec<u8>> {
    let root = process
        .root
        .as_ref()
        .ok_or_else(|| io::Error::other("process filesystem root is unavailable"))?;
    let relative = namespace_relative(path)?;
    #[cfg(target_os = "linux")]
    {
        use std::ffi::CString;
        use std::os::fd::{AsRawFd, FromRawFd};
        use std::os::unix::ffi::OsStrExt;
        #[repr(C)]
        struct OpenHow {
            flags: u64,
            mode: u64,
            resolve: u64,
        }
        use std::os::unix::fs::OpenOptionsExt;
        let root = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_CLOEXEC)
            .open(root)?;
        if !root.metadata()?.is_dir() {
            return Err(io::Error::other("invalid process filesystem root"));
        }
        let path = CString::new(relative.as_os_str().as_bytes())
            .map_err(|_| io::Error::other("invalid project path"))?;
        let how = OpenHow {
            flags: (libc::O_PATH | libc::O_CLOEXEC) as u64,
            mode: 0,
            // Absolute symlinks and '..' resolve within the target's root;
            // magic links such as /proc/other-pid/root cannot escape it.
            resolve: 0x10 | 0x02, // RESOLVE_IN_ROOT | RESOLVE_NO_MAGICLINKS
        };
        // SAFETY: root/path/how remain alive throughout this synchronous call.
        let descriptor = unsafe {
            libc::syscall(
                libc::SYS_openat2,
                root.as_raw_fd(),
                path.as_ptr(),
                &how as *const OpenHow,
                std::mem::size_of::<OpenHow>(),
            )
        };
        if descriptor < 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() == Some(libc::ENOSYS) {
                // Some systemd architecture filters report newer syscalls as
                // ENOSYS. Preserve namespace containment with fixed handles;
                // permission/resolve failures never trigger this fallback.
                return read_regular_handle(walk_in_root(&root, &relative)?, limit);
            }
            return Err(error);
        }
        // SAFETY: openat2 returned a new valid descriptor, uniquely owned here.
        let file = unsafe { File::from_raw_fd(descriptor as i32) };
        if !file.metadata()?.is_file() {
            return Err(io::Error::other("project metadata is not a regular file"));
        }
        read_regular_handle(file, limit)
    }
    #[cfg(not(target_os = "linux"))]
    {
        read_limited(&root.join(relative), limit)
    }
}

#[cfg(target_os = "linux")]
fn walk_in_root(root: &File, path: &Path) -> io::Result<File> {
    use std::collections::VecDeque;
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    const PATH_LIMIT: usize = 4096;
    const STEP_LIMIT: usize = 256;
    const LINK_LIMIT: usize = 40;
    const PROC_SUPER_MAGIC: libc::c_long = 0x9fa0;

    let bytes = path.as_os_str().as_bytes();
    if path.is_absolute() || bytes.len() > PATH_LIMIT || bytes.contains(&0) {
        return Err(io::Error::from_raw_os_error(libc::ENAMETOOLONG));
    }
    if !root.metadata()?.is_dir() {
        return Err(io::Error::other("invalid namespace root handle"));
    }
    let mut pending: VecDeque<Vec<u8>> = bytes
        .split(|byte| *byte == b'/')
        .map(<[u8]>::to_vec)
        .collect();
    let mut directories = vec![root.try_clone()?];
    let mut steps = 0;
    let mut links = 0;

    while let Some(component) = pending.pop_front() {
        steps += 1;
        if steps > STEP_LIMIT {
            return Err(io::Error::from_raw_os_error(libc::ELOOP));
        }
        if component.is_empty() || component == b"." {
            continue;
        }
        if component == b".." {
            if directories.len() > 1 {
                directories.pop();
            }
            continue;
        }
        let component =
            CString::new(component).map_err(|_| io::Error::other("invalid metadata component"))?;
        let parent = directories
            .last()
            .ok_or_else(|| io::Error::other("namespace root lost"))?;
        // SAFETY: component is NUL-terminated and parent is held across openat.
        // O_PATH|NOFOLLOW obtains an inode without following a link or invoking
        // a device's open method. No user-controlled pathname is opened for IO.
        let descriptor = unsafe {
            libc::openat(
                parent.as_raw_fd(),
                component.as_ptr(),
                libc::O_PATH | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if descriptor < 0 {
            return Err(io::Error::last_os_error());
        }
        // SAFETY: successful openat creates a new descriptor owned by this File.
        let opened = unsafe { File::from_raw_fd(descriptor) };
        let metadata = opened.metadata()?;
        if metadata.file_type().is_symlink() {
            links += 1;
            if links > LINK_LIMIT {
                return Err(io::Error::from_raw_os_error(libc::ELOOP));
            }
            let mut filesystem = std::mem::MaybeUninit::<libc::statfs>::uninit();
            // SAFETY: fstatfs writes statfs on success; opened remains valid.
            if unsafe { libc::fstatfs(opened.as_raw_fd(), filesystem.as_mut_ptr()) } < 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: successful fstatfs initialized this structure.
            if unsafe { filesystem.assume_init() }.f_type == PROC_SUPER_MAGIC {
                // Conservatively reject all procfs links, including fd/root/ns
                // magic links, rather than trying to reinterpret their targets.
                return Err(io::Error::from_raw_os_error(libc::ELOOP));
            }
            let mut target = vec![0u8; PATH_LIMIT];
            // SAFETY: the empty pathname asks readlinkat to read this fixed
            // O_PATH symlink inode; the writable buffer has PATH_LIMIT bytes.
            let length = unsafe {
                libc::readlinkat(
                    opened.as_raw_fd(),
                    c"".as_ptr(),
                    target.as_mut_ptr().cast(),
                    target.len(),
                )
            };
            if length < 0 {
                return Err(io::Error::last_os_error());
            }
            let length = length as usize;
            if length == 0 || length >= PATH_LIMIT {
                return Err(io::Error::from_raw_os_error(libc::ENAMETOOLONG));
            }
            target.truncate(length);
            if target.contains(&0)
                || length + pending.iter().map(|part| part.len() + 1).sum::<usize>() > PATH_LIMIT
            {
                return Err(io::Error::from_raw_os_error(libc::ENAMETOOLONG));
            }
            if target.first() == Some(&b'/') {
                directories.truncate(1);
            }
            let mut expanded: VecDeque<Vec<u8>> = target
                .split(|byte| *byte == b'/')
                .map(<[u8]>::to_vec)
                .collect();
            expanded.append(&mut pending);
            pending = expanded;
            continue;
        }
        if pending.is_empty() {
            return Ok(opened);
        }
        if !metadata.is_dir() {
            return Err(io::Error::from_raw_os_error(libc::ENOTDIR));
        }
        directories.push(opened);
    }
    directories
        .pop()
        .ok_or_else(|| io::Error::other("namespace root lost"))
}

fn runtime_name(process: &Process) -> Option<bool> {
    let name = process
        .exe
        .as_ref()
        .and_then(|p| p.file_name())
        .and_then(|v| v.to_str())
        .unwrap_or(&process.name);
    if matches!(name, "node" | "nodejs" | "bun" | "deno") {
        return Some(true);
    }
    if name.starts_with("python") || matches!(name, "uvicorn" | "gunicorn" | "hypercorn") {
        return Some(false);
    }
    None
}

fn safe_identifier(value: &str) -> Option<String> {
    (!value.is_empty()
        && !value.starts_with('-')
        && value.len() < 256
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._:/@-".contains(&c)))
    .then(|| value.to_owned())
}

// Parse runtime grammar rather than finding any *.js/*.py token: a credential
// passed to --token may itself have a script extension.
fn entry_arg(args: &[String], node: bool) -> Option<&str> {
    let mut index = 1;
    while index < args.len() {
        let arg = &args[index];
        if matches!(
            arg.as_str(),
            "-e" | "--eval" | "-p" | "--print" | "-c" | "-m"
        ) {
            return None;
        }
        if matches!(
            arg.as_str(),
            "-r" | "--require" | "--loader" | "--import" | "--inspect-port"
        ) {
            index += 2;
            continue;
        }
        if arg.starts_with('-') {
            if arg.contains('=')
                || matches!(
                    arg.as_str(),
                    "-u" | "-B"
                        | "-O"
                        | "-OO"
                        | "--no-warnings"
                        | "--enable-source-maps"
                        | "--experimental-modules"
                        | "--watch"
                        | "--inspect"
                        | "--inspect-brk"
                )
            {
                index += 1;
                continue;
            }
            // The arity of an unknown option is not known. Treat its following
            // value as private, rather than guessing it is a script path.
            return None;
        }
        let extensions: &[&str] = if node {
            &[".js", ".mjs", ".cjs", ".ts", ".tsx"]
        } else {
            &[".py", ".pyw"]
        };
        return (extensions.iter().any(|extension| arg.ends_with(extension))
            || (node && arg.ends_with("/next/dist/bin/next")))
        .then_some(arg.as_str());
    }
    None
}

pub fn runtime(process: &Process) -> Option<Attribution> {
    let node = runtime_name(process)?;
    let launcher = crate::knowledge::local::launcher(&process.args, !node);
    let entry = entry_arg(&process.args, node);
    let project = project_from(process, node, entry);
    let module = if node {
        None
    } else {
        python_module(&process.args)
    };
    let mut facts = Vec::new();
    if let Some(launcher) = launcher {
        facts.push(fact("公开软件", launcher));
    }
    if let Some(cwd) = &process.cwd {
        facts.push(fact("工作目录", cwd.to_string_lossy()));
    }
    if process.container_id.is_some() {
        facts.push(fact(
            "路径范围",
            "进程文件系统中的容器内路径；宿主路径见容器挂载",
        ));
    }
    if let Some(exe) = &process.exe {
        facts.push(fact("程序路径", exe.to_string_lossy()));
    }
    if let Some(entry) = entry {
        facts.push(fact(
            "入口",
            resolve_path(entry, process.cwd.as_deref()).to_string_lossy(),
        ));
    }
    if let Some(module) = &module {
        facts.push(fact("模块", module));
    }
    if let Some(script) = &process.npm_script {
        facts.push(fact("npm script", script));
    }
    if !node {
        if let Some(path) = process
            .args
            .first()
            .filter(|value| value.starts_with('/') && value.contains("/bin/python"))
        {
            if let Some(environment) = Path::new(path).parent().and_then(Path::parent) {
                if read_project_file(process, &environment.join("pyvenv.cfg"), FILE_LIMIT).is_ok() {
                    facts.push(fact("Python 环境", environment.to_string_lossy()));
                }
            }
        }
        if let Some((framework, app)) = python_framework(&process.args, module.as_deref()) {
            facts.push(fact("框架", framework));
            if let Some(app) = app {
                facts.push(fact("应用入口", app));
            }
        }
    }
    if let Some(project) = &project {
        facts.push(fact("项目路径", project.root.to_string_lossy()));
        facts.push(fact("配置路径", project.metadata.to_string_lossy()));
        if project.description.is_some() {
            facts.push(fact(
                "简介来源",
                if node {
                    "package.json description"
                } else {
                    "pyproject.toml description"
                },
            ));
        }
    }
    let mut mode = if process.args.iter().any(|a| a == "--reload") {
        "自动重载（--reload）"
    } else if process
        .args
        .iter()
        .any(|a| a == "--watch" || a.starts_with("--watch="))
    {
        "文件监听（--watch）"
    } else if process.args.iter().any(|a| {
        a == "--inspect"
            || a.starts_with("--inspect=")
            || a == "--inspect-brk"
            || a.starts_with("--inspect-brk=")
    }) {
        "调试（--inspect）"
    } else if node && node_framework_mode(&process.args).is_some() {
        node_framework_mode(&process.args).unwrap_or_default()
    } else if module.is_some() {
        "Python 模块运行（-m）"
    } else if entry.is_some() {
        "脚本直接运行"
    } else {
        "运行模式未确认（没有可读入口证据）"
    }
    .to_owned();
    if process.service.is_some() {
        mode.push_str("；由 systemd 管理");
    }
    if process.container_id.is_some() {
        mode.push_str("；容器内运行");
    }
    if let Some(script) = &process.npm_script {
        mode.push_str(&format!("；npm script: {script}"));
    }
    facts.push(fact("运行模式", mode));
    let description = project.as_ref().and_then(|p| p.description.clone());
    if description.is_none() {
        facts.push(fact(
            "用途",
            "项目没有可读取的静态简介；未根据端口猜测业务用途",
        ));
    }
    let name = project
        .as_ref()
        .and_then(|p| p.name.clone())
        .or_else(|| {
            entry
                .and_then(|e| Path::new(e).file_name())
                .map(|name| name.to_string_lossy().into_owned())
        })
        .or_else(|| module.map(|module| format!("Python: {module}")))
        .or_else(|| {
            process
                .cwd
                .as_ref()
                .and_then(|cwd| cwd.file_name())
                .map(|n| n.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| {
            if node {
                "Node.js 项目"
            } else {
                "Python 项目"
            }
            .to_owned()
        });
    Some(Attribution {
        kind: if node {
            "NodeApplication"
        } else {
            "PythonApplication"
        },
        name: clean(&name),
        description,
        confidence: if project.is_some() { "High" } else { "Medium" },
        source: "/proc cmdline/cwd/exe + 本地静态项目元数据（不执行项目）".to_owned(),
        facts,
    })
}

fn python_module(args: &[String]) -> Option<String> {
    let mut index = 1;
    while let Some(arg) = args.get(index) {
        if arg == "-m" {
            return args
                .get(index + 1)
                .and_then(|module| safe_identifier(module));
        }
        if matches!(
            arg.as_str(),
            "-u" | "-B" | "-O" | "-OO" | "-s" | "-S" | "-I" | "-E" | "-q"
        ) {
            index += 1;
            continue;
        }
        if arg == "-W" || arg == "-X" {
            index += 2;
            continue;
        }
        return None;
    }
    None
}

fn node_framework_mode(args: &[String]) -> Option<&'static str> {
    let entry = entry_arg(args, true)?;
    let position = args.iter().position(|arg| arg == entry)?;
    let command = args.get(position + 1).map(String::as_str);
    if entry.ends_with("/vite/bin/vite.js") || entry.ends_with("/vite/bin/vite.mjs") {
        return Some(match command {
            Some("preview") => "Vite 构建预览（preview）",
            Some("build") => "Vite 构建（build）",
            _ => "Vite 开发服务器（serve）",
        });
    }
    if entry.ends_with("/next/dist/bin/next") || entry.ends_with("/next/dist/bin/next.js") {
        return Some(match command {
            Some("dev") | None => "Next.js 开发服务器（dev）",
            Some("start") => "Next.js 生产服务器（start）",
            Some("build") => "Next.js 构建（build）",
            _ => "Next.js CLI（模式未确认）",
        });
    }
    if entry.ends_with("/webpack-cli/bin/cli.js") || entry.ends_with("/webpack/bin/webpack.js") {
        let mode = args
            .iter()
            .position(|arg| arg == "--mode")
            .and_then(|index| args.get(index + 1));
        return Some(match mode.map(String::as_str) {
            Some("development") => "webpack 开发模式（--mode development）",
            Some("production") => "webpack 生产模式（--mode production）",
            _ if args.iter().any(|arg| arg == "serve") => "webpack 开发服务器（serve）",
            _ => "webpack CLI（模式未确认）",
        });
    }
    None
}

fn python_framework(
    args: &[String],
    module: Option<&str>,
) -> Option<(&'static str, Option<String>)> {
    let executable = args.first()?.rsplit('/').next()?;
    let framework = module.unwrap_or(executable);
    let name = match framework {
        "uvicorn" => "Uvicorn ASGI 服务",
        "gunicorn" => "Gunicorn Python 应用服务",
        "hypercorn" => "Hypercorn ASGI/WSGI 服务",
        _ => return None,
    };
    let mut index = if module.is_some() {
        args.iter().position(|arg| arg == "-m")? + 2
    } else {
        1
    };
    let mut app = None;
    while let Some(arg) = args.get(index) {
        if matches!(
            arg.as_str(),
            "--host"
                | "--port"
                | "--workers"
                | "--bind"
                | "-b"
                | "--worker-class"
                | "-k"
                | "--log-level"
                | "--app-dir"
                | "--chdir"
        ) {
            index += 2;
            continue;
        }
        if matches!(
            arg.as_str(),
            "--reload" | "--preload" | "--daemon" | "--factory"
        ) {
            index += 1;
            continue;
        }
        if arg.starts_with('-') {
            break;
        }
        app = safe_identifier(arg);
        break;
    }
    Some((name, app))
}

pub fn program(process: &Process) -> Attribution {
    let executable = process
        .exe
        .as_ref()
        .and_then(|path| path.file_name())
        .and_then(|v| v.to_str())
        .unwrap_or(&process.name);
    let description = match executable {
        "systemd" => Some("Linux 系统与服务管理器；PID 1 的监听端口需进一步查看 socket 单元"),
        "systemd-resolved" => Some("systemd 本机 DNS 解析与缓存服务"),
        "systemd-networkd" => Some("systemd 网络接口配置服务"),
        "sshd" => Some("OpenSSH 远程登录服务"),
        "nginx" => Some("Nginx HTTP 服务和反向代理；具体站点用途需查看站点配置"),
        "apache2" | "httpd" => Some("Apache HTTP 服务；具体站点用途需查看站点配置"),
        "postgres" => Some("PostgreSQL 数据库服务"),
        "mysqld" | "mariadbd" => Some("MySQL/MariaDB 数据库服务"),
        "redis-server" => Some("Redis 数据存储与缓存服务"),
        "dockerd" => Some("Docker 容器引擎守护进程"),
        "containerd" => Some("容器生命周期与镜像管理服务"),
        "docker-proxy" => Some("Docker 已发布端口代理；实际容器见 Docker 归属"),
        "cupsd" => Some("CUPS 打印服务"),
        "avahi-daemon" => Some("Avahi mDNS/DNS-SD 局域网设备与服务发现"),
        "dnsmasq" => Some("DNS 缓存、DHCP 与网络启动服务；启用功能取决于配置"),
        "chronyd" => Some("Chrony 系统时钟同步服务"),
        "rpcbind" => Some("ONC RPC 程序与端口映射服务"),
        _ => None,
    };
    let mut facts = Vec::new();
    if let Some(exe) = &process.exe {
        facts.push(fact("程序路径", exe.to_string_lossy()));
    }
    if let Some(cwd) = &process.cwd {
        facts.push(fact("工作目录", cwd.to_string_lossy()));
    }
    if description.is_some() {
        facts.push(fact("简介来源", "已知程序职责；不代表该实例的业务配置"));
    } else {
        facts.push(fact("用途", "未发现程序简介；当前仅确认进程身份与路径"));
    }
    Attribution {
        kind: "SystemProcess",
        name: clean(executable),
        description: description.map(str::to_owned),
        confidence: if process.exe.is_some() {
            "High"
        } else {
            "Medium"
        },
        source: "/proc exe/cwd + 程序职责目录".to_owned(),
        facts,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn process(pid: u32, args: &[&str]) -> Process {
        Process {
            pid,
            name: args[0].to_owned(),
            args: strings(args),
            ..Process::default()
        }
    }

    #[test]
    fn docker_matches_protocol_address_and_published_port() {
        let container: Container = serde_json::from_str(r#"{"id":"abc","name":"/api-1","image":"demo/api","compose_dir":"/srv/demo","compose_service":"api","description":"订单 API","working_dir":"/app","ports":{"8000/tcp":[{"HostIp":"0.0.0.0","HostPort":"18000"}],"53/udp":[{"HostIp":"::","HostPort":"53"}]},"mounts":[{"source":"/srv/demo","target":"/app"}]}"#).unwrap();
        let snapshot = Docker {
            containers: vec![container],
            report: Report::new("Docker", "Complete", None),
        };
        let attribution = snapshot.matches("tcp", "127.0.0.1", 18000, None);
        assert_eq!(attribution[0].name, "api-1");
        assert_eq!(attribution[0].confidence, "High");
        assert_eq!(attribution[0].description.as_deref(), Some("订单 API"));
        assert!(attribution[0]
            .facts
            .iter()
            .any(|f| f.value == "/srv/demo → /app"));
        assert!(snapshot.matches("udp", "0.0.0.0", 18000, None).is_empty());
        assert!(snapshot.matches("tcp", "::", 18000, None).is_empty());
        assert!(snapshot.matches("udp", "0.0.0.0", 53, None).is_empty());
        assert_eq!(snapshot.matches("udp", "::1", 53, None).len(), 1);
        assert!(!host_matches("127.0.0.1", "0.0.0.0"));
        let host_node = process(21, &["node", "server.js"]);
        assert!(snapshot
            .matches("tcp", "127.0.0.1", 18000, Some(&host_node))
            .is_empty());
        let proxy = process(22, &["docker-proxy"]);
        assert_eq!(
            snapshot.matches("tcp", "127.0.0.1", 18000, Some(&proxy))[0].confidence,
            "Exact"
        );
    }

    #[test]
    fn remote_context_and_unix_paths_are_not_confused() {
        assert!(local_docker_host("unix:///var/run/docker.sock"));
        assert!(!local_docker_host("tcp://127.0.0.1:2375"));
        assert!(!local_docker_host("ssh://server"));
        assert!(!local_docker_host("unix://relative"));
        assert!(!local_docker_host("unix://server/docker.sock"));
        assert!(!local_docker_host("unix:////server/docker.sock"));
        assert!(!local_docker_host("unix:///"));
        assert!(!local_docker_host("unix:///var/run/docker.sock\n"));
        assert!(!INSPECT_TEMPLATE.contains(".Env"));
        assert!(!INSPECT_TEMPLATE.contains(".Config.Cmd"));
        assert!(!INSPECT_TEMPLATE.contains("json .Config.Labels"));
    }

    #[test]
    fn cgroup_identifies_service_and_container_without_init_scope_guess() {
        let id = "a".repeat(64);
        assert_eq!(
            parse_cgroup("0::/system.slice/demo@worker.service"),
            (Some("demo@worker.service".to_owned()), false, None)
        );
        assert_eq!(parse_cgroup("0::/init.scope").0, None);
        assert_eq!(
            parse_cgroup(&format!("0::/system.slice/docker-{id}.scope")).2,
            Some(id)
        );
        assert!(
            parse_cgroup("0::/user.slice/user-1000.slice/user@1000.service/app.slice/demo.service")
                .1
        );
    }

    #[test]
    fn socket_activation_maps_only_the_matching_unit_and_protocol() {
        let text = "Id=ssh.socket\nActiveState=active\nDescription=SSH listener\nFragmentPath=/usr/lib/systemd/system/ssh.socket\nTriggers=ssh.service\nListen=[::]:22 (Stream) 127.0.0.1:2222 (Stream)\n\nId=ssh.service\nDescription=OpenSSH server\nFragmentPath=/usr/lib/systemd/system/ssh.service\nWorkingDirectory=/\n\nId=dns.socket\nActiveState=active\nTriggers=dns.service\nListen=0.0.0.0:53 (Datagram)\n\nId=dns.service\nDescription=DNS server\n\nId=stopped.socket\nActiveState=inactive\nTriggers=stopped.service\nListen=[::]:22 (Stream)\n\nId=stopped.service\nDescription=Stopped service\n\nId=failed.socket\nActiveState=failed\nTriggers=failed.service\nListen=[::]:22 (Stream)\n\nId=failed.service\nDescription=Failed service\n";
        let snapshot = Systemd {
            units: parse_units(text),
            user_units: HashMap::new(),
            report: Report::new("systemd", "Complete", None),
        };
        let pid1 = process(1, &["systemd"]);
        let result = snapshot.matches("tcp", "::", 22, &pid1);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].name, "ssh.service");
        assert!(result[0].facts.iter().any(|f| f.value == "ssh.socket"));
        assert!(snapshot.matches("udp", "::", 22, &pid1).is_empty());
        assert!(snapshot.matches("tcp", "0.0.0.0", 9999, &pid1).is_empty());
        assert_eq!(
            snapshot.matches("udp", "127.0.0.1", 53, &pid1)[0].name,
            "dns.service"
        );
    }

    #[test]
    fn project_metadata_keeps_description_and_ignores_secrets() {
        let project = node_project(br#"{"name":"demo","description":"Demo API","scripts":{"start":"node server.js --token secret"}}"#, Path::new("/srv/demo/package.json")).unwrap();
        assert_eq!(project.name.as_deref(), Some("demo"));
        assert_eq!(project.description.as_deref(), Some("Demo API"));
        let project = python_project(b"[project]\nname = 'demo' # title\ndescription = \"Order API\"\n[tool.private]\ntoken = 'secret'\n", Path::new("/srv/demo/pyproject.toml")).unwrap();
        assert_eq!(project.description.as_deref(), Some("Order API"));
        assert!(!format!("{project:?}").contains("secret"));
    }

    #[test]
    fn runtime_grammar_never_exposes_option_values_or_inline_code() {
        let node = runtime(&process(
            1,
            &[
                "node",
                "server.js",
                "--token",
                "secret.js",
                "--password=supersecret",
            ],
        ))
        .unwrap();
        assert!(node
            .facts
            .iter()
            .any(|f| f.label == "入口" && f.value == "server.js"));
        let serialized = serde_json::to_string(&node).unwrap();
        assert!(!serialized.contains("secret"));
        assert_eq!(
            entry_arg(&strings(&["node", "--token", "secret.js"]), true),
            None
        );
        assert_eq!(
            entry_arg(&strings(&["node", "-e", "console.log('secret.js')"]), true),
            None
        );
        let python = runtime(&process(
            2,
            &[
                "python3",
                "-m",
                "uvicorn",
                "api:app",
                "--reload",
                "--token",
                "secret.py",
            ],
        ))
        .unwrap();
        assert!(python
            .facts
            .iter()
            .any(|f| f.label == "模块" && f.value == "uvicorn"));
        assert!(python
            .facts
            .iter()
            .any(|f| f.label == "运行模式" && f.value.contains("自动重载")));
        assert!(!serde_json::to_string(&python).unwrap().contains("secret"));
    }

    #[test]
    fn unknown_program_does_not_invent_a_purpose() {
        let result = program(&process(3, &["custom-app", "--secret", "private"]));
        assert!(result.description.is_none());
        assert!(!serde_json::to_string(&result).unwrap().contains("private"));
    }

    #[test]
    fn runtime_modes_require_actual_cli_or_parent_script_evidence() {
        assert_eq!(
            node_framework_mode(&strings(&[
                "node",
                "/srv/app/node_modules/vite/bin/vite.js",
                "preview"
            ])),
            Some("Vite 构建预览（preview）")
        );
        assert_eq!(
            node_framework_mode(&strings(&[
                "node",
                "/srv/app/node_modules/next/dist/bin/next",
                "start"
            ])),
            Some("Next.js 生产服务器（start）")
        );
        assert_eq!(
            node_framework_mode(&strings(&["node", "/srv/vite/server.js", "dev"])),
            None
        );
        assert_eq!(
            npm_script_from_args(&strings(&[
                "node",
                "/usr/lib/node_modules/npm/bin/npm-cli.js",
                "run",
                "dev",
                "--",
                "--token",
                "secret"
            ]))
            .as_deref(),
            Some("dev")
        );
        assert_eq!(
            npm_script_from_args(&strings(&["sh", "-c", "npm run dev --token secret"])),
            None
        );
        assert_eq!(
            python_module(&strings(&[
                "python",
                "server.py",
                "--token",
                "-m",
                "secret"
            ])),
            None
        );
        let (framework, app) = python_framework(
            &strings(&[
                "python", "-m", "uvicorn", "api:app", "--reload", "--token", "secret",
            ]),
            Some("uvicorn"),
        )
        .unwrap();
        assert_eq!(framework, "Uvicorn ASGI 服务");
        assert_eq!(app.as_deref(), Some("api:app"));
    }

    #[test]
    fn user_service_retains_verified_cgroup_name_without_runtime_manager() {
        let mut process = process(19, &["node", "server.js"]);
        process.user_service = true;
        process.service = Some("my-project.service".to_owned());
        let unit = Unit {
            name: "my-project.service".to_owned(),
            path: "/home/demo/.config/systemd/user/my-project.service".to_owned(),
            ..Unit::default()
        };
        let snapshot = Systemd {
            units: HashMap::new(),
            user_units: [(19, unit)].into_iter().collect(),
            report: Report::new("systemd", "Partial", None),
        };
        let results = snapshot.matches("tcp", "127.0.0.1", 3000, &process);
        assert_eq!(results[0].name, "my-project.service");
        assert_eq!(results[0].confidence, "High");
        assert!(results[0].description.is_none());
        assert!(results[0]
            .facts
            .iter()
            .any(|fact| fact.label == "运行模式" && fact.value.contains("用户级")));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn fifo_metadata_is_rejected_without_waiting_for_a_writer() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let path = std::env::temp_dir().join(format!(
            "portviewer-attribution-fifo-{}",
            std::process::id()
        ));
        let cpath = CString::new(path.as_os_str().as_bytes()).unwrap();
        // This fixture creates only its unique path in the temporary directory.
        assert_eq!(unsafe { libc::mkfifo(cpath.as_ptr(), 0o600) }, 0);
        let started = Instant::now();
        assert!(read_limited(&path, FILE_LIMIT).is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
        fs::remove_file(path).unwrap();
    }

    #[test]
    fn rejects_oversized_metadata() {
        let path =
            std::env::temp_dir().join(format!("portviewer-attribution-{}", std::process::id()));
        fs::write(&path, b"12345").unwrap();
        assert!(read_limited(&path, 4).is_err());
        fs::remove_file(&path).unwrap();
    }

    #[test]
    fn pyproject_accepts_multiline_metadata_and_rejects_invalid_toml() {
        let path = Path::new("/srv/api/pyproject.toml");
        let multiline = b"[project]\nname = 'api'\ndescription = \"\"\"\nOrder API\nwith a background worker.\"\"\"\n";
        let project = python_project(multiline, path).unwrap();
        assert_eq!(project.name.as_deref(), Some("api"));
        assert_eq!(
            project.description.as_deref(),
            Some("Order API\nwith a background worker.")
        );
        assert!(python_project(b"[project]\nname = 'broken\n", path).is_none());
        assert!(python_project(b"[tool.ruff]\nline-length=100\n", path).is_none());
    }

    #[test]
    fn npm_title_is_parsed_without_private_arguments() {
        assert_eq!(
            npm_script_from_args(&strings(&["npm run dev"])).as_deref(),
            Some("dev")
        );
        assert_eq!(
            npm_script_from_args(&strings(&["npm run dev --token secret"])).as_deref(),
            Some("dev")
        );
        assert_eq!(
            npm_script_from_args(&strings(&["npm start --token secret"])).as_deref(),
            Some("start")
        );
        assert!(npm_script_from_args(&strings(&["sh -c npm run dev"])).is_none());
        assert!(npm_script_from_args(&strings(&["npm run --token secret"])).is_none());
    }

    #[test]
    fn project_metadata_uses_process_root_and_never_falls_back_to_host_root() {
        let base =
            std::env::temp_dir().join(format!("portviewer-process-root-{}", std::process::id()));
        let host = base.join("host");
        let container = base.join("container");
        fs::create_dir_all(host.join("app")).unwrap();
        fs::create_dir_all(container.join("app")).unwrap();
        fs::write(
            host.join("app/package.json"),
            br#"{"name":"host-project","description":"Host workload"}"#,
        )
        .unwrap();
        fs::write(
            container.join("app/package.json"),
            br#"{"name":"container-project","description":"Container workload"}"#,
        )
        .unwrap();
        let mut process = process(20, &["node", "/app/server.js"]);
        process.cwd = Some(PathBuf::from("/app"));
        process.root = Some(container.clone());
        let attribution = runtime(&process).unwrap();
        assert_eq!(attribution.name, "container-project");
        assert_eq!(
            attribution.description.as_deref(),
            Some("Container workload")
        );
        process.root = Some(host.clone());
        assert_eq!(runtime(&process).unwrap().name, "host-project");
        process.root = None;
        assert!(runtime(&process).unwrap().description.is_none());
        #[cfg(not(target_os = "linux"))]
        assert_eq!(
            namespace_relative(Path::new("/app/../../app/package.json")).unwrap(),
            PathBuf::from("app/package.json")
        );
        #[cfg(target_os = "linux")]
        assert_eq!(
            namespace_relative(Path::new("/app/../../app/package.json")).unwrap(),
            PathBuf::from("app/../../app/package.json")
        );
        for root in [host, container] {
            fs::remove_file(root.join("app/package.json")).unwrap();
            fs::remove_dir(root.join("app")).unwrap();
            fs::remove_dir(root).unwrap();
        }
        fs::remove_dir(base).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn command_deadline_includes_inherited_stdout_after_successful_exit() {
        let started = Instant::now();
        let result = run_path(Path::new("/bin/sh"), &strings(&["-c", "sleep 3 & exit 0"]));
        assert!(matches!(result, Err(CommandError::Timeout)));
        assert!(started.elapsed() < Duration::from_millis(2200));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn metadata_handle_reopen_retains_verified_inode_after_path_replacement() {
        use std::os::unix::fs::OpenOptionsExt;
        let path =
            std::env::temp_dir().join(format!("portviewer-fixed-inode-{}", std::process::id()));
        fs::write(&path, b"original").unwrap();
        let handle = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_CLOEXEC)
            .open(&path)
            .unwrap();
        fs::remove_file(&path).unwrap();
        fs::write(&path, b"replacement").unwrap();
        assert_eq!(
            read_regular_handle(handle, FILE_LIMIT).unwrap(),
            b"original"
        );
        assert!(read_limited(Path::new("/dev/null"), FILE_LIMIT).is_err());
        fs::remove_file(path).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn project_parent_components_follow_target_namespace_symlink_semantics() {
        use std::os::unix::fs::symlink;
        let root =
            std::env::temp_dir().join(format!("portviewer-symlink-root-{}", std::process::id()));
        fs::create_dir_all(root.join("srv")).unwrap();
        fs::create_dir_all(root.join("opt/app/subdir")).unwrap();
        fs::write(
            root.join("srv/package.json"),
            br#"{"name":"unrelated-project"}"#,
        )
        .unwrap();
        fs::write(
            root.join("opt/app/package.json"),
            br#"{"name":"real-project","description":"Actual symlink target project"}"#,
        )
        .unwrap();
        symlink("/opt/app/subdir", root.join("srv/link")).unwrap();
        let mut process = process(23, &["node", "/srv/link/../server.js"]);
        process.root = Some(root.clone());
        let attribution = runtime(&process).unwrap();
        assert_eq!(attribution.name, "real-project");
        assert_eq!(
            attribution.description.as_deref(),
            Some("Actual symlink target project")
        );
        fs::remove_file(root.join("srv/link")).unwrap();
        fs::remove_file(root.join("srv/package.json")).unwrap();
        fs::remove_file(root.join("opt/app/package.json")).unwrap();
        for directory in ["opt/app/subdir", "opt/app", "opt", "srv"] {
            fs::remove_dir(root.join(directory)).unwrap();
        }
        fs::remove_dir(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    fn namespace_handle(path: &Path) -> File {
        use std::os::unix::fs::OpenOptionsExt;
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_PATH | libc::O_CLOEXEC | libc::O_DIRECTORY)
            .open(path)
            .unwrap()
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn enosys_walker_preserves_symlink_parents_and_clamps_root_escape() {
        use std::os::unix::fs::symlink;
        let root =
            std::env::temp_dir().join(format!("portviewer-fallback-links-{}", std::process::id()));
        fs::create_dir_all(root.join("srv")).unwrap();
        fs::create_dir_all(root.join("opt/app/subdir")).unwrap();
        fs::write(root.join("package.json"), b"root-project").unwrap();
        fs::write(root.join("srv/package.json"), b"wrong-project").unwrap();
        fs::write(root.join("opt/app/package.json"), b"real-project").unwrap();
        symlink("/opt/app/subdir", root.join("srv/absolute")).unwrap();
        symlink("../opt/app/subdir", root.join("srv/relative")).unwrap();
        symlink("../../package.json", root.join("srv/escape")).unwrap();
        symlink("/../../../package.json", root.join("srv/absolute-escape")).unwrap();
        let handle = namespace_handle(&root);
        for entry in [
            "srv/absolute/../package.json",
            "srv/relative/../package.json",
        ] {
            assert_eq!(
                read_regular_handle(walk_in_root(&handle, Path::new(entry)).unwrap(), FILE_LIMIT)
                    .unwrap(),
                b"real-project"
            );
        }
        for entry in ["../../package.json", "srv/escape", "srv/absolute-escape"] {
            assert_eq!(
                read_regular_handle(walk_in_root(&handle, Path::new(entry)).unwrap(), FILE_LIMIT)
                    .unwrap(),
                b"root-project"
            );
        }
        for entry in [
            "srv/absolute",
            "srv/relative",
            "srv/escape",
            "srv/absolute-escape",
            "srv/package.json",
            "opt/app/package.json",
            "package.json",
        ] {
            fs::remove_file(root.join(entry)).unwrap();
        }
        for entry in ["opt/app/subdir", "opt/app", "opt", "srv"] {
            fs::remove_dir(root.join(entry)).unwrap();
        }
        fs::remove_dir(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn enosys_walker_rejects_proc_magic_links() {
        let handle = namespace_handle(Path::new("/"));
        for path in [
            "proc/self/status".to_owned(),
            format!("proc/{}/root/etc/passwd", std::process::id()),
            format!("proc/{}/fd/0", std::process::id()),
        ] {
            assert_eq!(
                walk_in_root(&handle, Path::new(&path))
                    .unwrap_err()
                    .raw_os_error(),
                Some(libc::ELOOP)
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn enosys_walker_never_reads_fifo_or_device_handles() {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let root = std::env::temp_dir().join(format!(
            "portviewer-fallback-special-{}",
            std::process::id()
        ));
        fs::create_dir(&root).unwrap();
        let fifo = root.join("package.json");
        let cpath = CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // O_PATH obtains an inert inode handle; only regular handles can be
        // reopened for IO, including when openat2 is filtered by systemd.
        assert_eq!(unsafe { libc::mkfifo(cpath.as_ptr(), 0o600) }, 0);
        let started = Instant::now();
        let handle = walk_in_root(&namespace_handle(&root), Path::new("package.json")).unwrap();
        assert!(read_regular_handle(handle, FILE_LIMIT).is_err());
        let handle =
            walk_in_root(&namespace_handle(Path::new("/")), Path::new("dev/null")).unwrap();
        assert!(read_regular_handle(handle, FILE_LIMIT).is_err());
        assert!(started.elapsed() < Duration::from_secs(1));
        fs::remove_file(fifo).unwrap();
        fs::remove_dir(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn enosys_walker_bounds_links_steps_and_path_length() {
        use std::os::unix::fs::symlink;
        let root =
            std::env::temp_dir().join(format!("portviewer-fallback-limits-{}", std::process::id()));
        fs::create_dir(&root).unwrap();
        symlink("loop", root.join("loop")).unwrap();
        let handle = namespace_handle(&root);
        for path in ["loop".to_owned(), "./".repeat(257)] {
            assert_eq!(
                walk_in_root(&handle, Path::new(&path))
                    .unwrap_err()
                    .raw_os_error(),
                Some(libc::ELOOP)
            );
        }
        assert_eq!(
            walk_in_root(&handle, Path::new(&"x".repeat(4097)))
                .unwrap_err()
                .raw_os_error(),
            Some(libc::ENAMETOOLONG)
        );
        fs::remove_file(root.join("loop")).unwrap();
        fs::remove_dir(root).unwrap();
    }
}
