import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E 配置。
 *
 * 通过 `npm run dev:web` 启动 Hana server + Vite 前端（dev:web.js）：
 * - 服务器随机端口，写入 hanaHome 下的 server-info.json
 * - 前端 Vite dev server 固定监听 127.0.0.1:5173
 *
 * webServer 负责拉起整个栈；测试完成后 Playwright 发送 SIGTERM，
 * dev-web.js 已处理 SIGTERM/SIGBREAK 并级联关闭 Vite 与 server 子进程。
 */
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "**/*.spec.ts",
  // 区分于 vitest 的 *.test.ts，避免冲突。
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    headless: true,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  webServer: {
    command: "node scripts/dev-web.js",
    url: "http://127.0.0.1:5173",
    timeout: 180_000,
    reuseExistingServer: true,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      // 避免 dev:web 在 CI/无头环境尝试打开浏览器。
      BROWSER: "none",
    },
  },
});
