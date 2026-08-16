#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { applyDevEnvironment, defaultDevHanaHome } from "./dev-env.js";
import {
  buildDevWebClientConfig,
  buildDevWebPreviewUrl,
  normalizeServerInfoForDevWeb,
  resolveViteCommand,
} from "./dev-web-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const hanaHome = defaultDevHanaHome();
const serverInfoPath = path.join(hanaHome, "server-info.json");

let serverProcess = null;
let viteProcess = null;
let shuttingDown = false;

function log(message) {
  process.stdout.write(`[dev-web] ${message}\n`);
}

function removeStaleServerInfo() {
  try {
    fs.unlinkSync(serverInfoPath);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
  }
}

// 按上一次启动写下的 pid 终止残留 server 进程，释放其持有的 sqlite 锁，
// 避免新 bootstrap 在 import 主入口时因锁冲突而卡死（Windows 上 SIGBREAK
// 处理不完整常导致旧 server 变孤儿残留）。
function terminateProcess(pid) {
  if (typeof pid !== "number" || pid <= 0) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/F", "/T"], { stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch {
    // ESRCH（进程已不存在）等忽略
  }
}

function killStaleServerProcess() {
  try {
    const info = JSON.parse(fs.readFileSync(serverInfoPath, "utf-8"));
    const pid = info?.pid;
    if (typeof pid === "number" && pid > 0) {
      // 不要把当前 dev-web 父进程自己杀掉
      if (pid === process.pid) return;
      log(`terminating stale server process ${pid}`);
      terminateProcess(pid);
    }
  } catch {
    // 文件不存在或解析失败都忽略
  }
}

function isChildAlive(child) {
  return !!child && child.exitCode === null && child.signalCode === null;
}

async function waitForServerInfo({ timeoutMs = 90_000, intervalMs = 200 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isChildAlive(serverProcess)) {
      throw new Error("Hana server exited before writing server-info.json");
    }
    try {
      const raw = fs.readFileSync(serverInfoPath, "utf-8");
      return normalizeServerInfoForDevWeb(JSON.parse(raw));
    } catch {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  throw new Error("Timed out waiting for server-info.json");
}

function spawnServer() {
  fs.mkdirSync(hanaHome, { recursive: true });
  killStaleServerProcess();
  removeStaleServerInfo();

  const serverEnv = applyDevEnvironment({ ...process.env });
  serverEnv.HANA_ROOT = rootDir;
  serverEnv.HANA_SERVER_ENTRY = path.join(rootDir, "server", "main-full.ts");
  serverEnv.HANA_CREATE_STARTUP_SESSION = "0";
  serverEnv.HANA_PORT = process.env.HANA_PORT || "0";
  delete serverEnv.ELECTRON_RUN_AS_NODE;

  serverProcess = spawn(process.execPath, [path.join(rootDir, "server", "bootstrap.ts")], {
    cwd: rootDir,
    env: serverEnv,
    stdio: "inherit",
    // 继承父进程的 TS 运行参数（如 --experimental-strip-types），否则子进程
    // 动态 import() 主入口 server/main-full.ts 会因无法解析 .ts 而卡在 import。
    execArgv: process.execArgv.length ? process.execArgv : ["--experimental-strip-types"],
  });

  serverProcess.on("exit", (code, signal) => {
    if (!shuttingDown && isChildAlive(viteProcess)) {
      log(`server exited (${signal || code}); stopping Vite`);
      viteProcess.kill(signal || "SIGTERM");
    }
  });
}

function spawnVite(clientConfig, serverInfo) {
  const viteBin = resolveViteCommand(rootDir);
  const viteEnv = applyDevEnvironment({ ...process.env });
  viteEnv.HANA_DEV_WEB = "1";
  viteEnv.HANA_DEV_WEB_CLIENT_PORT = clientConfig.serverPort;
  viteEnv.HANA_DEV_WEB_API_BASE_URL = clientConfig.apiBaseUrl;
  viteEnv.HANA_DEV_WEB_SERVER_URL = `http://127.0.0.1:${serverInfo.port}`;
  viteEnv.HANA_DEV_WEB_SERVER_TOKEN = serverInfo.token;
  delete viteEnv.ELECTRON_RUN_AS_NODE;

  viteProcess = spawn(viteBin, [
    "--config",
    path.join(rootDir, "vite.config.ts"),
    "--host",
    "127.0.0.1",
  ], {
    cwd: rootDir,
    env: viteEnv,
    shell: process.platform === "win32",
    stdio: "inherit",
  });

  viteProcess.on("exit", (code, signal) => {
    if (!shuttingDown && isChildAlive(serverProcess)) {
      log(`Vite exited (${signal || code}); stopping server`);
      serverProcess.kill(signal || "SIGTERM");
    }
  });
}

function shutdown(signal = "SIGTERM") {
  if (shuttingDown) return;
  shuttingDown = true;
  if (isChildAlive(viteProcess)) viteProcess.kill(signal);
  if (isChildAlive(serverProcess)) serverProcess.kill(signal);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
if (process.platform === "win32") {
  process.on("SIGBREAK", () => shutdown("SIGBREAK"));
}

try {
  spawnServer();
  const serverInfo = await waitForServerInfo();
  const clientConfig = buildDevWebClientConfig(serverInfo);
  spawnVite(clientConfig, serverInfo);
  log(`open ${buildDevWebPreviewUrl()}`);
} catch (err) {
  shutdown();
  console.error(`[dev-web] ${err?.stack || err?.message || String(err)}`);
  process.exitCode = 1;
}
