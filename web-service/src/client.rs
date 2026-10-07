use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use reqwest::{Method, Url};
use serde::de::DeserializeOwned;

use crate::ports::{CheckResponse, FreePortRequest, FreePortResponse, ProtocolSelector};

const MAX_RESPONSE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone)]
pub struct ApiClient {
    base: Url,
    http: reqwest::Client,
    token: Option<Arc<str>>,
}

impl ApiClient {
    pub async fn connect(server: &str) -> Result<Self, String> {
        let base = validate_server_url(server)?;
        let host = base
            .host_str()
            .ok_or("PORTVIEWER_SERVER 缺少主机")?
            .to_string();
        let port = base
            .port_or_known_default()
            .ok_or("PORTVIEWER_SERVER 缺少有效端口")?;
        let addresses = resolve_lan_addresses(&host, port).await?;

        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(30))
            .user_agent(concat!("portviewer-cli/", env!("CARGO_PKG_VERSION")));
        if host.parse::<IpAddr>().is_err() {
            builder = builder.resolve_to_addrs(&host, &addresses);
        }
        let http = builder
            .build()
            .map_err(|error| format!("无法创建局域网 API 客户端：{error}"))?;
        let token = std::env::var("PORTVIEWER_API_TOKEN")
            .ok()
            .map(|value| validate_client_token(value).map(Arc::<str>::from))
            .transpose()?;

        Ok(Self { base, http, token })
    }

    pub async fn check_ports(
        &self,
        expression: &str,
        protocol: ProtocolSelector,
        detailed: bool,
    ) -> Result<CheckResponse, String> {
        let url = self.endpoint("api/v1/ports/check")?;
        let request = self.http.request(Method::GET, url).query(&[
            ("ports", expression.to_string()),
            ("protocol", protocol.to_string()),
            ("details", detailed.to_string()),
        ]);
        let request = if detailed {
            let token = self
                .token
                .as_deref()
                .ok_or("详细查询需要在 MCP/CLI 进程中设置 PORTVIEWER_API_TOKEN")?;
            if self.base.scheme() == "http" && !is_loopback_host(&self.base) {
                tracing::warn!(
                    "Token 正通过未加密的局域网 HTTP 发送；生产环境应在受信反向代理上启用 HTTPS"
                );
            }
            request.bearer_auth(token)
        } else {
            request
        };
        self.execute(request).await
    }

    pub async fn find_free_port(
        &self,
        protocol: ProtocolSelector,
        min_port: u16,
        max_port: u16,
    ) -> Result<FreePortResponse, String> {
        let request = FreePortRequest {
            protocol,
            min_port,
            max_port,
        };
        let url = self.endpoint("api/v1/ports/free")?;
        self.execute(self.http.request(Method::POST, url).json(&request))
            .await
    }

    async fn execute<T: DeserializeOwned>(
        &self,
        request: reqwest::RequestBuilder,
    ) -> Result<T, String> {
        let response = request
            .send()
            .await
            .map_err(|error| format!("无法连接 PortViewer 局域网 API：{error}"))?;
        let status = response.status();
        if response
            .content_length()
            .is_some_and(|size| size > MAX_RESPONSE_BYTES)
        {
            return Err("PortViewer API 响应超过 4 MiB 安全上限".to_string());
        }
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("无法读取 PortViewer API 响应：{error}"))?;
        if bytes.len() as u64 > MAX_RESPONSE_BYTES {
            return Err("PortViewer API 响应超过 4 MiB 安全上限".to_string());
        }
        if !status.is_success() {
            let message = serde_json::from_slice::<ApiErrorEnvelope>(&bytes)
                .map(|body| format!("{}：{}", body.code, body.error))
                .unwrap_or_else(|_| String::from_utf8_lossy(&bytes).chars().take(500).collect());
            return Err(format!(
                "PortViewer API 返回 HTTP {}：{message}",
                status.as_u16()
            ));
        }
        serde_json::from_slice(&bytes)
            .map_err(|error| format!("PortViewer API 响应格式无效：{error}"))
    }

    fn endpoint(&self, path: &str) -> Result<Url, String> {
        self.base
            .join(path)
            .map_err(|error| format!("无法构造 PortViewer API 地址：{error}"))
    }
}

#[derive(serde::Deserialize)]
struct ApiErrorEnvelope {
    code: String,
    error: String,
}

fn validate_server_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|error| format!("PORTVIEWER_SERVER 无效：{error}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("PORTVIEWER_SERVER 只允许 http 或 https".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("PORTVIEWER_SERVER 禁止在 URL 中携带凭据".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("PORTVIEWER_SERVER 禁止 query 或 fragment".to_string());
    }
    if url.path() != "/" && !url.path().is_empty() {
        return Err("PORTVIEWER_SERVER 必须指向服务根地址，不能包含路径".to_string());
    }
    if url.host_str().is_none() {
        return Err("PORTVIEWER_SERVER 缺少主机".to_string());
    }
    Ok(url)
}

async fn resolve_lan_addresses(host: &str, port: u16) -> Result<Vec<SocketAddr>, String> {
    let addresses = if let Ok(ip) = host.parse::<IpAddr>() {
        vec![SocketAddr::new(ip, port)]
    } else {
        tokio::net::lookup_host((host, port))
            .await
            .map_err(|error| format!("无法解析局域网 API 主机 {host}：{error}"))?
            .collect::<Vec<_>>()
    };
    if addresses.is_empty() {
        return Err(format!("局域网 API 主机 {host} 没有可用地址"));
    }
    if addresses
        .iter()
        .any(|address| !crate::api::is_lan_peer_ip(address.ip()))
    {
        return Err(format!(
            "拒绝连接非局域网地址；{host} 的全部解析结果必须是 loopback、私有或链路本地地址"
        ));
    }
    let mut addresses = addresses;
    addresses.sort();
    addresses.dedup();
    Ok(addresses)
}

fn validate_client_token(value: String) -> Result<String, String> {
    let bytes = value.as_bytes();
    if !(32..=256).contains(&bytes.len())
        || !bytes
            .iter()
            .all(|byte| byte.is_ascii_graphic() && !byte.is_ascii_whitespace())
    {
        return Err(
            "PORTVIEWER_API_TOKEN 必须是 32..256 字节、无空白的可打印 ASCII 字符".to_string(),
        );
    }
    Ok(value)
}

fn is_loopback_host(url: &Url) -> bool {
    url.host_str()
        .and_then(|host| host.parse::<IpAddr>().ok())
        .is_some_and(|ip| ip.is_loopback())
        || url.host_str() == Some("localhost")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_url_rejects_credentials_paths_and_public_protocols() {
        assert!(validate_server_url("ftp://127.0.0.1/").is_err());
        assert!(validate_server_url("http://user:pass@127.0.0.1/").is_err());
        assert!(validate_server_url("http://127.0.0.1/base").is_err());
        assert!(validate_server_url("http://127.0.0.1:17890/").is_ok());
    }

    #[tokio::test]
    async fn resolver_rejects_public_literal_and_accepts_loopback() {
        assert!(resolve_lan_addresses("8.8.8.8", 80).await.is_err());
        assert!(resolve_lan_addresses("127.0.0.1", 17890).await.is_ok());
    }
}
