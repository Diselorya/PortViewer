import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PortTable from "../PortTable.vue";
import { useAppStore } from "../../../stores/app";

const DataTableStub = {
  template: '<div class="data-table-stub"><slot name="empty"></slot></div>',
};
const ColumnStub = { template: "<div></div>" };

function render() {
  return mount(PortTable, {
    global: { stubs: { DataTable: DataTableStub, Column: ColumnStub } },
  });
}

describe("PortTable states", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.mocked(navigator.clipboard.writeText).mockReset();
  });

  it("reports clipboard rejection while copying scan diagnostics", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(
      new Error("NotAllowedError"),
    );
    const store = useAppStore();
    store.hasScanned = true;
    store.scanError = "Windows API 返回拒绝访问";
    const wrapper = render();

    await wrapper
      .findAll(".error-state button")
      .find((button) => button.text().includes("复制"))!
      .trigger("click");
    await flushPromises();

    expect(store.notification).toEqual({
      type: "error",
      text: "复制诊断信息失败：NotAllowedError",
    });
  });

  it("distinguishes a disabled startup scan from loading", () => {
    const store = useAppStore();
    const idle = render();
    expect(idle.text()).toContain("尚未扫描本机端口");
    store.isScanning = true;
    const loading = render();
    expect(loading.text()).toContain("正在读取本机 TCP/UDP 端点");
    expect(loading.get('[aria-busy="true"]')).toBeTruthy();
  });

  it("shows a persistent retry and diagnostic path for a total scan failure", () => {
    const store = useAppStore();
    store.hasScanned = true;
    store.scanError = "Windows API 返回拒绝访问";
    const wrapper = render();
    expect(wrapper.text()).toContain("无法读取本机端口");
    expect(wrapper.text()).toContain("Windows API 返回拒绝访问");
    expect(wrapper.text()).toContain("重新扫描");
    expect(wrapper.text()).toContain("复制诊断信息");
  });

  it("distinguishes a true empty scan from no search matches", () => {
    const store = useAppStore();
    store.hasScanned = true;
    const empty = render();
    expect(empty.text()).toContain("当前未发现 TCP/UDP 端点");

    store.entries = [
      {
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
        process_created_at: "now",
        process_status: "Available",
        process_status_message: null,
        attributions: [],
      },
    ];
    store.query = "missing";
    const noMatch = render();
    expect(noMatch.text()).toContain("没有符合当前条件的结果");
    expect(noMatch.text()).toContain("清除搜索与筛选");
  });
});
