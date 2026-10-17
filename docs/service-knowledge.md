# 服务中文名、资料补充与详情

端口列表优先显示服务中文名和用途。点服务名查看真实实例、软件说明、来源、路径和相关连接；点本机或对端查看机器信息；有 HTTP(S) 证据的端口可直接访问，其他协议进入端口详情。

## 信息从哪里来

| 信息 | 依据 |
|---|---|
| 实际服务、容器或项目 | 当前扫描的 PID、服务配置、容器映射和项目元数据 |
| 实际用途 | systemd Description、Windows 服务描述、OCI 描述、package.json 或 pyproject.toml |
| 中文产品名与通用职责 | 随包维护的有限中文对照表 |
| 公开软件说明 | 固定 npm、PyPI、GitHub API 的公开软件坐标 |
| 搜索候选 | 无法确认同名仓库时保留候选，不提高归属置信度 |
| AI 整理 | 配置并启用后的公开资料中文整理，保留来源标记 |

实际项目的业务简介与启动工具的介绍分别展示。例如 Vite 的软件介绍只能说明启动工具，不代表该机器上用户项目的业务用途。原始容器名、unit 名、服务名和项目名始终保留。

资料补充独立于基础扫描，默认自动联网，使用去重队列、缓存、限流和有界请求。断网或限流时保留本机信息与缓存，状态在列表底部显示。

## 中文对照表

当前内置 64 项精确中文对照，覆盖常见运行时、Windows 服务及 Linux 守护进程。原始名称已有中文时优先保留；没有可信中文名的实例使用中文归属类别和原名，实际项目名称与用途分别展示。

源文件为 src/data/serviceCatalog.json，schema_version 为 1。条目包含稳定 id、display_name_zh、original_name、summary、component_role、process_names、service_names、public_ids 和 source_url。

匹配依据是实际程序、服务或公开软件标识。添加条目时提供可核验的官方来源，并保留产品原名；不要只凭端口号认定服务身份。软件的新别名应加入原条目，避免产生互相冲突的重复中文名。

## 自动联网与缓存

自动查询只发送规范化公开软件坐标，不发送完整命令行、环境变量、用户名、机器名、扫描 IP 或本地路径。private:true、未知私有项目和私有 registry 不自动进入公开资料查询。

本机根项目的名称、repository 和简介保持本地，不自动派生公开坐标。预置的公开坐标和已取得的公开 registry 元数据可关联 GitHub 仓库；后端不会直接访问任意 URL，也不会执行 README、包安装命令或 Python 构建钩子。公开描述均按纯文本展示。

GitHub 匿名主额度为每 IP 每小时 60 次，搜索另有每分钟 10 次限制，程序使用更保守的预算，并遵循服务端的剩余额度、重置时间和 Retry-After。见 [GitHub 官方限流说明](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api) 和 [Search API](https://docs.github.com/en/rest/search/search)。

固定公开资料 GET 的连接上限为 5 秒，单次请求总上限为 15 秒。连接、超时、响应中断或 HTTP 500/502/503/504 最多额外重试一次，每次都占用既有查询预算；429/403/404、地址校验、格式或体积错误不自动重试。瞬时离线仅负缓存 60 秒，后续查询或扫描过冷却后可再次排队；失败不会清除已有的有效资料。

可选环境配置：

| 环境变量 | 用途 |
|---|---|
| PORTVIEWER_KNOWLEDGE_DIR | 显式资料缓存和设置目录 |
| PORTVIEWER_KNOWLEDGE_OFFLINE=1 | 强制离线 |
| PORTVIEWER_KNOWLEDGE_PROXY | 显式受信的本机 HTTP(S) 代理，如 http://127.0.0.1:7897；只允许无凭据的数字 loopback 地址与非零端口 |
| PORTVIEWER_GITHUB_TOKEN | 专用只读 Token；不会借用 gh 登录态或发布凭据 |

默认缓存目录为 Windows 的 LOCALAPPDATA/PortViewer/knowledge，或 Linux 的 XDG_CACHE_HOME/portviewer/knowledge；未配置 XDG_CACHE_HOME 时使用 HOME/.cache/portviewer/knowledge。

随包 systemd 模板通过 `CacheDirectory=portviewer` 创建权限为 0700 的 `/var/cache/portviewer`，并把资料目录显式设置为 `/var/cache/portviewer/knowledge`，因此默认只读文件系统仍可保存缓存和偏好。

### 受信本机代理与 Fake-IP

默认直连时，资料请求只允许固定公开 API，并在连接前校验 DNS 结果；保留地址（包括 TUN 常见的 198.18.0.0/15 Fake-IP）不会被当作公网目标放行。Windows 可自动采用当前用户**已启用**的静态代理，但只接受无凭据、数字 loopback 地址、显式非零端口的 HTTP(S) 代理。已关闭的保存项、PAC、WPAD、远程代理、带凭据的代理和不支持的格式均跳过；不读取通用 HTTP_PROXY、HTTPS_PROXY 或 ALL_PROXY。

PORTVIEWER_KNOWLEDGE_PROXY 优先于上述自动发现，校验失败会明确显示配置错误，不静默切换到其他代理。TUN/Fake-IP 已接管 DNS、但系统代理未启用时，需为 PortViewer 进程显式指定受信的本机代理；否则资料查询显示离线或 DNS 地址校验提示。本机代理必须已运行，端口请按实际配置修改。例如仅在当前 PowerShell 启动环境中设置：

~~~powershell
$env:PORTVIEWER_KNOWLEDGE_PROXY = "http://127.0.0.1:7897"
.\portviewer-web.exe serve --assets .\web-assets
~~~

Linux 单次启动示例：

~~~sh
PORTVIEWER_KNOWLEDGE_PROXY=http://127.0.0.1:7897 ./portviewer-web serve --assets ./web-assets
~~~

这些示例不修改系统代理或全局环境。代理只承载固定 npm、PyPI、GitHub HTTPS 目标，仍校验证书并执行大小、超时和预算限制；代理模式拒绝所有 HTTP 重定向。资料代理不用于 AI 请求，AI 端点仍由单独的后端环境配置。Windows 自动发现使用 [WinHTTP 当前用户代理配置接口](https://learn.microsoft.com/en-us/windows/win32/api/winhttp/nf-winhttp-winhttpgetieproxyconfigforcurrentuser)，不会下载或执行代理自动配置脚本。

## 可选 AI

默认未配置、未启用 AI。AI 只接收已取得的公开软件片段和来源，不接收本机项目业务简介、进程参数、环境变量或路径，也没有文件或命令执行工具。AI 输出标明“AI 整理”。

密钥、模型和 API 地址由启动后端的环境提供；界面只显示配置状态和启用偏好，不编辑或回显密钥。云端需要显式 API key，配置在 PORTVIEWER_AI_API_KEY；不要把真实密钥写进项目文件、脚本参数或前端 localStorage。

| 环境变量 | 值 |
|---|---|
| PORTVIEWER_AI_PROVIDER | openai-compatible 或 ollama |
| PORTVIEWER_AI_BASE_URL | 管理员指定的 API base URL，通常以 /v1 结束 |
| PORTVIEWER_AI_MODEL | 已配置或已安装的模型名称 |
| PORTVIEWER_AI_API_KEY | 云端凭据；本机 Ollama 可省略 |
| PORTVIEWER_AI_ALLOW_LOCAL=1 | 显式允许本机 HTTP AI 服务 |

AI 连接上限为 5 秒，单次推理请求总上限为 45 秒，输出仍有大小和长度上限。AI POST 不自动重试，避免重复计费；未成功整理时采用独立的 300 秒冷却，后续查询再尝试。关闭 AI 后，在途响应不会重新恢复 AI 内容。

本机 Ollama 的 PowerShell 启动示例：

~~~powershell
$env:PORTVIEWER_AI_PROVIDER = "ollama"
$env:PORTVIEWER_AI_BASE_URL = "http://127.0.0.1:11434/v1"
$env:PORTVIEWER_AI_MODEL = "<你已安装的模型名>"
$env:PORTVIEWER_AI_ALLOW_LOCAL = "1"
.\portviewer-web.exe serve --assets .\web-assets
~~~

模型必须已可用。启动后在界面启用 AI 整理；服务器未配置时开关不可用。Ollama 的接口说明见[官方兼容接口文档](https://docs.ollama.com/api/openai-compatibility)。

## 机器名与访问链接

“本机”始终指执行扫描的服务端。对端名使用系统解析器的反向 DNS 结果并标注来源，不能据此确定对方 OS、项目目录或操作者。

WebGUI 默认仅 loopback，跨机器浏览需按部署指南配置受控代理或隧道；局域网 API 的开放不代表开放完整 WebGUI。在受控浏览场景中，通配监听地址使用当前入口对应的扫描服务端地址构造候选链接。只绑定 loopback 的服务仍只能在扫描机器上访问。IPv6 地址保留方括号与 scope；无法可靠打开的地址提供复制和原因。

SSH、数据库、UDP 和未知协议不会被冒充成网页。常见 Web 端口只有推断、没有协议证据时，可在端口详情中明确尝试 HTTP 或 HTTPS。详情中拼好的 IP+端口文本也是链接；缺少已确认 Web 协议信息时，入口明确标为“尝试 HTTP”，HTTPS 保留独立选项。UDP、不可访问的 loopback 和 scoped IPv6 等地址仍提供复制及原因。点击详情外的遮罩即可关闭，内部点击和拖选保持详情打开。

## 视图操作

工具栏的筛选、分组、排序、着色和字段按钮打开浮动面板，不改变列表位置。排序可配置优先级，列头与面板共享同一状态；仅已加入排序的字段显示单向箭头。字段面板支持显示、顺序和自动宽度，表头也可直接拖拽调整顺序。默认紧凑显示，长描述和路径通过详情查看。

列表、分组、筛选候选和详情关联连接均无需翻页，扫描结果一次保留；大量数据用虚拟滚动控制显示节点数。搜索、筛选及组合模式、排序、分组及展开状态、列顺序/可见性/宽度、密度和着色规则自动保存在当前浏览器或桌面 WebView 的本地存储中，重开可恢复。旧版默认列布局会升级，自定义顺序和隐藏列保留。

筛选和着色共用条件编辑器：字段之间可切换“全部满足”或“满足任一”，每个字段的选项可切换“包含任一”或“包含全部”。默认保持字段之间全部满足、同字段多选包含任一；空条件匹配全部。全局搜索与条件组组合生效。

着色规则只需范围、颜色和筛选条件：整行或指定列中命中的单元格。规则从上到下按优先级生效；空条件可用于整列固定底色。选中状态和状态标签仍保持清楚。

视图交互参考[飞书分组和筛选](https://www.feishu.cn/hc/zh-CN/articles/360049067904-使用多维表格分组和筛选)与 [Lark 条件着色](https://www.larksuite.com/hc/en-US/articles/211751045999-use-conditional-coloring-in-base)，并按端口工具的规模与性能作了简化。
