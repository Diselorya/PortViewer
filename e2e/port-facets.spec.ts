import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { PortEntry, ScanResult } from "../src/types/port.js";

function portLabel(value: string | number): RegExp {
  return new RegExp("^" + value + "(?:↗[?]?)?$");
}

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
async function load(
  page: Page,
  scan: () => ScanResult,
  settings: Record<string, unknown> = {},
) {
  await page.addInitScript(
    (settings) =>
      localStorage.setItem(
        "portviewer.settings.v1",
        JSON.stringify({
          schemaVersion: 4,
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
          ...settings,
        }),
      ),
    settings,
  );
  await page.route("**/api/v1/knowledge/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/settings"))
      return route.fulfill({
        json: {
          online_enabled: true,
          reverse_dns_enabled: true,
          ai_enabled: false,
          ai_configured: false,
          ai_provider: null,
          ai_model: null,
          can_configure: true,
        },
      });
    if (url.pathname.endsWith("/profiles"))
      return route.fulfill({
        json: {
          profiles: [],
          pending_count: 0,
          online_enabled: true,
          ai_configured: false,
          ai_enabled: false,
        },
      });
    const address = url.searchParams.get("address") ?? "";
    const isLocal = ["", "127.0.0.1", "::1", "0.0.0.0", "::"].includes(address);
    return route.fulfill({
      json: {
        address: address || "local",
        kind: isLocal ? "local" : "public",
        is_local: isLocal,
        machine_name: isLocal ? "fixture-scanner" : null,
        hostname: isLocal ? "fixture-scanner" : "fixture-peer.example",
        hostname_source: isLocal ? "system" : "reverse_dns",
        dns_status: "ready",
        os: isLocal ? "Linux" : null,
        observed_addresses: ["127.0.0.1"],
        resolved_at: null,
      },
    });
  });
  await page.route("**/api/v1/scan", (route) =>
    route.fulfill({ json: scan() }),
  );
  await page.goto("/");
  await expect(page.locator(".result-count")).toContainText(
    String(scan().entries.length),
    { timeout: 30_000 },
  );
}
async function panel(page: Page, name: string) {
  const trigger = page.locator('[data-panel-trigger="' + name + '"]');
  if ((await trigger.getAttribute("aria-expanded")) !== "true")
    await trigger.click();
}
async function chooseFacet(page: Page, field: string, value: string) {
  await panel(page, "filters");
  await page.getByTestId("facet-field").selectOption(field);
  await page.getByTestId("facet-option-" + value).check();
  await page.getByTestId("toolbar-filters").click();
}
async function setGroup(page: Page, field: string) {
  await panel(page, "group");
  await page.getByTestId("group-by").selectOption(field);
  await page.getByTestId("toolbar-group").click();
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
  await expect(page.locator("tbody .port-number")).toHaveText(portLabel(8080));
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
    page.getByRole("columnheader", { name: /Listening address/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: /Local port/ }),
  ).toBeVisible();
  await page
    .locator('th[data-column-field="local_port"] .p-datatable-column-title')
    .click();
  await expect(page.locator("tbody .port-number")).toHaveText(
    ["80", "443", "65535"].map(portLabel),
  );
  await page
    .locator('th[data-column-field="local_port"] .p-datatable-column-title')
    .click();
  await expect(page.locator("tbody .port-number")).toHaveText(
    ["65535", "443", "80"].map(portLabel),
  );
  // A non-meta click replaces the active sort, so address and role are verified independently.
  await page
    .locator('th[data-column-field="local_address"] .p-datatable-column-title')
    .click();
  await expect(page.locator("tbody .endpoint-cell")).toHaveText([
    "192.0.2.1",
    "192.0.2.3",
    "192.0.2.20",
  ]);
  await page
    .locator('th[data-column-field="role"] .p-datatable-column-title')
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
  await panel(page, "filters");
  await page.getByTestId("facet-field").selectOption("local_address");
  await expect(page.getByTestId("facet-option-127.0.0.1")).toBeChecked();
  await expect(
    page.getByTestId("facet-option-127.0.0.1").locator(".."),
  ).toContainText("0");
  await page.getByTestId("toolbar-filters").click();
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
  await setGroup(page, "service_manager");
  await expect(page.getByTestId("port-group-header")).toHaveCount(2);
  await page
    .locator('th[data-column-field="local_port"] .p-datatable-column-title')
    .click();
  await expect(page.locator("tbody .port-number")).toHaveText(
    ["80", "443", "8080"].map(portLabel),
  );
  await page
    .locator("tbody tr", {
      has: page.locator(".port-number", { hasText: portLabel(443) }),
    })
    .click();
  await expect(page.getByTestId("detail-drawer")).toContainText("443");
  await page
    .getByTestId("detail-drawer")
    .locator(".p-dialog-close-button")
    .click();
  await panel(page, "export");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: /JSON/ }).click();
  const download = await downloaded;
  const exported = JSON.parse(await readFile((await download.path())!, "utf8"));
  expect(exported.entries.map((row: PortEntry) => row.local_port)).toEqual([
    80, 443, 8080,
  ]);
  expect(exported.metadata.groupBy).toBe("service_manager");
  expect(exported.metadata.entryCount).toBe(3);
  await setGroup(page, "");
  await expect(page.getByTestId("port-group-header")).toHaveCount(0);
  await expect(page.locator("tbody .port-number")).toHaveText(
    ["80", "443", "8080"].map(portLabel),
  );
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
  await setGroup(page, "local_address");
  await expect(page.getByTestId("port-group-header").first()).toBeVisible();
  expect(await page.locator("tbody tr").count()).toBeLessThanOrEqual(200);
  expect(await page.locator("tbody .port-number").count()).toBe(100);
  for (let refresh = 0; refresh < 2; refresh++) {
    await Promise.all([
      page.waitForResponse((response) =>
        new URL(response.url()).pathname.endsWith("/api/v1/scan"),
      ),
      page.getByRole("button", { name: "Refresh · F5" }).click(),
    ]);
    await expect(
      page.getByRole("button", { name: "Refresh · F5" }),
    ).toBeEnabled();
    expect(await page.locator("tbody tr").count()).toBeLessThanOrEqual(200);
  }
  await page.locator(".p-paginator-next").click();
  await expect(page.locator("tbody .port-number").first()).not.toHaveText("0");
  expect(await page.locator("tbody tr").count()).toBeLessThanOrEqual(200);
  await setGroup(page, "");
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
    page.getByRole("columnheader", { name: /监听地址/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: /本地端口/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: /方向 \/ 角色/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: /上级服务/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "打开设置" }).click();
  await page
    .locator(".settings-dialog select")
    .filter({ has: page.locator('option[value="en-US"]') })
    .selectOption("en-US");
  await page.locator(".settings-dialog .p-dialog-close-button").click();
  await panel(page, "group");
  await expect(page.getByTestId("group-by")).toHaveAttribute(
    "aria-label",
    "Group by",
  );
  await expect(
    page.getByRole("columnheader", { name: /Listening address/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("columnheader", { name: /Service manager/ }),
  ).toBeVisible();
  const settings = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("portviewer.settings.v1")!),
  );
  expect(settings.schemaVersion).toBe(4);
  expect(settings.visibleColumns).toEqual([
    "service_name",
    "service_description",
    "local_address",
    "local_port",
    "role",
    "service_manager",
    "attribution",
  ]);
});

test("should preserve compact table geometry while sorting and reordering visible fields", async ({
  page,
}) => {
  await load(
    page,
    () =>
      snapshot([
        endpoint({ pid: 1, local_port: 80 }),
        endpoint({ pid: 2, local_port: 443 }),
      ]),
    {
      visibleColumns: [
        "service_name",
        "service_description",
        "local_port",
        "local_address",
        "protocol",
        "state",
      ],
      density: "compact",
    },
  );
  const initial = await tableGeometry(page);
  await expect(page.locator("thead th").first()).toHaveAttribute(
    "data-column-field",
    "service_name",
  );
  const firstRow = page.locator("tbody tr").first();
  expect((await firstRow.boundingBox())!.height).toBeLessThanOrEqual(42);
  await panel(page, "sort");
  await page.getByTestId("add-sort").click();
  await page.getByTestId("add-sort").click();
  expect(await page.getByTestId("sort-rule").count()).toBe(2);
  expect(await tableGeometry(page)).toEqual(initial);
  await page.getByTestId("toolbar-sort").click();
  await panel(page, "fields");
  const second = page.locator(".field-order-row").nth(1);
  await second.getByRole("button", { name: /Move up/ }).click();
  await page.getByTestId("auto-fit-columns").click();
  await page.getByTestId("toolbar-fields").click();
  await expect(page.locator("thead th").first()).toHaveAttribute(
    "data-column-field",
    "service_description",
  );
  expect(await tableGeometry(page)).toEqual(initial);
});

test("should color selected columns under empty conditions without coloring unrelated cells", async ({
  page,
}) => {
  await load(page, () =>
    snapshot([
      endpoint({ pid: 1, local_port: 80 }),
      endpoint({
        pid: 2,
        local_port: 443,
        state: "Established",
        remote_address: "198.51.100.1",
        remote_port: 443,
      }),
    ]),
  );
  await panel(page, "colors");
  await page.getByTestId("add-color-rule").click();
  const rule = page.locator(".color-rule").first();
  await rule.locator(".color-rule-head select").selectOption("columns");
  await rule.getByRole("checkbox", { name: "Local port", exact: true }).check();
  await rule.getByRole("checkbox", { name: "Protocol", exact: true }).uncheck();
  await rule.getByTestId("facet-option-Listen").uncheck();
  await rule.getByRole("button", { name: "Red", exact: true }).click();
  await page.getByTestId("toolbar-colors").click();
  await expect(
    page.locator(
      'td[data-column-field="local_port"] .port-cell.conditional-red',
    ),
  ).toHaveCount(2);
  await expect(
    page.locator('td[data-column-field="protocol"] .port-cell.conditional-red'),
  ).toHaveCount(0);
});

test("should show local workload evidence and both machine details without changing table width", async ({
  page,
}, testInfo) => {
  const source = endpoint({
    state: "Established",
    remote_address: "198.51.100.1",
    remote_port: 443,
    attributions: [
      {
        kind: "DockerContainer",
        name: "warehouse-api",
        description: "Warehouse inventory API",
        confidence: "Exact",
        source: "Docker published port",
        facts: [{ label: "Project path", value: "/srv/warehouse" }],
      },
    ],
  });
  await load(page, () => snapshot([source]), {
    visibleColumns: [
      "service_name",
      "service_description",
      "local_address",
      "local_port",
      "local_host",
      "remote_host",
      "remote_address",
      "remote_port",
      "state",
    ],
  });
  const initial = await tableGeometry(page);
  await expect(page.locator(".service-description")).toHaveText(
    "Warehouse inventory API",
  );
  await page.screenshot({
    path: testInfo.outputPath("workbench-wide-table.png"),
    fullPage: true,
  });
  await page.locator(".service-name-action").click();
  const drawer = page.getByTestId("detail-drawer");
  await expect(drawer).toBeVisible();
  await expect(drawer.locator(".detail-purpose")).toHaveText(
    "Warehouse inventory API",
  );
  await drawer.locator('[data-tab="evidence"]').click();
  await expect(drawer).toContainText("/srv/warehouse");
  await page.screenshot({
    path: testInfo.outputPath("workbench-wide-detail.png"),
    fullPage: true,
  });
  expect(await tableGeometry(page)).toEqual(initial);
  await drawer.locator(".p-dialog-close-button").click();
  await page.locator('td[data-column-field="local_address"] button').click();
  await expect(drawer).toContainText("fixture-scanner");
  await drawer.locator(".p-dialog-close-button").click();
  await page.locator('td[data-column-field="remote_address"] button').click();
  await expect(drawer).toContainText("198.51.100.1");
  const facts = drawer.locator(".detail-facts").first();
  await expect(facts).toContainText("Public");
  await expect(facts).toContainText("fixture-peer.example");
  await expect(facts).not.toContainText("fixture-scanner");
  await expect(facts).not.toContainText("Linux");
  await expect(facts).not.toContainText("Operating system");
  expect(await tableGeometry(page)).toEqual(initial);
  await page.setViewportSize({ width: 430, height: 900 });
  await expect(drawer).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("workbench-narrow-detail.png"),
    fullPage: true,
  });
});

test("should order grouped port values descending and export the same order", async ({
  page,
}) => {
  await load(page, () =>
    snapshot([
      endpoint({ pid: 1, local_port: 80 }),
      endpoint({ pid: 2, local_port: 443 }),
      endpoint({ pid: 3, local_port: 8080 }),
    ]),
  );
  await setGroup(page, "local_port");
  const header = page.locator(
    'th[data-column-field="local_port"] .p-datatable-column-title',
  );
  await header.click();
  await header.click();
  await expect(page.getByTestId("port-group-header").locator("b")).toHaveText([
    "8080",
    "443",
    "80",
  ]);
  await panel(page, "export");
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: /JSON/ }).click();
  const file = await downloaded;
  const data = JSON.parse(await readFile((await file.path())!, "utf8"));
  expect(data.entries.map((row: PortEntry) => row.local_port)).toEqual([
    8080, 443, 80,
  ]);
  expect(data.metadata.sort).toEqual([{ field: "local_port", order: -1 }]);
});

test("should keep transient public knowledge failures in the fixed bottom notices without moving the table", async ({
  page,
}) => {
  const statuses = ["offline", "rate_limited", "error"] as const;
  const source = endpoint({ service_profile_ids: [...statuses] });
  await load(page, () => snapshot([source]));
  const initial = await tableGeometry(page);
  let failed = true;
  await page.route("**/api/v1/knowledge/profiles", (route) =>
    route.fulfill({
      json: {
        profiles: statuses.map((id) => ({
          id,
          component_role: "runtime",
          original_name: "fixture-" + id,
          display_name_zh: null,
          summary: null,
          software_summary: null,
          identity_match: "unresolved",
          public_ids: [],
          sources: [],
          candidates: [],
          enrichment_status: failed ? id : "ready",
          updated_at: null,
          stale: false,
          message: null,
        })),
        pending_count: 0,
        online_enabled: true,
        ai_configured: false,
        ai_enabled: false,
      },
    }),
  );
  await page.getByRole("button", { name: "Refresh · F5" }).click();
  const toggle = page.getByTestId("scan-notices-toggle");
  await expect(toggle).toContainText("3");
  expect(await tableGeometry(page)).toEqual(initial);
  await toggle.click();
  await expect(page.locator(".scan-notices-details p.warning")).toHaveCount(3);
  expect(await tableGeometry(page)).toEqual(initial);
  failed = false;
  await page.getByRole("button", { name: "Refresh · F5" }).click();
  await expect(toggle).toBeDisabled();
  await expect(page.locator(".scan-notices-details")).toHaveCount(0);
  expect(await tableGeometry(page)).toEqual(initial);
});
