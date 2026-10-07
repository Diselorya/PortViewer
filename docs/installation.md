# Windows 安装与依赖

PortViewer 提供两种安装包：

- 在线 NSIS：默认发行包，内置 Microsoft Evergreen Bootstrapper。检测到缺少 WebView2 Runtime 时，显示 Microsoft 安装界面并从 Microsoft 下载最新 Evergreen Runtime。
- 离线 MSI：内置完整 WebView2 Runtime，适合内网、Windows Server、LTSC 或隔离环境，安装包会明显更大。

如果 WebView2 安装失败，安装器会显示 Microsoft 官方下载地址。请勿从第三方下载 Runtime：

- 官方下载页：https://developer.microsoft.com/en-us/microsoft-edge/webview2/#download-section
- 分发与检测说明：https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/distribution
- 安装故障排除：https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/manageability/update-install-rollback-failures

当前 PortViewer release 不依赖 `VCRUNTIME140.dll` 或 `MSVCP140.dll`，因此不额外安装 Visual C++ Redistributable。Docker、Nginx、IIS、NSSM、Node.js/npm 和 Python 是归属识别的数据源，不是 PortViewer 启动依赖，安装器不会改动这些环境。

构建在线安装包：

```powershell
npm run build:installer:online
```

构建完全离线安装包：

```powershell
npm run build:installer:offline
```

正式安装包按机器安装到受 Windows ACL 保护的 Program Files，但应用日常仍以标准权限运行。需要读取高权限进程或受限配置时，在应用内明确选择“以管理员身份重新启动并重新扫描”；安装权限与扫描权限相互独立。

为防止用户可写目录中的程序被替换后借 UAC 提权，便携版或开发目录中的 PortViewer 不开放应用内自提权。需要管理员扫描时请使用正式安装包。管理员模式也不会从 `PATH` 搜索 Docker CLI，只执行 Program Files 下经过最终路径校验的 Docker Desktop CLI。
