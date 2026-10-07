use std::collections::VecDeque;
use std::net::SocketAddr;
use std::path::PathBuf;

use crate::auth::ApiToken;
use crate::formatting::OutputFormat;
use crate::ports::ProtocolSelector;

const DEFAULT_LISTEN: &str = "127.0.0.1:17890";
const DEFAULT_SERVER: &str = "http://127.0.0.1:17890";
const DEFAULT_FREE_START: u16 = 30_001;
const DEFAULT_FREE_END: u16 = 49_151;

pub enum Command {
    Serve(ServeConfig),
    Check(CheckConfig),
    Free(FreeConfig),
    Mcp(ClientConfig),
    Help(String),
}

pub struct ServeConfig {
    pub listen: SocketAddr,
    pub assets: Option<PathBuf>,
    pub token: Option<ApiToken>,
    pub allowed_hosts: Vec<String>,
}

pub struct CheckConfig {
    pub server: String,
    pub ports: String,
    pub protocol: ProtocolSelector,
    pub details: bool,
    pub output: OutputFormat,
}

pub struct FreeConfig {
    pub server: String,
    pub protocol: ProtocolSelector,
    pub start: u16,
    pub end: u16,
    pub output: OutputFormat,
}

pub struct ClientConfig {
    pub server: String,
}

struct Defaults {
    listen: String,
    assets: Option<PathBuf>,
    api_only: bool,
    server: String,
    token: Option<String>,
    allowed_hosts: String,
}

impl Command {
    pub fn parse_environment_and_args() -> Result<Self, String> {
        let defaults = Defaults {
            listen: std::env::var("PORTVIEWER_LISTEN")
                .unwrap_or_else(|_| DEFAULT_LISTEN.to_string()),
            assets: std::env::var_os("PORTVIEWER_ASSETS").map(PathBuf::from),
            api_only: std::env::var("PORTVIEWER_API_ONLY")
                .ok()
                .is_some_and(|value| is_truthy(&value)),
            server: std::env::var("PORTVIEWER_SERVER")
                .unwrap_or_else(|_| DEFAULT_SERVER.to_string()),
            token: std::env::var("PORTVIEWER_API_TOKEN").ok(),
            allowed_hosts: std::env::var("PORTVIEWER_ALLOWED_HOSTS").unwrap_or_default(),
        };
        Self::parse(std::env::args().skip(1), defaults)
    }

    fn parse(args: impl IntoIterator<Item = String>, defaults: Defaults) -> Result<Self, String> {
        let mut args = args.into_iter().collect::<VecDeque<_>>();
        let command = match args.front().map(String::as_str) {
            Some("serve" | "check" | "free" | "mcp") => args.pop_front().unwrap(),
            Some("help") => return Ok(Self::Help(help_text())),
            Some("--help" | "-h") => return Ok(Self::Help(help_text())),
            Some(value) if !value.starts_with('-') => {
                return Err(format!("未知子命令：{value}\n\n{}", help_text()));
            }
            _ => "serve".to_string(),
        };

        if args
            .iter()
            .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
        {
            return Ok(Self::Help(command_help(&command)));
        }

        match command.as_str() {
            "serve" => parse_serve(args, defaults).map(Self::Serve),
            "check" => parse_check(args, defaults).map(Self::Check),
            "free" => parse_free(args, defaults).map(Self::Free),
            "mcp" => parse_mcp(args, defaults).map(Self::Mcp),
            _ => unreachable!("validated command"),
        }
    }
}

fn parse_serve(mut args: VecDeque<String>, defaults: Defaults) -> Result<ServeConfig, String> {
    let mut listen = defaults.listen;
    let mut assets = defaults.assets;
    let mut api_only = defaults.api_only;

    while let Some(argument) = args.pop_front() {
        match argument.as_str() {
            "--listen" => listen = take_value(&mut args, "--listen")?,
            "--assets" => assets = Some(PathBuf::from(take_value(&mut args, "--assets")?)),
            "--api-only" => api_only = true,
            value => return Err(format!("serve 不支持参数：{value}")),
        }
    }

    let listen = listen
        .parse::<SocketAddr>()
        .map_err(|error| format!("监听地址无效：{error}"))?;
    if !listen.ip().is_loopback() && !crate::api::is_lan_bind_ip(listen.ip()) {
        return Err("监听地址必须是 loopback、私有地址、链路本地地址或未指定地址".to_string());
    }
    let token = ApiToken::parse(defaults.token)?;
    if !listen.ip().is_loopback() && token.is_none() {
        return Err(
            "监听局域网地址前必须通过 PORTVIEWER_API_TOKEN 配置至少 32 位随机 Token".to_string(),
        );
    }
    let allowed_hosts = parse_allowed_hosts(&defaults.allowed_hosts)?;
    let assets = if api_only {
        None
    } else {
        Some(assets.unwrap_or_else(default_assets_directory))
    };

    Ok(ServeConfig {
        listen,
        assets,
        token,
        allowed_hosts,
    })
}

fn parse_check(mut args: VecDeque<String>, defaults: Defaults) -> Result<CheckConfig, String> {
    let mut server = defaults.server;
    let mut ports = None;
    let mut protocol = ProtocolSelector::Tcp;
    let mut details = false;
    let mut output = OutputFormat::Json;

    while let Some(argument) = args.pop_front() {
        match argument.as_str() {
            "--server" => server = take_value(&mut args, "--server")?,
            "--ports" => ports = Some(take_value(&mut args, "--ports")?),
            "--protocol" => {
                protocol = take_value(&mut args, "--protocol")?.parse()?;
            }
            "--details" => details = true,
            "--output" => output = take_value(&mut args, "--output")?.parse()?,
            value => return Err(format!("check 不支持参数：{value}")),
        }
    }

    Ok(CheckConfig {
        server,
        ports: ports.ok_or("check 必须提供 --ports，例如 80,443,3000-3010")?,
        protocol,
        details,
        output,
    })
}

fn parse_free(mut args: VecDeque<String>, defaults: Defaults) -> Result<FreeConfig, String> {
    let mut server = defaults.server;
    let mut protocol = ProtocolSelector::Tcp;
    let mut start = DEFAULT_FREE_START;
    let mut end = DEFAULT_FREE_END;
    let mut output = OutputFormat::Json;

    while let Some(argument) = args.pop_front() {
        match argument.as_str() {
            "--server" => server = take_value(&mut args, "--server")?,
            "--protocol" => {
                protocol = take_value(&mut args, "--protocol")?.parse()?;
            }
            "--min" => start = parse_port(&take_value(&mut args, "--min")?, "--min")?,
            "--max" => end = parse_port(&take_value(&mut args, "--max")?, "--max")?,
            "--output" => output = take_value(&mut args, "--output")?.parse()?,
            value => return Err(format!("free 不支持参数：{value}")),
        }
    }
    if start < DEFAULT_FREE_START {
        return Err(format!("--min 不能小于 {DEFAULT_FREE_START}"));
    }
    if start > end {
        return Err("--min 不能大于 --max".to_string());
    }

    Ok(FreeConfig {
        server,
        protocol,
        start,
        end,
        output,
    })
}

fn parse_mcp(mut args: VecDeque<String>, defaults: Defaults) -> Result<ClientConfig, String> {
    let mut server = defaults.server;
    while let Some(argument) = args.pop_front() {
        match argument.as_str() {
            "--server" => server = take_value(&mut args, "--server")?,
            value => return Err(format!("mcp 不支持参数：{value}")),
        }
    }
    Ok(ClientConfig { server })
}

fn parse_allowed_hosts(value: &str) -> Result<Vec<String>, String> {
    let mut hosts = Vec::new();
    for raw in value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if hosts.len() >= 32 {
            return Err("PORTVIEWER_ALLOWED_HOSTS 最多允许 32 项".to_string());
        }
        if raw.len() > 253
            || raw.chars().any(char::is_whitespace)
            || raw.contains('/')
            || raw.contains('@')
        {
            return Err(format!("PORTVIEWER_ALLOWED_HOSTS 包含无效主机名：{raw}"));
        }
        hosts.push(raw.trim_end_matches('.').to_ascii_lowercase());
    }
    hosts.sort();
    hosts.dedup();
    Ok(hosts)
}

fn parse_port(value: &str, option: &str) -> Result<u16, String> {
    value
        .parse::<u16>()
        .ok()
        .filter(|port| *port > 0)
        .ok_or_else(|| format!("{option} 必须是 1..65535 的端口号"))
}

fn take_value(args: &mut VecDeque<String>, option: &str) -> Result<String, String> {
    args.pop_front()
        .filter(|value| !value.is_empty() && !value.starts_with("--"))
        .ok_or_else(|| format!("{option} 缺少值"))
}

fn is_truthy(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn default_assets_directory() -> PathBuf {
    let current = PathBuf::from("dist");
    if current.is_dir() {
        return current;
    }
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(std::path::Path::to_path_buf))
        .map(|path| path.join("web-assets"))
        .unwrap_or(current)
}

fn help_text() -> String {
    format!(
        "PortViewer WebGUI / LAN Port API / CLI / MCP\n\n\
         用法：\n  \
         portviewer-web [serve] [--listen {DEFAULT_LISTEN}] [--assets ./dist] [--api-only]\n  \
         portviewer-web check --ports 80,443,3000-3010 [--protocol tcp|udp|both] [--details] [--server URL] [--output json|markdown]\n  \
         portviewer-web free [--protocol tcp|udp|both] [--min {DEFAULT_FREE_START}] [--max {DEFAULT_FREE_END}] [--server URL] [--output json|markdown]\n  \
         portviewer-web mcp [--server URL]\n\n\
         环境变量：PORTVIEWER_API_TOKEN、PORTVIEWER_LISTEN、PORTVIEWER_ASSETS、\n\
         PORTVIEWER_API_ONLY、PORTVIEWER_ALLOWED_HOSTS、PORTVIEWER_SERVER、RUST_LOG\n\n\
         Token 只通过环境变量传递，避免出现在命令历史和进程列表中。"
    )
}

fn command_help(command: &str) -> String {
    match command {
        "serve" => format!(
            "portviewer-web serve [--listen {DEFAULT_LISTEN}] [--assets ./dist] [--api-only]"
        ),
        "check" => "portviewer-web check --ports 80,443,3000-3010 [--protocol tcp|udp|both] [--details] [--server URL] [--output json|markdown]".to_string(),
        "free" => format!(
            "portviewer-web free [--protocol tcp|udp|both] [--min {DEFAULT_FREE_START}] [--max {DEFAULT_FREE_END}] [--server URL] [--output json|markdown]"
        ),
        "mcp" => "portviewer-web mcp [--server URL]".to_string(),
        _ => help_text(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn defaults() -> Defaults {
        Defaults {
            listen: DEFAULT_LISTEN.to_string(),
            assets: Some(PathBuf::from("dist")),
            api_only: true,
            server: DEFAULT_SERVER.to_string(),
            token: Some("0123456789abcdef0123456789abcdef".to_string()),
            allowed_hosts: String::new(),
        }
    }

    #[test]
    fn preserves_legacy_serve_invocation() {
        let command = Command::parse(
            ["--listen", "127.0.0.1:19000"]
                .into_iter()
                .map(str::to_string),
            defaults(),
        )
        .unwrap();
        let Command::Serve(config) = command else {
            panic!("expected serve");
        };
        assert_eq!(config.listen.port(), 19_000);
    }

    #[test]
    fn parses_check_ranges_and_details() {
        let command = Command::parse(
            [
                "check",
                "--ports",
                "80,443,3000-3010",
                "--protocol",
                "both",
                "--details",
            ]
            .into_iter()
            .map(str::to_string),
            defaults(),
        )
        .unwrap();
        let Command::Check(config) = command else {
            panic!("expected check");
        };
        assert_eq!(config.protocol, ProtocolSelector::Both);
        assert!(config.details);
    }

    #[test]
    fn rejects_lan_listen_without_token() {
        let mut defaults = defaults();
        defaults.token = None;
        let result = Command::parse(
            ["serve", "--listen", "0.0.0.0:17890"]
                .into_iter()
                .map(str::to_string),
            defaults,
        );
        assert!(result.is_err());
    }

    #[test]
    fn rejects_free_ranges_below_product_floor() {
        let result = Command::parse(
            ["free", "--min", "29999"].into_iter().map(str::to_string),
            defaults(),
        );
        assert!(result.is_err());
    }
}
