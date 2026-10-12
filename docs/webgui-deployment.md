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
curl http://127.0.0.1:17890/api/v1/scan
```

服务单元必须保留 `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`；Linux 网络枚举需要 `AF_NETLINK`。只有 health 正常不能说明扫描正常，部署后必须检查 `/api/v1/scan`。

普通账号模式是默认配置：端口占用仍可查询，但其他账号的 `/proc/<pid>/fd`、命令行、工作目录以及 Docker socket 常不可读。在 Ubuntu 反馈环境中，监听端口的进程归因率不足 1%。界面会显示归因受限和未知归属，不把无法取得 PID 的端点当成系统进程。端口扫描完整与服务归因完整分别报告。

需要完整归因时，安装随仓库提供的显式 root drop-in：

```bash
sudo mkdir -p /etc/systemd/system/portviewer-web.service.d
sudo cp deploy/linux/portviewer-web-full-attribution.conf \
  /etc/systemd/system/portviewer-web.service.d/20-full-attribution.conf
sudo systemctl daemon-reload
sudo systemctl restart portviewer-web
curl http://127.0.0.1:17890/api/v1/scan
```

此配置只修改运行账号，保留基础单元的只读文件系统、`NoNewPrivileges`、地址族限制等加固。WebGUI 继续只监听 loopback。root 通常能补全本机进程归因，但 `/proc` 挂载策略、LSM 和容器命名空间仍可能限制可见性；不能承诺仅授予 `CAP_SYS_PTRACE` 就等价于 root。容器识别还需要本机 Docker CLI、可用的本地 Engine 和 socket 访问权限。Docker socket 本身具有管理宿主机的能力，PortViewer 只调用只读查询。

## Linux 归属信息

列表显示业务名称、用途/简介和运行模式或路径；详情、搜索、复制及 CSV/JSON 导出保留关联证据：

| 对象 | 识别依据与可显示信息 |
|---|---|
| Docker / docker-proxy | 本机 published port、协议与绑定地址；容器名、镜像、Compose project/service、描述标签、Compose 目录/文件、容器工作目录及宿主挂载路径 |
| systemd 服务 | 进程 cgroup 对应的 unit；真实服务名、Description、unit 配置路径与工作目录；PID 1 的 socket activation 需匹配实际监听端点，不能把所有端口泛指为 systemd |
| Node.js 项目 | 当前进程入口和工作目录、`package.json` 的名称/简介；npm script、Vite/Next.js 等可辨认运行方式和项目路径 |
| Python 项目 | 脚本或 `-m` 模块入口、工作目录、`pyproject.toml` 等项目元数据；Uvicorn/Gunicorn/Django 等可辨认运行方式与项目路径 |
| 系统程序 | 可执行路径、已知程序的用途说明及可关联的 systemd 服务；未知程序明确显示用途未确认 |

用途优先取自本机元数据。程序类型提示带来源与置信度，不代表某个自定义项目的实际业务简介；缺少描述标签或项目简介时显示未提供。扫描不会执行项目脚本，也不把环境变量或完整命令行作为归属事实输出。

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

### 子路径挂载

前端资源和 WebGUI API 都相对页面入口解析，同一发布包可部署在 `/` 或 `/portviewer/`。由代理剥离前缀；入口必须以 `/` 结尾。以下示例供本机或经 SSH 隧道访问的 Nginx 使用，继续遵守已有的管理网访问限制：

```nginx
location = /portviewer {
    return 308 /portviewer/;
}
location /portviewer/ {
    # 末尾的 / 让 Nginx 剥离 /portviewer/ 前缀。
    proxy_pass http://127.0.0.1:17890/;
    proxy_set_header Host 127.0.0.1:17890;
    proxy_set_header Origin "";
}
```

不需要响应体字符串改写或重新构建前端。后端不信任 `X-Forwarded-For`；loopback-only 检查保持不变。`--api-only` 没有 WebGUI 页面，不能用于此页面挂载。

## 常见故障

- `静态目录不完整`：先运行 `npm run build`，或确认发布目录包含完整 `web-assets`。
- `构建身份字段缺失`：前端与服务不是同一发布包，重新构建并整体替换。
- `监听局域网地址前必须配置 Token`：设置至少 32 字节的随机 `PORTVIEWER_API_TOKEN`，并检查防火墙规则。
- `已有扫描正在进行`：等待当前扫描完成，不要并发刷新。
- `Linux 端口扫描失败` / `Failed to call ffi`：检查 systemd 地址族白名单是否包含 `AF_NETLINK`，再检查网络命名空间和系统权限。
- Linux 进程名/路径缺失或归因率很低：检查运行账号的 `/proc` 可读范围，按需要选择上面的完整归因 drop-in；归因报告会区分权限、退出和解析器不可用。
- 子路径白屏或 API 404：使用本次构建的完整前端、入口补末尾 `/`、代理剥离前缀，检查资源和 API 都请求 `/portviewer/` 下的路径。

权限机制参考 [Linux ptrace 手册](https://www.man7.org/linux/man-pages/man2/ptrace.2.html)；容器元数据参考 [Docker inspect](https://docs.docker.com/reference/cli/docker/inspect/) 与 [Docker labels](https://docs.docker.com/engine/manage-resources/labels/)。
