import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import AboutDialog from "../AboutDialog.vue";
import { useAppStore } from "../../../stores/app";
import type { PortEntry } from "../../../types/port";

const DialogStub = {
  template:
    '<section><slot></slot><footer><slot name="footer"></slot></footer></section>',
};

function entry(patch: Partial<PortEntry> = {}): PortEntry {
  return {
    protocol: "Tcp",
    ip_version: "V6",
    local_address: "::1",
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

function render() {
  return mount(AboutDialog, {
    global: { stubs: { Dialog: DialogStub } },
  });
}

describe("AboutDialog", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.mocked(navigator.clipboard.writeText).mockReset();
  });

  it("shows a privacy-safe diagnostic summary with scan and count context", () => {
    const store = useAppStore();
    store.entries = [
      entry(),
      entry({
        pid: 99,
        process_name: null,
        process_path: null,
        process_status: "AccessDenied",
      }),
    ];
    store.totalCount = 2;
    store.query = "node";
    store.scanScope = "V6 Tcp 完整 · V6 Udp 完整";
    store.scannedAt = "2026-08-23T00:00:00Z";
    store.scanDurationMs = 17;
    store.scanIssues = ["IPv4 UDP 扫描失败"];

    const text = render().text();

    expect(text).toContain("PortViewer 1.0.0");
    expect(text).toContain("扫描范围: V6 Tcp 完整 · V6 Udp 完整");
    expect(text).toContain("最新成功时间: 2026-08-23T00:00:00Z");
    expect(text).toContain("扫描耗时: 17 ms");
    expect(text).toContain("显示/命中/总计: 1/1/2");
    expect(text).toContain("权限受限条目: 1");
    expect(text).toContain("部分失败范围: 1");
    expect(text).toContain("应用默认不联网");
    expect(text).not.toContain("C:\\node.exe");
  });

  it("reports clipboard rejection while copying diagnostics", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(
      new Error("NotAllowedError"),
    );
    const store = useAppStore();
    const wrapper = render();

    await wrapper
      .findAll("footer button")
      .find((button) => button.text() === "复制诊断摘要")!
      .trigger("click");
    await flushPromises();

    expect(store.notification).toEqual({
      type: "error",
      text: "复制诊断摘要失败：NotAllowedError",
    });
  });
});
