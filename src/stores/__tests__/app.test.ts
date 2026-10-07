import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { nextTick } from "vue";
import { useAppStore, validateSettings } from "../app";
import type {
  AttributionResult,
  PortEntry,
  ScanResult,
} from "../../types/port";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
const standardPrivilege = {
  is_elevated: false,
  elevation_type: "Default",
  integrity_level: "Medium",
  can_elevate: true,
  elevation_reason: null,
};
function scanCallCount() {
  return invokeMock.mock.calls.filter(
    ([command]) => command === "scan_all_ports",
  ).length;
}

function entry(patch: Partial<PortEntry> = {}): PortEntry {
  return {
    protocol: "Tcp",
    ip_version: "V4",
    local_address: "127.0.0.1",
    local_port: 3000,
    remote_address: null,
    remote_port: null,
    state: "Listen",
    pid: 42,
    process_name: "node.exe",
    process_path: "C:\\node.exe",
    process_created_at: "2026-08-23T00:00:00Z",
    process_status: "Available",
    process_status_message: null,
    attributions: [],
    ...patch,
  };
}

function scan(
  entries: PortEntry[] = [],
  patch: Partial<ScanResult> = {},
): ScanResult {
  return {
    entries,
    total_count: entries.length,
    timestamp: "2026-08-23T00:00:00Z",
    scan_duration_ms: 4,
    is_partial: false,
    scopes: [],
    warnings: [],
    attribution_reports: [],
    attribution_deferred: false,
    ...patch,
  };
}

describe("app store", () => {
  beforeEach(() => {
    vi.useRealTimers();
    localStorage.clear();
    setActivePinia(createPinia());
    invokeMock.mockReset();
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => vi.useRealTimers());

  it("coalesces overlapping refresh calls into one IPC request", async () => {
    let release: (value: ScanResult) => void = () => {};
    invokeMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    const store = useAppStore();
    store.updateSettings({ refreshIntervalMs: 1000 });
    const first = store.refresh();
    const second = store.refresh();
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(store.isScanning).toBe(true);
    release(scan());
    await Promise.all([first, second]);
    expect(store.isScanning).toBe(false);
    expect(store.hasScanned).toBe(true);
  });

  it("applies deferred attribution only after the authoritative scan is visible", async () => {
    const source = entry();
    const enriched = entry({
      attributions: [
        {
          kind: "NodeApplication",
          name: "npm: portviewer",
          description: "npm 临时服务",
          confidence: "High",
          source: "Win32_Process",
          facts: [],
        },
      ],
    });
    let releaseEnrichment: (value: AttributionResult) => void = () => {};
    invokeMock.mockImplementation((command) => {
      if (command === "scan_all_ports") {
        return Promise.resolve(scan([source], { attribution_deferred: true }));
      }
      if (command === "enrich_ports") {
        return new Promise<AttributionResult>((resolve) => {
          releaseEnrichment = resolve;
        });
      }
      throw new Error(`unexpected command: ${String(command)}`);
    });
    const store = useAppStore();

    const refreshing = store.refresh();
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("enrich_ports", {
        entries: [source],
      }),
    );
    expect(store.entries).toEqual([source]);

    releaseEnrichment({
      entries: [enriched],
      reports: [
        {
          resolver: "Node.js / npm",
          status: "Complete",
          matched_count: 1,
          message: null,
          elevation_may_help: false,
        },
      ],
      duration_ms: 8,
    });
    await refreshing;

    expect(store.entries).toEqual([enriched]);
    expect(store.attributionMatchedCount).toBe(1);
    expect(store.attributionReports[0]?.matched_count).toBe(1);
  });

  it("keeps the authoritative snapshot when deferred attribution fails", async () => {
    const source = entry();
    invokeMock.mockImplementation((command) => {
      if (command === "scan_all_ports") {
        return Promise.resolve(scan([source], { attribution_deferred: true }));
      }
      if (command === "enrich_ports") {
        return Promise.reject({
          kind: "AccessDenied",
          message: "服务归属读取被拒绝",
        });
      }
      throw new Error(`unexpected command: ${String(command)}`);
    });
    const store = useAppStore();

    await store.refresh();

    expect(store.entries).toEqual([source]);
    expect(store.attributionReports).toEqual([
      {
        resolver: "服务归属",
        status: "Failed",
        matched_count: 0,
        message: "服务归属读取被拒绝",
        elevation_may_help: false,
      },
    ]);
  });

  it("records a completed authoritative empty scan without stale state", async () => {
    invokeMock.mockResolvedValue(scan([]));
    const store = useAppStore();

    await store.refresh();

    expect(store.hasScanned).toBe(true);
    expect(store.entries).toEqual([]);
    expect(store.totalCount).toBe(0);
    expect(store.scanError).toBeNull();
    expect(store.stale).toBe(false);
  });

  it("keeps successful data and marks it stale for ScanBusy and scan failures", async () => {
    const source = entry();
    invokeMock
      .mockResolvedValueOnce(scan([source]))
      .mockRejectedValueOnce({ kind: "ScanBusy", message: "扫描正在进行" })
      .mockRejectedValueOnce({ kind: "ScanError", message: "读取失败" });
    const store = useAppStore();
    await store.refresh();
    await store.refresh();
    expect(store.entries).toEqual([source]);
    expect(store.stale).toBe(true);
    expect(store.scanError).toBe("扫描正在进行");
    await store.refresh();
    expect(store.entries).toEqual([source]);
    expect(store.scanError).toBe("读取失败");
  });

  it("clears stale and error state after recovery", async () => {
    invokeMock
      .mockRejectedValueOnce({ kind: "ScanError", message: "失败" })
      .mockResolvedValueOnce(scan([entry()]));
    const store = useAppStore();
    await store.refresh();
    expect(store.scanError).toBe("失败");
    await store.refresh();
    expect(store.scanError).toBeNull();
    expect(store.stale).toBe(false);
  });

  it("maps partial scope warnings and counts restricted PIDs only once", async () => {
    invokeMock.mockResolvedValue(
      scan(
        [
          entry({ pid: 7, process_status: "AccessDenied" }),
          entry({ pid: 7, local_port: 3001, process_status: "Partial" }),
          entry({ pid: 8, process_status: "Unavailable" }),
        ],
        {
          is_partial: true,
          warnings: [
            {
              code: "scope_failed",
              protocol: "Udp",
              ip_version: "V6",
              message: "IPv6 UDP 扫描失败",
            },
          ],
          scopes: [
            {
              protocol: "Tcp",
              ip_version: "V4",
              status: "Complete",
              entry_count: 2,
              message: null,
            },
            {
              protocol: "Udp",
              ip_version: "V6",
              status: "Failed",
              entry_count: 0,
              message: "失败",
            },
          ],
        },
      ),
    );
    const store = useAppStore();
    await store.refresh();
    expect(store.scanIssues).toEqual(["IPv6 UDP 扫描失败"]);
    expect(store.permissionLimitedCount).toBe(1);
    expect(store.scanScope).toContain("V4 Tcp 完整");
    expect(store.scanScope).toContain("V6 Udp 失败");
  });

  it("relocalizes an existing scan immediately when the language changes", async () => {
    invokeMock.mockResolvedValue(
      scan([], {
        warnings: [
          {
            code: "scope_failed",
            protocol: "Udp",
            ip_version: "V6",
            message: "IPv6 UDP 扫描失败",
          },
        ],
        scopes: [
          {
            protocol: "Udp",
            ip_version: "V6",
            status: "Failed",
            entry_count: 0,
            message: "失败",
          },
        ],
      }),
    );
    const store = useAppStore();
    await store.refresh();
    store.updateSettings({ language: "en-US" });
    await nextTick();

    expect(store.scanIssues).toEqual(["V6 Udp scan unavailable"]);
    expect(store.scanScope).toBe("V6 Udp failed");
  });

  it("retains selection by stable identity and clears it when the row disappears", async () => {
    const source = entry();
    invokeMock
      .mockResolvedValueOnce(scan([source]))
      .mockResolvedValueOnce(scan([{ ...source }]))
      .mockResolvedValueOnce(scan([]));
    const store = useAppStore();
    await store.refresh();
    store.selectEntry(source);
    await store.refresh();
    expect(store.selectedEntry).toEqual(source);
    await store.refresh();
    expect(store.selectedEntry).toBeNull();
  });

  it.each([
    entry({ pid: 0 }),
    entry({ pid: 4 }),
    entry({ process_created_at: null }),
    entry({ process_status: "AccessDenied" }),
    entry({ process_status: "System" }),
    entry({ process_status: "Exited" }),
  ])("does not expose kill for an unsafe identity", (unsafeEntry) => {
    const store = useAppStore();
    expect(store.canKill(unsafeEntry)).toBe(false);
  });

  it("passes endpoint identity and required creation time to kill IPC, then refreshes", async () => {
    const source = entry();
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(scan([]));
    const store = useAppStore();
    store.entries = [source];
    store.selectEntry(source);
    store.openKill();
    expect(store.killVisible).toBe(true);
    await store.killSelected();
    expect(invokeMock).toHaveBeenNthCalledWith(1, "kill_process", {
      endpoint: {
        protocol: "Tcp",
        ip_version: "V4",
        local_address: "127.0.0.1",
        local_port: 3000,
        remote_address: null,
        remote_port: null,
        pid: 42,
      },
      expectedCreatedAt: "2026-08-23T00:00:00Z",
    });
    expect(invokeMock).toHaveBeenNthCalledWith(2, "scan_all_ports");
    expect(store.killVisible).toBe(false);
  });

  it("discards pre-termination enrichment and forces a new scan generation after kill", async () => {
    const preTermination = entry();
    const staleEnriched = entry({
      attributions: [
        {
          kind: "NodeApplication",
          name: "stale npm service",
          description: null,
          confidence: "High",
          source: "Win32_Process",
          facts: [],
        },
      ],
    });
    const postTermination = entry({
      pid: 84,
      local_port: 8080,
      process_name: "replacement.exe",
      process_created_at: "2026-08-23T00:01:00Z",
    });
    let scanNumber = 0;
    let releaseEnrichment: (value: AttributionResult) => void = () => {};
    let releaseKill: () => void = () => {};
    let releasePostKillScan: (value: ScanResult) => void = () => {};
    invokeMock.mockImplementation((command) => {
      if (command === "scan_all_ports") {
        scanNumber += 1;
        if (scanNumber === 1) {
          return Promise.resolve(
            scan([preTermination], { attribution_deferred: true }),
          );
        }
        return new Promise<ScanResult>((resolve) => {
          releasePostKillScan = resolve;
        });
      }
      if (command === "enrich_ports") {
        return new Promise<AttributionResult>((resolve) => {
          releaseEnrichment = resolve;
        });
      }
      if (command === "kill_process") {
        return new Promise<void>((resolve) => {
          releaseKill = resolve;
        });
      }
      throw new Error(`unexpected command: ${String(command)}`);
    });
    const store = useAppStore();

    const initialRefresh = store.refresh();
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("enrich_ports", {
        entries: [preTermination],
      }),
    );
    store.selectEntry(preTermination);
    store.openKill();
    const killing = store.killSelected();
    await vi.waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "kill_process",
        expect.any(Object),
      ),
    );

    releaseKill();
    await Promise.resolve();
    releaseEnrichment({
      entries: [staleEnriched],
      reports: [
        {
          resolver: "Node.js / npm",
          status: "Complete",
          matched_count: 1,
          message: null,
          elevation_may_help: false,
        },
      ],
      duration_ms: 20,
    });
    await initialRefresh;
    await vi.waitFor(() => expect(scanCallCount()).toBe(2));

    expect(store.entries).toEqual([preTermination]);
    expect(store.attributionReports).toEqual([]);

    releasePostKillScan(scan([postTermination]));
    await killing;

    expect(store.entries).toEqual([postTermination]);
    expect(scanCallCount()).toBe(2);
    expect(store.killVisible).toBe(false);
  });

  it("keeps kill context open and data intact when the backend rejects", async () => {
    const source = entry();
    invokeMock.mockRejectedValue({ kind: "AccessDenied", message: "权限不足" });
    const store = useAppStore();
    store.entries = [source];
    store.selectEntry(source);
    store.openKill();
    await store.killSelected();
    expect(store.killVisible).toBe(true);
    expect(store.killError).toBe("权限不足");
    expect(store.entries).toEqual([source]);
  });

  it("coalesces repeated kill confirmation while termination is pending", async () => {
    let release: () => void = () => {};
    invokeMock.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const source = entry();
    const store = useAppStore();
    store.entries = [source];
    store.selectEntry(source);
    store.openKill();

    const first = store.killSelected();
    const second = store.killSelected();

    expect(invokeMock).toHaveBeenCalledTimes(1);
    release();
    invokeMock.mockResolvedValueOnce(scan([]));
    await Promise.all([first, second]);
  });

  it("reschedules one auto-refresh timer and stops when interval is disabled", async () => {
    vi.useFakeTimers();
    invokeMock.mockImplementation((command) =>
      Promise.resolve(
        command === "get_privilege_status" ? standardPrivilege : scan(),
      ),
    );
    const store = useAppStore();
    store.updateSettings({ scanOnStartup: false, refreshIntervalMs: 1000 });
    await store.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(scanCallCount()).toBe(1);
    store.updateSettings({ refreshIntervalMs: 0 });
    await nextTick();
    store.scheduleAutoRefresh();
    await vi.advanceTimersByTimeAsync(5000);
    expect(scanCallCount()).toBe(1);
    store.stop();
  });

  it("pauses while hidden and refreshes once when visibility returns", async () => {
    invokeMock.mockImplementation((command) =>
      Promise.resolve(
        command === "get_privilege_status" ? standardPrivilege : scan(),
      ),
    );
    const store = useAppStore();
    store.updateSettings({ scanOnStartup: false, refreshIntervalMs: 0 });
    await store.start();
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(scanCallCount()).toBe(0);
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(scanCallCount()).toBe(1));
    store.stop();
  });

  it("does not schedule another refresh when stopped during startup scan", async () => {
    vi.useFakeTimers();
    let release: (value: ScanResult) => void = () => {};
    invokeMock.mockResolvedValueOnce(standardPrivilege).mockReturnValueOnce(
      new Promise<ScanResult>((resolve) => {
        release = resolve;
      }),
    );
    const store = useAppStore();

    const starting = store.start();
    store.stop();
    release(scan());
    await starting;
    await vi.advanceTimersByTimeAsync(5000);

    expect(scanCallCount()).toBe(1);
  });

  it("does not restart auto refresh when stopped during a visibility refresh", async () => {
    vi.useFakeTimers();
    let release: (value: ScanResult) => void = () => {};
    invokeMock.mockResolvedValueOnce(standardPrivilege).mockReturnValueOnce(
      new Promise<ScanResult>((resolve) => {
        release = resolve;
      }),
    );
    const store = useAppStore();
    store.updateSettings({ scanOnStartup: false, refreshIntervalMs: 1000 });
    await store.start();

    document.dispatchEvent(new Event("visibilitychange"));
    store.stop();
    release(scan());
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(5000);

    expect(scanCallCount()).toBe(1);
  });

  it("validates settings, persists supported values and resets without deleting data", async () => {
    const settings = validateSettings({
      theme: "invalid",
      refreshIntervalMs: 3,
      maxEntries: 4,
      visibleColumns: [],
      unknown: "ignored",
    });
    expect(settings.theme).toBe("system");
    expect(settings.refreshIntervalMs).toBe(5000);
    expect(settings.visibleColumns.length).toBeGreaterThan(1);

    const store = useAppStore();
    store.entries = [entry()];
    store.updateSettings({ theme: "dark", refreshIntervalMs: 1000 });
    await nextTick();
    expect(
      JSON.parse(localStorage.getItem("portviewer.settings.v1")!),
    ).toMatchObject({
      theme: "dark",
      refreshIntervalMs: 1000,
    });
    store.resetSettings();
    expect(store.settings.theme).toBe("system");
    expect(store.settings.refreshIntervalMs).toBe(5000);
    expect(store.entries).toHaveLength(1);
  });

  it.each([0, 1000, 2000, 5000, 10000, 30000, 60000] as const)(
    "accepts supported refresh interval boundary %i",
    (refreshIntervalMs) => {
      expect(validateSettings({ refreshIntervalMs }).refreshIntervalMs).toBe(
        refreshIntervalMs,
      );
    },
  );

  it.each([1000, 10000, 50000, 100000] as const)(
    "accepts supported maximum entry boundary %i",
    (maxEntries) => {
      expect(validateSettings({ maxEntries }).maxEntries).toBe(maxEntries);
    },
  );

  it("drops unknown and duplicate persisted column identifiers", () => {
    const settings = validateSettings({
      visibleColumns: ["local_port", "retired_column", "local_port"],
    });

    expect(settings.visibleColumns).toEqual(["local_port"]);
  });

  it("migrates v1 column settings by adding the new attribution column once", () => {
    const settings = validateSettings({
      schemaVersion: 1,
      visibleColumns: ["local_port", "process_name"],
    });

    expect(settings.schemaVersion).toBe(2);
    expect(settings.visibleColumns).toEqual([
      "local_port",
      "attribution",
      "process_name",
    ]);
    expect(
      validateSettings({ ...settings }).visibleColumns.filter(
        (field) => field === "attribution",
      ),
    ).toHaveLength(1);
  });

  it("tracks attribution coverage and reports only partial or failed resolvers", async () => {
    invokeMock.mockResolvedValue(
      scan(
        [
          entry({
            attributions: [
              {
                kind: "PythonApplication",
                name: "Python: server.py",
                description: null,
                confidence: "High",
                source: "Win32_Process",
                facts: [],
              },
            ],
          }),
          entry({ pid: 43, local_port: 3001 }),
        ],
        {
          attribution_reports: [
            {
              resolver: "Docker",
              status: "Skipped",
              matched_count: 0,
              message: "未安装",
              elevation_may_help: false,
            },
            {
              resolver: "Nginx",
              status: "Partial",
              matched_count: 0,
              message: "配置不可读",
              elevation_may_help: true,
            },
          ],
        },
      ),
    );
    const store = useAppStore();
    await store.refresh();

    expect(store.attributionMatchedCount).toBe(1);
    expect(store.attributionIssues).toEqual(["Nginx：配置不可读"]);
  });

  it("offers elevation only for explicit access denial or resolver guidance", () => {
    const store = useAppStore();
    store.privilegeStatus = standardPrivilege;
    store.entries = [entry({ process_status: "Partial", process_path: null })];
    expect(store.hasExplicitPermissionIssue).toBe(false);
    store.entries = [entry({ process_status: "AccessDenied" })];
    expect(store.hasExplicitPermissionIssue).toBe(true);
    expect(store.canRequestElevation).toBe(true);
    store.privilegeStatus = {
      is_elevated: true,
      elevation_type: "Full",
      integrity_level: "High",
      can_elevate: false,
      elevation_reason: "AlreadyElevated",
    };
    expect(store.canRequestElevation).toBe(false);
  });

  it("limits the searchable and exportable view without deleting the scan snapshot", () => {
    const store = useAppStore();
    store.entries = Array.from({ length: 1001 }, (_, index) =>
      entry({ local_port: index, pid: index + 10 }),
    );
    store.totalCount = 1001;
    store.updateSettings({ maxEntries: 1000 });

    expect(store.entries).toHaveLength(1001);
    expect(store.limitedEntries).toHaveLength(1000);
    expect(store.viewEntries).toHaveLength(1000);
    expect(store.isTruncated).toBe(true);
  });

  it("clears query and filters while preserving the explicit sort", () => {
    const store = useAppStore();
    store.query = "port:3000";
    store.protocols = ["Tcp"];
    store.states = ["Listen"];
    store.sort = [{ field: "pid", order: -1 }];

    store.clearFilters();

    expect(store.query).toBe("");
    expect(store.protocols).toEqual([]);
    expect(store.states).toEqual([]);
    expect(store.sort).toEqual([{ field: "pid", order: -1 }]);
  });

  it("sends the current CSV view to the native save command and reports success", async () => {
    invokeMock.mockResolvedValue("C:\\Exports\\ports.csv");
    const store = useAppStore();
    store.entries = [entry()];
    store.scannedAt = "2026-08-23T00:00:00Z";

    await store.download("csv");

    expect(invokeMock).toHaveBeenCalledWith("save_export", {
      suggestedName: expect.stringMatching(/^PortViewer_\d{8}\d{6}\.csv$/),
      contents: expect.stringContaining("\uFEFF协议,IP 版本"),
      format: "csv",
    });
    expect(store.notification).toEqual({
      type: "success",
      text: "已导出 1 条 CSV 数据：C:\\Exports\\ports.csv",
    });
  });

  it("treats a cancelled native save dialog as a silent no-op", async () => {
    invokeMock.mockResolvedValue(null);
    const store = useAppStore();
    store.entries = [entry()];

    await store.download("json");

    expect(invokeMock).toHaveBeenCalledOnce();
    expect(store.notification).toBeNull();
  });

  it("reports a native export write failure without losing the current view", async () => {
    invokeMock.mockRejectedValue({
      kind: "ExportFailed",
      message: "目标目录不可写",
    });
    const source = entry();
    const store = useAppStore();
    store.entries = [source];

    await store.download("csv");

    expect(store.notification).toEqual({
      type: "error",
      text: "导出失败：目标目录不可写",
    });
    expect(store.viewEntries).toEqual([source]);
  });

  it("recovers corrupt persisted JSON and raises a one-time session flag", () => {
    localStorage.setItem("portviewer.settings.v1", "{broken");
    setActivePinia(createPinia());
    const store = useAppStore();
    expect(store.settingsRecovered).toBe(true);
    expect(store.settings).toMatchObject({
      theme: "system",
      refreshIntervalMs: 5000,
    });
  });
});
