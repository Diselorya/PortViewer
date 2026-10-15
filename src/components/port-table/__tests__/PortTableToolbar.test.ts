import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import Toolbar from "../PortTableToolbar.vue";
import { useAppStore } from "../../../stores/app";
import type { PortEntry } from "../../../types/port";
import { FACET_FIELDS } from "../../../domain/portFacets";

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
    await wrapper.get('[data-testid="facet-option-Listen"]').setValue(true);
    expect(store.protocols).toEqual(["Tcp"]);
    expect(store.states).toEqual(["Listen"]);
    expect(store.viewEntries).toEqual([tcp]);
    expect(wrapper.text()).toContain("命中 1 条");
    await wrapper.get("button.clear-all-filters").trigger("click");
    expect(store.protocols).toEqual([]);
    expect(store.states).toEqual([]);
    expect(store.viewEntries).toHaveLength(2);
  });

  it("changes visible columns but refuses to hide the final column", async () => {
    const wrapper = mount(Toolbar);
    const store = useAppStore();
    const boxes = wrapper.findAll<HTMLInputElement>(
      '.columns-menu input[type="checkbox"]',
    );
    await boxes[0].setValue(false);
    expect(store.settings.visibleColumns).not.toContain("protocol");
    store.updateSettings({ visibleColumns: ["local_port"] });
    const remounted = mount(Toolbar);
    const localPortBox = remounted
      .findAll<HTMLInputElement>('.columns-menu input[type="checkbox"]')
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
    expect(wrapper.findAll("nav.querybar > details.menu")).toHaveLength(3);
  });

  it("should expose every finite field for filtering and grouping", () => {
    const wrapper = mount(Toolbar);
    for (const testid of ["facet-field", "group-by"]) {
      const values = wrapper
        .get(`[data-testid="${testid}"]`)
        .findAll("option")
        .map((option) => option.attributes("value"))
        .filter(Boolean);
      expect(values).toEqual([...FACET_FIELDS]);
    }
  });

  it("should combine multi-selected managers with protocol and state filters", async () => {
    const store = useAppStore();
    const docker = { ...tcp, service_manager: "Docker" as const };
    const systemd = {
      ...tcp,
      local_port: 5432,
      service_manager: "Systemd" as const,
    };
    store.entries = [docker, systemd, { ...udp, service_manager: "Docker" }];
    const wrapper = mount(Toolbar);
    await wrapper
      .get('[data-testid="facet-field"]')
      .setValue("service_manager");
    await wrapper.get('[data-testid="facet-option-Docker"]').setValue(true);
    await wrapper.get('[data-testid="facet-option-Systemd"]').setValue(true);
    await wrapper.get("button.chip").trigger("click");
    await wrapper.get('[data-testid="facet-field"]').setValue("state");
    await wrapper.get('[data-testid="facet-option-Listen"]').setValue(true);
    expect(store.viewEntries).toEqual([docker, systemd]);
    expect(store.activeFilterCount).toBe(4);
    await wrapper.get("button.clear-all-filters").trigger("click");
    expect(store.viewEntries).toHaveLength(3);
    expect(store.activeFilterCount).toBe(0);
  });

  it("should retain a selected address when it disappears from the scan", async () => {
    const store = useAppStore();
    store.entries = [tcp];
    const wrapper = mount(Toolbar);
    await wrapper.get('[data-testid="facet-field"]').setValue("local_address");
    await wrapper.get('[data-testid="facet-option-127.0.0.1"]').setValue(true);
    store.entries = [];
    await wrapper.vm.$nextTick();
    const selected = wrapper.get<HTMLInputElement>(
      '[data-testid="facet-option-127.0.0.1"]',
    );
    expect(selected.element.checked).toBe(true);
    expect(selected.element.closest("label")?.textContent).toContain("0");
    await wrapper
      .get(
        '[data-testid="active-filters"] button[data-facet-field="local_address"]',
      )
      .trigger("click");
    expect(store.activeFilterCount).toBe(0);
  });

  it("should change grouping independently from active filters and translate new controls", async () => {
    const store = useAppStore();
    store.entries = [tcp];
    const wrapper = mount(Toolbar);
    await wrapper.get('[data-testid="group-by"]').setValue("service_manager");
    expect(store.groupBy).toBe("service_manager");
    expect(store.activeFilterCount).toBe(0);
    store.updateSettings({ language: "en-US" });
    await wrapper.vm.$nextTick();
    expect(
      wrapper.get('[data-testid="facet-field"]').attributes("aria-label"),
    ).toBe("Filter field");
    expect(wrapper.get('[data-testid="group-by"]').text()).toContain(
      "Service manager",
    );
    await wrapper.get('[data-testid="group-by"]').setValue("");
    expect(store.groupBy).toBeNull();
  });
});
