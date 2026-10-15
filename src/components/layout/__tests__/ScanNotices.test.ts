import { beforeEach, describe, expect, it } from "vitest";
import { createPinia, setActivePinia } from "pinia";
import { mount } from "@vue/test-utils";
import ScanNotices from "../ScanNotices.vue";
import { useAppStore } from "../../../stores/app";

describe("scan diagnostics footer", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });

  it("should keep the footer container present when there are no transient diagnostics", () => {
    const wrapper = mount(ScanNotices);
    expect(wrapper.get('[data-testid="scan-notices"]').element).toBeInstanceOf(
      HTMLElement,
    );
    expect(
      wrapper.get('[data-testid="scan-notices-toggle"]').attributes("disabled"),
    ).toBeDefined();
    expect(wrapper.find(".scan-notices-details").exists()).toBe(false);
  });

  it("should expand optional attribution diagnostics and collapse when the resolver recovers", async () => {
    const store = useAppStore(),
      wrapper = mount(ScanNotices);
    store.attributionReports = [
      {
        resolver: "Docker",
        status: "Partial",
        message: "docker.exe probe timed out (3000 ms)",
        matched_count: 0,
        elevation_may_help: false,
      },
    ];
    await wrapper.vm.$nextTick();
    await wrapper.get('[data-testid="scan-notices-toggle"]').trigger("click");
    expect(wrapper.get(".scan-notices-details").text()).toContain("3000 ms");
    expect(
      wrapper
        .get('[data-testid="scan-notices-toggle"]')
        .attributes("aria-expanded"),
    ).toBe("true");
    store.attributionReports = [];
    await wrapper.vm.$nextTick();
    expect(wrapper.find(".scan-notices-details").exists()).toBe(false);
    expect(
      wrapper
        .get('[data-testid="scan-notices-toggle"]')
        .attributes("aria-expanded"),
    ).toBe("false");
  });

  it("should expose the same diagnostic state in English after changing language", async () => {
    const store = useAppStore(),
      wrapper = mount(ScanNotices);
    store.attributionReports = [
      {
        resolver: "Docker",
        status: "Failed",
        message: "timeout",
        matched_count: 0,
        elevation_may_help: false,
      },
    ];
    store.updateSettings({ language: "en-US" });
    await wrapper.vm.$nextTick();
    expect(
      wrapper
        .get('[data-testid="scan-notices-toggle"]')
        .attributes("aria-label"),
    ).toBe("Show notice details");
    expect(wrapper.get(".scan-notices-summary").text()).toContain(
      "Some attribution resolvers are unavailable",
    );
  });
});
