import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import { defineComponent, h } from "vue";
import Toolbar from "../PortTableToolbar.vue";
import { useAppStore } from "../../../stores/app";
import { FACET_FIELDS } from "../../../domain/portFacets";
import { port } from "../../../domain/__tests__/workbenchFixtures";
const tcp = port(),
  udp = port({ protocol: "Udp", local_port: 53, state: null });
let wrappers: VueWrapper[] = [];
// jsdom has no layout viewport. Browser tests cover the real scrolling behavior.
const VirtualScrollerStub = defineComponent({
  props: ["items"],
  setup(props, { slots }) {
    return () =>
      h(
        "div",
        props.items?.map((item: unknown) => slots.item?.({ item })),
      );
  },
});
function render() {
  const wrapper = mount(Toolbar, {
    global: { stubs: { VirtualScroller: VirtualScrollerStub } },
  });
  wrappers.push(wrapper);
  return wrapper;
}
async function open(wrapper: VueWrapper, panel: string) {
  await wrapper.get('[data-panel-trigger="' + panel + '"]').trigger("click");
}
async function chooseFilter(wrapper: VueWrapper, field: string, value: string) {
  await wrapper.get('[data-testid="facet-field"]').setValue(field);
  await wrapper
    .get('[data-testid="facet-option-' + value + '"]')
    .setValue(true);
}

describe("PortTableToolbar", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    localStorage.clear();
    setActivePinia(createPinia());
    wrappers = [];
  });
  afterEach(() => {
    for (const wrapper of wrappers) wrapper.unmount();
    vi.unstubAllGlobals();
  });
  it("should combine filter conditions and clear them without changing sorts", async () => {
    const store = useAppStore();
    store.entries = [tcp, udp];
    store.setSortSpecs([{ field: "pid", order: -1 }]);
    const wrapper = render();
    await open(wrapper, "filters");
    await chooseFilter(wrapper, "protocol", "Tcp");
    await chooseFilter(wrapper, "state", "Listen");
    expect(store.viewEntries).toEqual([tcp]);
    expect(store.activeFilterCount).toBe(2);
    expect(wrapper.text()).toContain("命中 1 条");
    await wrapper.get("button.clear-all-filters").trigger("click");
    expect(store.activeFilterCount).toBe(0);
    expect(store.viewEntries).toHaveLength(2);
    expect(store.sortSpecs).toEqual([{ field: "pid", order: -1 }]);
  });
  it("should switch outer conditions and inner multi-value conditions independently", async () => {
    const store = useAppStore();
    store.entries = [tcp, udp];
    const wrapper = render();
    await open(wrapper, "filters");
    await chooseFilter(wrapper, "protocol", "Tcp");
    await chooseFilter(wrapper, "protocol", "Udp");
    await chooseFilter(wrapper, "state", "Listen");
    expect(store.viewEntries).toEqual([tcp]);
    expect(
      wrapper.get<HTMLSelectElement>('[data-condition-field="protocol"]')
        .element.value,
    ).toBe("any");
    await wrapper.get('[data-condition-field="protocol"]').setValue("all");
    expect(store.viewEntries).toEqual([]);
    await wrapper.get('[data-testid="condition-group-mode"]').setValue("any");
    expect(store.viewEntries).toEqual([tcp]);
    await wrapper.get('[data-condition-field="protocol"]').setValue("any");
    expect(store.viewEntries).toEqual([tcp, udp]);
    expect(store.settings).toMatchObject({
      filterMode: "any",
      filterFieldModes: { protocol: "any" },
    });
  });
  it("should preserve any semantics for multiple states when no inner mode is configured", async () => {
    const established = port({ local_port: 8081, state: "Established" });
    const store = useAppStore();
    store.entries = [tcp, established, udp];
    const wrapper = render();
    await open(wrapper, "filters");
    await chooseFilter(wrapper, "state", "Listen");
    await chooseFilter(wrapper, "state", "Established");
    expect(
      wrapper.get<HTMLSelectElement>('[data-condition-field="state"]').element
        .value,
    ).toBe("any");
    expect(store.viewEntries).toEqual([tcp, established]);
  });
  it("should show only the requested floating panel and close it with Escape", async () => {
    const wrapper = render();
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
    await open(wrapper, "filters");
    expect(wrapper.find('[data-testid="facet-field"]').exists()).toBe(true);
    await open(wrapper, "sort");
    expect(wrapper.find('[data-testid="facet-field"]').exists()).toBe(false);
    expect(wrapper.findAll('[role="dialog"]')).toHaveLength(1);
    await wrapper.get('[role="dialog"]').trigger("keydown", { key: "Escape" });
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });
  it("should expose every finite field for filtering and grouping", async () => {
    const wrapper = render();
    await open(wrapper, "filters");
    expect(
      wrapper
        .get('[data-testid="facet-field"]')
        .findAll("option")
        .map((option) => option.attributes("value")),
    ).toEqual([...FACET_FIELDS]);
    await open(wrapper, "group");
    expect(
      wrapper
        .get('[data-testid="group-by"]')
        .findAll("option")
        .map((option) => option.attributes("value"))
        .filter(Boolean),
    ).toEqual([...FACET_FIELDS]);
  });
  it("should combine selected managers with protocol and state conditions", async () => {
    const store = useAppStore();
    const docker = { ...tcp, service_manager: "Docker" as const },
      systemd = {
        ...tcp,
        local_port: 5432,
        service_manager: "Systemd" as const,
      };
    store.entries = [docker, systemd, { ...udp, service_manager: "Docker" }];
    const wrapper = render();
    await open(wrapper, "filters");
    await chooseFilter(wrapper, "service_manager", "Docker");
    await chooseFilter(wrapper, "service_manager", "Systemd");
    await chooseFilter(wrapper, "protocol", "Tcp");
    await chooseFilter(wrapper, "state", "Listen");
    expect(store.viewEntries).toEqual([docker, systemd]);
    expect(store.activeFilterCount).toBe(4);
  });
  it("should retain a selected address after it disappears from the scanner", async () => {
    const store = useAppStore();
    store.entries = [tcp];
    const wrapper = render();
    await open(wrapper, "filters");
    await chooseFilter(wrapper, "local_address", "127.0.0.1");
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
  it("should configure grouping without changing filters and translate its controls", async () => {
    const store = useAppStore();
    store.entries = [tcp];
    const wrapper = render();
    await open(wrapper, "group");
    await wrapper.get('[data-testid="group-by"]').setValue("service_manager");
    expect(store.groupBy).toBe("service_manager");
    expect(store.activeFilterCount).toBe(0);
    store.updateSettings({ language: "en-US" });
    await wrapper.vm.$nextTick();
    expect(wrapper.get('[data-testid="group-by"]').text()).toContain(
      "Service manager",
    );
    await wrapper.get('[data-testid="group-by"]').setValue("");
    expect(store.groupBy).toBeNull();
    await open(wrapper, "filters");
    expect(
      wrapper.get('[data-testid="facet-field"]').attributes("aria-label"),
    ).toBe("Filter field");
  });
  it("should add a new unused sort field and allow priority and direction changes", async () => {
    const store = useAppStore();
    const wrapper = render();
    await open(wrapper, "sort");
    await wrapper.get('[data-testid="add-sort"]').trigger("click");
    await wrapper.get('[data-testid="add-sort"]').trigger("click");
    expect(store.sortSpecs).toHaveLength(2);
    expect(new Set(store.sortSpecs.map((sort) => sort.field)).size).toBe(2);
    const second = wrapper.findAll('[data-testid="sort-rule"]')[1]!;
    const previous = [...store.sortSpecs];
    await second.findAll("select")[1]!.setValue("-1");
    expect(store.sortSpecs[1]?.order).toBe(-1);
    await second.findAll("button")[0]!.trigger("click");
    expect(store.sortSpecs[0]?.field).toBe(previous[1]?.field);
  });
  it("should prevent hiding the final visible column", async () => {
    const store = useAppStore();
    store.updateSettings({ visibleColumns: ["local_port"] });
    const wrapper = render();
    await open(wrapper, "fields");
    const input = wrapper.get<HTMLInputElement>(
      '[data-column-field="local_port"] input',
    );
    expect(input.element.checked).toBe(true);
    expect(input.attributes("disabled")).toBeDefined();
    await wrapper
      .get<HTMLInputElement>('[data-column-field="pid"] input')
      .setValue(true);
    expect(store.settings.visibleColumns).toEqual(["local_port", "pid"]);
    await input.setValue(false);
    expect(store.settings.visibleColumns).toEqual(["pid"]);
  });
  it("should reorder fields with keyboard-accessible move controls and emit auto fit", async () => {
    const store = useAppStore();
    const wrapper = render();
    await open(wrapper, "fields");
    const previous = [...store.settings.columnOrder];
    await wrapper
      .findAll("[data-column-field]")[1]!
      .findAll("button")[0]!
      .trigger("click");
    expect(store.settings.columnOrder.slice(0, 2)).toEqual([
      previous[1],
      previous[0],
    ]);
    await wrapper.get('[data-testid="auto-fit-columns"]').trigger("click");
    expect(wrapper.emitted("auto-fit")).toHaveLength(1);
  });
  it("should disable empty-view exports and emit group collapse without mutating filters", async () => {
    const store = useAppStore();
    const wrapper = render();
    await open(wrapper, "export");
    expect(
      wrapper
        .findAll(".export-panel button")
        .every((button) => button.attributes("disabled") !== undefined),
    ).toBe(true);
    store.setGroupBy("protocol");
    await open(wrapper, "group");
    const buttons = wrapper.findAll(".panel-button-row button");
    await buttons[1]!.trigger("click");
    expect(wrapper.emitted("group-expansion")?.[0]).toEqual([false]);
  });
  it("should add conditional coloring with an explicit finite-field condition", async () => {
    const store = useAppStore();
    const wrapper = render();
    await open(wrapper, "colors");
    await wrapper.get('[data-testid="add-color-rule"]').trigger("click");
    expect(store.settings.colorRules).toHaveLength(1);
    expect(wrapper.find('[data-testid="color-rules-panel"]').exists()).toBe(
      true,
    );
    expect(store.settings.colorRules[0]?.target.kind).toBe("row");
  });
});
