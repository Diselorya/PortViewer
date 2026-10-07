import { afterEach, describe, expect, it, vi } from "vitest";
import { invokeWeb } from "../backend";

afterEach(() => vi.restoreAllMocks());

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
      "/api/v1/build-identity",
      expect.objectContaining({ method: "GET", credentials: "same-origin" }),
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

  it("does not expose destructive desktop commands", async () => {
    await expect(invokeWeb("kill_process")).rejects.toThrow("只读模式");
    await expect(invokeWeb("restart_elevated")).rejects.toThrow("只读模式");
  });
});
