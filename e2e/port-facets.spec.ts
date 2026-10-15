import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { PortEntry, ScanResult } from "../src/types/port.js";

function endpoint(patch: Partial<PortEntry> = {}): PortEntry {
  return {
    protocol: "Tcp",
    ip_version: "V4",
    local_address: "127.0.0.1",
    local_port: 8080,
    remote_address: null,
    remote_port: null,
    state: "Listen",
    pid: 42,
    process_name: "fixture-api",
    process_path: "/srv/fixture/api",
    process_created_at: "2026-10-16T00:00:00Z",
    process_status: "Available",
    process_status_message: null,
    service_manager: "Docker",
    attributions: [],
    ...patch,
  };
}
function snapshot(
  entries: PortEntry[],
  patch: Partial<ScanResult> = {},
): ScanResult {
  return {
    entries,
    total_count: entries.length,
    timestamp: "2026-10-16T00:00:00Z",
    scan_duration_ms: 4,
    is_partial: false,
    scopes: [],
    warnings: [],
    attribution_reports: [],
    attribution_deferred: false,
    ...patch,
  };
}
async function load(page: Page, scan: () => ScanResult) {
  await page.addInitScript(() =>
    localStorage.setItem(
      "portviewer.settings.v1",
      JSON.stringify({
        schemaVersion: 3,
        language: "en-US",
        refreshIntervalMs: 0,
        maxEntries: 100000,
        visibleColumns: [
          "protocol",
          "local_address",
          "local_port",
          "role",
          "state",
          "service_manager",
          "pid",
        ],
      }),
    ),
  );
  await page.route("**/api/v1/scan", (route) =>
    route.fulfill({ json: scan() }),
  );
  await page.goto("/");
  await expect(page.locator(".result-count")).toContainText(
    String(scan().entries.length),
    { timeout: 30_000 },
  );
}
async function chooseFacet(page: Page, field: string, value: string) {
  await page.getByTestId("facet-field").selectOption(field);
  const menu = page.getByTestId("facet-values");
  if (!(await menu.getAttribute("open"))) await menu.locator("summary").click();
  await page.getByTestId(`facet-option-${value}`).check();
  await menu.locator("summary").click();
}
async function tableGeometry(page: Page) {
  return page.getByTestId("port-table").evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { top: box.top, height: box.height };
  });
}

test("should keep table geometry unchanged while transient diagnostics appear, expand and disappear", async ({
  page,
}) => {
  let current = snapshot([endpoint()]);
  await load(page, () => current);
  await expect(page.locator("tbody .port-number")).toHaveText("8080");
  const initial = await tableGeometry(page);
  current = snapshot([endpoint()], {
    attribution_reports: [
      {
        resolver: "Docker",
        status: "Partial",
        matched_count: 0,
        message:
          "docker.exe probe timed out (3000 ms). Basic port enumeration remains available.",
        elevation_may_help: false,
      },
      {
        resolver: "Windows Services / NSSM",
        status: "Partial",
        matched_count: 0,
        message: "2 processes denied access. Administrator mode may help.",
        elevation_may_help: true,
      },
    ],
  });
  await page.getByRole("button", { name: "Refresh · F5" }).click();
  await expect(page.getByTestId("scan-notices-toggle")).toBeEnabled();
  expect(await tableGeometry(page)).toEqual(initial);
  const tableBottom = initial.top + initial.height;
  expect(
    (await page.getByTestId("scan-notices").boundingBox())!.y,
  ).toBeGreaterThanOrEqual(tableBottom);
  await page.getByTestId("scan-notices-toggle").click();
  await expect(page.locator(".scan-notices-details")).toContainText("3000 ms");
  expect(await tableGeometry(page)).toEqual(initial);
  current = snapshot([endpoint()]);
  await page.getByRole("button", { name: "Refresh · F5" }).click();
  await expect(page.getByTestId("scan-notices-toggle")).toBeDisabled();
  await expect(page.locator(".scan-notices-details")).toHaveCount(0);
  expect(await tableGeometry(page)).toEqual(initial);
});

test("should sort independent address, port and role columns by their displayed values", async ({
  page,
}) => {
  const rows = [
    endpoint({ pid: 1, local_address: "192.0.2.20", local_port: 443 }),
    endpoint({ pid: 2, local_address: "192.0.2.3", local_port: 80 }),
    endpoint({
      pid: 3,
      local_address: "192.0.2.1",
      local_port: 65535,
      state: "SynSent",
      remote_address: "198.51.100.1",
      remote_port: 443,
    }),
  ];
  await load(page, () => snapshot(rows));
  await expect(
    page.getByRole("columnheader", { name: "Listening address", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Local port", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("columnheader", { name: "Local port", exact: true })
    .click();
  await expect(page.locator("tbody .port-number")).toHaveText([
    "80",
    "443",
    "65535",
  ]);
  await page
    .getByRole("columnheader", { name: "Local port", exact: false })
    .click();
  await expect(page.locator("tbody .port-number")).toHaveText([
    "65535",
    "443",
    "80",
  ]);
  // A non-meta click replaces the active sort, so address and role are verified independently.
  await page
    .getByRole("columnheader", { name: "Listening address", exact: true })
    .click();
  await expect(page.locator("tbody .endpoint-cell b")).toHaveText([
    "192.0.2.1",
    "192.0.2.3",
    "192.0.2.20",
  ]);
  await page
    .getByRole("columnheader", { name: "Direction / role", exact: true })
    .click();
  await expect(page.locator("tbody .direction-cell").first()).toHaveClass(
    /role-listen/,
  );
});

test("should combine filters, retain stale selected values and clear them without losing the list", async ({
  page,
}) => {
  let current = snapshot([
    endpoint({ pid: 1 }),
    endpoint({
      pid: 2,
      service_manager: "Systemd",
      local_address: "192.0.2.1",
      local_port: 5432,
    }),
    endpoint({ pid: 3, protocol: "Udp", state: null, local_port: 53 }),
  ]);
  await load(page, () => current);
  await chooseFacet(page, "service_manager", "Docker");
  await chooseFacet(page, "protocol", "Tcp");
  await chooseFacet(page, "local_address", "127.0.0.1");
  await expect(page.locator(".result-count")).toHaveText("1 matches");
  current = snapshot([
    endpoint({
      pid: 2,
      service_manager: "Systemd",
      local_address: "192.0.2.1",
      local_port: 5432,
    }),
  ]);
  await page.getByRole("button", { name: "Refresh · F5" }).click();
  await expect(page.locator(".result-count")).toHaveText("0 matches");
  await page.getByTestId("facet-field").selectOption("local_address");
  await page.getByTestId("facet-values").locator("summary").click();
  await expect(page.getByTestId("facet-option-127.0.0.1")).toBeChecked();
  await expect(
    page.getByTestId("facet-option-127.0.0.1").locator(".."),
  ).toContainText("0");
  await page.getByTestId("facet-values").locator("summary").click();
  await page.locator("button.clear-all-filters").click();
  await expect(page.locator(".result-count")).toHaveText("1 matches");
  await expect(page.getByTestId("active-filters")).toContainText(
    "All endpoints · Combine filters across fields",
  );
});

test("should group by manager, sort within each group, select a row and export the entire view", async ({
  page,
}) => {
  await load(page, () =>
    snapshot([
      endpoint({ pid: 1, local_port: 8080, service_manager: "Systemd" }),
      endpoint({ pid: 2, local_port: 443 }),
      endpoint({ pid: 3, local_port: 80 }),
    ]),
  );
  await page.getByTestId("group-by").selectOption("service_manager");
  await expect(page.getByTestId("port-group-header")).toHaveCount(2);
  await page
    .getByRole("columnheader", { name: "Local port", exact: true })
    .click();
  await expect(page.locator("tbody .port-number")).toHaveText([
    "80",
    "443",
    "8080",
  ]);
  await page
    .locator("tbody tr", {
      has: page.locator(".port-number", { hasText: /^443$/ }),
    })
    .click();
  await expect(page.locator("aside.inspector")).toContainText("443");
  await page
    .locator("details.menu", {
      has: page.locator("summary", { hasText: /^Export$/ }),
    })
    .locator("summary")
    .click();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: /JSON/ }).click();
  const download = await downloaded;
  const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(exported.entries.map((row: PortEntry) => row.local_port)).toEqual([
    80, 443, 8080,
  ]);
  expect(exported.metadata.groupBy).toBe("service_manager");
  expect(exported.metadata.entryCount).toBe(3);
  await page.getByTestId("group-by").selectOption("");
  await expect(page.getByTestId("port-group-header")).toHaveCount(0);
  await expect(page.locator("tbody .port-number")).toHaveText([
    "80",
    "443",
    "8080",
  ]);
});

test("should bound DOM rows when grouping one hundred thousand endpoints", async ({
  page,
}) => {
  test.setTimeout(120_000);
  const rows = Array.from({ length: 100000 }, (_, index) =>
    endpoint({
      pid: index + 10,
      local_port: index % 65536,
      local_address: `10.${Math.floor(index / 65536)}.${Math.floor(index / 256) % 256}.${index % 256}`,
    }),
  );
  await load(page, () => snapshot(rows));
  await page.getByTestId("group-by").selectOption("local_address");
  await expect(page.getByTestId("port-group-header").first()).toBeVisible();
  expect(await page.locator("tbody tr").count()).toBeLessThanOrEqual(200);
  expect(await page.locator("tbody .port-number").count()).toBe(100);
  await page.locator(".p-paginator-next").click();
  await expect(page.locator("tbody .port-number").first()).not.toHaveText("0");
  expect(await page.locator("tbody tr").count()).toBeLessThanOrEqual(200);
  await page.getByTestId("group-by").selectOption("");
  await expect(page.getByTestId("port-group-header")).toHaveCount(0);
  await expect(page.locator("tbody .port-number").first()).toBeVisible();
  expect(await page.locator("tbody tr").count()).toBeLessThan(200);
});

test("should migrate legacy columns and translate the independent fields in the browser", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem(
      "portviewer.settings.v1",
      JSON.stringify({
        schemaVersion: 2,
        language: "zh-CN",
        refreshIntervalMs: 0,
        visibleColumns: ["local_address", "local_port", "attribution"],
      }),
    ),
  );
  await page.route("**/api/v1/scan", (route) =>
    route.fulfill({ json: snapshot([endpoint()]) }),
  );
  await page.goto("/");
  await expect(
    page.getByRole("columnheader", { name: "监听地址", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "本地端口", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "方向 / 角色", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "上级服务", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "打开设置" }).click();
  await page
    .locator(".settings-dialog select")
    .filter({ has: page.locator('option[value="en-US"]') })
    .selectOption("en-US");
  await page.locator(".settings-dialog .p-dialog-close-button").click();
  await expect(page.getByTestId("group-by")).toHaveAttribute(
    "aria-label",
    "Group by",
  );
  await expect(
    page.getByRole("columnheader", { name: "Listening address", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: "Service manager", exact: true }),
  ).toBeVisible();
  const settings = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("portviewer.settings.v1")!),
  );
  expect(settings.schemaVersion).toBe(3);
  expect(settings.visibleColumns).toEqual([
    "local_address",
    "local_port",
    "role",
    "service_manager",
    "attribution",
  ]);
});
