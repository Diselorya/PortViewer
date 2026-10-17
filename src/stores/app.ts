import { computed, ref, shallowRef, watch } from "vue";
import { validateSettings } from "../domain/settings";
export { validateSettings } from "../domain/settings";
import { displayEntry, type EntryDisplay } from "../domain/serviceKnowledge";
import type {
  HostContext,
  KnowledgeConfiguration,
  KnowledgeSettings,
  ServiceProfile,
  ServiceProfilesResult,
} from "../types/knowledge";
import { defineStore } from "pinia";
import { invoke, isWebRuntime } from "../services/backend";
import { queryEntries } from "../domain/portQuery";
import { createCsv, createJson } from "../domain/exportData";
import { PRODUCT_VERSION } from "../domain/appMetadata";
import { backendText } from "../i18n";
import {
  groupEntries,
  type FacetField,
  type FacetFilters,
  type ConditionMode,
  type FacetFieldModes,
} from "../domain/portFacets";
import { DEFAULT_SETTINGS, type AppSettings } from "../types/settings";
import {
  entryKey,
  type AttributionResolverReport,
  type AttributionResult,
  type PortEntry,
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
    query = computed<string>({
      get: () => settings.value.query,
      set: (value) => updateSettings({ query: value }),
    }),
    facetFilters = computed<FacetFilters>({
      get: () => settings.value.facetFilters,
      set: (value) => updateSettings({ facetFilters: value }),
    }),
    protocols = computed<string[]>({
      get: () => facetFilters.value.protocol ?? [],
      set: (value) => setFacetFilter("protocol", value),
    }),
    states = computed<string[]>({
      get: () => facetFilters.value.state ?? [],
      set: (value) => setFacetFilter("state", value),
    }),
    filterMode = computed<ConditionMode>(() => settings.value.filterMode),
    filterFieldModes = computed<FacetFieldModes>(
      () => settings.value.filterFieldModes,
    ),
    groupBy = computed<FacetField | null>({
      get: () => settings.value.groupBy,
      set: (value) => updateSettings({ groupBy: value }),
    }),
    sort = computed<SortSpec[]>({
      get: () => settings.value.sortSpecs,
      set: (value) => updateSettings({ sortSpecs: value }),
    }),
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

  const serviceProfiles = shallowRef(new Map<string, ServiceProfile>());
  const hostContexts = shallowRef(new Map<string, HostContext>());
  const hostContextFetchedAt = new Map<string, number>();
  const knowledgeSettings = ref<KnowledgeConfiguration | null>(null);
  const knowledgePending = ref(0);
  const knowledgeBusy = ref(false);
  const knowledgeError = ref<string | null>(null);
  const selectedDetail = ref<{
    kind: "service" | "local" | "remote" | "endpoint";
    entryKey: string;
  } | null>(null);
  const aiConfigured = computed(
    () => knowledgeSettings.value?.ai_configured ?? false,
  );
  let knowledgeTimer: ReturnType<typeof setTimeout> | null = null;
  let knowledgeRun = 0;
  let knowledgePollAttempt = 0;
  const displayResolver = computed(() => {
    const profiles = serviceProfiles.value,
      hosts = hostContexts.value;
    const language = settings.value.language;
    const locale =
      language === "system"
        ? navigator.language.toLowerCase().startsWith("zh")
          ? "zh-CN"
          : "en-US"
        : language;
    const cache = new WeakMap<PortEntry, EntryDisplay>();
    return (entry: PortEntry) => {
      let display = cache.get(entry);
      if (!display) {
        display = displayEntry(entry, profiles, hosts, locale);
        cache.set(entry, display);
      }
      return display;
    };
  });
  function displayFor(entry: PortEntry): EntryDisplay {
    return displayResolver.value(entry);
  }
  const detailEntry = computed(() =>
    selectedDetail.value
      ? (entries.value.find(
          (entry) => entryKey(entry) === selectedDetail.value?.entryKey,
        ) ?? null)
      : null,
  );
  function openDetail(
    kind: "service" | "local" | "remote" | "endpoint",
    entry: PortEntry,
  ) {
    selectEntry(entry);
    selectedDetail.value = { kind, entryKey: entryKey(entry) };
    if (kind === "local") void loadHostContext(entry.local_address);
    if (kind === "remote" && entry.remote_address)
      void loadHostContext(entry.remote_address);
    if (kind === "service") void loadEntryProfiles(entry);
  }
  function closeDetail() {
    selectedDetail.value = null;
  }
  function setSortSpecs(specs: SortSpec[]) {
    sort.value = specs;
  }
  function setGroupBy(field: FacetField | null) {
    groupBy.value = field;
  }

  async function loadKnowledgeSettings(): Promise<void> {
    try {
      knowledgeSettings.value = await invoke<KnowledgeConfiguration>(
        "get_knowledge_settings",
      );
      knowledgeError.value = null;
    } catch (error) {
      knowledgeError.value = message(error);
    }
  }
  async function updateKnowledgeSettings(
    patch: Partial<KnowledgeSettings>,
  ): Promise<void> {
    const current = knowledgeSettings.value;
    if (!current?.can_configure)
      throw new Error(
        ui(
          "当前连接不允许修改资料查询设置",
          "This connection cannot configure knowledge settings",
        ),
      );
    const next: KnowledgeSettings = {
      online_enabled: patch.online_enabled ?? current.online_enabled,
      reverse_dns_enabled:
        patch.reverse_dns_enabled ?? current.reverse_dns_enabled,
      ai_enabled: patch.ai_enabled ?? current.ai_enabled,
    };
    if (next.ai_enabled && !current.ai_configured)
      throw new Error(
        ui("请先在服务端配置 AI", "Configure AI on the server first"),
      );
    knowledgeRun += 1;
    knowledgeSettings.value = await invoke<KnowledgeConfiguration>(
      "set_knowledge_settings",
      { settings: next },
    );
    await refreshKnowledge(true);
  }
  async function loadHostContext(
    address?: string,
  ): Promise<HostContext | null> {
    const generation = scanGeneration;
    try {
      const host = await invoke<HostContext>(
        "get_host_context",
        address === undefined ? undefined : { address },
      );
      if (generation !== scanGeneration) return null;
      if (host && typeof host.address === "string") {
        const next = new Map(hostContexts.value);
        next.set(address ?? "", host);
        hostContextFetchedAt.set(address ?? "", Date.now());
        while (next.size > 512) {
          const oldest = [...next.keys()].find((key) => key !== "");
          if (oldest === undefined) break;
          next.delete(oldest);
          hostContextFetchedAt.delete(oldest);
        }
        hostContexts.value = next;
        return host;
      }
    } catch (error) {
      if (generation === scanGeneration) knowledgeError.value = message(error);
    }
    return null;
  }
  async function loadEntryProfiles(entry: PortEntry): Promise<void> {
    const ids = [...new Set(entry.service_profile_ids ?? [])].slice(0, 128);
    if (!ids.length) return;
    const generation = scanGeneration;
    try {
      const result = await invoke<ServiceProfilesResult>(
        "get_service_profiles",
        { profileIds: ids, refresh: false },
      );
      if (generation !== scanGeneration) return;
      const next = new Map(serviceProfiles.value);
      for (const profile of result.profiles ?? [])
        next.set(profile.id, profile);
      serviceProfiles.value = next;
    } catch (error) {
      if (generation === scanGeneration) knowledgeError.value = message(error);
    }
  }
  /** Deduplicate public identity requests. Endpoint refresh never waits on DNS or registries. */
  async function refreshKnowledge(
    refresh = false,
    polling = false,
  ): Promise<void> {
    if (knowledgeTimer) clearTimeout(knowledgeTimer);
    knowledgeTimer = null;
    if (!polling) knowledgePollAttempt = 0;
    const run = ++knowledgeRun,
      generation = scanGeneration;
    const current = () => run === knowledgeRun && generation === scanGeneration;
    knowledgeBusy.value = true;
    try {
      const ids = [
        ...new Set(
          entries.value.flatMap((entry) => entry.service_profile_ids ?? []),
        ),
      ].slice(0, 4096);
      let pending = 0;
      const retainedIds = new Set(ids);
      const profiles = new Map(
        [...serviceProfiles.value].filter(([id]) => retainedIds.has(id)),
      );
      for (let index = 0; index < ids.length; index += 128) {
        const result = await invoke<ServiceProfilesResult>(
          "get_service_profiles",
          { profileIds: ids.slice(index, index + 128), refresh },
        );
        if (!current()) return;
        for (const profile of result.profiles ?? [])
          profiles.set(profile.id, profile);
        pending = Math.max(pending, result.pending_count ?? 0);
      }
      if (!current()) return;
      serviceProfiles.value = profiles;
      await loadHostContext();
      if (!current()) return;
      const currentLocalAddresses = new Set(
        hostContexts.value.get("")?.observed_addresses ?? [],
      );
      // Invalidate all bounded cached identities before limiting background requests.
      const retainedHosts = new Map(hostContexts.value);
      for (const [address, cached] of retainedHosts) {
        if (address === "") continue;
        const fetchedAt = hostContextFetchedAt.get(address);
        const age = fetchedAt === undefined ? Infinity : Date.now() - fetchedAt;
        const expectedLocal =
          currentLocalAddresses.has(address) || cached.kind === "loopback";
        if (cached.is_local !== expectedLocal || age < 0 || age >= 60_000) {
          retainedHosts.delete(address);
          hostContextFetchedAt.delete(address);
        }
      }
      if (retainedHosts.size !== hostContexts.value.size)
        hostContexts.value = retainedHosts;
      // A bounded set is resolved automatically; opening any endpoint resolves it on demand.
      const addresses = [
        ...new Set(
          entries.value.flatMap((entry) =>
            [entry.local_address, entry.remote_address].filter(
              (value): value is string => Boolean(value),
            ),
          ),
        ),
      ].slice(0, 128);
      let cursor = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, addresses.length) }, async () => {
          while (cursor < addresses.length && current()) {
            const address = addresses[cursor++]!;
            const cached = hostContexts.value.get(address);
            const fetchedAt = hostContextFetchedAt.get(address);
            const age =
              fetchedAt === undefined ? Infinity : Date.now() - fetchedAt;
            const expectedLocal =
              currentLocalAddresses.has(address) || cached?.kind === "loopback";
            if (
              !refresh &&
              cached &&
              cached.is_local === expectedLocal &&
              age >= 0 &&
              age < 60_000 &&
              !["queued", "timeout", "error"].includes(cached.dns_status)
            )
              continue;
            await loadHostContext(address);
          }
        }),
      );
      if (!current()) return;
      pending += [...hostContexts.value.values()].filter(
        (host) => host.dns_status === "queued",
      ).length;
      knowledgePending.value = pending;
      knowledgeError.value = null;
      // Allow queued metadata retries and optional AI to finish while keeping polling bounded.
      if (pending > 0 && knowledgePollAttempt++ < 200) {
        knowledgeTimer = setTimeout(() => {
          knowledgeTimer = null;
          void refreshKnowledge(false, true);
        }, 1500);
      }
    } catch (error) {
      if (current()) knowledgeError.value = message(error);
    } finally {
      if (current()) knowledgeBusy.value = false;
    }
  }

  const effectiveFacetFilters = computed<FacetFilters>(
      () => facetFilters.value,
    ),
    filteredEntries = computed(() =>
      queryEntries(
        entries.value,
        query.value,
        [],
        [],
        sort.value,
        effectiveFacetFilters.value,
        displayFor,
        { mode: filterMode.value, fieldModes: filterFieldModes.value },
      ),
    ),
    entryGroups = computed(() =>
      groupBy.value
        ? groupEntries(
            filteredEntries.value,
            groupBy.value,
            displayFor,
            sort.value.find((spec) => spec.field === groupBy.value)?.order ?? 1,
          )
        : [],
    ),
    viewEntries = computed(() =>
      groupBy.value
        ? entryGroups.value.flatMap((group) => group.entries)
        : filteredEntries.value,
    ),
    limitedEntries = computed(() => entries.value),
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
    selectedProcessEntries = computed(() => {
      const selected = selectedEntry.value;
      if (!selected) return [];
      // An unknown owner has no process identity; PID 0 cannot join endpoints.
      if (selected.pid === 0) return [selected];
      return entries.value.filter(
        (e) =>
          e.pid === selected.pid &&
          e.process_created_at === selected.process_created_at,
      );
    }),
    activeFilterCount = computed(
      () =>
        Number(Boolean(query.value.trim())) +
        Object.values(facetFilters.value).reduce(
          (count, values) => count + (values?.length ?? 0),
          0,
        ),
    ),
    attributionMatchedCount = computed(
      () => entries.value.filter((entry) => entry.attributions?.length).length,
    ),
    attributionIssues = computed(() =>
      attributionReports.value
        .filter((report) => ["Partial", "Failed"].includes(report.status))
        .map(
          (report) =>
            `${ui(report.resolver, backendText("en-US", report.resolver))}：${ui(report.message ?? "解析未完整完成", report.message ? backendText("en-US", report.message) : "Resolver did not complete")}`,
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
        warning.code === "attribution_limited"
          ? "Process attribution is limited. Check /proc permissions and the service account; port enumeration remains available."
          : `${warning.ip_version} ${warning.protocol} scan unavailable`,
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
    { deep: true, flush: "sync" },
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
        if (
          selectedDetail.value &&
          !entries.value.some(
            (entry) => entryKey(entry) === selectedDetail.value?.entryKey,
          )
        )
          closeDetail();

        void refreshKnowledge();

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
            void refreshKnowledge();
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
    updateSettings({
      query: "",
      facetFilters: {},
      filterMode: "all",
      filterFieldModes: {},
    });
  }
  function setFacetFilter(field: FacetField, values: string[]) {
    const next = { ...facetFilters.value };
    if (values.length) next[field] = [...new Set(values)];
    else delete next[field];
    updateSettings({ facetFilters: next });
  }
  function setFacetFilters(filters: FacetFilters) {
    updateSettings({ facetFilters: filters });
  }
  function setFilterMode(mode: ConditionMode) {
    updateSettings({ filterMode: mode });
  }
  function setFilterFieldModes(modes: FacetFieldModes) {
    updateSettings({ filterFieldModes: modes });
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
    const next = { ...settings.value, ...p };
    if (
      p.groupBy !== undefined &&
      p.groupBy !== settings.value.groupBy &&
      !p.groupExpansion
    )
      next.groupExpansion = { defaultExpanded: true, exceptions: [] };
    settings.value = validateSettings(next);
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
    void loadKnowledgeSettings();
    void loadHostContext();
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
    knowledgeRun += 1;
    if (knowledgeTimer) clearTimeout(knowledgeTimer);
    knowledgeTimer = null;
    knowledgeBusy.value = false;
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
            ? createCsv(
                snapshot,
                settings.value.columnOrder.filter((field) =>
                  settings.value.visibleColumns.includes(field),
                ),
                displayFor,
              )
            : createJson(
                snapshot,
                {
                  productVersion: PRODUCT_VERSION,
                  exportedAt: new Date().toISOString(),
                  scannedAt: scannedAt.value,
                  filters: {
                    query: query.value,
                    protocols: [...protocols.value],
                    states: [...states.value],
                    mode: filterMode.value,
                    fieldModes: { ...filterFieldModes.value },
                    facets: Object.fromEntries(
                      Object.entries(effectiveFacetFilters.value).map(
                        ([field, values]) => [field, [...(values ?? [])]],
                      ),
                    ),
                  },
                  groupBy: groupBy.value,
                  sort: sort.value.map((spec) => ({ ...spec })),
                  columns: settings.value.columnOrder.filter((field) =>
                    settings.value.visibleColumns.includes(field),
                  ),
                  entryCount: snapshot.length,
                  truncated: isTruncated.value,
                },
                displayFor,
              ),
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
    serviceProfiles,
    hostContexts,
    knowledgeSettings,
    knowledgePending,
    knowledgeError,
    knowledgeBusy,
    aiConfigured,
    displayFor,
    selectedDetail,
    detailEntry,
    openDetail,
    closeDetail,
    refreshKnowledge,
    loadHostContext,
    loadKnowledgeSettings,
    updateKnowledgeSettings,
    sortSpecs: sort,
    setSortSpecs,
    setGroupBy,
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
    facetFilters,
    effectiveFacetFilters,
    filterMode,
    filterFieldModes,
    groupBy,
    entryGroups,
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
    setFacetFilter,
    setFacetFilters,
    setFilterMode,
    setFilterFieldModes,
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
