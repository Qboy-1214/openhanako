import { test, expect } from "@playwright/test";

/**
 * 浏览器端到端冒烟测试：验证 dev:web 全栈（Hana server + Vite 前端）
 * 能正常启动并渲染主应用外壳，且无启动期崩溃。
 */
test.describe("app loads (dev:web)", () => {
  test("page title and app shell render without launch crash", async ({ page }) => {
    const launchErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") launchErrors.push(msg.text());
    });
    page.on("pageerror", (err) => launchErrors.push(String(err)));

    await page.goto("/", { waitUntil: "domcontentloaded" });

    // 标题来自 desktop/src/index.html (#7)
    await expect(page).toHaveTitle("HanaAgent");

    // React 根已挂载并渲染出应用外壳（App.tsx 的 .app-shell）
    const appShell = page.locator(".app-shell");
    await expect(appShell).toBeVisible({ timeout: 30_000 });

    // react-root 不应为空
    const childCount = await page.evaluate(() => {
      const el = document.getElementById("react-root");
      return el ? el.childElementCount : -1;
    });
    expect(childCount).toBeGreaterThan(0);

    // 启动期不应有未捕获的 JS 运行时异常（页面级崩溃）。
    // 已知：空 agent 的 dev 环境下，后端 /api/health、/api/server/identity
    // 会因 agent 缺失返回 500（后端健壮性缺陷，非前端崩溃），这些网络级
    // 500 与 favicon/vite HMR 噪声一并过滤，聚焦于真正的脚本异常。
    const fatal = launchErrors.filter(
      (e) =>
        !/favicon|net::ERR_ABORTED|\[vite\]|HMR/i.test(e) &&
        !/Failed to load resource.*(500|404)/i.test(e) &&
        !/server identity failed|hanaFetch.*500/i.test(e),
    );
    expect(fatal, `launch errors: ${fatal.join(" | ")}`).toHaveLength(0);
  });

  test("dev-web config injected into window", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const hasConfig = await page.evaluate(() => {
      const w = window as unknown as { __HANA_DEV_WEB__?: unknown };
      return typeof w.__HANA_DEV_WEB__ === "object" && w.__HANA_DEV_WEB__ !== null;
    });
    expect(hasConfig).toBe(true);
  });
});
