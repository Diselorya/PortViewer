# PortViewer 上游缺陷报告（待提交 GitHub Issue）

- 报告日期：2026-10-12
- 被测版本：PortViewer v1.0.0，官方预编译包（`productId=com.portviewer.desktop`、`productVersion=1.0.0`、`frontendContractVersion=1`、`sourceHash=a942025e5333fe64a523a66f14b8c4d3a796ca71566f91b2cca751fc0d8439da`）
- 对应提交：`2ac64a57052ee54665a56e9fc3874d2bce08a487`（2026-10-07）
- 验收环境：Ubuntu 24.04 / Linux 7.0.0-31-generic / x86_64，RTX 5090 主机
- 上游仓库：https://github.com/Diselorya/PortViewer
- 结论：**Windows 版验收通过；Linux 版发现 3 个问题**，其中 #1 为功能性缺陷（开箱即不可用），#2 为部署形态限制，#3 为文档/体验断崖。

> 提交说明：本机未安装 `gh` CLI，无法自动提交，故整理成可直接粘贴的 Issue 正文，由 lichao 转交作者。
> 三个问题彼此独立，建议**分 3 个 Issue 提交**。

---

## Issue 1（功能性缺陷，建议优先修）：官方 Linux systemd 单元缺少 `AF_NETLINK`，端口扫描必定失败

### 摘要

按仓库自带 `deploy/linux/portviewer-web.service` 部署后，`GET /api/v1/scan` **必定返回 HTTP 500**，Web GUI 与 CLI 都拿不到任何数据。二进制本身没有错，是**单元文件的沙箱把扫描所需的 socket 家族挡掉了**。

### 环境

- PortViewer v1.0.0（官方预编译包 `portviewer-web`，13.7 MB ELF）
- Ubuntu 24.04，x86_64
- 使用仓库 `deploy/linux/portviewer-web.service` 原样部署

### 复现步骤

1. 按 README 解包到某目录，按 `deploy/linux/portviewer-web.service` 装为 systemd 服务（保持该文件原样，仅改路径）。
2. `sudo systemctl start portviewer-web`
3. `curl http://127.0.0.1:17890/api/v1/scan`

### 实际结果

```
HTTP/1.1 500 Internal Server Error
{"code":"scan_failed","error":"Linux 端口扫描失败：Failed to call ffi"}
```

`/api/health` 正常 200，`/` 与静态资源也正常 200 —— **只有扫描这一条路断掉**，所以表现为「界面能打开、表格永远空/报错」。

### 对照实验（定位到单元文件，而非二进制）

| 运行方式 | `/api/v1/scan` |
|---|---|
| 直接跑二进制（无 systemd 沙箱） | **200**，约 82–102 KB 数据 |
| 按官方 `deploy/linux/portviewer-web.service` 跑 | **500** `Failed to call ffi` |
| 官方单元 + 下面的 drop-in 补一行 | **200**，恢复正常 |

### 根因

`deploy/linux/portviewer-web.service` 第 23 行：

```ini
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
```

Linux 侧端口枚举经 `netstat2` → `getifaddrs()` 读取网卡列表，而 **`getifaddrs()` 在 Linux 上要开一个 `AF_NETLINK` socket** 向内核查询。该 socket 家族不在白名单里 → 系统调用被拒绝 → FFI 调用失败 → 上层归一成 `Failed to call ffi`。所以报错文案看着像 FFI 绑定问题，实际是沙箱策略问题，排查方向容易被带偏。

### 建议修法

在 `deploy/linux/portviewer-web.service` 的 `RestrictAddressFamilies` 里补上 `AF_NETLINK`：

```ini
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
```

（我们是用 drop-in 绕过的，未改动上游文件：）

```ini
# /etc/systemd/system/portviewer-web.service.d/10-netlink.conf
[Service]
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK
```

### 顺带建议

- 报错文案可以把根因带出来（例如区分 `EPERM/EAFNOSUPPORT` 并提示「可能是 RestrictAddressFamilies 未含 AF_NETLINK」），否则使用者会去查 FFI 绑定，方向完全错。
- 若只想保守加固，`AF_NETLINK` 是只读查询用途（`RTM_GETADDR`/`RTM_GETLINK`），放行不显著扩大攻击面。

---

## Issue 2（部署形态限制）：前端资源与 API 全用绝对路径，无法挂在子路径下

### 摘要

Web GUI 的资源引用与 API 调用**全部使用以 `/` 开头的绝对路径**，且没有 `<base>` 标签。这导致应用**无法挂载在反向代理的子路径下**（如 `https://host/portviewer/`），只能占用独立端口或域名根。

### 具体清单（v1.0.0 官方包）

`web-assets/index.html` —— 10 处绝对路径，无一相对：

```html
<link rel="stylesheet" href="/assets/index-DNvaCug6.css">
<link rel="modulepreload" href="/assets/vendor-9iOJmRJQ.js">
<link rel="modulepreload" href="/assets/vendor-kdU4avpg.js">
<link rel="modulepreload" href="/assets/vendor-sIirijcS.js">
<link rel="modulepreload" href="/assets/vendor-DviKeERU.js">
<link rel="modulepreload" href="/assets/vendor-nyR9DPf-.js">
<link rel="modulepreload" href="/assets/vendor-C8aSJuXX.js">
<link rel="modulepreload" href="/assets/vendor-CF-3sTya.js">
<link rel="icon" href="/favicon.svg">
<script type="module" src="/assets/index-CBZD6uDy.js"></script>
```

`web-assets/assets/index-CBZD6uDy.js` —— 2 处绝对 API 路径：

```js
// get_build_identity 分支
return O(`/api/v1/build-identity`);
// scan_all 分支
`/api/v1/scan`   // 交给 fetch(e, { method: 'GET', cache: 'no-store', credentials: 'same-origin' })
```

（8 个 `vendor-*.js` 里没有绝对路径；`icons.svg`、`portviewer-build-identity.json` 由后端在根路径提供，但前端未引用。）

### 实际影响

挂在 `https://host/portviewer/` 下时：

- 10 个资源引用 → 浏览器去请求 `https://host/assets/...` → **404**，页面白屏；
- 2 个 API 调用 → 请求 `https://host/api/v1/...` → **404**，即使页面能打开也没有数据。

使用者只剩两条路，都不可取：

1. **在反代层做响应体字符串改写**（如 nginx `sub_filter`）：脆弱、依赖压缩与内容类型设置、应用升级即碎；
2. **放弃子路径，改用独立端口/子域名**：与「统一入口、统一 HTTPS、统一 SSO」的部署诉求冲突。

补充：`<html lang="zh-CN">` 是硬编码的（JS 会按解析出的语言覆盖 `documentElement.lang`），这一条不影响子路径，仅是顺带发现。

### 建议修法（任选其一，第 3 种最稳）

1. **改相对路径**：`href="assets/…"`、`src="./assets/…"`、`href="./favicon.svg"`。因为该前端没有 history 路由（`createWebHistory` 出现 0 次），页面只会停在入口 URL，相对路径不会因「深层路径 + 相对基准」而算错 —— 这一改动风险很低。
2. **加 `<base href="./">`**：一行即可让现有相对/绝对混合写法中的相对引用生效，但仍需把 `/assets/...` 改成相对形式才有效果，所以其实等价于第 1 种。
3. **API 基址改为运行时可知**（推荐，且对绝对路径同样有效）：
   - 前端从 `document.baseURI` 推导，或读取运行时注入的 `window.__PORTVIEWER_BASE__`（由服务端在 `index.html` 里注入，或提供 `--base-path` 参数）；
   - fetch 用 `new URL('api/v1/scan', document.baseURI)` 这类写法，取代裸字符串 `'/api/v1/scan'`；
   - 后端相应接受带前缀的路由，或在文档里说明「由反代剥前缀」。
4. **提供 `--base-path /portviewer` 启动参数**：服务端自己生成带前缀的 HTML/资源链接。适合不想动前端构建的使用者。

### 为什么值得修

这是「能跑在容器/反代后面」这类自托管场景的**准入条件**。同类的本机自托管工具（Grafana、Uptime Kuma、MinIO 等）都提供 `--base-path`/`root_url` 一类开关，就是这个原因。当前形态下，PortViewer 只能独占端口，套不进统一入口。

---

## Issue 3（文档/体验断崖）：Linux 上不给 root 就基本没有进程归因，且 `CAP_SYS_PTRACE` 替代无效

### 摘要

「哪个进程占了这个端口」是 PortViewer 的核心价值。但在 Linux 上，**非特权用户跑出来的归因率接近 0**，而官方单元文件恰好是以非特权用户（`User=portviewer`）运行的。功能因此形同虚设，README 也没有说明这一点。

### 实测数据（同一台机器，同一时刻）

| 运行身份 | 条目总数 | 认出进程名 | **listening 端口归因率** |
|---|---|---|---|
| 非特权（专用用户） | 277 | 2（0.7%） | **1 / 118 ≈ 0.8%** |
| root | 287 | 147（51%） | **118 / 118 = 100%** |

也就是说：**开箱默认部署下，界面上几乎所有端口的「进程」列都是空的**，用户很容易误判成工具坏了或本机没有进程信息。

### 根因

`netstat2` 需要读 `/proc/<pid>/fd` 才能把 socket inode 映射回 PID，而这在 Linux 上需要 root（或等价的 `CAP_SYS_PTRACE` + 相应 ptrace 限制放宽）。

### 已实测排除的方案

**单给 `CAP_SYS_PTRACE` 不管用**：以 ambient capability 方式授予后核对确认

```
CapInh/CapPrm/CapEff/CapBnd/CapAmb = 0000000000080000   # CAP_SYS_PTRACE 确已生效
```

但 `/proc/1/fd` 仍然不可读，归因率没有改善 → 必须完整 root（`User=root`），或调整 `yama/ptrace_scope` 等系统策略（不推荐为单个工具改全局内核策略）。我们最终改用 `User=root` 运行，并保留其余全部加固项（`ProtectSystem=strict`、`ProtectHome=read-only`、`NoNewPrivileges=true`、`RestrictAddressFamilies=…` 等）。

### 建议

1. **README 明确写清**：Linux 下完整归因需要 root；非特权模式只能做「端口占用检测」，做不了「进程归因」。现在的单元文件默认非特权，属于「默认配置跑不出核心功能」。
2. 可选：提供两档 systemd 单元，或一个 `--no-attribution` 之类的开关，把两种模式的取舍显式化。
3. 可选：归因失败时在 UI 上给一行提示（「当前以非特权身份运行，进程归因不可用」），而不是静默留空 —— 静默留空最容易让人误判为故障。
4. 若确实想保持非特权，可评估让 `netstat2` 退化为 `ss`/`/proc/net/tcp` 的有限归因（无 PID 但至少有 inode/uid 维度），至少让列有信息量。

---

## 附：验收过程中确认**正常**的部分（供作者参考，无需处理）

为免作者误以为下面这些也是问题，一并列出：

- API：`/api/health`、`/api/v1/scan`、`/api/v1/build-identity`、`/api/v1/ports/check`、`/api/v1/ports/free` 全部按预期工作；错误码语义清晰（`invalid_token` 401、`invalid_ports` 400、`invalid_port_range` 400、并发扫描 `busy` 409）。
- 并发：4 个并发 `/api/v1/scan` 得到 1×200 + 3×409，行为一致、不抖动。
- loopback 硬门禁：非 loopback 访问 `/api/v1/scan` 与 WebGUI 一律 403 `loopback_only_surface`，且明确不信任 `X-Forwarded-For` —— 设计上是正确的（我们因此改用 UNIX socket 从宿主发起，而不是伪造头部）。
- CLI：`check`（json/markdown）、`check --details`、`free --min/--max`、`mcp` 均正常；`--server` 对非局域网地址（`8.8.8.8`、`example.com`）拒绝并给出「拒绝连接非局域网地址」，SSRF 防护有效。
- MCP：`initialize` 正常（rmcp 3.1.4）；`tools/list` 返回 2 个工具（`portviewer_check_ports`、`portviewer_find_free_port`）；`tools/call` 正常；未知工具返回 JSON-RPC `-32602` 而非崩溃。**MCP 形态很好用，值得保留。**
- 前端：中文界面完整（默认跟随 `navigator.language`，zh-CN 下全中文，en-US 下全英文）；主题 `dark` 正常应用；检索语法（如 `port:22`）正常过滤；CSV 导出带 UTF-8 BOM，Excel 打开不乱码；控制台 0 error、0 未捕获异常。
- 作者自带的测试套件：`npm test` 12 文件 / 105 用例全通过；`npm run test:lan-interfaces` 返回 `{"api":"PASS","cli":"PASS","mcp":"PASS"}`。

---

## 提交清单（供 lichao 转交时参考）

| # | 标题 | 类型 | 优先级 |
|---|---|---|---|
| 1 | `deploy/linux/portviewer-web.service` 缺 `AF_NETLINK`，Linux 端口扫描必定 500 | bug | 高（开箱不可用） |
| 2 | 前端资源与 API 使用绝对路径，无法部署在子路径下 | enhancement | 中（影响自托管接入） |
| 3 | Linux 非特权运行下进程归因率≈0，单元文件默认即此模式，README 未说明 | docs/enhancement | 中（核心功能静默缺失） |

- 仓库地址：https://github.com/Diselorya/PortViewer
- 本报告不含任何凭据信息。
