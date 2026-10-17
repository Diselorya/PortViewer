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

不带 `--api-only` 时同时加载本机 WebGUI；局域网客户端仍只能访问 health、端口 API，以及经过 Bearer Token 鉴权的服务资料 API。通过主机名而不是私有 IP 访问时，服务端还需配置：

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

详细端点的 `service_manager` 将上级管理层与具体工作负载拆开，取值为 `Docker`、`Systemd`、`WindowsService`、`Nssm`、`Iis`、`Nginx` 或 `Unknown`。具体容器、服务和项目的名称、用途及路径仍位于 `attributions`；`Unknown` 表示没有足够证据，不能解释为进程没有受管理。基础扫描在未运行归属解析时也返回 `Unknown`。JSON API、CLI 和 MCP 使用相同字段，Markdown 输出单独显示“上级服务”。

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

## 服务资料与主机详情（1.3）

高级端口结果中的可选 `service_profile_ids` 可查询服务中文名、真实本机简介、软件说明、来源、候选和缓存状态。所有知识接口在局域网都要求已配置且有效的 Bearer Token；本机 WebGUI 仍要求安全 Host / 同源 Origin。知识接口不接受客户端路径、命令行或任意 URL。

- `POST /api/v1/knowledge/profiles`：JSON `{"profile_ids":["catalog:nginx"],"refresh":false}`。也可显式提供结构化公开 `public_ids`（github/npm/pypi）；这些结果不会自动绑定某个 PID。
- `GET /api/v1/knowledge/host?address=127.0.0.1`：数字 IP 的主机上下文；省略 address 返回扫描服务端本机。对端只做有界反向 DNS，名称不是验证过的机器身份。
- `GET /api/v1/knowledge/settings`：返回开关、AI 是否已配置和 `can_configure`，不返回端点或密钥。
- `PUT /api/v1/knowledge/settings`：仅本机同源界面，JSON `{"online_enabled":true,"ai_enabled":false,"reverse_dns_enabled":true}`；局域网即使 Token 有效也不能更改。

本机地址来自最近一次完整成功扫描的当前 socket 地址集合；部分失败保留上一份有效快照，地址集合变化会使相关主机缓存失效。它不是完整网卡清单，通配监听地址不能当作某台机器的实际地址。

资料与 DNS 均异步补充；请求立即返回缓存或 queued，不阻塞端口扫描。每批最多 128 个资料 ID。默认自动查询已确认的公开软件坐标，未知私有项目保持本机资料。联网来源只说明软件用途，不能提高 PID 归属可信度。`summary` 是本机项目用途，`software_summary` 是软件说明。详细设置与环境变量见 [服务知识补充](service-knowledge.md)。
