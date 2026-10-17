# 一键发布与本地安装包同步

在 Windows、Node.js 22、Git 环境执行。完整版本已提交到干净的 `main` 后，一条命令完成公开源码快照、精确提交 CI、GitHub Release、所有远端与标签、本地安装包同步：

```powershell
npm run release
```

脚本通过 `GH_TOKEN` / `GITHUB_TOKEN`、已登录的 `gh`，或 Git Credential Manager 获取 GitHub 凭据。凭据只保存在进程内存；日志不输出 token 或下载跳转地址。凭据需要 Actions 调度、读取 Actions 和 Release/标签写入权限。Git 推送继续使用 Git 本身的凭据。

执行前可只读查看计划：

```powershell
npm run release -- --check
npm run release -- --dry-run
```

版本取自 `package.json`，并检查 npm lock、Tauri 配置、两个 Cargo manifest 及其项目锁项完全一致。脚本不修改版本、不自动提交工作区。版本需要递增；已发布的同名标签不允许移动，公开 Release 的资产不允许覆盖。

默认远端映射是 `lc-server=main:main` 和 `github=public-release:main`。配置其他远端时，每个远端都必须提供映射，禁止猜测：

```powershell
npm run release -- --remote github=public-release:main --remote lc-server=main:main --remote backup=main:main
```

`public-release` 用隔离 Git index、`commit-tree` 与比较后更新 ref 创建，父提交仅来自先前公开分支；主工作区和完整 `main` 历史不会进入公开分支。继续排除 `docs/design/`、`docs/product/`、`docs/architecture/`、`docs/qa/`、`skills/`、`.vscode/` 和 `StartClaudeCode-Full.bat`，同时净化 README。快照泄漏检查失败即停止。脚本不使用 force push、临时工作树或递归删除。

先把精确公开 SHA 推送至 GitHub，等待该 SHA 在公开 `main` 的 CI 两个必需任务均成功。CI 失败即退出，修复并提交后重新执行。CI 成功才调度 `release.yml`，参数包含目标完整 SHA、版本标签与 `publish=true`。workflow 重新核对 checkout SHA、版本和 CI，构建后先验收六文件、四包 SHA-256、Windows EXE/MSI ProductVersion 与两个 WebGUI 内置身份，再创建或核对标签、上传 draft，API digest 全部一致才公开。

正式 Release 公开后，脚本同步所有显式映射远端和该版本标签，并逐一读取远端分支与标签确认。最后下载六个正式资产到忽略的暂存目录，核对 GitHub API 的每项 SHA-256 digest、两份校验清单、安装器版本、部署包完整性及各自 WebGUI 的 `sourceHash` / `distHash`。允许平台换行差异导致 Windows/Linux sourceHash 不同；两包版本和合约版本必须相同。Windows 部署包会实际解包启动，检查页面资源、health、scan 和运行服务返回的前端身份；Linux 构建任务通过实际打包 `start.sh` 做同样验收。所有临时服务在 finally 中终止。Windows Installer COM 用于读取 MSI 真实 ProductVersion，所以完整本地验收需要 Windows。

所有下载与验收通过后才更新 `release/` 根目录和 `release/v<版本>/` 的六文件。被替换文件逐个保存在 `release/archive/replaced-<时间>-<随机值>/`，历史版本目录保留。最后再次核对根目录和版本目录的每份 SHA-256，并更新本地 README。仅当全部远端、标签与本地文件核验通过，命令才返回成功。

只补齐已公开发行版的本地文件，不重新构建或发布：

```powershell
npm run release -- --sync-only --tag v1.1.0
```

该模式仍要求 `main` 工作区干净，验证正式 Release、精确标签和完整六文件。省略 `--tag` 则使用当前源码版本。

可用 Actions 界面手动运行 Release：选择公开 `main`，填写 `expected_sha` 的完整提交 SHA；勾选 `publish` 才公开 Release，不勾选时只构建并保留 Actions 产物。无需创建临时分支。标签已有且指向错误提交、CI 缺失/失败、版本或校验不符时均不公开。

下载采用有界分段重试和 Range 续传，每次请求前先清空尾段；只接收区间与总长度都符合的 `Content-Range`，TLS 中断后保留验证过响应头的有效前缀，最终完整 SHA-256 通过才接受。下载每 20 秒显示已保留字节进度，GitHub API 只读 GET 对临时网络/服务端故障有界重试。中断、调度失败或同步失败后运行原命令恢复：快照无变化不重复提交，已有工作流运行可继续等待，已公开资产不覆盖，已完成且 digest 正确的本地下载可复用。调度前查询已有运行并将最大运行 ID 原子写入 journal；POST 响应丢失时，重跑按精确 SHA、公开分支、事件及新增运行 ID 查证，避免本机时间偏差影响恢复。结果未知时停止并保留 journal，避免重复发布。暂存状态保存在 `.tmp/release-state/` 与 `.tmp/release-download/`。

离线 MSI 构建会对可识别的临时下载连接故障最多尝试三次；源码、版本或完整性错误立即停止。这样微软 WebView2 下载的短暂断线可以在同一任务内恢复，最终版本和 SHA-256 门禁保持不变。
