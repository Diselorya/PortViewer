import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ProcessInspector from "../ProcessInspector.vue";
import { useAppStore } from "../../stores/app";
import type { PortEntry } from "../../types/port";

function entry(patch: Partial<PortEntry> = {}): PortEntry {
  return {
    protocol: "Tcp",
    ip_version: "V6",
    local_address: "::1",
    local_port: 3000,
    remote_address: "2001:db8::1",
    remote_port: 443,
    state: "Established",
    pid: 42,
    process_name: "程序 node.exe",
    process_path: "C:\\Program Files\\程序 node.exe",
    process_created_at: "2026-08-23T00:00:00Z",
    process_status: "Available",
    process_status_message: null,
    attributions: [],
    ...patch,
  };
}

describe("ProcessInspector", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.mocked(navigator.clipboard.writeText).mockClear();
  });

  it("shows complete Unicode identity and all endpoints for the selected PID", () => {
    const selected = entry();
    const second = entry({
      protocol: "Udp",
      local_port: 53,
      remote_address: null,
      remote_port: null,
      state: null,
    });
    const store = useAppStore();
    store.entries = [selected, second, entry({ pid: 99 })];
    store.selectEntry(selected);
    const wrapper = mount(ProcessInspector);
    expect(wrapper.text()).toContain("程序 node.exe");
    expect(wrapper.text()).toContain("C:\\Program Files\\程序 node.exe");
    expect(wrapper.text()).toContain("2026-08-23T00:00:00Z");
    expect(wrapper.findAll(".endpoints > button")).toHaveLength(2);
    expect(wrapper.text()).toContain("[::1]:3000");
  });

  it("copies original path without truncation", async () => {
    const selected = entry();
    const store = useAppStore();
    store.entries = [selected];
    store.selectEntry(selected);
    const wrapper = mount(ProcessInspector);
    const pathButton = wrapper
      .findAll("button.copy-value")
      .find((button) => button.text() === selected.process_path)!;
    await pathButton.trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      selected.process_path,
    );
  });

  it("reports clipboard permission rejection without an unhandled error", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(
      new Error("NotAllowedError"),
    );
    const selected = entry();
    const store = useAppStore();
    store.entries = [selected];
    store.selectEntry(selected);
    const wrapper = mount(ProcessInspector);

    await wrapper
      .findAll("button.copy-value")
      .find((button) => button.text() === selected.process_path)!
      .trigger("click");
    await flushPromises();

    expect(store.notification).toEqual({
      type: "error",
      text: "复制路径失败：NotAllowedError",
    });
  });

  it("disables termination when identity is restricted or creation time is missing", () => {
    const selected = entry({
      process_status: "AccessDenied",
      process_created_at: null,
      process_path: null,
    });
    const store = useAppStore();
    store.entries = [selected];
    store.selectEntry(selected);
    const wrapper = mount(ProcessInspector);
    expect(wrapper.text()).toContain("访问受限");
    expect(
      wrapper.get("button.danger-text").attributes("disabled"),
    ).toBeDefined();
  });

  it("shows all workload candidates with confidence and evidence", () => {
    const selected = entry({
      attributions: [
        {
          kind: "DockerContainer",
          name: "api-1 · demo/api",
          description: "Docker 容器 · demo/api:1",
          confidence: "Exact",
          source: "本地 Docker Engine published port",
          facts: [{ label: "端口映射", value: "0.0.0.0:18000 → 8000/tcp" }],
        },
        {
          kind: "NodeApplication",
          name: "npm: dev · demo",
          description: "Node.js/npm 临时运行工作负载",
          confidence: "High",
          source: "Win32_Process",
          facts: [{ label: "npm script", value: "dev" }],
        },
      ],
    });
    const store = useAppStore();
    store.entries = [selected];
    store.selectEntry(selected);
    const wrapper = mount(ProcessInspector);

    expect(wrapper.findAll(".workload-card")).toHaveLength(2);
    expect(wrapper.text()).toContain("api-1 · demo/api");
    expect(wrapper.text()).toContain("npm: dev · demo");
    expect(wrapper.text()).toContain("精确");
    expect(wrapper.text()).toContain("0.0.0.0:18000 → 8000/tcp");
  });

  it("puts service purpose and project location first and copies evidence without truncation", async () => {
    const selected = entry({
      process_name: "python3",
      attributions: [
        {
          kind: "SystemdService",
          name: "inventory.service",
          description: "Warehouse inventory API",
          confidence: "Exact",
          source: "/proc/42/cgroup + systemctl show",
          facts: [
            { label: "服务名", value: "inventory.service" },
            { label: "运行模式", value: "uvicorn --reload" },
            { label: "项目路径", value: "/opt/仓库/inventory" },
          ],
        },
      ],
    });
    const store = useAppStore();
    store.entries = [selected];
    store.selectEntry(selected);
    const wrapper = mount(ProcessInspector);
    expect(wrapper.get("h2").text()).toBe("inventory.service");
    expect(wrapper.findAll("section")[0]?.classes()).toContain(
      "workload-section",
    );
    expect(wrapper.text()).toContain("Warehouse inventory API");
    expect(wrapper.text()).toContain("uvicorn --reload");
    await wrapper
      .findAll(".workload-card .copy-value")
      .find((button) => button.text() === "/opt/仓库/inventory")!
      .trigger("click");
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      "/opt/仓库/inventory",
    );
    await wrapper.get("footer button").trigger("click");
    const copied = vi.mocked(navigator.clipboard.writeText).mock.lastCall?.[0];
    expect(copied).toContain("Warehouse inventory API");
    expect(copied).toContain("运行模式: uvicorn --reload");
    expect(copied).toContain("项目路径: /opt/仓库/inventory");
    expect(copied).toContain("/proc/42/cgroup + systemctl show");
  });

  it("keeps endpoints whose PID is unknown separate and explains the attribution limit", () => {
    const selected = entry({
      pid: 0,
      process_name: null,
      process_path: null,
      process_created_at: null,
      process_status: "AccessDenied",
    });
    const store = useAppStore();
    store.entries = [selected, { ...selected, local_port: 4000 }];
    store.selectEntry(selected);
    const wrapper = mount(ProcessInspector);
    expect(wrapper.get("h2").text()).toBe("归属未知");
    expect(wrapper.text()).toContain("没有取得对应 PID 的证据");
    expect(wrapper.text()).not.toContain("系统进程");
    expect(wrapper.findAll(".endpoints > button")).toHaveLength(1);
    expect(
      wrapper.get("button.danger-text").attributes("disabled"),
    ).toBeDefined();
  });

  it("does not recategorize Windows System entries as missing PID evidence", () => {
    const selected = entry({
      pid: 0,
      process_name: "System",
      process_status: "System",
    });
    const store = useAppStore();
    store.entries = [selected];
    store.selectEntry(selected);
    const wrapper = mount(ProcessInspector);
    expect(wrapper.get("h2").text()).toBe("System");
    expect(wrapper.text()).toContain("系统进程");
    expect(wrapper.text()).not.toContain("没有取得对应 PID 的证据");
  });
});
