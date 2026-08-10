import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// M1 专用 vitest 配置：复用主配置的别名，但不加载 setup-auto-updater.ts。
// 原因：vitest v4 在 setupFiles 顶层直接 import { beforeEach } 并调用会报
// "Vitest failed to find the runner"（v3 无此问题）。该 setup 仅用于桌面端
// electron 自动更新测试，M1 的引擎/路由/E2E 测试不需要它。
export default defineConfig({
  resolve: {
    alias: {
      "@hana/plugin-protocol": path.resolve(__dirname, "packages/plugin-protocol/src/index.ts"),
      "@hana/plugin-sdk": path.resolve(__dirname, "packages/plugin-sdk/src/index.ts"),
      "@hana/plugin-runtime": path.resolve(__dirname, "packages/plugin-runtime/src/index.ts"),
      "@hana/plugin-components": path.resolve(__dirname, "packages/plugin-components/src/index.ts"),
      "@": path.resolve(__dirname, "desktop/src/react"),
    },
  },
  test: {
    testTimeout: 15_000,
    server: {
      deps: {
        inline: ["electron-updater", /desktop\/auto-updater/],
      },
    },
  },
});
