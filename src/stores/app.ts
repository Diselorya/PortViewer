import { computed, ref, watch } from "vue";
import { defineStore } from "pinia";
import { invoke, isWebRuntime } from "../services/backend";
import { queryEntries } from "../domain/portQuery";
import { createCsv, createJson } from "../domain/exportData";
import { PRODUCT_VERSION } from "../domain/appMetadata";
import {
  ALL_COLUMN_FIELDS,
  DEFAULT_SETTINGS,
  type AppSettings,
} from "../types/settings";
import {
  entryKey,
  type AttributionResolverReport,
  type AttributionResult,
  type PortEntry,
  type PortColumnField,
  type ScanResult,
  type SortSpec,
} from "../types/port";
const STORAGE_KEY = "portviewer.settings.v1";
export interface PrivilegeStatus {
  is_elevated: boolean;
  elevation_type: string;
  integrity_level: string;
  can_elevate: boolean;
  elevation_reason: string | null;
}
export type ElevationResult =
  | "Started"
  | "AlreadyElevated"
  | "UacCancelled"
  | "PolicyBlocked"
  | "LaunchFailed";
const refreshValues = [0, 1000, 2000, 5000, 10000, 30000, 60000],
  maxValues = [1000, 10000, 50000, 100000];
export function validateSettings(value: unknown): AppSettings {
  if (!value || typeof value !== "object")
    return structuredClone(DEFAULT_SETTINGS);
  const r = value as Partial<AppSettings>;
  const schemaVersion = (value as { schemaVersion?: unknown }).schemaVersion;
  if (
    schemaVersion !== undefined &&
    (typeof schemaVersion !== "number" || ![1, 2].includes(schemaVersion))
  )
    return structuredClone(DEFAULT_SETTINGS);
  const allowedColumns = new Set<PortColumnField>(ALL_COLUMN_FIELDS);
  let visible = Array.isArray(r.visibleColumns)
    ? [
        ...new Set(
          r.visibleColumns.filter(
            (x): x is PortColumnField =>
              typeof x === "string" && allowedColumns.has(x as PortColumnField),
          ),
        ),
      ]
    : DEFAULT_SETTINGS.visibleColumns;
  if (schemaVersion === 1 && !visible.includes("attribution")) {
    const processIndex = visible.indexOf("process_name");
    visible = [...visible];
    visible.splice(
      processIndex < 0 ? visible.length : processIndex,
      0,
      "attribution",
    );
  }
  return {
    schemaVersion: 2,
    refreshIntervalMs: (refreshValues.includes(Number(r.refreshIntervalMs))
      ? r.refreshIntervalMs
      : 5000) as AppSettings["refreshIntervalMs"],
    theme: (["light", "dark", "system"].includes(String(r.theme))
      ? r.theme
      : "system") as AppSettings["theme"],
    language: (["zh-CN", "en-US", "system"].includes(String(r.language))
      ? r.language
      : "system") as AppSettings["language"],
    maxEntries: (maxValues.includes(Number(r.maxEntries))
      ? r.maxEntries
      : 50000) as AppSettings["maxEntries"],
    scanOnStartup:
      typeof r.scanOnStartup === "boolean" ? r.scanOnStartup : true,
    density: (["compact", "standard", "comfortable"].includes(String(r.density))
      ? r.density
      : "standard") as AppSettings["density"],
    visibleColumns: visible.length
      ? visible
      : [...DEFAULT_SETTINGS.visibleColumns],
  };
}
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return {
      settings: raw
        ? validateSettings(JSON.parse(raw))
        : structuredClone(DEFAULT_SETTINGS),
      recovered: false,
    };
  } catch {
    return { settings: structuredClone(DEFAULT_SETTINGS), recovered: true };
  }
}
function message(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const e = error as { message?: string; error?: string };
    return e.message ?? e.error ?? JSON.stringify(error);
  }
  return String(error);
}
export const useAppStore = defineStore("app", () => {
  const loaded = load();
  const webReadOnly = isWebRuntime();
  const settings = ref(loaded.settings),
    settingsRecovered = ref(loaded.recovered),
    entries = ref<PortEntry[]>([]),
    totalCount = ref(0),
    scannedAt = ref<string | null>(null),
    scanDurationMs = ref(0),
    scanIssues = ref<string[]>([]),
    scanWarningsRaw = ref<ScanResult["warnings"]>([]),
    scanScopesRaw = ref<ScanResult["scopes"]>([]),
    scanErrorRaw = ref<unknown | null>(null),
    attributionReports = ref<AttributionResolverReport[]>([]),
    permissionLimitedCount = ref(0),
    backendTruncated = ref(false),
    scanScope = ref("IPv4 / IPv6 · TCP / UDP"),
    isScanning = ref(false),
    hasScanned = ref(false),
    scanError = ref<string | null>(null),
    stale = ref(false),
    query = ref(""),
    protocols = ref<string[]>([]),
    states = ref<string[]>([]),
    sort = ref<SortSpec[]>([]),
    selectedKey = ref<string | null>(null),
    settingsVisible = ref(false),
    aboutVisible = ref(false),
    killVisible = ref(false),
    killBusy = ref(false),
    killError = ref<string | null>(null),
    killTarget = ref<PortEntry | null>(null),
    killTargetEndpointCount = ref(0),
    resetConfirmVisible = ref(false),
    notification = ref<{
      type: "success" | "error" | "info";
      text: string;
    } | null>(null),
    privilegeStatus = ref<PrivilegeStatus | null>(null),
    privilegeStatusError = ref<string | null>(null),
    elevationBusy = ref(false);
  let activeRefresh: Promise<void> | null = null,
    autoTimer: ReturnType<typeof setTimeout> | null = null,
    lifecycleToken = 0,
    scanGeneration = 0,
    started = false;
  const filteredEntries = computed(() =>
      queryEntries(
        entries.value,
        query.value,
        protocols.value,
        states.value,
        sort.value,
      ),
    ),
    viewEntries = computed(() =>
      filteredEntries.value.slice(0, settings.value.maxEntries),
    ),
    limitedEntries = computed(() =>
      entries.value.slice(0, settings.value.maxEntries),
    ),
    isTruncated = computed(
      () =>
        backendTruncated.value ||
        totalCount.value > entries.value.length ||
        filteredEntries.value.length > viewEntries.value.length,
    ),
    selectedEntry = computed(
      () =>
        entries.value.find((e) => entryKey(e) === selectedKey.value) ?? null,
    ),
    selectedProcessEntries = computed(() =>
      selectedEntry.value
        ? entries.value.filter(
            (e) =>
              e.pid === selectedEntry.value!.pid &&
              e.process_created_at === selectedEntry.value!.process_created_at,
          )
        : [],
    ),
    activeFilterCount = computed(
      () =>
        Number(Boolean(query.value.trim())) +
        protocols.value.length +
        states.value.length,
    ),
    attributionMatchedCount = computed(
      () => entries.value.filter((entry) => entry.attributions?.length).length,
    ),
    attributionIssues = computed(() =>
      attributionReports.value
        .filter((report) => ["Partial", "Failed"].includes(report.status))
        .map(
          (report) =>
            `${ui(report.resolver, report.resolver === "Windows 服务 / NSSM" ? "Windows Services / NSSM" : report.resolver)}：${ui(report.message ?? "解析未完整完成", "Resolver did not complete")}`,
        ),
    ),
    hasExplicitPermissionIssue = computed(
      () =>
        entries.value.some(
          (entry) => entry.process_status === "AccessDenied",
        ) ||
        attributionReports.value.some(
          (report) =>
            ["Partial", "Failed"].includes(report.status) &&
            report.elevation_may_help,
        ),
    ),
    canRequestElevation = computed(
      () =>
        !webReadOnly &&
        hasExplicitPermissionIssue.value &&
        privilegeStatusError.value === null &&
        privilegeStatus.value?.can_elevate === true,
    );
  function ui(zh: string, en: string) {
    const option = settings.value.language;
    const locale =
      option === "system"
        ? navigator.language.toLowerCase().startsWith("zh")
          ? "zh-CN"
          : "en-US"
        : option;
    return locale === "zh-CN" ? zh : en;
  }
  function localizedError(error: unknown): string {
    const raw = message(error);
    if (ui("zh", "en") === "zh") return raw;
    const kind =
      error && typeof error === "object" && "kind" in error
        ? String((error as { kind: unknown }).kind)
        : "";
    return (
      {
        ScanBusy: "A scan is already running.",
        ScanError: "The requested network scope could not be scanned.",
        ProcessNotFound: "The process no longer exists.",
        AccessDenied: "Windows denied access to this operation.",
        KillFailed: "Windows could not terminate the process.",
        InvalidExport: "The export request is invalid.",
        ExportFailed: "The export could not be saved.",
        Internal: "An internal Windows integration error occurred.",
      }[kind] ??
      "The operation failed. Copy diagnostics for the native error details."
    );
  }
  function relocalizeScanState() {
    scanIssues.value = scanWarningsRaw.value.map((warning) =>
      ui(
        warning.message,
        `${warning.ip_version} ${warning.protocol} scan unavailable`,
      ),
    );
    if (scanScopesRaw.value.length) {
      scanScope.value = scanScopesRaw.value
        .map((scope) =>
          [
            scope.ip_version,
            scope.protocol,
            scope.status === "Complete"
              ? ui("完整", "complete")
              : ui("失败", "failed"),
          ].join(" "),
        )
        .join(" · ");
    }
    scanError.value = scanErrorRaw.value
      ? localizedError(scanErrorRaw.value)
      : null;
  }
  watch(
    settings,
    (v) => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
      } catch (error) {
        notify(
          "error",
          `${ui("设置保存失败", "Failed to save settings")}：${message(error)}`,
        );
      }
    },
    { deep: true },
  );
  function notify(type: "success" | "error" | "info", text: string) {
    notification.value = { type, text };
    window.setTimeout(
      () => {
        if (notification.value?.text === text) notification.value = null;
      },
      type === "error" ? 8000 : 4000,
    );
  }
  async function refresh(): Promise<void> {
    if (activeRefresh) return activeRefresh;
    const generation = ++scanGeneration;
    activeRefresh = (async () => {
      isScanning.value = true;
      scanErrorRaw.value = null;
      scanError.value = null;
      try {
        const r = await invoke<ScanResult>("scan_all_ports");
        entries.value = r.entries ?? [];
        totalCount.value = r.total_count ?? entries.value.length;
        scannedAt.value = r.timestamp;
        scanDurationMs.value = r.scan_duration_ms;
        scanWarningsRaw.value = r.warnings ?? [];
        scanScopesRaw.value = r.scopes ?? [];
        relocalizeScanState();
        attributionReports.value = r.attribution_reports ?? [];
        permissionLimitedCount.value = new Set(
          entries.value
            .filter((e) => e.process_status === "AccessDenied")
            .map((e) => e.pid),
        ).size;
        backendTruncated.value = false;
        if (
          entries.value.some(
            (entry) => entry.process_status === "AccessDenied",
          ) ||
          attributionReports.value.some((report) => report.elevation_may_help)
        ) {
          void loadPrivilegeStatus();
        }
        stale.value = false;
        hasScanned.value = true;
        if (
          selectedKey.value &&
          !entries.value.some((e) => entryKey(e) === selectedKey.value)
        )
          selectedKey.value = null;

        // Keep optional service attribution outside the authoritative endpoint
        // scan critical path. The table is already usable while Docker and
        // configuration resolvers run in the background.
        if (r.attribution_deferred)
          try {
            const enriched = await invoke<AttributionResult>("enrich_ports", {
              entries: r.entries ?? [],
            });
            if (generation !== scanGeneration) return;
            if (enriched?.entries) entries.value = enriched.entries;
            attributionReports.value = enriched?.reports ?? [];
            permissionLimitedCount.value = new Set(
              entries.value
                .filter((entry) => entry.process_status === "AccessDenied")
                .map((entry) => entry.pid),
            ).size;
            if (
              entries.value.some(
                (entry) => entry.process_status === "AccessDenied",
              ) ||
              attributionReports.value.some(
                (report) => report.elevation_may_help,
              )
            ) {
              void loadPrivilegeStatus();
            }
          } catch (error) {
            if (generation !== scanGeneration) return;
            attributionReports.value = [
              {
                resolver: ui("服务归属", "Service attribution"),
                status: "Failed",
                matched_count: 0,
                message: localizedError(error),
                elevation_may_help: false,
              },
            ];
          }
      } catch (e) {
        scanErrorRaw.value = e;
        scanError.value = localizedError(e);
        stale.value = entries.value.length > 0;
        hasScanned.value = true;
      } finally {
        isScanning.value = false;
        activeRefresh = null;
      }
    })();
    return activeRefresh;
  }
  function clearFilters() {
    query.value = "";
    protocols.value = [];
    states.value = [];
  }
  function selectEntry(e: PortEntry | null) {
    selectedKey.value = e ? entryKey(e) : null;
  }
  function canKill(e: PortEntry) {
    return Boolean(
      !webReadOnly &&
      e.process_created_at &&
      e.pid > 4 &&
      e.process_status === "Available",
    );
  }
  function openKill() {
    if (selectedEntry.value && canKill(selectedEntry.value)) {
      killError.value = null;
      killTarget.value = { ...selectedEntry.value };
      killTargetEndpointCount.value = selectedProcessEntries.value.length;
      killVisible.value = true;
    }
  }
  async function killSelected() {
    const e = killTarget.value;
    if (!e?.process_created_at || killBusy.value) return;
    killBusy.value = true;
    killError.value = null;
    try {
      await invoke("kill_process", {
        endpoint: {
          protocol: e.protocol,
          ip_version: e.ip_version,
          local_address: e.local_address,
          local_port: e.local_port,
          remote_address: e.remote_address,
          remote_port: e.remote_port,
          pid: e.pid,
        },
        expectedCreatedAt: e.process_created_at,
      });
      killVisible.value = false;
      notify(
        "success",
        ui(
          `${e.process_name} (PID ${e.pid}) 已终止`,
          `${e.process_name} (PID ${e.pid}) terminated`,
        ),
      );
      // Invalidate any enrichment started from the pre-termination snapshot,
      // wait for it to drain, then force a new authoritative generation.
      scanGeneration += 1;
      const previousRefresh = activeRefresh;
      if (previousRefresh) await previousRefresh;
      await refresh();
    } catch (x) {
      killError.value = localizedError(x);
    } finally {
      killBusy.value = false;
    }
  }
  function updateSettings(p: Partial<AppSettings>) {
    settings.value = validateSettings({ ...settings.value, ...p });
  }
  async function loadPrivilegeStatus() {
    try {
      privilegeStatus.value = await invoke<PrivilegeStatus>(
        "get_privilege_status",
      );
      privilegeStatusError.value = null;
    } catch (error) {
      privilegeStatusError.value = localizedError(error);
    }
  }
  async function restartElevated(): Promise<ElevationResult> {
    if (elevationBusy.value) return "LaunchFailed";
    elevationBusy.value = true;
    try {
      return await invoke<ElevationResult>("restart_elevated");
    } finally {
      elevationBusy.value = false;
    }
  }
  function resetSettings() {
    settings.value = structuredClone(DEFAULT_SETTINGS);
    resetConfirmVisible.value = false;
    notify("info", ui("设置已恢复默认", "Settings restored to defaults"));
  }
  function scheduleAutoRefresh() {
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = null;
    if (!started) return;
    const ms = settings.value.refreshIntervalMs;
    if (!ms || document.hidden) return;
    autoTimer = setTimeout(async () => {
      await refresh();
      scheduleAutoRefresh();
    }, ms);
  }
  async function onVisibilityChange() {
    if (!started) return;
    if (document.hidden) {
      if (autoTimer) clearTimeout(autoTimer);
      autoTimer = null;
    } else {
      await refresh();
      if (!started) return;
      scheduleAutoRefresh();
    }
  }
  async function start() {
    if (started) return;
    started = true;
    const token = ++lifecycleToken;
    document.addEventListener("visibilitychange", onVisibilityChange);
    await loadPrivilegeStatus();
    if (
      (settings.value.scanOnStartup || privilegeStatus.value?.is_elevated) &&
      !hasScanned.value
    )
      await refresh();
    if (!started || token !== lifecycleToken) return;
    scheduleAutoRefresh();
  }
  function stop() {
    started = false;
    lifecycleToken += 1;
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = null;
    document.removeEventListener("visibilitychange", onVisibilityChange);
  }
  watch(() => settings.value.refreshIntervalMs, scheduleAutoRefresh);
  watch(() => settings.value.language, relocalizeScanState);
  async function download(format: "csv" | "json") {
    try {
      const snapshot = [...viewEntries.value],
        stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14),
        name = `PortViewer_${stamp}.${format}`,
        content =
          format === "csv"
            ? createCsv(snapshot)
            : createJson(snapshot, {
                productVersion: PRODUCT_VERSION,
                exportedAt: new Date().toISOString(),
                scannedAt: scannedAt.value,
                filters: {
                  query: query.value,
                  protocols: [...protocols.value],
                  states: [...states.value],
                },
                entryCount: snapshot.length,
                truncated: isTruncated.value,
              }),
        savedPath = await invoke<string | null>("save_export", {
          suggestedName: name,
          contents: content,
          format,
        });
      if (!savedPath) return;
      notify(
        "success",
        ui(
          `已导出 ${snapshot.length} 条 ${format.toUpperCase()} 数据：${savedPath}`,
          `Exported ${snapshot.length} ${format.toUpperCase()} rows: ${savedPath}`,
        ),
      );
    } catch (error) {
      notify(
        "error",
        `${ui("导出失败", "Export failed")}：${localizedError(error)}`,
      );
    }
  }
  return {
    settings,
    settingsRecovered,
    entries,
    totalCount,
    scannedAt,
    scanDurationMs,
    scanIssues,
    attributionReports,
    attributionIssues,
    attributionMatchedCount,
    permissionLimitedCount,
    scanScope,
    isScanning,
    hasScanned,
    scanError,
    stale,
    query,
    protocols,
    states,
    sort,
    selectedKey,
    selectedEntry,
    selectedProcessEntries,
    settingsVisible,
    aboutVisible,
    killVisible,
    killBusy,
    killError,
    killTarget,
    killTargetEndpointCount,
    resetConfirmVisible,
    notification,
    privilegeStatus,
    privilegeStatusError,
    elevationBusy,
    webReadOnly,
    hasExplicitPermissionIssue,
    canRequestElevation,
    limitedEntries,
    filteredEntries,
    viewEntries,
    isTruncated,
    activeFilterCount,
    refresh,
    clearFilters,
    selectEntry,
    canKill,
    openKill,
    killSelected,
    updateSettings,
    loadPrivilegeStatus,
    restartElevated,
    resetSettings,
    scheduleAutoRefresh,
    start,
    stop,
    download,
    notify,
  };
});
