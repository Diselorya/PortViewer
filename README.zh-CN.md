[English](README.md) | **简体中文**

# PortViewer

服务器上的服务越堆越多：数据库、管理面板、反向代理、自动化脚本……时间一长，谁也记不清 8080 到底分给了谁，新服务上线前也不知道哪个端口还空着。PortViewer 就是为这一刻准备的。

PortViewer 直接读取 Windows/Linux 网络端点，把 IPv4/IPv6 的 TCP、UDP 条目与进程身份、容器、站点、Windows 服务和脚本入口关联，搜索、筛选、导出一步到位——不爱命令行的用户点开界面就能看懂；开发、运维和技术支持也能快速定位端口占用、确认监听范围、复制排障证据，并在 Windows 桌面版中经过身份复核后终止错误进程。

桌面版无账号、无后台服务，默认不联网；另提供默认只监听 loopback 的只读 WebGUI，以及显式启用、LAN-only、Token 分级授权的端口查询 API——问一句"这个端口被占了吗"，匿名只返回占用结论，Bearer Token 返回完整监听与归属，Agent 还能直接要一个当前可绑定的空闲端口。扫描结果只保存在当前进程内存中。

## v1 能做什么

- 扫描 IPv4/IPv6 TCP 连接、TCP 监听与 UDP 端点；
- 显示协议、IP 版本、本地/远程端点、TCP 状态、服务归属、PID、进程名、路径和创建时间；
- 将 Docker published port 精确到容器名、镜像及 Compose project/service；
- 将 Nginx 监听映射到 `server_name` 与配置来源，将 IIS HTTP.sys/worker process 映射到站点和应用池；
- 通过原生 Windows 进程父链和 Service Control Manager 识别 Windows Service、NSSM、npm/Node.js 入口与 Python 脚本/模块；
- 搜索端口、PID、进程、工作负载、路径和 IP，并支持 `port:`、`pid:`、`process:`、`service:`、`owner:`、`workload:`、`ip:`、`state:`、`protocol:` 字段语法；
- 按协议和 TCP 状态过滤、多列排序、选择可见列；
- 单次和自动刷新，窗口隐藏时暂停，扫描失败时保留上一份成功数据；
- 查看进程详情与全部关联端点，复制字段或完整诊断信息；
- 通过 Windows 原生保存对话框导出当前过滤、排序后的视图为 CSV 或 JSON，并明确处理取消与写入失败；
- 在后端重新校验 PID 与进程创建时间后终止普通进程；
- 支持浅色、深色、跟随系统主题及三档表格密度。
- 通过局域网 API、CLI 和 MCP 查询指定单端口、端口列表或区间；匿名只返回占用结论，Bearer Token 可返回详细监听与归属；Agent 可请求 `30001` 之后随机、当前可绑定的服务端口。

## 非目标

v1 不做抓包、协议解析、流量统计、防火墙管理、恶意进程判断、任意公网主机扫描、长期历史、告警、托盘常驻、开机自启、账号、云同步或团队协作。局域网能力只查询已部署 PortViewer 服务的主机，不做网段发现或主动扫描其他主机。PortViewer 提供系统事实，不替代 TCPView、Wireshark、EDR 或任务管理器。

## 运行要求

使用已打包版本需要：

- Windows 10/11 x64；
- Microsoft Edge WebView2 Runtime。受支持的 Windows 通常已预装，缺失时需从 Microsoft 安装。

从源码开发还需要：

- Node.js 22 与 npm；
- Rust stable，目标工具链为 `x86_64-pc-windows-msvc`；
- Visual Studio 2022 Build Tools，并安装“使用 C++ 的桌面开发”和 Windows SDK；
- WebView2 开发环境。

### 启动 WebGUI

Windows PowerShell：

```powershell
npm ci
npm run build
cargo run --release --manifest-path web-service/Cargo.toml -- --assets dist
Start-Process http://127.0.0.1:17890
```

Linux：

```bash
npm ci
npm run build
cargo run --release --manifest-path web-service/Cargo.toml -- --assets dist
xdg-open http://127.0.0.1:17890
```

WebGUI 可以扫描、筛选、查看详情和导出，不提供终止进程或远程提权。默认只监听 loopback；远程 WebGUI 使用 SSH 隧道。配置强 Token 后可以显式监听局域网地址，但非 loopback 只开放 health 与端口 API。完整的 systemd、NSSM、Nginx 和 IIS 配置见 [WebGUI 部署指南](docs/webgui-deployment.md)。

局域网端口 API（API-only 示例）：

```powershell
$env:PORTVIEWER_API_TOKEN = '<至少 32 字节的随机 Token>'
cargo run --release --manifest-path web-service/Cargo.toml -- serve --api-only --listen 0.0.0.0:17890
```

接口、CLI、MCP、安全边界和 Agent 配置见 [局域网端口接口指南](docs/lan-port-api.md)。

```powershell
npm ci
npm run tauri dev
```

前端质量门禁：

```powershell
npm test
npm run typecheck
npm run build
```

Rust 质量门禁：

```powershell
cd src-tauri
cargo fmt --all -- --check
cargo test
cargo clippy --all-targets --all-features -- -D warnings
```

创建便携 release exe（输出到 `src-tauri/target/release/portviewer-app.exe`）：

```powershell
npm run build:desktop
```

创建默认的在线 Windows 安装包（缺少 WebView2 时使用随包携带的 Microsoft Bootstrapper）：

```powershell
npm run build:installer
```

创建完全离线的 MSI（内置完整 WebView2 Runtime，体积更大）：

```powershell
npm run build:installer:offline
```

安装器依赖策略、Microsoft 官方下载地址与故障排除见 [Windows 安装与依赖](docs/installation.md)。

CI 在 `windows-latest` 上执行同一组前端与 Rust 检查。

不要使用裸 `cargo build --release` 生成发布程序。生产构建必须启用 Tauri
`custom-protocol`，否则应用会连接开发地址。构建脚本会拒绝这种危险产物。

### 前后端构建绑定

生产构建使用四层校验保证 Rust 后端只加载本仓库的 PortViewer 前端：

1. `custom-protocol` 将 `dist` 嵌入 exe，不访问 Vite 的 5173 开发端口；
2. Tauri 主配置、平台配置和 `TAURI_CONFIG` 不得改写产品身份、前端目录或把窗口指向外部/开发 URL；
3. 构建清单记录产品 ID、版本、接口契约、全部前端输入的源码 SHA-256 和最终 `dist` 内容 SHA-256；Rust `build.rs` 独立复算并校验，错误、陈旧或被修改的 `dist` 会令构建失败；
4. 启动时前端通过 `get_build_identity` 与后端握手，任一标识不一致时阻断主界面并显示诊断信息。

## 安全终止进程

“终止进程”是不可逆操作。前端只有在取得非空进程创建时间后才开放入口，确认框会显示进程名、PID、路径、创建时间和受影响端点数量。执行时 Rust 后端会重新读取进程身份，并拒绝以下情况：

- PID 已被复用或创建时间发生变化；
- PID 0、PID 4、PortViewer 自身或 Windows 关键进程；
- 进程已退出、身份不可确认或当前权限不足。

部分进程需要管理员权限，受保护进程即使以管理员身份运行也可能无法读取或终止。PortViewer 不绕过 Windows 权限模型。

## 导出安全

CSV 使用 UTF-8 BOM 和 RFC 4180 转义，并对以 `=`, `+`, `-`, `@` 等字符开头的字段进行公式注入防护。JSON 包含版本、导出时间、扫描时间、活动过滤条件、条目数和截断状态。导出范围始终是当前过滤与排序后的完整视图，而非仅屏幕上已渲染的行。

## 项目结构

```text
PortViewer/
├─ src/                         Vue 3 单窗口界面、Pinia 状态与前端测试
│  ├─ components/              表格、详情检查器、设置与确认对话框
│  ├─ domain/                  查询、排序和导出纯逻辑
│  ├─ stores/                  统一应用状态、IPC 与刷新调度
│  └─ types/                   与 Rust IPC 对齐的数据类型
├─ src-tauri/                  Tauri 2 / Rust 后端
│  └─ src/                     Windows 扫描、服务归属解析、进程解析与安全终止
├─ web-service/                Windows/Linux 本机只读 WebGUI 服务
│  └─ src/                     局域网端口 API、CLI、MCP 与统一查询核心
└─ .github/workflows/ci.yml    Windows 持续集成
```

## 已知限制

- Windows 桌面版支持 Windows 10/11 x64；只读 WebGUI 支持 Windows 与 Linux；
- Linux WebGUI 当前提供端口与进程归属，Docker/systemd/Nginx 的高级归属仍低于 Windows 桌面/WebGUI；
- 进程名称、路径和创建时间受 Windows 权限及进程生命周期影响；不可读取时界面会明确标注；
- 服务归属是带来源和置信度的增强证据，不替代 OS 端口/PID 事实；同端口的 Nginx/IIS 虚拟主机会保留为多个候选；
- Docker 只解析当前本机 Engine 的 published port，主动跳过远端 context；容器内部未发布端口不属于 Windows 本机端口范围；
- Docker CLI/daemon、Nginx 配置或 IIS 配置不可用时只降低对应解析器状态，不会令基础端口扫描失败；
- 某个协议/IP 扫描范围失败时会保留其余结果并显示部分扫描警告，不能据此断言缺失范围的端口空闲；
- 自动刷新展示实时快照，不保存历史或变化趋势；
- 局域网“空闲端口”是检查时的 bind 建议，不是租约；Agent 必须立即绑定，竞争失败时重新请求；
- Token 通过直连 HTTP 发送时不具备传输机密性；敏感环境必须使用隔离管理网或 HTTPS 反向代理；
- 数据量达到设置上限时会截断显示并在状态栏及导出元数据中标记；
- 生产发布仍需在 Windows 10/11、普通用户/管理员权限以及 WebView2 缺失场景完成实机验收。

## 延伸阅读

- [WebGUI 部署指南](docs/webgui-deployment.md)
- [局域网端口 API、CLI 与 MCP](docs/lan-port-api.md)
- [安全策略](SECURITY.md)
- [参与贡献](CONTRIBUTING.md)
