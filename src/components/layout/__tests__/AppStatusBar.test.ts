import { beforeEach, describe, expect, it } from "vitest";
import { mount } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import AppStatusBar from "../AppStatusBar.vue";
import { useAppStore } from "../../../stores/app";

describe("attribution scan status", () => {
  beforeEach(() => {
    localStorage.clear();
    setActivePinia(createPinia());
  });
  it("reports incomplete attribution without presenting an endpoint scan error", () => {
    const store = useAppStore();
    store.attributionReports = [
      {
        resolver: "systemd",
        status: "Partial",
        matched_count: 1,
        message: "Unit metadata unavailable",
        elevation_may_help: false,
      },
    ];
    const wrapper = mount(AppStatusBar);
    expect(wrapper.get(".health").text()).toBe("归因不完整");
    expect(wrapper.get(".health").classes()).not.toContain("error");
    expect(wrapper.text()).toContain("总计 0");
    expect(
      wrapper
        .findAll("span")
        .some((span) =>
          span.attributes("title")?.includes("Unit metadata unavailable"),
        ),
    ).toBe(true);
  });
  it("keeps the attribution report explanation accessible in English", () => {
    const store = useAppStore();
    store.updateSettings({ language: "en-US" });
    store.attributionReports = [
      {
        resolver: "systemd",
        status: "Partial",
        matched_count: 0,
        message: "Check /proc visibility",
        elevation_may_help: true,
      },
    ];
    const wrapper = mount(AppStatusBar);
    expect(wrapper.get(".health").text()).toBe("Attribution incomplete");
    expect(
      wrapper
        .findAll("span")
        .some((span) =>
          span.attributes("title")?.includes("Check /proc visibility"),
        ),
    ).toBe(true);
  });
});
