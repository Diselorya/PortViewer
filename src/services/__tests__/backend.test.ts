import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeWeb, openExternalUrl } from "../backend";
const { tauriInvokeMock } = vi.hoisted(() => ({ tauriInvokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriInvokeMock }));

beforeEach(() => window.history.replaceState({}, "", "/"));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  window.history.replaceState({}, "", "/");
  document.querySelector("base[data-transport-test]")?.remove();
});

describe("WebGUI transport", () => {
  it("loads the browser build identity from the same-origin API", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ productId: "com.portviewer.desktop" }), {
        status: 200,
      }),
    );

    await expect(invokeWeb("get_build_identity")).resolves.toEqual({
      productId: "com.portviewer.desktop",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `${window.location.origin}/api/v1/build-identity`,
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
  });

  it.each([
    ["/", "/api/v1/scan"],
    ["/?theme=dark#ports", "/api/v1/scan"],
    ["/portviewer/", "/portviewer/api/v1/scan"],
    ["/portviewer/?theme=dark#ports", "/portviewer/api/v1/scan"],
    ["/tools/ports/index.html?theme=dark#ports", "/tools/ports/api/v1/scan"],
  ])("should scan relative to the document at %s", async (page, expected) => {
    window.history.replaceState({}, "", page);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ entries: [] })));

    await expect(invokeWeb("scan_all_ports")).resolves.toEqual({ entries: [] });

    expect(fetchMock).toHaveBeenCalledWith(
      `${window.location.origin}${expected}`,
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
    );
  });

  it("should keep build identity under a subpath with query and hash", async () => {
    window.history.replaceState({}, "", "/portviewer/?mode=readonly#details");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ productVersion: "1" })));

    await invokeWeb("get_build_identity");

    expect(fetchMock).toHaveBeenCalledWith(
      `${window.location.origin}/portviewer/api/v1/build-identity`,
      expect.any(Object),
    );
  });

  it("should honor an explicit document base for proxy deployment", async () => {
    const base = document.createElement("base");
    base.dataset.transportTest = "true";
    base.href = "/tools/portviewer/";
    document.head.append(base);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));

    await invokeWeb("get_build_identity");

    expect(fetchMock).toHaveBeenCalledWith(
      `${window.location.origin}/tools/portviewer/api/v1/build-identity`,
      expect.any(Object),
    );
  });

  it("returns a bounded API error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "scan unavailable" }), {
        status: 503,
      }),
    );
    await expect(invokeWeb("scan_all_ports")).rejects.toThrow(
      "WebGUI API 503: scan unavailable",
    );
  });

  it("should limit an unstructured server error to 500 characters", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("x".repeat(800), { status: 502 }),
    );

    await expect(invokeWeb("scan_all_ports")).rejects.toMatchObject({
      message: `WebGUI API 502: ${"x".repeat(500)}`,
    });
  });

  it("should propagate network failures and clear the pending timeout", async () => {
    const clearTimeout = vi.spyOn(window, "clearTimeout");
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("offline"));

    await expect(invokeWeb("scan_all_ports")).rejects.toThrow("offline");

    expect(clearTimeout).toHaveBeenCalledOnce();
  });

  it("should abort a hung scan after 30 seconds", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, options) => {
      const signal = options?.signal;
      return new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () =>
          reject(new DOMException("request aborted", "AbortError")),
        );
      });
    });
    const request = expect(invokeWeb("scan_all_ports")).rejects.toMatchObject({
      name: "AbortError",
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await request;

    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not expose destructive desktop commands", async () => {
    await expect(invokeWeb("kill_process")).rejects.toThrow("只读模式");
    await expect(invokeWeb("restart_elevated")).rejects.toThrow("只读模式");
  });
});

describe("knowledge transport", () => {
  it("should send only profile IDs and public coordinates to the subpath API", async () => {
    window.history.replaceState({}, "", "/portviewer/");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    await invokeWeb("get_service_profiles", {
      profileIds: ["local:abc"],
      publicIds: [{ provider: "github", name: "owner/demo" }],
      refresh: true,
      process_path: "must-not-transmit",
      entries: [],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      window.location.origin + "/portviewer/api/v1/knowledge/profiles",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          profile_ids: ["local:abc"],
          public_ids: [{ provider: "github", name: "owner/demo" }],
          refresh: true,
        }),
      }),
    );
  });
  it("should encode IPv6 scope text as a query parameter", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    await invokeWeb("get_host_context", { address: "fe80::1%12" });
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      window.location.origin +
        "/api/v1/knowledge/host?address=fe80%3A%3A1%2512",
    );
  });
  it("should omit the address when loading scanner details", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    await invokeWeb("get_host_context");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      window.location.origin + "/api/v1/knowledge/host",
    );
  });
  it("should put knowledge settings through the authenticated same-origin transport", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("{}"));
    const settings = {
      online_enabled: false,
      ai_enabled: false,
      reverse_dns_enabled: true,
    };
    await invokeWeb("set_knowledge_settings", { settings });
    expect(fetchMock).toHaveBeenCalledWith(
      window.location.origin + "/api/v1/knowledge/settings",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify(settings),
        credentials: "same-origin",
      }),
    );
  });
  it("should expose a permission refusal without replacing it with success", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "local-only configuration" }), {
        status: 403,
      }),
    );
    await expect(
      invokeWeb("set_knowledge_settings", { settings: {} }),
    ).rejects.toThrow("WebGUI API 403: local-only configuration");
  });
});

describe("safe external browser opener", () => {
  it.each([
    "javascript:alert(1)",
    "file:///C:/Windows/cmd.exe",
    "https://user:password@example.test/",
    "https://example.test/\ncommand",
    "not a URL",
    "https://example.test/" + "x".repeat(2048),
  ])("should reject invalid or credential-bearing URL %s", async (value) => {
    tauriInvokeMock.mockReset();
    await expect(openExternalUrl(value)).rejects.toThrow();
    expect(tauriInvokeMock).not.toHaveBeenCalled();
  });
  it.each([
    "http://127.0.0.1:3000/",
    "https://192.168.1.50:8443/",
    "http://[::1]:8080/",
  ])(
    "should pass explicit local or LAN browser URL %s as one IPC argument",
    async (url) => {
      tauriInvokeMock.mockReset();
      tauriInvokeMock.mockResolvedValue(undefined);
      await openExternalUrl(url);
      expect(tauriInvokeMock).toHaveBeenCalledWith("open_external_url", {
        url,
      });
    },
  );
});

describe("native browser APIs", () => {
  it("should open a WebGUI link in a separate context without desktop IPC", async () => {
    vi.stubEnv("MODE", "production");
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    tauriInvokeMock.mockReset();
    await openExternalUrl("https://example.test/");
    expect(open).toHaveBeenCalledWith(
      "https://example.test/",
      "_blank",
      "noopener,noreferrer",
    );
    expect(tauriInvokeMock).not.toHaveBeenCalled();
  });
  it("should download the current browser export and release the object URL", async () => {
    let downloaded = "";
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      downloaded = this.download;
    });
    vi.mocked(URL.createObjectURL).mockClear();
    vi.mocked(URL.revokeObjectURL).mockClear();
    await expect(
      invokeWeb("save_export", {
        suggestedName: "current.csv",
        contents: "header\nrow",
        format: "csv",
      }),
    ).resolves.toBe("current.csv");
    expect(downloaded).toBe("current.csv");
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test");
  });
});
