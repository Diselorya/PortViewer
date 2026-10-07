import { beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import ConfirmKillDialog from "../ConfirmKillDialog.vue";
import { useAppStore } from "../../../stores/app";
import type { PortEntry } from "../../../types/port";

const target: PortEntry = {
  protocol: "Tcp",
  ip_version: "V4",
  local_address: "0.0.0.0",
  local_port: 3000,
  remote_address: null,
  remote_port: null,
  state: "Listen",
  pid: 42,
  process_name: "node.exe",
  process_path: "C:\\Program Files\\node.exe",
  process_created_at: "2026-08-23T00:00:00Z",
  process_status: "Available",
  process_status_message: null,
  attributions: [],
};
const DialogStub = {
  template:
    '<section><slot></slot><footer><slot name="footer"></slot></footer></section>',
};

describe("ConfirmKillDialog", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
    vi.mocked(navigator.clipboard.writeText).mockReset();
  });

  it("keeps the confirmed identity stable when the live selection changes", () => {
    const other = {
      ...target,
      pid: 99,
      process_name: "other.exe",
      process_path: "C:\\other.exe",
      process_created_at: "2026-08-23T00:01:00Z",
    };
    const store = useAppStore();
    store.entries = [target, { ...target, local_port: 3001 }, other];
    store.selectEntry(target);
    store.openKill();
    store.selectEntry(other);

    const wrapper = mount(ConfirmKillDialog, {
      global: { stubs: { Dialog: DialogStub } },
    });

    expect(wrapper.text()).toContain("node.exe");
    expect(wrapper.text()).toContain("2 个网络端点");
    expect(wrapper.text()).not.toContain("other.exe");
  });

  it("reports clipboard rejection while copying a kill error", async () => {
    vi.mocked(navigator.clipboard.writeText).mockRejectedValueOnce(
      new Error("NotAllowedError"),
    );
    const store = useAppStore();
    store.entries = [target];
    store.selectEntry(target);
    store.openKill();
    store.killError = "权限不足";
    const wrapper = mount(ConfirmKillDialog, {
      global: { stubs: { Dialog: DialogStub } },
    });

    await wrapper.get(".inline-error button").trigger("click");
    await flushPromises();

    expect(store.notification).toEqual({
      type: "error",
      text: "复制错误信息失败：NotAllowedError",
    });
  });

  it("shows immutable identity, endpoint impact and irreversible warning", () => {
    const store = useAppStore();
    store.entries = [target, { ...target, local_port: 3001 }];
    store.selectEntry(target);
    store.openKill();
    const wrapper = mount(ConfirmKillDialog, {
      global: { stubs: { Dialog: DialogStub } },
    });
    expect(wrapper.text()).toContain("node.exe");
    expect(wrapper.text()).toContain("42");
    expect(wrapper.text()).toContain("C:\\Program Files\\node.exe");
    expect(wrapper.text()).toContain("2026-08-23T00:00:00Z");
    expect(wrapper.text()).toContain("2 个网络端点");
    expect(wrapper.text()).toContain("未保存的数据可能丢失");
  });

  it("places initial focus intent on cancel instead of the destructive action", () => {
    const store = useAppStore();
    store.entries = [target];
    store.selectEntry(target);
    const wrapper = mount(ConfirmKillDialog, {
      global: { stubs: { Dialog: DialogStub } },
    });
    const buttons = wrapper.findAll("footer button");
    expect(buttons[0].text()).toBe("取消");
    expect(buttons[0].attributes("autofocus")).toBeDefined();
    expect(buttons[1].text()).toBe("终止进程");
    expect(buttons[1].attributes("autofocus")).toBeUndefined();
  });
});
