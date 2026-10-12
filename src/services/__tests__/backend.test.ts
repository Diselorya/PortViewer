import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invokeWeb } from "../backend";

beforeEach(() => window.history.replaceState({}, "", "/"));
afterEach(() => {
  vi.restoreAllMocks();
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
