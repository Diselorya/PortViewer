//! Explicitly trusted local CONNECT proxies; remote metadata destinations remain allowlisted.
use reqwest::Url;
use std::net::SocketAddr;

/// Deliberately has no Debug implementation. Rejected input must never enter diagnostics.
pub(super) struct MetadataProxy {
    url: Url,
}
impl MetadataProxy {
    pub(super) fn parse(value: &str) -> Result<Self, &'static str> {
        if value.len() > 2048 || value.chars().any(char::is_control) {
            return Err("知识代理配置无效：仅支持无凭据的数字 loopback HTTP(S) 代理");
        }
        let value = value.trim();
        let (scheme, address) = value
            .split_once("://")
            .ok_or("知识代理配置无效：需要 HTTP(S) 和显式端口")?;
        let scheme = scheme.to_ascii_lowercase();
        if !matches!(scheme.as_str(), "http" | "https") {
            return Err("知识代理配置无效：仅支持 HTTP(S)");
        }
        let address = address.strip_suffix('/').unwrap_or(address);
        let socket = address
            .parse::<SocketAddr>()
            .map_err(|_| "知识代理配置无效：仅支持无凭据的数字 loopback 地址和显式端口")?;
        if !socket.ip().is_loopback() || socket.port() == 0 {
            return Err("知识代理配置无效：仅允许数字 loopback 地址和非零端口");
        }
        let url = Url::parse(&format!("{scheme}://{socket}/")).map_err(|_| "知识代理配置无效")?;
        Ok(Self { url })
    }
    pub(super) fn for_target(&self, target: &Url) -> Result<reqwest::Proxy, &'static str> {
        if !super::network::valid_public_target(target) {
            return Err("知识代理只用于固定公开资料 HTTPS 目标");
        }
        reqwest::Proxy::https(self.url.clone())
            .map(|proxy| proxy.no_proxy(None))
            .map_err(|_| "知识代理配置无效")
    }
}
#[derive(Default)]
pub(super) struct SystemProxySettings {
    pub(super) enabled: bool,
    pub(super) auto_detect: bool,
    pub(super) has_pac: bool,
    pub(super) server: Option<String>,
}
pub(super) fn choose(
    explicit: Option<&str>,
    system: &SystemProxySettings,
) -> Result<Option<MetadataProxy>, &'static str> {
    if let Some(explicit) = explicit {
        return MetadataProxy::parse(explicit).map(Some);
    }
    if !system.enabled || system.auto_detect || system.has_pac {
        return Ok(None);
    }
    Ok(system
        .server
        .as_deref()
        .and_then(system_endpoint)
        .and_then(|value| MetadataProxy::parse(&value).ok()))
}
fn system_endpoint(value: &str) -> Option<String> {
    if value.len() > 4096 || value.contains('@') || value.chars().any(char::is_control) {
        return None;
    }
    let value = value.trim();
    let endpoint = if value.contains('=') {
        let mut https = None;
        for (index, item) in value
            .split(';')
            .filter(|item| !item.trim().is_empty())
            .enumerate()
        {
            if index >= 8 {
                return None;
            }
            let (protocol, endpoint) = item.trim().split_once('=')?;
            if protocol.trim().eq_ignore_ascii_case("https") {
                if https.is_some() {
                    return None;
                }
                https = Some(endpoint.trim());
            }
        }
        https?
    } else {
        if value.contains(';') {
            return None;
        }
        value
    };
    Some(if endpoint.contains("://") {
        endpoint.to_owned()
    } else {
        format!("http://{endpoint}")
    })
}
#[cfg(not(test))]
pub(super) fn discover() -> Result<Option<MetadataProxy>, &'static str> {
    let explicit = match std::env::var("PORTVIEWER_KNOWLEDGE_PROXY") {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(_) => return Err("知识代理配置不是有效文本"),
    };
    let system = if explicit.is_none() {
        system_settings()
    } else {
        SystemProxySettings::default()
    };
    choose(explicit.as_deref(), &system)
}
#[cfg(all(not(test), not(windows)))]
fn system_settings() -> SystemProxySettings {
    SystemProxySettings::default()
}
#[cfg(all(not(test), windows))]
fn system_settings() -> SystemProxySettings {
    use std::ffi::c_void;
    #[repr(C)]
    struct IeProxyConfig {
        auto_detect: i32,
        auto_config_url: *mut u16,
        proxy: *mut u16,
        proxy_bypass: *mut u16,
    }
    #[link(name = "Winhttp")]
    extern "system" {
        fn WinHttpGetIEProxyConfigForCurrentUser(config: *mut IeProxyConfig) -> i32;
    }
    #[link(name = "Kernel32")]
    extern "system" {
        fn GlobalFree(memory: *mut c_void) -> *mut c_void;
    }
    let mut config = IeProxyConfig {
        auto_detect: 0,
        auto_config_url: std::ptr::null_mut(),
        proxy: std::ptr::null_mut(),
        proxy_bypass: std::ptr::null_mut(),
    };
    let success = unsafe { WinHttpGetIEProxyConfigForCurrentUser(&mut config) } != 0;
    let has_pac = !config.auto_config_url.is_null() && unsafe { *config.auto_config_url != 0 };
    let mut result = SystemProxySettings {
        enabled: success && !config.proxy.is_null(),
        auto_detect: config.auto_detect != 0,
        has_pac,
        server: None,
    };
    if result.enabled && !result.auto_detect && !has_pac {
        // WinHTTP owns a valid NUL-terminated string until GlobalFree below.
        let mut units = Vec::new();
        for index in 0..4097 {
            let unit = unsafe { *config.proxy.add(index) };
            if unit == 0 {
                result.server = String::from_utf16(&units).ok();
                break;
            }
            units.push(unit);
        }
    }
    for pointer in [config.auto_config_url, config.proxy, config.proxy_bypass] {
        if !pointer.is_null() {
            unsafe {
                GlobalFree(pointer.cast());
            }
        }
    }
    result
}
#[cfg(test)]
#[path = "proxy_tests.rs"]
mod tests;
