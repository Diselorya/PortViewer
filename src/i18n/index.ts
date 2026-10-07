import { computed } from "vue";
import { useAppStore } from "../stores/app";
import type { ConnectionState, ProcessStatus } from "../types/port";
import type { LanguageOption } from "../types/settings";

export type AppLocale = "zh-CN" | "en-US";
type Params = Record<string, string | number>;

const messages = {
  "zh-CN": {
    appSubtitle: "本机端口检查器",
    searchReady: "搜索端口、PID、进程、路径或 IP…",
    searchWaiting: "等待首次扫描…",
    refresh: "刷新",
    close: "关闭",
    retry: "重试",
    cancel: "取消",
    clearSearch: "清除搜索",
    openSettings: "打开设置",
    openAbout: "打开关于与诊断",
    state: "状态",
    allStates: "全部 TCP 状态",
    clearFilters: "清除 {count} 个条件",
    matches: "命中 {count} 条",
    columns: "列",
    export: "导出",
    jsonWithMetadata: "JSON · 含元数据",
    protocol: "协议",
    localEndpoint: "本机端",
    directionRole: "方向 / 角色",
    peer: "对端",
    processOwner: "进程归属",
    loading: "正在读取本机 TCP/UDP 端点…",
    notScanned: "尚未扫描本机端口",
    notScannedHint: "启动后立即扫描已关闭。需要时手动读取当前 TCP/UDP 端点。",
    startScan: "开始扫描",
    scanFailed: "无法读取本机端口",
    scanFailedHint: "扫描未返回可用数据。请重试；若问题持续，可复制诊断信息。",
    scanAgain: "重新扫描",
    copyDiagnostics: "复制诊断信息",
    noEndpoints: "当前未发现 TCP/UDP 端点",
    noMatches: "没有符合当前条件的结果",
    noMatchesHint: "搜索“{query}”及当前筛选未命中。",
    clearSearchFilters: "清除搜索与筛选",
    unavailable: "未获取",
    restricted: "访问受限",
    processExited: "进程已退出",
    processOnly: "未发现更高层服务归属",
    settingsRecovered: "设置文件已损坏，已安全恢复默认值。",
    webReadOnly:
      "WebGUI 为本机只读模式：可以扫描、筛选和导出；终止进程与提权仅在 Windows 桌面版提供。",
    staleData: "刷新失败，当前继续显示 {time} 的旧数据。",
    scopeUnavailable: "部分扫描范围不可用：{issues}",
    attributionUnavailable:
      "服务归属部分不可用：{issues}。基础端口数据不受影响。",
    permissionLimited:
      "{count} 个进程的详细信息不可用；以管理员身份运行可能获得更多信息。",
    attributionPermissionLimited:
      "部分服务归属因权限不足而无法读取；以管理员身份运行可能获得更多信息。",
    settings: "设置",
    scan: "扫描",
    autoRefresh: "自动刷新",
    autoRefreshHint: "窗口隐藏时自动暂停",
    maxRows: "最大显示条目",
    maxRowsHint: "达到上限时会持续标注截断",
    scanStartup: "启动后立即扫描",
    appearance: "外观",
    language: "界面语言",
    languageHint: "切换后立即生效",
    languageSystem: "跟随系统",
    languageZh: "简体中文",
    languageEn: "English",
    theme: "主题",
    themeSystem: "跟随系统",
    themeLight: "浅色",
    themeDark: "深色",
    density: "表格密度",
    compact: "紧凑",
    standard: "标准",
    comfortable: "舒适",
    privacy: "隐私",
    privacyText: "端口数据只在内存中处理；应用默认不联网、不保存扫描历史。",
    resetSettings: "恢复默认设置",
    resetTitle: "恢复默认设置？",
    resetText:
      "将重置语言、主题、刷新间隔、表格密度和列设置。当前扫描数据与导出文件不会被删除。",
    resetConfirm: "恢复默认",
    off: "关闭",
    seconds: "{count} 秒",
    inspectorAria: "连接关系检查器",
    connectionRelation: "连接关系",
    closeDetails: "关闭详情",
    initiator: "谁发起",
    provider: "谁提供服务",
    evidence: "判断依据",
    confidence: "可信度",
    inferenceWarning:
      "角色与服务名称来自端口及 TCP 状态推测，不能替代协议抓包或服务配置。",
    local: "本机",
    remote: "对端",
    sameMachine: "本机内部",
    unknown: "暂无法判断",
    localProvides: "本机提供服务",
    remoteProvides: "对端提供服务",
    peerToPeer: "双方对等通信",
    noFixedPeer: "无固定对端",
    listening: "本机监听",
    outbound: "本机发起连接",
    inbound: "对端访问本机",
    loopback: "本机内部连接",
    udpBind: "UDP 端口绑定",
    udpPeer: "UDP 对端通信",
    unknownRole: "角色暂无法判断",
    listenSentence:
      "{process} 正在本机 {local} 等待连接，并向访问者提供{service}服务。",
    outboundSentence:
      "{process} 从本机 {local} 连接到对端 {remote}，由对端提供{service}服务。",
    inboundSentence:
      "对端 {remote} 正在访问本机 {local}，由 {process} 提供{service}服务。",
    loopbackSentence:
      "本机进程通过 {local} 与本机对端 {remote} 通信，流量不会离开本机。",
    udpBindSentence:
      "{process} 已绑定本机 UDP 端点 {local}，当前记录没有固定对端。",
    udpPeerSentence:
      "{process} 通过本机 {local} 与 UDP 对端 {remote} 通信；UDP 本身不维护连接状态。",
    unknownSentence:
      "{process} 正在本机 {local} 与 {remote} 通信，但当前快照不足以可靠判断发起方。",
    evidenceListen: "TCP 状态为 Listen，且记录没有固定远程端点。",
    evidenceSynSent: "TCP 状态为 SynSent，表示本机正在主动发起握手。",
    evidenceSynRcvd: "TCP 状态为 SynRcvd，表示本机已收到连接请求并正在回应。",
    evidenceLoopback: "本机与对端地址均为回环地址。",
    evidenceOutboundPort: "本地端口更像临时端口，对端端口更像服务端口。",
    evidenceInboundPort: "本地端口更像服务端口，对端端口更像临时端口。",
    evidenceUdpBind: "UDP 记录没有远程端点，只能确认本地端口绑定。",
    evidenceUdpPeer: "UDP 记录包含远程端点，但协议本身不保存连接状态。",
    evidenceUnknown: "单次端口快照未包含连接发起历史，端口角色也不足以判断。",
    certain: "确定",
    high: "高",
    medium: "中",
    low: "低",
    processAndAttribution: "进程与服务归属",
    processState: "进程状态",
    executable: "可执行文件",
    created: "创建时间",
    scanned: "扫描时间",
    serviceAttribution: "服务归属",
    processOnlyTitle: "仅识别到 OS 进程",
    processOnlyHint:
      "当前端点没有匹配到容器、站点、Windows 服务或运行时入口。进程事实仍然有效。",
    source: "证据：{source}",
    currentEndpoints: "当前端点",
    copyDetails: "复制详情",
    terminate: "终止进程…",
    terminateDisabled: "缺少创建时间、权限不足或属于受保护进程",
    running: "正在运行",
    partial: "信息不完整",
    systemProcess: "系统进程",
    statusUnavailable: "不可用",
    exited: "已退出",
    accessRestricted: "访问受限",
    elevate: "以管理员身份重新启动",
    elevateBusy: "正在请求权限…",
    elevateConfirm:
      "PortViewer 将请求 Windows 管理员权限并重新启动。当前扫描快照不会写入磁盘，是否继续？",
    uacCancelled: "已取消管理员授权，当前数据保持不变。",
    alreadyElevated: "当前已是管理员权限。",
    elevationBlocked: "系统策略阻止了管理员启动。",
    elevationFailed: "无法以管理员身份启动，请检查系统策略后重试。",
  },
  "en-US": {
    appSubtitle: "Local port inspector",
    searchReady: "Search port, PID, process, path, or IP…",
    searchWaiting: "Waiting for first scan…",
    refresh: "Refresh",
    close: "Close",
    retry: "Retry",
    cancel: "Cancel",
    clearSearch: "Clear search",
    openSettings: "Open settings",
    openAbout: "Open About & diagnostics",
    state: "State",
    allStates: "All TCP states",
    clearFilters: "Clear {count} filters",
    matches: "{count} matches",
    columns: "Columns",
    export: "Export",
    jsonWithMetadata: "JSON · with metadata",
    protocol: "Protocol",
    localEndpoint: "Local endpoint",
    directionRole: "Direction / role",
    peer: "Peer",
    processOwner: "Process / owner",
    loading: "Reading local TCP/UDP endpoints…",
    notScanned: "Local ports have not been scanned",
    notScannedHint:
      "Startup scan is disabled. Scan current TCP/UDP endpoints when needed.",
    startScan: "Start scan",
    scanFailed: "Unable to read local ports",
    scanFailedHint:
      "The scan returned no usable data. Retry or copy diagnostics if the problem persists.",
    scanAgain: "Scan again",
    copyDiagnostics: "Copy diagnostics",
    noEndpoints: "No TCP/UDP endpoints found",
    noMatches: "No results match the current filters",
    noMatchesHint: "Search “{query}” and active filters returned no matches.",
    clearSearchFilters: "Clear search and filters",
    unavailable: "Unavailable",
    restricted: "Access restricted",
    processExited: "Process exited",
    processOnly: "No higher-level service attribution",
    settingsRecovered: "Corrupt settings were safely reset to defaults.",
    webReadOnly:
      "WebGUI is local and read-only: scan, filter, and export are available; process termination and elevation require the Windows desktop app.",
    staleData: "Refresh failed; still showing data from {time}.",
    scopeUnavailable: "Some scan scopes are unavailable: {issues}",
    attributionUnavailable:
      "Some attribution resolvers are unavailable: {issues}. Base port data is unaffected.",
    permissionLimited:
      "Details for {count} processes are unavailable; running as administrator may reveal more information.",
    attributionPermissionLimited:
      "Some service attribution data is unavailable due to permissions; running as administrator may reveal more information.",
    settings: "Settings",
    scan: "Scan",
    autoRefresh: "Auto refresh",
    autoRefreshHint: "Pauses while the window is hidden",
    maxRows: "Maximum rows",
    maxRowsHint: "Truncation remains visible when the limit is reached",
    scanStartup: "Scan immediately after launch",
    appearance: "Appearance",
    language: "Interface language",
    languageHint: "Applies immediately",
    languageSystem: "Use system language",
    languageZh: "简体中文",
    languageEn: "English",
    theme: "Theme",
    themeSystem: "Use system theme",
    themeLight: "Light",
    themeDark: "Dark",
    density: "Table density",
    compact: "Compact",
    standard: "Standard",
    comfortable: "Comfortable",
    privacy: "Privacy",
    privacyText:
      "Port data is processed in memory only; the app makes no network requests and saves no scan history by default.",
    resetSettings: "Reset settings",
    resetTitle: "Reset settings?",
    resetText:
      "Language, theme, refresh interval, density, and columns will be reset. Scan data and exported files will not be deleted.",
    resetConfirm: "Reset",
    off: "Off",
    seconds: "{count} seconds",
    inspectorAria: "Connection relationship inspector",
    connectionRelation: "Connection relationship",
    closeDetails: "Close details",
    initiator: "Initiator",
    provider: "Service provider",
    evidence: "Evidence",
    confidence: "Confidence",
    inferenceWarning:
      "Roles and service names are inferred from ports and TCP state; they do not replace packet capture or service configuration.",
    local: "Local machine",
    remote: "Peer",
    sameMachine: "This machine",
    unknown: "Unknown",
    localProvides: "Local machine provides service",
    remoteProvides: "Peer provides service",
    peerToPeer: "Peer-to-peer",
    noFixedPeer: "No fixed peer",
    listening: "Listening locally",
    outbound: "Outbound connection",
    inbound: "Inbound connection",
    loopback: "Local loopback",
    udpBind: "UDP port binding",
    udpPeer: "UDP peer traffic",
    unknownRole: "Role unknown",
    listenSentence:
      "{process} is listening on {local} and provides a {service} service to clients.",
    outboundSentence:
      "{process} connects from {local} to {remote}, where the peer provides the {service} service.",
    inboundSentence:
      "Peer {remote} is accessing local endpoint {local}, where {process} provides the {service} service.",
    loopbackSentence:
      "A local process communicates from {local} to local peer {remote}; traffic does not leave this machine.",
    udpBindSentence:
      "{process} is bound to local UDP endpoint {local}; this record has no fixed peer.",
    udpPeerSentence:
      "{process} exchanges UDP traffic between local endpoint {local} and peer {remote}; UDP does not maintain connection state.",
    unknownSentence:
      "{process} communicates between local endpoint {local} and {remote}, but this snapshot cannot reliably identify the initiator.",
    evidenceListen:
      "TCP state is Listen and the record has no fixed remote endpoint.",
    evidenceSynSent:
      "TCP state SynSent means the local machine initiated the handshake.",
    evidenceSynRcvd:
      "TCP state SynRcvd means the local machine received and is answering a connection request.",
    evidenceLoopback: "Both local and peer addresses are loopback addresses.",
    evidenceOutboundPort:
      "The local port resembles an ephemeral port and the peer port resembles a service port.",
    evidenceInboundPort:
      "The local port resembles a service port and the peer port resembles an ephemeral port.",
    evidenceUdpBind:
      "The UDP record has no peer, so only the local binding is known.",
    evidenceUdpPeer:
      "The UDP record has a peer, but the protocol does not retain connection state.",
    evidenceUnknown:
      "A port snapshot has no initiation history, and the port roles are inconclusive.",
    certain: "Certain",
    high: "High",
    medium: "Medium",
    low: "Low",
    processAndAttribution: "Process and attribution",
    processState: "Process state",
    executable: "Executable",
    created: "Created",
    scanned: "Scanned",
    serviceAttribution: "Service attribution",
    processOnlyTitle: "OS process only",
    processOnlyHint:
      "This endpoint did not match a container, site, Windows service, or runtime entry. Process facts remain valid.",
    source: "Evidence: {source}",
    currentEndpoints: "Current endpoints",
    copyDetails: "Copy details",
    terminate: "Terminate process…",
    terminateDisabled:
      "Creation time is missing, permission is insufficient, or this is a protected process",
    running: "Running",
    partial: "Partial information",
    systemProcess: "System process",
    statusUnavailable: "Unavailable",
    exited: "Exited",
    accessRestricted: "Access restricted",
    elevate: "Restart as administrator",
    elevateBusy: "Requesting permission…",
    elevateConfirm:
      "PortViewer will request Windows administrator permission and restart. The current scan snapshot is not written to disk. Continue?",
    uacCancelled:
      "Administrator authorization was cancelled; current data is unchanged.",
    alreadyElevated: "PortViewer is already elevated.",
    elevationBlocked: "System policy blocked administrator launch.",
    elevationFailed:
      "Unable to restart as administrator. Check system policy and try again.",
  },
} as const;

export type TranslationKey = keyof (typeof messages)["zh-CN"];

const stateMessages: Record<AppLocale, Record<ConnectionState, string>> = {
  "zh-CN": {
    Closed: "已关闭",
    Listen: "监听",
    SynSent: "正在连接",
    SynRcvd: "正在握手",
    Established: "已连接",
    FinWait1: "正在关闭（阶段 1）",
    FinWait2: "正在关闭（阶段 2）",
    CloseWait: "等待本机关闭",
    Closing: "双方正在关闭",
    LastAck: "等待最终确认",
    TimeWait: "等待连接回收",
    DeleteTcb: "连接已移除",
    Unknown: "未知",
  },
  "en-US": {
    Closed: "Closed",
    Listen: "Listening",
    SynSent: "Connecting",
    SynRcvd: "Handshaking",
    Established: "Established",
    FinWait1: "Closing (stage 1)",
    FinWait2: "Closing (stage 2)",
    CloseWait: "Waiting for local close",
    Closing: "Both sides closing",
    LastAck: "Waiting for final ACK",
    TimeWait: "Waiting for cleanup",
    DeleteTcb: "Connection removed",
    Unknown: "Unknown",
  },
};

export function resolveLocale(option: LanguageOption): AppLocale {
  if (option !== "system") return option;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US";
}

export function translate(
  locale: AppLocale,
  key: TranslationKey,
  params: Params = {},
): string {
  let text: string = messages[locale][key];
  for (const [name, value] of Object.entries(params)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

export function stateLabel(
  locale: AppLocale,
  state: ConnectionState | null,
): string {
  return state ? stateMessages[locale][state] : "—";
}

export function processStatusLabel(
  locale: AppLocale,
  status: ProcessStatus,
  fallback?: string | null,
): string {
  const keys: Record<ProcessStatus, TranslationKey> = {
    Available: "running",
    Partial: "partial",
    AccessDenied: "accessRestricted",
    Exited: "exited",
    System: "systemProcess",
    Unavailable: "statusUnavailable",
  };
  return locale === "zh-CN" && fallback && status === "Partial"
    ? fallback
    : translate(locale, keys[status]);
}

const BACKEND_TEXT_EN: Record<string, string> = {
  "Node.js 应用": "Node.js application",
  "Python 应用": "Python application",
  项目: "Project",
  入口: "Entry point",
  模块: "Module",
  "容器 ID": "Container ID",
  镜像: "Image",
  端口映射: "Port mapping",
  应用池: "Application pool",
  关联站点: "Related sites",
  协议: "Protocol",
  绑定: "Binding",
  配置: "Configuration",
  "站点 ID": "Site ID",
  服务名: "Service name",
  服务状态: "Service state",
  "服务 PID": "Service PID",
  关联方式: "Relationship",
  监听: "Listening on",
  配置来源: "Configuration source",
  "Node.js/npm 临时运行工作负载": "Temporary Node.js/npm workload",
  "Python 临时运行工作负载": "Temporary Python workload",
  "NSSM 托管的 Windows 服务": "Windows service hosted by NSSM",
  "Windows 服务": "Windows service",
  "Windows 服务 / NSSM": "Windows Services / NSSM",
  "Nginx 虚拟主机": "Nginx virtual host",
  "Win32_Process 命令行 + 父进程链（脱敏摘要）":
    "Win32_Process command line and parent chain (redacted summary)",
  "Win32_Process 命令行（脱敏摘要）":
    "Win32_Process command line (redacted summary)",
  "Windows Service Control Manager + 原生进程父链":
    "Windows Service Control Manager and native process parent chain",
  "w3wp.exe -ap 参数": "w3wp.exe -ap argument",
  "本地 Docker Engine published port": "Local Docker Engine published port",
};

export function backendText(locale: AppLocale, value: string): string {
  if (locale === "zh-CN") return value;
  const exact = BACKEND_TEXT_EN[value];
  if (exact) return exact;
  return value
    .replace(/^Docker 容器 · /, "Docker container · ")
    .replace(/^Nginx 默认站点 /, "Nginx default site ")
    .replace(
      /^Nginx 虚拟主机 · 另有 (\d+) 个名称$/,
      "Nginx virtual host · $1 additional names",
    )
    .replace(/^IIS ([A-Z]+) 站点$/, "IIS $1 site")
    .replace(/^IIS 站点 · /, "IIS site · ")
    .replace(
      /^端口进程的第 (\d+) 级父进程$/,
      "Level $1 parent of the endpoint process",
    );
}

export function useI18n() {
  const store = useAppStore();
  const locale = computed(() => resolveLocale(store.settings.language));
  return {
    locale,
    t: (key: TranslationKey, params?: Params) =>
      translate(locale.value, key, params),
    state: (value: ConnectionState | null) => stateLabel(locale.value, value),
  };
}
