import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * 独立配置：仅用于「live」真实端点测试（如 agnes-2.5-flash）。
 *
 * 不复用主 config 的 setupFiles（tests/setup-auto-updater.ts），因为该 setup
 * 在仅运行单个/少数文件时会在顶层 beforeEach 处报 "Vitest failed to find the
 * runner"（vitest 4 已知行为，主 config 全量运行因多文件共享 runner 上下文而正常）。
 *
 * 同时设 pool=forks + isolate=false，规避 vitest 4 在少文件收集时的
 * "failed to find the current suite" 问题（共享 VM 上下文）。
 *
 * 密钥安全：live 测试从 process.env.AGNES_API_KEY 读取，不硬编码；无密钥时
 * 测试以 skipIf 跳过。本配置本身不持有任何密钥。
 */
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
    include: ["tests/live/**/*.test.ts"],
    pool: "threads",
    globals: true,
    setupFiles: ["./tests/setup-auto-updater.ts"],
    testTimeout: 30_000,
    // 不加载 auto-updater setup。
  },
});
