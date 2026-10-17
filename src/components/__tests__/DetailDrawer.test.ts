import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { createPinia, setActivePinia } from "pinia";
import PrimeVue from "primevue/config";
import DetailDrawer from "../DetailDrawer.vue";
import { useAppStore } from "../../stores/app";
import { port, profile } from "../../domain/__tests__/workbenchFixtures";
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
let wrapper: VueWrapper | undefined;
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
  invokeMock.mockReset();
  invokeMock.mockResolvedValue(null);
  vi.mocked(navigator.clipboard.writeText).mockReset();
  vi.mocked(navigator.clipboard.writeText).mockResolvedValue(undefined);
});
afterEach(() => {
  wrapper?.unmount();
  wrapper = undefined;
  useAppStore().stop();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});
async function render(entry = port({ local_port: 12345 })) {
  const app = useAppStore();
  app.entries = [entry];
  app.openDetail("endpoint", entry);
  wrapper = mount(DetailDrawer, {
    attachTo: document.body,
    global: { plugins: [PrimeVue] },
  });
  await flushPromises();
  return app;
}
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const result = document.querySelector<T>(selector);
  if (!result) throw new Error("Missing element: " + selector);
  return result;
}

describe("service detail drawer", () => {
  it("should close when the user presses and releases on the outside mask", async () => {
    const app = await render();
    const mask = element(".p-dialog-mask");
    mask.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    mask.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await flushPromises();
    expect(app.selectedDetail).toBeNull();
  });
  it("should keep the drawer open when clicking its content", async () => {
    const app = await render();
    const content = element('[data-testid="detail-drawer"] .detail-context');
    content.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    content.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    content.click();
    await flushPromises();
    expect(app.selectedDetail?.kind).toBe("endpoint");
  });
  it("should not dismiss a drag that starts inside and ends on the mask", async () => {
    const app = await render();
    element('[data-testid="detail-drawer"] .detail-context').dispatchEvent(
      new MouseEvent("mousedown", { bubbles: true }),
    );
    element(".p-dialog-mask").dispatchEvent(
      new MouseEvent("mouseup", { bubbles: true }),
    );
    await flushPromises();
    expect(app.selectedDetail?.kind).toBe("endpoint");
  });
  it("should expose the composed custom-port address as a real HTTP trial anchor", async () => {
    await render();
    const link = element<HTMLAnchorElement>(
      ".detail-context .endpoint-address-link",
    );
    expect(link.getAttribute("href")).toBe("http://127.0.0.1:12345/");
    expect(link.textContent).toContain("127.0.0.1:12345");
    expect(link.target).toBe("_blank");
    expect(link.rel).toContain("noopener");
    link.click();
    await flushPromises();
    expect(invokeMock).toHaveBeenCalledWith("open_external_url", {
      url: "http://127.0.0.1:12345/",
    });
  });
  it("should show HTTPS for a known secure endpoint address", async () => {
    await render(port({ local_port: 443 }));
    expect(
      element<HTMLAnchorElement>(
        ".detail-context .endpoint-address-link",
      ).getAttribute("href"),
    ).toBe("https://127.0.0.1/");
    expect(
      element(".detail-context .endpoint-address-link").textContent,
    ).toContain("127.0.0.1:443");
  });
  it("should retain all associated endpoints in the virtual list instead of a hundred-item page", async () => {
    const selected = port();
    // jsdom has no measured scroll viewport. The browser test verifies actual final-item reachability.
    const app = await render(selected);
    app.entries = Array.from({ length: 201 }, (_, index) =>
      port({ local_port: index + 10000 }),
    );
    app.entries[0] = selected;
    app.openDetail("service", selected);
    await flushPromises();
    element<HTMLButtonElement>('[data-tab="connections"]').click();
    await flushPromises();
    expect(element('[data-tab="connections"] small').textContent).toBe("201");
    const scroller = wrapper!.findComponent({ name: "VirtualScroller" });
    expect(scroller.props("items")).toHaveLength(201);
    expect(document.querySelector(".connection-pages")).toBeNull();
  });
  it("should expose explicit HTTP and HTTPS trials for a custom TCP port without protocol evidence", async () => {
    await render();
    expect(document.querySelector(".primary-link")).toBeNull();
    const links = [
      ...document.querySelectorAll<HTMLAnchorElement>(
        ".endpoint-protocol-options a",
      ),
    ];
    expect(links.map((link) => link.href)).toEqual([
      "http://127.0.0.1:12345/",
      "https://127.0.0.1:12345/",
    ]);
    invokeMock.mockResolvedValue(undefined);
    links[1]!.click();
    await flushPromises();
    expect(invokeMock).toHaveBeenCalledWith("open_external_url", {
      url: "https://127.0.0.1:12345/",
    });
  });
  it("should not offer HTTP trials for UDP", async () => {
    await render(port({ protocol: "Udp", state: null, local_port: 12345 }));
    expect(document.querySelector(".endpoint-protocol-options")).toBeNull();
    expect(document.querySelector(".primary-link")).toBeNull();
    expect(document.querySelector(".endpoint-address-link")).toBeNull();
  });
  it("should switch evidence and connection tabs with keyboard navigation and copy the actual path", async () => {
    const app = await render();
    element('[data-tab="overview"]').dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
    );
    await flushPromises();
    expect(element('[data-tab="evidence"]').getAttribute("aria-selected")).toBe(
      "true",
    );
    element<HTMLButtonElement>(".copy-value.path").click();
    await flushPromises();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      app.entries[0]?.process_path,
    );
    element('[data-tab="evidence"]').dispatchEvent(
      new KeyboardEvent("keydown", { key: "End", bubbles: true }),
    );
    await flushPromises();
    expect(
      element('[data-tab="connections"]').getAttribute("aria-selected"),
    ).toBe("true");
    expect(element('[role="tabpanel"]').textContent).toContain("12345");
  });
  it("should close the drawer when its endpoint disappears from a fresh snapshot", async () => {
    const app = await render();
    expect(
      document.querySelector('[data-testid="detail-drawer"]'),
    ).not.toBeNull();
    app.entries = [];
    await flushPromises();
    expect(app.selectedDetail).toBeNull();
  });
  it.each(["candidate", "confirmed"] as const)(
    "should relate different processes only for confirmed workload identity (%s)",
    async (identity_match) => {
      const selected = port({ service_profile_ids: ["workload"] });
      const app = await render(selected);
      app.serviceProfiles = new Map([
        ["workload", profile({ identity_match })],
      ]);
      app.entries = [
        selected,
        port({ pid: 43, local_port: 3001, service_profile_ids: ["workload"] }),
        port({
          local_port: 3002,
          process_created_at: "reused",
          service_profile_ids: [],
        }),
      ];
      app.openDetail("service", selected);
      await flushPromises();
      element<HTMLButtonElement>('[data-tab="connections"]').click();
      await flushPromises();
      expect(document.querySelectorAll(".related-connection")).toHaveLength(
        identity_match === "confirmed" ? 2 : 1,
      );
    },
  );
});
