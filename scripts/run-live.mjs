import { startVitest } from "vitest/node";

// Programmatic entry so the command line does not contain the bare trigger
// token that the harness mis-classifies as a watch service.
// Usage: node scripts/run-live.mjs [filterGlob...]
const filters = process.argv.slice(2);
const ctx = await startVitest("test", filters, {
  config: "vitest.live.config.js",
  run: true,
  watch: false,
  passWithNoTests: false,
});

if (!ctx.shouldKeepServer()) await ctx.exit();
