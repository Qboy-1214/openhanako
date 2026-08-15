import { test, expect } from "@playwright/test";

/**
 * 阶段 3 — 前端核心导航冒烟（浏览器端 E2E）。
 *
 * 验证 dev:web 全栈下，用户可在主应用内切换核心界面且不崩溃：
 *  - 默认 chat 入口可用（含发送按钮）
 *  - 切换到市场（M3 market tab）渲染
 *  - 通过桌面区入口进入设置面板，设置 tab 列表渲染
 *
 * 注意：本环境 dev:web 实例未配置模型（"model.noneConfigured"），且 agent 未
 * 初始化，故不在此断言「发送消息并收到回复」这类依赖模型/agent 的路径（交由
 * live LLM 测试覆盖）。这里只验证 UI 导航骨架健康。
 */
test.describe("navigation smoke (dev:web)", () => {
  test("default chat entry is present with a send control", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".app-shell", { timeout: 30_000 });

    // 默认 chat tab 的发送按钮应存在。
    const send = page.getByRole("button", { name: "chat.send" });
    await expect(send).toBeVisible();

    // 无模型配置提示应在 chat 区域可见（预期状态，非崩溃）。
    const noneCfg = page.getByText("model.noneConfigured");
    await expect(noneCfg.first()).toBeVisible();

    const fatal = errors.filter((e) => !/favicon|net::ERR_ABORTED|\[vite\]|HMR/i.test(e));
    expect(fatal, `pageerrors: ${fatal.join(" | ")}`).toHaveLength(0);
  });

  test("switch to market tab renders without crash", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".app-shell", { timeout: 30_000 });

    const marketTab = page.getByRole("button", { name: "channel.marketTab" });
    await expect(marketTab).toBeVisible();
    await marketTab.click();

    // 切换后应用外壳仍在，且未崩溃。
    await expect(page.locator(".app-shell")).toBeVisible();
    const fatal = errors.filter((e) => !/favicon|net::ERR_ABORTED|\[vite\]|HMR/i.test(e));
    expect(fatal, `pageerrors: ${fatal.join(" | ")}`).toHaveLength(0);
  });

  test("open settings panel from desktop area", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".app-shell", { timeout: 30_000 });

    const goToSettings = page.getByRole("button", { name: "desk.goToSettings" });
    await expect(goToSettings).toBeVisible();
    await goToSettings.click();

    // 设置面板应渲染出设置 tab 列表（至少一个 settings.tabs.* 按钮）。
    const providersTab = page.getByRole("button", { name: "settings.tabs.providers" });
    await expect(providersTab).toBeVisible({ timeout: 15_000 });

    const fatal = errors.filter((e) => !/favicon|net::ERR_ABORTED|\[vite\]|HMR/i.test(e));
    expect(fatal, `pageerrors: ${fatal.join(" | ")}`).toHaveLength(0);
  });
});
