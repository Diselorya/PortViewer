import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { useAppStore } from "../app";
import { host, port, profile } from "../../domain/__tests__/workbenchFixtures";
import type { ScanResult } from "../../types/port";
import type {
  KnowledgeConfiguration,
  ServiceProfilesResult,
} from "../../types/knowledge";
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
const configuration: KnowledgeConfiguration = {
  online_enabled: true,
  reverse_dns_enabled: true,
  ai_enabled: false,
  ai_configured: false,
  ai_provider: null,
  ai_model: null,
  can_configure: true,
};
const result = (
  profiles: ServiceProfilesResult["profiles"] = [],
  pending_count = 0,
): ServiceProfilesResult => ({
  profiles,
  pending_count,
  online_enabled: true,
  ai_configured: false,
  ai_enabled: false,
});
const scan = (entries: ScanResult["entries"]): ScanResult => ({
  entries,
  total_count: entries.length,
  timestamp: "2026-10-17T00:00:00Z",
  scan_duration_ms: 1,
  is_partial: false,
  scopes: [],
  warnings: [],
  attribution_reports: [],
  attribution_deferred: false,
});
let stores: ReturnType<typeof useAppStore>[] = [];
function store() {
  const value = useAppStore();
  stores.push(value);
  return value;
}
beforeEach(() => {
  localStorage.clear();
  setActivePinia(createPinia());
  stores = [];
  invokeMock.mockReset();
  invokeMock.mockImplementation(
    (command: string, args?: Record<string, unknown>) => {
      if (command === "get_knowledge_settings")
        return Promise.resolve({ ...configuration });
      if (command === "get_host_context")
        return Promise.resolve(
          host({ address: String(args?.address ?? "local") }),
        );
      if (command === "get_service_profiles") return Promise.resolve(result());
      if (command === "scan_all_ports") return Promise.resolve(scan([]));
      throw new Error("Unexpected command: " + command);
    },
  );
});
afterEach(() => {
  for (const value of stores) value.stop();
  vi.useRealTimers();
});

describe("asynchronous service and host knowledge", () => {
  it("should publish the authoritative scan without waiting for public metadata", async () => {
    let release: (value: ServiceProfilesResult) => void = () => {};
    const entry = port({ service_profile_ids: ["workload"] });
    invokeMock.mockImplementation((command: string) => {
      if (command === "scan_all_ports") return Promise.resolve(scan([entry]));
      if (command === "get_service_profiles")
        return new Promise<ServiceProfilesResult>((resolve) => {
          release = resolve;
        });
      return Promise.resolve(host());
    });
    const app = store();
    await app.refresh();
    expect(app.entries).toEqual([entry]);
    expect(app.isScanning).toBe(false);
    expect(app.knowledgeBusy).toBe(true);
    release(result([profile()]));
    await vi.waitFor(() =>
      expect(app.serviceProfiles.has("workload")).toBe(true),
    );
  });
  it("should discard public metadata from a previous scan generation", async () => {
    let release: (value: ServiceProfilesResult) => void = () => {};
    let scanNumber = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "scan_all_ports")
        return Promise.resolve(
          scan([
            port({
              pid: ++scanNumber,
              service_profile_ids: [scanNumber === 1 ? "old" : "new"],
            }),
          ]),
        );
      if (command === "get_service_profiles")
        return scanNumber === 1
          ? new Promise<ServiceProfilesResult>((resolve) => {
              release = resolve;
            })
          : Promise.resolve(
              result([profile({ id: "new", original_name: "replacement" })]),
            );
      return Promise.resolve(host());
    });
    const app = store();
    await app.refresh();
    await app.refresh();
    await vi.waitFor(() => expect(app.serviceProfiles.has("new")).toBe(true));
    release(result([profile({ id: "old" })]));
    await Promise.resolve();
    expect(app.serviceProfiles.has("old")).toBe(false);
    expect(app.entries[0]?.pid).toBe(2);
  });
  it("should batch and deduplicate profile identities without transmitting process paths", async () => {
    const app = store();
    app.entries = Array.from({ length: 260 }, (_, index) =>
      port({
        pid: index,
        service_profile_ids: ["profile-" + index, "profile-" + index],
      }),
    );
    await app.refreshKnowledge();
    const calls = invokeMock.mock.calls.filter(
      ([command]) => command === "get_service_profiles",
    );
    expect(calls.map(([, args]) => args.profileIds.length)).toEqual([
      128, 128, 4,
    ]);
    expect(JSON.stringify(calls)).not.toContain("projects");
    expect(new Set(calls.flatMap(([, args]) => args.profileIds)).size).toBe(
      260,
    );
  });
  it("should resolve at most 128 observed addresses automatically and preserve the local scanner context", async () => {
    const app = store();
    app.entries = Array.from({ length: 150 }, (_, index) =>
      port({ pid: index, local_address: "10.0.0." + index }),
    );
    await app.refreshKnowledge();
    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === "get_host_context",
      ),
    ).toHaveLength(129);
    expect(app.hostContexts.has("")).toBe(true);
    expect(app.hostContexts.size).toBe(129);
  });
  it("should bound on-demand hostname caching while retaining the scanner host", async () => {
    const app = store();
    await app.loadHostContext();
    for (let index = 0; index < 520; index++)
      await app.loadHostContext(
        "10.0." + Math.floor(index / 256) + "." + (index % 256),
      );
    expect(app.hostContexts.size).toBe(512);
    expect(app.hostContexts.has("")).toBe(true);
    expect(app.hostContexts.has("10.0.0.0")).toBe(false);
  });
  it("should keep metadata failures separate from scan failure state", async () => {
    const app = store();
    app.entries = [port({ service_profile_ids: ["workload"] })];
    invokeMock.mockImplementation((command: string) =>
      command === "get_service_profiles"
        ? Promise.reject(new Error("registry unavailable"))
        : Promise.resolve(host()),
    );
    await app.refreshKnowledge();
    expect(app.knowledgeError).toBe("registry unavailable");
    expect(app.scanError).toBeNull();
    expect(app.entries).toHaveLength(1);
    expect(app.knowledgeBusy).toBe(false);
  });
  it("should clear pending timers when stopped so a stale queue cannot continue polling", async () => {
    vi.useFakeTimers();
    const app = store();
    app.entries = [port({ service_profile_ids: ["workload"] })];
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(
        command === "get_service_profiles" ? result([profile()], 1) : host(),
      ),
    );
    await app.refreshKnowledge();
    const before = invokeMock.mock.calls.length;
    expect(app.knowledgePending).toBe(1);
    app.stop();
    await vi.advanceTimersByTimeAsync(10000);
    expect(invokeMock.mock.calls).toHaveLength(before);
  });
  it("should not configure optional AI before the backend has credentials and a model", async () => {
    const app = store();
    await app.loadKnowledgeSettings();
    expect(app.aiConfigured).toBe(false);
    await expect(
      app.updateKnowledgeSettings({ ai_enabled: true }),
    ).rejects.toThrow("请先在服务端配置 AI");
    expect(
      invokeMock.mock.calls.some(
        ([command]) => command === "set_knowledge_settings",
      ),
    ).toBe(false);
  });
  it("should reject settings writes on a read-only LAN session", async () => {
    const app = store();
    app.knowledgeSettings = { ...configuration, can_configure: false };
    await expect(
      app.updateKnowledgeSettings({ online_enabled: false }),
    ).rejects.toThrow("当前连接不允许");
    expect(invokeMock).not.toHaveBeenCalled();
  });
  it("should preserve the accepted settings when the server refuses a change", async () => {
    const app = store();
    app.knowledgeSettings = { ...configuration };
    invokeMock.mockRejectedValue(new Error("permission denied"));
    await expect(
      app.updateKnowledgeSettings({ online_enabled: false }),
    ).rejects.toThrow("permission denied");
    expect(app.knowledgeSettings.online_enabled).toBe(true);
  });
  it("should bind details to endpoint identity and distinguish reused process creation time", () => {
    const app = store();
    const first = port();
    app.entries = [first];
    app.openDetail("endpoint", first);
    expect(app.detailEntry).toEqual(first);
    app.closeDetail();
    expect(app.detailEntry).toBeNull();
    app.entries = [
      first,
      port({ local_port: 3001, process_created_at: "later" }),
    ];
    app.openDetail("endpoint", first);
    expect(app.selectedProcessEntries).toEqual([first]);
  });
  it("should recover knowledge configuration after a permission or transport error", async () => {
    const app = store();
    invokeMock.mockRejectedValueOnce(new Error("configuration unavailable"));
    await app.loadKnowledgeSettings();
    expect(app.knowledgeError).toBe("configuration unavailable");
    await app.loadKnowledgeSettings();
    expect(app.knowledgeError).toBeNull();
    expect(app.knowledgeSettings).toEqual(configuration);
  });
  it("should save permitted settings and refresh existing profiles explicitly", async () => {
    const app = store();
    app.knowledgeSettings = { ...configuration, ai_configured: true };
    app.entries = [port({ service_profile_ids: ["workload"] })];
    invokeMock.mockImplementation(
      (command: string, args?: Record<string, unknown>) => {
        if (command === "set_knowledge_settings")
          return Promise.resolve({
            ...configuration,
            ...(args?.settings as object),
            ai_configured: true,
          });
        if (command === "get_service_profiles")
          return Promise.resolve(result([profile()]));
        return Promise.resolve(host());
      },
    );
    await app.updateKnowledgeSettings({
      online_enabled: false,
      reverse_dns_enabled: false,
      ai_enabled: true,
    });
    expect(invokeMock).toHaveBeenCalledWith("set_knowledge_settings", {
      settings: {
        online_enabled: false,
        reverse_dns_enabled: false,
        ai_enabled: true,
      },
    });
    expect(invokeMock).toHaveBeenCalledWith("get_service_profiles", {
      profileIds: ["workload"],
      refresh: true,
    });
    expect(app.knowledgeSettings.ai_enabled).toBe(true);
  });
  it("should discard a hostname lookup from an earlier scan generation", async () => {
    let release: (value: ReturnType<typeof host>) => void = () => {};
    let first = true;
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_host_context" && first) {
        first = false;
        return new Promise<ReturnType<typeof host>>((resolve) => {
          release = resolve;
        });
      }
      if (command === "scan_all_ports") return Promise.resolve(scan([]));
      return Promise.resolve(host());
    });
    const app = store();
    const old = app.loadHostContext("203.0.113.1");
    await app.refresh();
    release(host({ address: "203.0.113.1", hostname: "old.example" }));
    await old;
    expect(app.hostContexts.has("203.0.113.1")).toBe(false);
  });
  it("should report hostname lookup failure without replacing the selected endpoint", async () => {
    const app = store();
    const selected = port();
    app.entries = [selected];
    app.openDetail("endpoint", selected);
    invokeMock.mockRejectedValue(new Error("DNS timeout"));
    await expect(app.loadHostContext("203.0.113.1")).resolves.toBeNull();
    expect(app.knowledgeError).toBe("DNS timeout");
    expect(app.detailEntry).toEqual(selected);
  });
  it("should recheck a former local address immediately when the latest scan changes the host role", async () => {
    const app = store();
    let observed = ["10.0.0.8"];
    const address = "10.0.0.8";
    invokeMock.mockImplementation(
      (command: string, args?: Record<string, unknown>) => {
        if (command === "get_host_context") {
          const requested = args?.address as string | undefined;
          return Promise.resolve(
            requested
              ? host({
                  address: requested,
                  kind: "private",
                  is_local: observed.includes(requested),
                  machine_name: observed.includes(requested) ? "scanner" : null,
                  hostname: observed.includes(requested)
                    ? "scanner"
                    : "former-local-peer",
                  hostname_source: observed.includes(requested)
                    ? "system"
                    : "reverse_dns",
                  observed_addresses: observed.includes(requested)
                    ? observed
                    : [],
                })
              : host({
                  address: "local",
                  hostname: "scanner",
                  machine_name: "scanner",
                  observed_addresses: observed,
                }),
          );
        }
        return Promise.resolve(result());
      },
    );
    app.entries = [port({ local_address: address })];
    await app.refreshKnowledge();
    expect(app.hostContexts.get(address)?.is_local).toBe(true);
    observed = ["10.0.0.9"];
    app.entries = [
      port({
        local_address: "10.0.0.9",
        state: "Established",
        remote_address: address,
        remote_port: 443,
      }),
    ];
    await app.refreshKnowledge();
    expect(app.hostContexts.get(address)?.is_local).toBe(false);
    expect(app.displayFor(app.entries[0]!).remoteHost).toBe(
      "former-local-peer",
    );
  });
  it("should expire ready peer DNS after sixty local seconds even with a future server timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
    const app = store();
    const peer = "198.51.100.1";
    let lookup = 0;
    invokeMock.mockImplementation(
      (command: string, args?: Record<string, unknown>) => {
        if (command === "get_host_context") {
          const address = args?.address as string | undefined;
          if (address === peer) {
            lookup++;
            return Promise.resolve(
              host({
                address: peer,
                is_local: false,
                kind: "public",
                machine_name: null,
                hostname: "peer-" + lookup,
                hostname_source: "reverse_dns",
                resolved_at: "2099-01-01T00:00:00Z",
                observed_addresses: [],
              }),
            );
          }
          return Promise.resolve(
            host({
              address: address ?? "local",
              observed_addresses: ["127.0.0.1"],
            }),
          );
        }
        return Promise.resolve(result());
      },
    );
    app.entries = [
      port({ state: "Established", remote_address: peer, remote_port: 443 }),
    ];
    await app.refreshKnowledge();
    expect(lookup).toBe(1);
    vi.setSystemTime(new Date("2026-10-17T00:00:59.999Z"));
    await app.refreshKnowledge();
    expect(lookup).toBe(1);
    vi.setSystemTime(new Date("2026-10-17T00:01:00.001Z"));
    await app.refreshKnowledge();
    expect(lookup).toBe(2);
    expect(app.displayFor(app.entries[0]!).remoteHost).toBe("peer-2");
  });
  it("should invalidate an old local hostname even beyond the automatic lookup budget", async () => {
    const app = store();
    const previous = "10.0.0.8",
      current = "10.0.0.9";
    let observed = [previous];
    invokeMock.mockImplementation(
      (command: string, args?: Record<string, unknown>) => {
        if (command === "get_host_context") {
          const address = args?.address as string | undefined;
          return Promise.resolve(
            host({
              address: address ?? "local",
              kind: address ? "private" : "local",
              is_local: address ? observed.includes(address) : true,
              machine_name:
                !address || observed.includes(address) ? "scanner" : null,
              hostname:
                !address || observed.includes(address)
                  ? "old-local-machine"
                  : "peer",
              hostname_source:
                !address || observed.includes(address)
                  ? "system"
                  : "reverse_dns",
              observed_addresses: observed,
            }),
          );
        }
        return Promise.resolve(result());
      },
    );
    app.entries = [port({ local_address: previous })];
    await app.refreshKnowledge();
    expect(app.hostContexts.get(previous)?.is_local).toBe(true);
    observed = [current];
    app.entries = Array.from({ length: 130 }, (_, index) =>
      port({
        pid: index + 100,
        local_address: current,
        state: "Established",
        remote_address: "203.0.113." + (index + 1),
        remote_port: 443,
      }),
    );
    app.entries.push(
      port({
        pid: 999,
        local_address: current,
        state: "Established",
        remote_address: previous,
        remote_port: 443,
      }),
    );
    await app.refreshKnowledge();
    expect(
      invokeMock.mock.calls.filter(
        ([command, args]) =>
          command === "get_host_context" && args?.address === previous,
      ),
    ).toHaveLength(1);
    expect(app.hostContexts.has(previous)).toBe(false);
    expect(app.displayFor(app.entries.at(-1)!).remoteHost).toBe("");
  });
  it("should receive ready public knowledge after more than thirty seconds of queued polling", async () => {
    vi.useFakeTimers();
    const startedAt = Date.now();
    invokeMock.mockImplementation((command: string) => {
      if (command === "get_service_profiles") {
        const ready = Date.now() - startedAt >= 45_000;
        return Promise.resolve(
          result(
            [
              profile({
                enrichment_status: ready ? "ready" : "queued",
                software_summary: ready
                  ? "Slow public metadata and AI completed"
                  : null,
              }),
            ],
            ready ? 0 : 1,
          ),
        );
      }
      return Promise.resolve(host());
    });
    const app = store();
    app.entries = [port({ service_profile_ids: ["workload"] })];
    await app.refreshKnowledge();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(app.knowledgePending).toBe(1);
    expect(app.serviceProfiles.get("workload")?.enrichment_status).toBe(
      "queued",
    );
    await vi.advanceTimersByTimeAsync(15_000);
    expect(app.knowledgePending).toBe(0);
    expect(app.serviceProfiles.get("workload")?.software_summary).toBe(
      "Slow public metadata and AI completed",
    );
    expect(app.serviceProfiles.get("workload")?.enrichment_status).toBe(
      "ready",
    );
    const completed = invokeMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(invokeMock.mock.calls).toHaveLength(completed);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("should bound indefinitely queued polling to five minutes and allow an explicit refresh afterward", async () => {
    vi.useFakeTimers();
    let pending = true;
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(
        command === "get_service_profiles"
          ? result(
              [profile({ enrichment_status: pending ? "queued" : "ready" })],
              pending ? 1 : 0,
            )
          : host(),
      ),
    );
    const app = store();
    app.entries = [port({ service_profile_ids: ["workload"] })];
    await app.refreshKnowledge();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(
      invokeMock.mock.calls.filter(
        ([command]) => command === "get_service_profiles",
      ),
    ).toHaveLength(201);
    expect(app.knowledgePending).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    const bounded = invokeMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(invokeMock.mock.calls).toHaveLength(bounded);
    pending = false;
    await app.refreshKnowledge(true);
    expect(app.knowledgePending).toBe(0);
    expect(app.serviceProfiles.get("workload")?.enrichment_status).toBe(
      "ready",
    );
    app.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
