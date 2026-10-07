# 参与贡献

## 开始之前

请先搜索已有 Issue。Bug 请附最小复现、系统版本、PortViewer 版本、权限级别和已脱敏的诊断信息；新功能请说明用户场景、非目标和验收方式。

## 本地开发

Windows 桌面版需要 Node.js 22、Rust stable、Visual Studio 2022 Build Tools、Windows SDK 和 WebView2 开发环境。WebGUI 可在 Windows 或 Linux 开发。

```text
npm ci
npm test
npm run typecheck
npm run format:check
npm run build
cargo test --manifest-path web-service/Cargo.toml
```

Windows 桌面后端还需执行：

```text
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
```

## 变更要求

- 保持 WebGUI 只读和 loopback-only；任何网络暴露或写操作必须先提交威胁模型设计讨论。
- Windows 归属识别必须保留“事实、来源、置信度、失败状态”，不得用猜测覆盖 PID/端口事实。
- 新增行为需覆盖正常、边界和错误路径；修复回归必须先增加可失败的测试。
- 不提交密钥、真实主机端口清单、包含用户名的绝对路径、构建输出或依赖目录。
- UI 文案同时提供简体中文和英文，并通过键盘和高对比度场景检查。
- Pull Request 保持单一目的，描述用户影响、风险、测试证据和截图（界面变更时）。

## 提交信息

使用 `<type>(<scope>): <简体中文描述>`，例如 `fix(web): 修复构建身份握手`。类型使用 `feat`、`fix`、`refactor`、`test`、`docs` 或 `chore`。

提交即表示你有权贡献该内容，并同意按仓库的 MIT License 发布。
