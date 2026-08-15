/**
 * 方案 2 运行器：
 * 1. 用 esbuild 把 tests/live/agnes-live.ts（含其对 core/llm-client.ts 等 .ts 依赖）
 *    打包为单一 ESM 到临时目录；
 * 2. 用 `node --test` 执行打包结果，触发 node:test 用例。
 *
 * 密钥经 process.env.AGNES_API_KEY 传入（调用方在 shell 中 export）。
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const entry = fileURLToPath(new URL("./agnes-live.ts", import.meta.url));
const out = join(tmpdir(), `agnes-live-bundle-${Date.now()}.mjs`);

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  outfile: out,
  logLevel: "warning",
  // 项目里个别依赖可能引用 node 内置，交给 node 解析。
  external: ["node:*", "electron"],
});

if (result.errors && result.errors.length) {
  console.error("esbuild failed:", result.errors);
  process.exit(1);
}

const run = spawnSync(process.execPath, ["--test", out], {
  stdio: "inherit",
  env: process.env,
});
process.exit(run.status ?? 1);
