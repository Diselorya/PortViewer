import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import Toolbar from "../PortTableToolbar.vue";
import { useAppStore } from "../../../stores/app";
import type { PortEntry } from "../../../types/port";

const tcp: PortEntry = {
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
};
const udp: PortEntry = {
  ...tcp,
  protocol: "Udp",
  local_port: 53,
  state: null,
};

describe("PortTableToolbar", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("combines protocol and status controls and clears all active conditions", async () => {
    const wrapper = mount(Toolbar);
    const store = useAppStore();
    store.entries = [tcp, udp];
    await wrapper.get("button.chip").trigger("click");
    await wrapper.get("select").setValue("Listen");
    expect(store.protocols).toEqual(["Tcp"]);
    expect(store.states).toEqual(["Listen"]);
    expect(store.viewEntries).toEqual([tcp]);
    expect(wrapper.text()).toContain("命中 1 条");
    await wrapper.get("button.text-btn").trigger("click");
    expect(store.protocols).toEqual([]);
    expect(store.states).toEqual([]);
    expect(store.viewEntries).toHaveLength(2);
  });

  it("changes visible columns but refuses to hide the final column", async () => {
    const wrapper = mount(Toolbar);
    const store = useAppStore();
    const boxes = wrapper.findAll<HTMLInputElement>(
      '.menu-panel input[type="checkbox"]',
    );
    await boxes[0].setValue(false);
    expect(store.settings.visibleColumns).not.toContain("protocol");
    store.updateSettings({ visibleColumns: ["local_port"] });
    const remounted = mount(Toolbar);
    const localPortBox = remounted
      .findAll<HTMLInputElement>('.menu-panel input[type="checkbox"]')
      .find((box) => box.element.checked);
    await localPortBox!.setValue(false);
    expect(store.settings.visibleColumns).toEqual(["local_port"]);
  });

  it("disables export actions when the current view is empty", () => {
    const wrapper = mount(Toolbar);
    const exportButtons = wrapper.findAll(".menu-panel.export button");
    expect(exportButtons).toHaveLength(2);
    expect(
      exportButtons.every(
        (button) => button.attributes("disabled") !== undefined,
      ),
    ).toBe(true);
  });

  it("keeps column and export menus outside the narrow-screen scroll region", () => {
    const wrapper = mount(Toolbar);
    const scrollRegion = wrapper.get(".filter-scroll");
    expect(scrollRegion.findAll("details.menu")).toHaveLength(0);
    expect(wrapper.findAll("nav.querybar > details.menu")).toHaveLength(2);
  });
});
