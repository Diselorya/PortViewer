# PortViewer WebGUI 部署指南

## 运行模型

WebGUI 由一个本机 Rust 服务同时提供静态页面和只读 API：

```text
浏览器 http://127.0.0.1:17890
        │ 同源 GET
        ▼
portviewer-web ──读取──> 系统端口与进程信息
```

默认服务只监听 loopback。WebGUI 支持扫描、筛选、详情和浏览器下载导出；终止进程、提权和其他写操作只属于 Windows 桌面版。

显式配置强 Token 后，服务可监听私有/未指定地址，但局域网只开放 health 与最小化端口 API；WebGUI、构建身份和完整扫描仍限制为 loopback。CLI/API/MCP 的完整配置见 [局域网端口接口指南](lan-port-api.md)。

## Windows 前台启动

安装 Node.js 22、Rust stable 和 Visual Studio C++ Build Tools 后，在仓库根目录执行：

```powershell
npm ci
npm run build
cargo build --release --manifest-path web-service/Cargo.toml
& .\web-service\target\release\portviewer-web.exe --assets .\dist
```

另开一个 PowerShell：

```powershell
Start-Process http://127.0.0.1:17890
```

也可直接执行 `npm run dev:web`。这会先生成生产前端，再启动服务；它不是 Vite 开发服务器。

## Windows 注册为 NSSM 服务

发布目录建议如下：

```text
C:\Program Files\PortViewer Web\
├─ portviewer-web.exe
└─ web-assets\
   ├─ index.html
   ├─ assets\...
   └─ portviewer-build-identity.json
```

以管理员 PowerShell 执行，并将 NSSM 路径替换为实际位置：

```powershell
$nssm = "C:\Tools\nssm\win64\nssm.exe"
$app = "C:\Program Files\PortViewer Web\portviewer-web.exe"
$assets = "C:\Program Files\PortViewer Web\web-assets"
& $nssm install PortViewerWeb $app
& $nssm set PortViewerWeb AppParameters "--listen 127.0.0.1:17890 --assets `"$assets`""
& $nssm set PortViewerWeb AppDirectory "C:\Program Files\PortViewer Web"
& $nssm set PortViewerWeb Start SERVICE_AUTO_START
& $nssm set PortViewerWeb ObjectName "NT AUTHORITY\LocalService"
& $nssm start PortViewerWeb
```

`LocalService` 是默认推荐的最小权限账号；某些系统进程会显示访问受限。若业务确实要求完整可见性，应为专用服务账号授予最少的额外权限，而不是让浏览器或整个 Web 服务默认以管理员运行。

查看状态和日志：

```powershell
Get-Service PortViewerWeb
Invoke-RestMethod http://127.0.0.1:17890/api/health
```

## Linux 前台启动

需要 Node.js 22、Rust stable，以及发行版的 C/C++ 基础构建工具。

Debian/Ubuntu 示例：

```bash
sudo apt-get update
sudo apt-get install -y build-essential curl
npm ci
npm run build
cargo build --release --manifest-path web-service/Cargo.toml
./web-service/target/release/portviewer-web --assets ./dist
```

有桌面环境时：

```bash
xdg-open http://127.0.0.1:17890
```

无桌面的远程 Linux 主机使用 SSH 隧道，在你的电脑执行：

```bash
ssh -L 17890:127.0.0.1:17890 user@server
```

然后在本机浏览器打开 `http://127.0.0.1:17890`。

## Linux systemd 服务

构建后将二进制复制到 `/opt/portviewer/portviewer-web`，将 `dist` 的内容复制到 `/opt/portviewer/web-assets/`，创建不可登录的 `portviewer` 用户，再安装仓库中的 `deploy/linux/portviewer-web.service`：

```bash
sudo useradd --system --home /opt/portviewer --shell /usr/sbin/nologin portviewer
sudo chown -R root:root /opt/portviewer
sudo chmod -R a=rX /opt/portviewer
sudo cp deploy/linux/portviewer-web.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now portviewer-web
systemctl status portviewer-web
curl http://127.0.0.1:17890/api/health
```

普通服务账号可能无法读取其他用户的完整 `/proc/<pid>` 信息；基础端口仍会显示，进程归属会按实际权限降级。不要仅为消除“访问受限”就默认改成 root。

## 端口与环境变量

```text
--listen 127.0.0.1:17890       监听地址；非 loopback 时必须配置强 Token
--assets /path/to/web-assets   生产前端目录
--api-only                     不加载 WebGUI 静态文件，只运行端口 API
PORTVIEWER_LISTEN              对应 --listen
PORTVIEWER_ASSETS              对应 --assets
PORTVIEWER_API_ONLY            true/1 时等价于 --api-only
PORTVIEWER_API_TOKEN           32..256 字节的可打印随机 Bearer Token
PORTVIEWER_ALLOWED_HOSTS       额外允许的局域网 Host，逗号分隔
PORTVIEWER_SERVER              CLI/MCP 默认连接的 API 根地址
RUST_LOG                       日志级别，例如 info 或 warn
```

命令行参数优先于环境变量。服务启动时会校验静态目录及构建身份文件，前后端身份不一致时页面会拒绝进入主界面。

## Nginx / IIS

WebGUI 跨机器访问仍优先使用 SSH 隧道。如果启用局域网端口 API，可把服务绑定到私有地址或 `0.0.0.0`，但必须同时配置强 Token、操作系统防火墙和受信网段。详细查询经 Nginx/IIS 暴露时，后端必须使用 `--api-only`，代理必须提供 TLS、来源限制，并把上游 `Host` 设置为 `127.0.0.1:17890`；若转发了 `Origin`，也必须归一化。API-only 会物理移除 WebGUI、构建身份和完整扫描路由；不能启用时，代理必须只允许三个局域网 API 路径。不得向公网发布该服务。

## 常见故障

- `静态目录不完整`：先运行 `npm run build`，或确认发布目录包含完整 `web-assets`。
- `构建身份字段缺失`：前端与服务不是同一发布包，重新构建并整体替换。
- `监听局域网地址前必须配置 Token`：设置至少 32 字节的随机 `PORTVIEWER_API_TOKEN`，并检查防火墙规则。
- `已有扫描正在进行`：等待当前扫描完成，不要并发刷新。
- Linux 进程名/路径缺失：以运行服务的账号检查 `/proc` 权限；优先接受显式降级而非永久 root。
