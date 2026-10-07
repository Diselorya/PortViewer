use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::str::FromStr;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::rejection::{JsonRejection, QueryRejection};
use axum::extract::{ConnectInfo, DefaultBodyLimit, Json, Query, Request, State};
use axum::http::uri::Authority;
use axum::http::{header, HeaderName, HeaderValue, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::Mutex;
use tower_http::services::{ServeDir, ServeFile};
use tower_http::trace::TraceLayer;
use tracing::{info, warn};

use crate::auth::{authorization_status, ApiToken, AuthResult};
use crate::command::ServeConfig;
use crate::ports::{
    check_ports, find_free_port, parse_ports, parse_snapshot, validate_free_request, CheckResponse,
    FreePortRequest, FreePortResponse, ProtocolSelector, Snapshot,
};

const MAX_ERROR_LENGTH: usize = 500;
const SCAN_TIMEOUT: Duration = Duration::from_secs(25);

#[derive(Clone)]
struct AppState {
    build_identity: Option<Value>,
    scan_lock: Arc<Mutex<()>>,
    token: Option<Arc<ApiToken>>,
    allowed_hosts: Arc<Vec<String>>,
    api_only: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Health<'a> {
    status: &'a str,
    service: &'a str,
    platform: &'a str,
    mode: &'a str,
    api_version: u8,
    token_details_configured: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckQuery {
    ports: String,
    #[serde(default = "default_protocol_query")]
    protocol: String,
    #[serde(default)]
    details: bool,
}

pub async fn serve(config: ServeConfig) -> Result<(), String> {
    let assets = config.assets.map(validate_assets).transpose()?;
    let build_identity = assets
        .as_ref()
        .map(|path| {
            load_json(&path.join("portviewer-build-identity.json"))
                .and_then(normalize_build_identity)
        })
        .transpose()?;
    let state = AppState {
        build_identity,
        scan_lock: Arc::new(Mutex::new(())),
        token: config.token.map(Arc::new),
        allowed_hosts: Arc::new(config.allowed_hosts),
        api_only: assets.is_none(),
    };
    let app = router(state.clone(), assets);
    let listener = tokio::net::TcpListener::bind(config.listen)
        .await
        .map_err(|error| format!("无法监听 {}：{error}", config.listen))?;

    info!(
        "PortViewer 已启动：http://{}（WebGUI 仅 loopback；局域网只开放端口 API）",
        config.listen
    );
    if !config.listen.ip().is_loopback() {
        warn!("局域网 Token 在直连 HTTP 中未加密；详细查询应通过受信 HTTPS 反向代理或隔离管理网");
    }
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await
    .map_err(|error| format!("PortViewer Web/API 服务异常结束：{error}"))
}

fn router(state: AppState, assets: Option<PathBuf>) -> Router {
    let mut app = Router::new()
        .route("/api/health", get(health))
        .route("/api/v1/ports/check", get(check))
        .route("/api/v1/ports/free", post(free));
    if let Some(assets) = assets {
        let index = assets.join("index.html");
        app = app
            .route("/api/v1/build-identity", get(build_identity))
            .route("/api/v1/scan", get(scan))
            .fallback_service(ServeDir::new(assets).not_found_service(ServeFile::new(index)));
    }
    app.layer(DefaultBodyLimit::max(16 * 1024))
        .layer(TraceLayer::new_for_http())
        .layer(middleware::from_fn_with_state(
            state.clone(),
            validate_lan_request,
        ))
        .layer(middleware::from_fn(security_headers))
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> Json<Health<'static>> {
    Json(Health {
        status: "ok",
        service: "portviewer-web",
        platform: std::env::consts::OS,
        mode: if state.api_only {
            "lan-port-api"
        } else {
            "local-webgui-and-lan-port-api"
        },
        api_version: 1,
        token_details_configured: state.token.is_some(),
    })
}

async fn build_identity(State(state): State<AppState>) -> Response {
    match state.build_identity {
        Some(identity) => Json(identity).into_response(),
        None => ApiProblem::not_found("webgui_disabled", "API-only 模式未加载 WebGUI 构建身份")
            .into_response(),
    }
}

async fn scan(State(state): State<AppState>) -> Response {
    match run_platform_scan(&state, true).await {
        Ok(snapshot) => Json(snapshot).into_response(),
        Err(error) => error.into_response(),
    }
}

async fn check(
    State(state): State<AppState>,
    headers: axum::http::HeaderMap,
    query: Result<Query<CheckQuery>, QueryRejection>,
) -> Result<Json<CheckResponse>, ApiProblem> {
    let Query(query) = query.map_err(|error| {
        ApiProblem::bad_request(
            "invalid_query",
            &format!("查询参数无效：{}", error.body_text()),
        )
    })?;
    let auth = authorization_status(state.token.as_deref(), &headers);
    if auth == AuthResult::Invalid {
        return Err(ApiProblem::unauthorized());
    }
    if query.details {
        if state.token.is_none() {
            return Err(ApiProblem::new(
                StatusCode::SERVICE_UNAVAILABLE,
                "token_not_configured",
                "服务端未配置 PORTVIEWER_API_TOKEN，无法提供详细查询",
            ));
        }
        if auth != AuthResult::Valid {
            return Err(ApiProblem::unauthorized());
        }
    }

    let ports = parse_ports(&query.ports)
        .map_err(|message| ApiProblem::bad_request("invalid_ports", &message))?;
    let protocol = query
        .protocol
        .parse::<ProtocolSelector>()
        .map_err(|message| ApiProblem::bad_request("invalid_protocol", &message))?;
    let snapshot = run_snapshot(&state, query.details).await?;
    Ok(Json(check_ports(&snapshot, ports, protocol, query.details)))
}

async fn free(
    State(state): State<AppState>,
    request: Result<Json<FreePortRequest>, JsonRejection>,
) -> Result<Json<FreePortResponse>, ApiProblem> {
    let Json(request) = request.map_err(|error| {
        ApiProblem::bad_request(
            "invalid_json",
            &format!("JSON 请求体无效：{}", error.body_text()),
        )
    })?;
    validate_free_request(&request)
        .map_err(|message| ApiProblem::bad_request("invalid_port_range", &message))?;
    let snapshot = run_snapshot(&state, false).await?;
    find_free_port(&snapshot, &request)
        .map(Json)
        .map_err(|message| ApiProblem::new(StatusCode::CONFLICT, "no_free_port", &message))
}

async fn run_snapshot(state: &AppState, detailed: bool) -> Result<Snapshot, ApiProblem> {
    let value = run_platform_scan(state, detailed).await?;
    parse_snapshot(value).map_err(|message| {
        ApiProblem::new(StatusCode::INTERNAL_SERVER_ERROR, "scan_contract", &message)
    })
}

async fn run_platform_scan(state: &AppState, detailed: bool) -> Result<Value, ApiProblem> {
    let guard = state
        .scan_lock
        .clone()
        .try_lock_owned()
        .map_err(|_| ApiProblem::busy())?;
    let task = tokio::task::spawn_blocking(move || {
        let _guard = guard;
        if detailed {
            crate::platform::scan()
        } else {
            crate::platform::scan_basic()
        }
    });
    match tokio::time::timeout(SCAN_TIMEOUT, task).await {
        Ok(Ok(Ok(value))) => Ok(value),
        Ok(Ok(Err(error))) => Err(ApiProblem::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "scan_failed",
            &error,
        )),
        Ok(Err(error)) => Err(ApiProblem::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "scan_task_failed",
            &format!("扫描线程异常结束：{error}"),
        )),
        Err(_) => Err(ApiProblem::new(
            StatusCode::GATEWAY_TIMEOUT,
            "scan_timeout",
            "扫描超过 25 秒安全预算",
        )),
    }
}

async fn validate_lan_request(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    let Some(ConnectInfo(remote)) = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .copied()
    else {
        return ApiProblem::new(
            StatusCode::FORBIDDEN,
            "missing_peer_address",
            "无法确认请求来源",
        )
        .into_response();
    };
    if !is_lan_peer_ip(remote.ip()) {
        warn!(peer = %remote.ip(), "拒绝非局域网请求");
        return ApiProblem::new(
            StatusCode::FORBIDDEN,
            "lan_only",
            "该接口仅允许本机或局域网来源",
        )
        .into_response();
    }

    let path = request.uri().path();
    if !remote.ip().is_loopback() && !is_remote_api_path(path) {
        return ApiProblem::new(
            StatusCode::FORBIDDEN,
            "loopback_only_surface",
            "WebGUI 与完整扫描仅允许本机访问；局域网只开放端口 API",
        )
        .into_response();
    }
    if !valid_host(request.headers(), &state.allowed_hosts) {
        warn!("拒绝无效 Host 请求");
        return ApiProblem::bad_request(
            "invalid_host",
            "Host 必须是 loopback、私有 IP 或 PORTVIEWER_ALLOWED_HOSTS 中的主机名",
        )
        .into_response();
    }
    if !valid_origin(request.headers()) {
        return ApiProblem::new(StatusCode::FORBIDDEN, "invalid_origin", "拒绝跨站 Origin")
            .into_response();
    }
    next.run(request).await
}

fn is_remote_api_path(path: &str) -> bool {
    matches!(
        path,
        "/api/health" | "/api/v1/ports/check" | "/api/v1/ports/free"
    )
}

fn valid_host(headers: &axum::http::HeaderMap, allowed_hosts: &[String]) -> bool {
    let Some(raw) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    let Ok(authority) = Authority::from_str(raw) else {
        return false;
    };
    let host = authority
        .host()
        .trim_matches(['[', ']'])
        .trim_end_matches('.')
        .to_ascii_lowercase();
    host == "localhost"
        || allowed_hosts.iter().any(|allowed| allowed == &host)
        || host.parse::<IpAddr>().is_ok_and(is_lan_peer_ip)
}

fn valid_origin(headers: &axum::http::HeaderMap) -> bool {
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let Some(host) = headers
        .get(header::HOST)
        .and_then(|value| value.to_str().ok())
    else {
        return false;
    };
    origin.eq_ignore_ascii_case(&format!("http://{host}"))
        || origin.eq_ignore_ascii_case(&format!("https://{host}"))
}

async fn security_headers(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        header::CONTENT_SECURITY_POLICY,
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        ),
    );
    headers.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    headers.insert(
        header::REFERRER_POLICY,
        HeaderValue::from_static("no-referrer"),
    );
    headers.insert(
        HeaderName::from_static("x-frame-options"),
        HeaderValue::from_static("DENY"),
    );
    headers.insert(
        HeaderName::from_static("permissions-policy"),
        HeaderValue::from_static("camera=(), microphone=(), geolocation=()"),
    );
    headers.insert(
        HeaderName::from_static("cross-origin-resource-policy"),
        HeaderValue::from_static("same-origin"),
    );
    headers.insert(
        HeaderName::from_static("x-portviewer-api-version"),
        HeaderValue::from_static("1"),
    );
    headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

fn validate_assets(path: PathBuf) -> Result<PathBuf, String> {
    let path = path
        .canonicalize()
        .map_err(|error| format!("无法读取 WebGUI 静态目录 {}：{error}", path.display()))?;
    if !path.join("index.html").is_file() || !path.join("portviewer-build-identity.json").is_file()
    {
        return Err(format!(
            "静态目录 {} 不完整；请先运行 npm run build，或使用 --api-only",
            path.display()
        ));
    }
    Ok(path)
}

fn load_json(path: &Path) -> Result<Value, String> {
    let bytes =
        std::fs::read(path).map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    if bytes.len() > 64 * 1024 {
        return Err("构建身份文件超过安全大小限制".to_string());
    }
    serde_json::from_slice(&bytes).map_err(|error| format!("构建身份文件格式无效：{error}"))
}

fn normalize_build_identity(raw: Value) -> Result<Value, String> {
    let required_string = |key: &str| {
        raw.get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty() && value.len() <= 256)
            .map(str::to_owned)
            .ok_or_else(|| format!("构建身份字段 {key} 缺失或无效"))
    };
    let contract_version = raw
        .get("frontendContractVersion")
        .and_then(Value::as_u64)
        .filter(|value| *value <= u32::MAX.into())
        .ok_or_else(|| "构建身份字段 frontendContractVersion 缺失或无效".to_string())?;
    Ok(json!({
        "productId": required_string("productId")?,
        "productVersion": required_string("productVersion")?,
        "frontendContractVersion": contract_version,
        "frontendSourceHash": required_string("sourceHash")?,
    }))
}

#[derive(Debug)]
struct ApiProblem {
    status: StatusCode,
    code: &'static str,
    message: String,
    retry_after: bool,
    authenticate: bool,
}

impl ApiProblem {
    fn new(status: StatusCode, code: &'static str, message: &str) -> Self {
        Self {
            status,
            code,
            message: message.chars().take(MAX_ERROR_LENGTH).collect(),
            retry_after: false,
            authenticate: false,
        }
    }

    fn bad_request(code: &'static str, message: &str) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    fn not_found(code: &'static str, message: &str) -> Self {
        Self::new(StatusCode::NOT_FOUND, code, message)
    }

    fn unauthorized() -> Self {
        let mut problem = Self::new(
            StatusCode::UNAUTHORIZED,
            "invalid_token",
            "详细查询需要有效的 Authorization: Bearer Token",
        );
        problem.authenticate = true;
        problem
    }

    fn busy() -> Self {
        let mut problem = Self::new(StatusCode::CONFLICT, "scan_busy", "已有扫描正在进行");
        problem.retry_after = true;
        problem
    }
}

impl IntoResponse for ApiProblem {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            Json(json!({ "code": self.code, "error": self.message })),
        )
            .into_response();
        if self.retry_after {
            response
                .headers_mut()
                .insert(header::RETRY_AFTER, HeaderValue::from_static("1"));
        }
        if self.authenticate {
            response.headers_mut().insert(
                header::WWW_AUTHENTICATE,
                HeaderValue::from_static("Bearer realm=\"portviewer\", charset=\"UTF-8\""),
            );
        }
        response
    }
}

pub(crate) fn is_lan_bind_ip(ip: IpAddr) -> bool {
    ip.is_unspecified() || is_lan_peer_ip(ip)
}

pub(crate) fn is_lan_peer_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(address) => ipv4_is_lan(address),
        IpAddr::V6(address) => address
            .to_ipv4_mapped()
            .map(ipv4_is_lan)
            .unwrap_or_else(|| {
                address.is_loopback()
                    || address.is_unique_local()
                    || address.is_unicast_link_local()
            }),
    }
}

fn ipv4_is_lan(address: Ipv4Addr) -> bool {
    address.is_loopback() || address.is_private() || address.is_link_local()
}

async fn shutdown_signal() {
    let ctrl_c = async {
        let _ = tokio::signal::ctrl_c().await;
    };
    #[cfg(unix)]
    let terminate = async {
        if let Ok(mut signal) =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
        {
            signal.recv().await;
        }
    };
    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();
    tokio::select! {
        _ = ctrl_c => {}
        _ = terminate => {}
    }
}

fn default_protocol_query() -> String {
    "tcp".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lan_classification_rejects_public_and_unspecified_peers() {
        assert!(is_lan_peer_ip(IpAddr::V4(Ipv4Addr::new(192, 168, 1, 2))));
        assert!(is_lan_peer_ip(IpAddr::V4(Ipv4Addr::LOCALHOST)));
        assert!(!is_lan_peer_ip(IpAddr::V4(Ipv4Addr::new(8, 8, 8, 8))));
        assert!(!is_lan_peer_ip(IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
        assert!(is_lan_bind_ip(IpAddr::V4(Ipv4Addr::UNSPECIFIED)));
        assert!(is_lan_peer_ip(IpAddr::V6(std::net::Ipv6Addr::LOCALHOST)));
        assert!(is_lan_peer_ip("fd00::1".parse().unwrap()));
        assert!(!is_lan_peer_ip("2001:4860:4860::8888".parse().unwrap()));
    }

    #[test]
    fn host_validation_accepts_private_ips_and_explicit_names() {
        let mut headers = axum::http::HeaderMap::new();
        headers.insert(header::HOST, "192.168.1.5:17890".parse().unwrap());
        assert!(valid_host(&headers, &[]));

        headers.insert(header::HOST, "ports.internal:17890".parse().unwrap());
        assert!(!valid_host(&headers, &[]));
        assert!(valid_host(&headers, &["ports.internal".to_string()]));
    }

    #[test]
    fn normalizes_generated_identity_for_frontend_contract() {
        let normalized = normalize_build_identity(json!({
            "productId": "com.portviewer.desktop",
            "productVersion": "1.0.0",
            "frontendContractVersion": 1,
            "sourceHash": "abc",
            "distHash": "def"
        }))
        .unwrap();
        assert_eq!(normalized["frontendSourceHash"], "abc");
        assert!(normalized.get("sourceHash").is_none());
    }
}
