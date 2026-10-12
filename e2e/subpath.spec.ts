import http from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";

const SELF_PORT = "18789";
const PREFIX = "/portviewer/";
let proxy: http.Server;
let proxyBase: string;

test.beforeAll(async () => {
  // Model a reverse proxy which strips the prefix without rewriting HTML/JS.
  // Requests escaping the application mount fail, reproducing the reported 404.
  proxy = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/portviewer") {
      response.writeHead(308, { Location: `${PREFIX}${url.search}` }).end();
      return;
    }
    if (!url.pathname.startsWith(PREFIX)) {
      response.writeHead(404).end("outside the application mount");
      return;
    }
    const headers = { ...request.headers, host: `127.0.0.1:${SELF_PORT}` };
    // Match the documented proxy_set_header Origin "". Module requests carry
    // the browser-facing Origin, whose port differs from the upstream Host.
    delete headers.origin;
    const upstream = http.request(
      {
        hostname: "127.0.0.1",
        port: Number(SELF_PORT),
        method: request.method,
        path: `${url.pathname.slice(PREFIX.length - 1)}${url.search}`,
        headers,
      },
      (incoming) => {
        response.writeHead(incoming.statusCode ?? 502, incoming.headers);
        incoming.pipe(response);
      },
    );
    upstream.setTimeout(15_000, () => upstream.destroy(new Error("timeout")));
    upstream.on("error", () => {
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end("upstream unavailable");
    });
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  });
  proxy.requestTimeout = 20_000;
  await new Promise<void>((resolve, reject) => {
    proxy.once("error", reject);
    proxy.listen(0, "127.0.0.1", resolve);
  });
  proxyBase = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  if (!proxy?.listening) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      proxy.closeAllConnections();
      reject(new Error("subpath proxy did not close within 5 seconds"));
    }, 5_000);
    proxy.close((error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    });
    proxy.closeAllConnections();
  });
});

for (const entry of ["/portviewer/", "/portviewer/?theme=dark#details"]) {
  test(`should load production assets, scan and details at ${entry}`, async ({
    page,
  }, testInfo) => {
    const pageErrors: string[] = [];
    const failedRequests: string[] = [];
    const requests: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    page.on("request", (request) => requests.push(request.url()));
    page.on("requestfailed", (request) =>
      failedRequests.push(`${request.url()}: ${request.failure()?.errorText}`),
    );
    page.on("response", (response) => {
      if (response.status() >= 400) {
        failedRequests.push(`${response.status()}: ${response.url()}`);
      }
    });
    await page.addInitScript(() => {
      localStorage.setItem(
        "portviewer.settings.v1",
        JSON.stringify({ refreshIntervalMs: 0 }),
      );
    });
    const identity = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
        "/portviewer/api/v1/build-identity",
    );
    const scan = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/portviewer/api/v1/scan",
      { timeout: 30_000 },
    );

    let identityResponse;
    let scanResponse;
    try {
      [, identityResponse, scanResponse] = await Promise.all([
        page.goto(`${proxyBase}${entry}`),
        identity.then((response) => {
          expect(response.status()).toBe(200);
          return response;
        }),
        scan,
      ]);
    } finally {
      await testInfo.attach("browser-network", {
        body: JSON.stringify({ requests, failedRequests, pageErrors }),
        contentType: "application/json",
      });
      if (!identityResponse || !scanResponse) {
        await page.screenshot({
          path: testInfo.outputPath("port-attribution.png"),
          fullPage: true,
        });
      }
    }
    await expect(page.locator('[aria-label="PortViewer"]')).toBeVisible();
    expect(identityResponse.status()).toBe(200);
    expect(scanResponse.status()).toBe(200);
    await page.getByRole("searchbox").fill(SELF_PORT);
    const row = page.locator("tbody tr", { hasText: SELF_PORT }).first();
    await expect(row).toBeVisible();
    await row.click();
    await expect(page.locator("aside.inspector")).toBeVisible();
    await expect(page.locator("aside.inspector")).toContainText(
      /portviewer-web/i,
    );

    const applicationRequests = requests
      .filter((url) => url.startsWith(proxyBase))
      .map((url) => new URL(url).pathname);
    expect(
      applicationRequests.some((url) => /\/assets\/.+\.js$/.test(url)),
    ).toBe(true);
    expect(
      applicationRequests.some((url) => /\/assets\/.+\.css$/.test(url)),
    ).toBe(true);
    expect(applicationRequests.every((url) => url.startsWith(PREFIX))).toBe(
      true,
    );
    expect(failedRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
    await page.screenshot({
      path: testInfo.outputPath("port-attribution.png"),
      fullPage: true,
    });
  });
}
