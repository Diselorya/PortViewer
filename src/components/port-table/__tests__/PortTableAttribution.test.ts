import {
  computed,
  defineComponent,
  h,
  inject,
  provide,
  type ComputedRef,
} from "vue";
import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PortTable from "../PortTable.vue";
import { useAppStore } from "../../../stores/app";
import type { PortEntry } from "../../../types/port";

const DataTableStub = defineComponent({
  props: ["value"],
  setup(props, { slots }) {
    provide(
      "entry",
      computed(() => props.value[0]),
    );
    return () => h("div", slots.default?.());
  },
});
const ColumnStub = defineComponent({
  props: ["header"],
  setup(props, { slots }) {
    const entry = inject<ComputedRef<PortEntry>>("entry")!;
    return () =>
      h("article", [
        h("header", props.header),
        slots.body?.({ data: entry.value }),
      ]);
  },
});
const entry: PortEntry = {
  protocol: "Tcp",
  ip_version: "V4",
  local_address: "0.0.0.0",
  local_port: 8080,
  remote_address: null,
  remote_port: null,
  state: "Listen",
  pid: 42,
  process_name: "docker-proxy",
  process_path: "/usr/bin/docker-proxy",
  process_created_at: "2026-10-13T00:00:00Z",
  process_status: "Available",
  process_status_message: null,
  attributions: [
    {
      kind: "DockerContainer",
      name: "warehouse-api",
      description: "仓库库存查询 API",
      confidence: "Exact",
      source: "Docker Engine published port",
      facts: [
        { label: "运行模式", value: "compose" },
        { label: "项目路径", value: "/srv/warehouse" },
      ],
    },
  ],
};
function render() {
  return mount(PortTable, {
    global: { stubs: { DataTable: DataTableStub, Column: ColumnStub } },
  });
}
describe("port workload summary", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });
  it("should separate the container name and purpose and open its full evidence", async () => {
    const store = useAppStore();
    store.hasScanned = true;
    store.entries = [entry];
    const wrapper = render();
    expect(wrapper.get(".service-name-action b").text()).toBe(
      "容器：warehouse-api",
    );
    expect(wrapper.get(".service-description").text()).toBe("仓库库存查询 API");
    await wrapper.get(".owner-cell").trigger("click");
    expect(store.selectedDetail?.kind).toBe("service");
    expect(store.detailEntry?.attributions[0]?.facts).toEqual(
      entry.attributions[0]?.facts,
    );
    expect(store.detailEntry?.process_name).toBe("docker-proxy");
  });
  it("keeps an unattributed Linux endpoint visible with an explicit unknown owner", () => {
    const store = useAppStore();
    store.hasScanned = true;
    store.entries = [
      {
        ...entry,
        pid: 0,
        process_name: null,
        process_path: null,
        process_status: "AccessDenied",
        attributions: [],
      },
    ];
    const wrapper = render();
    const owner = wrapper.get(".owner-cell");
    expect(wrapper.get(".service-name-action").text()).toContain("归属未知");
    expect(owner.text()).toContain("未获取");
    expect(store.entries[0]?.process_status).toBe("AccessDenied");
    expect(owner.text()).not.toContain("System");
  });
  it("states when purpose metadata is missing rather than inventing a project description", () => {
    const store = useAppStore();
    store.hasScanned = true;
    store.entries = [
      {
        ...entry,
        attributions: [{ ...entry.attributions[0]!, description: null }],
      },
    ];
    expect(render().get(".service-description").text()).toContain("用途未提供");
  });
});
