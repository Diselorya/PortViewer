import { expect, test } from "@playwright/test";

// 服务自身监听的端口：必然出现在扫描结果中，是跨平台稳定的断言锚点。
const SELF_PORT = "18789";

test("页面加载并渲染本机扫描结果", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  await page.goto("/");
  await expect(page.locator('[aria-label="PortViewer"]')).toBeVisible();
  // 搜索定位自身端口，避免虚拟滚动把目标行留在渲染窗口外
  await page.getByRole("searchbox").fill(SELF_PORT);
  await expect(
    page.locator("tbody tr", { hasText: SELF_PORT }).first(),
  ).toBeVisible({ timeout: 30_000 });
  expect(pageErrors).toEqual([]);
});

test("搜索过滤后仅保留匹配端口", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("searchbox").fill(SELF_PORT);
  // Loading renders an empty-message row before the real scan response arrives.
  const rows = page.locator("tbody tr").filter({
    has: page.locator("td[data-column-field]"),
  });
  await expect(rows.filter({ hasText: SELF_PORT }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(rows.filter({ hasNotText: SELF_PORT })).toHaveCount(0);
});

test("点击端口行打开详情面板并显示服务进程", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("searchbox").fill(SELF_PORT);
  const row = page.locator("tbody tr", { hasText: SELF_PORT }).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  // loopback 模式返回完整归属，进程名跨平台为 portviewer-web(.exe)
  await expect(page.locator("body")).toContainText(/portviewer-web/i, {
    timeout: 15_000,
  });
});
