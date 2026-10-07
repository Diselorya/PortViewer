# PortViewer 局域网端口 API、CLI 与 MCP

## 能力与边界

`portviewer-web` 可以作为局域网主机上的轻量端口探针。三个入口复用同一 HTTP API 契约：

- API：供脚本、CI 和其他服务调用；
- CLI：从当前终端查询指定的局域网 PortViewer 服务；
- MCP stdio：供 Codex、Claude Code、Kimi Code 等 Agent 客户端调用。

匿名调用只返回指定 TCP/UDP 端口的 `occupied`、`available` 或 `indeterminate`。只有有效 Bearer Token 才能请求端点、监听状态、PID、进程路径和 Docker/Nginx/IIS/NSSM/Node/Python 等归属详情。完整 WebGUI 和旧 `/api/v1/scan` 始终只允许 loopback 请求。

服务端与客户端都会拒绝公网地址。允许的来源/目标是 loopback、IPv4 RFC1918、IPv4/IPv6 链路本地地址和 IPv6 ULA。该限制不是防火墙替代品；仍应在操作系统防火墙中只允许受信网段。

## 启动局域网 API

先生成至少 32 字节的随机 Token。不要把 Token 写入仓库、命令参数或日志。

Windows PowerShell：

```powershell
$bytes = [byte[]]::new(32)
[Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
$env:PORTVIEWER_API_TOKEN = [Convert]::ToHexString($bytes).ToLowerInvariant()
.\web-service\target\release\portviewer-web.exe serve --api-only --listen 0.0.0.0:17890
```

Linux：

```bash
export PORTVIEWER_API_TOKEN="$(openssl rand -hex 32)"
./web-service/target/release/portviewer-web serve --api-only --listen 0.0.0.0:17890
```

不带 `--api-only` 时同时加载本机 WebGUI；局域网客户端仍只能访问 health 与端口 API。通过主机名而不是私有 IP 访问时，服务端还需配置：

```text
PORTVIEWER_ALLOWED_HOSTS=ports.internal,devbox.lan
```

直连 HTTP 无法防止同一网段内的被动窃听。详细查询应部署在隔离管理网，或由 Nginx/IIS/Caddy 提供 HTTPS 后再转发到 loopback。PortViewer 不信任 `X-Forwarded-For`，反向代理必须自行完成来源限制。经反向代理提供局域网 API 时必须使用 `--api-only`；该模式会直接移除 WebGUI、构建身份和完整扫描路由。若确有其他本机用途而不能使用 API-only，代理必须只放行 `/api/health`、`/api/v1/ports/check` 与 `/api/v1/ports/free`。

## HTTP API

### 健康检查

```http
GET /api/health
```

返回 API 版本、平台、运行模式以及服务端是否配置了详细查询 Token，不返回 Token 本身。

### 查询单端口、列表或区间

```http
GET /api/v1/ports/check?ports=80,443,3000-3010&protocol=tcp&details=false
```

约束：

- `ports` 支持单端口、逗号列表和闭区间，去重后最多 1024 个；
- 端口必须在 `1..65535`；
- `protocol` 为 `tcp`、`udp` 或 `both`，默认 `tcp`；
- `details=true` 必须发送 `Authorization: Bearer <token>`；
- 错误 Token 不会静默降级成匿名响应。

匿名结果不会出现 `endpoints`、`endpointCount`、PID、地址或进程信息。若某个协议/IP 扫描范围失败且没有观察到目标端口，结果为：

```json
{
  "status": "indeterminate",
  "occupied": null
}
```

调用方不得把 `indeterminate` 当作空闲。

详细查询示例：

```powershell
$headers = @{ Authorization = "Bearer $env:PORTVIEWER_API_TOKEN" }
Invoke-RestMethod -Headers $headers `
  "http://192.168.1.20:17890/api/v1/ports/check?ports=3000&protocol=tcp&details=true"
```

### 请求当前空闲端口

```http
POST /api/v1/ports/free
Content-Type: application/json

{
  "protocol": "tcp",
  "minPort": 30001,
  "maxPort": 49151
}
```

服务会随机排列候选端口，先检查系统端点快照，再对 IPv4/IPv6 通配地址执行真实 bind 探测。若扫描范围不完整，服务拒绝返回“空闲”结论。

返回的端口是即时建议，不是租约或预留；其他进程仍可能在 Agent 启动服务前抢占。正确工作流是“请求 → 立即 bind → bind 失败则重新请求”。

错误响应统一包含稳定 `code` 与最长 500 字符的安全消息：

```json
{
  "code": "invalid_token",
  "error": "详细查询需要有效的 Authorization: Bearer Token"
}
```

完整机器契约见 [OpenAPI 3.1 文件](api/portviewer-lan.openapi.yaml)。

## CLI

默认连接 `http://127.0.0.1:17890`，可通过 `--server` 或 `PORTVIEWER_SERVER` 指定局域网服务。客户端禁用系统代理和 HTTP 重定向，并在连接前解析、校验及固定私网地址，防止 Token 被代理或 DNS 重绑定转发到公网。

```powershell
portviewer-web.exe check --server http://192.168.1.20:17890 `
  --ports 80,443,3000-3010 --protocol both --output markdown

$env:PORTVIEWER_API_TOKEN = '<从安全存储注入>'
portviewer-web.exe check --server http://192.168.1.20:17890 `
  --ports 3000 --protocol tcp --details --output json

portviewer-web.exe free --server http://192.168.1.20:17890 `
  --protocol tcp --min 30001 --max 49151 --output json
```

## MCP

MCP 使用当前规范的 stdio transport。Agent 机器启动本地 MCP 子进程，子进程再连接指定的局域网 API，因此不需要把 MCP 协议端口暴露到网络。

```json
{
  "mcpServers": {
    "portviewer": {
      "command": "C:/Program Files/PortViewer Web/portviewer-web.exe",
      "args": ["mcp", "--server", "http://192.168.1.20:17890"],
      "env": {
        "PORTVIEWER_API_TOKEN": "<由客户端密钥存储或环境变量注入>"
      }
    }
  }
}
```

可用工具：

- `portviewer_check_ports`：查询单端口、列表或区间；默认 Markdown，可选 JSON；`details=true` 使用 Token；
- `portviewer_find_free_port`：随机返回当前可绑定端口；结果明确标记为 advisory。

MCP 进程只向 stdout 写协议消息，诊断日志写 stderr。两项工具都标记为 read-only、non-destructive；空闲端口工具因随机选择而不标记为 idempotent。

## 自动化验收

```powershell
cargo build --manifest-path web-service/Cargo.toml
npm run test:lan-interfaces
```

该 E2E 会启动真实 API 和 TCP listener，验证匿名数据最小化、Token 详情、错误 Token、Host 防护、空闲端口 bind、CLI 输出，以及 MCP initialize/tools/list/tools/call 全链路。
