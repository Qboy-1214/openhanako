/**
 * user-script-runtime.ts — M2-1 用户脚本工具运行时（core 层，无 server 依赖）
 *
 * - 落盘：per-user 根的 users/<userId>/tools/<id>/{manifest.json,src}
 * - 热注册：转 ToolCatalogEntryInput，origin="user"，幂等 replaceSource
 * - 执行：js/ts 用 vm 沙箱；py/sh 通过调用方注入的 execBackend（bwrap/docker）执行
 */

import fs from "fs";
import path from "path";
import vm from "vm";
import { transpileModule } from "typescript";

export type UserScriptRuntime = "js" | "ts" | "py" | "sh";

export interface UserScriptDef {
  id: string;
  name: string;
  description?: string;
  runtime: UserScriptRuntime;
  src: string;
  schema?: object;
  paramsSummary?: string;
  /** M3：标记来源资产 id（跨用户 fork 链）。 */
  forkedFrom?: string;
  /** M3：强制该工具经强沙箱执行（从 Sharing Market 安装所得）。 */
  sandboxed?: boolean;
}

export interface ExecuteUserScriptOptions {
  /** py/sh 运行时需要的沙盒 exec（由 server 层注入 bwrap/docker exec） */
  execBackend?: (command: string, execCwd: string, opts: { onData?: (d: string) => void; signal?: AbortSignal; timeout?: number }) => Promise<{ exitCode: number | null }>;
  timeoutMs?: number;
}

/** M2-1 落盘：per-user 根的 users/<userId>/tools/<id>/ */
export function persistUserScript(userId: string, id: string, def: UserScriptDef, hanakoHome: string): void {
  const dir = path.join(hanakoHome, "tools", id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(def, null, 2));
  fs.writeFileSync(path.join(dir, "src"), def.src);
}

export function readUserScript(userId: string, id: string, hanakoHome: string): UserScriptDef | null {
  const dir = path.join(hanakoHome, "tools", id);
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const def = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as UserScriptDef;
    def.src = fs.readFileSync(path.join(dir, "src"), "utf8");
    return def;
  } catch {
    return null;
  }
}

/**
 * M3 (Task 5)：扫描 per-user 根 tools/ 下所有已安装资产（localId 形如
 * "<kind>:<sourceId>@<ownerId>"），返回其 UserScriptDef 列表。引擎启动时
 * 调用以把 Market 安装的工具重新热注册（走强沙箱）。
 */
export function scanLocalInstalls(userHome: string): UserScriptDef[] {
  const toolsDir = path.join(userHome, "tools");
  if (!fs.existsSync(toolsDir)) return [];
  const out: UserScriptDef[] = [];
  for (const name of fs.readdirSync(toolsDir)) {
    const manifestPath = path.join(toolsDir, name, "manifest.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const def = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as UserScriptDef;
      if (!def.sandboxed) continue; // 仅重新注册从 Sharing Market 安装的工具
      const srcPath = path.join(toolsDir, name, "src");
      def.src = fs.existsSync(srcPath) ? fs.readFileSync(srcPath, "utf8") : "";
      out.push(def);
    } catch {
      // 跳过损坏项
    }
  }
  return out;
}

async function runInVm(scriptJs: string, args: Record<string, unknown>, ctx: unknown, timeoutMs?: number): Promise<string> {
  const logs: string[] = [];
  const sandbox: any = {
    args,
    ctx,
    console: { log: (...a: unknown[]) => logs.push(a.map(String).join(" ")) },
    JSON,
    Math,
    Date,
  };
  const result = vm.runInNewContext(`(async () => { ${scriptJs} })()`, sandbox, {
    timeout: timeoutMs ?? 30_000,
  });
  const r = await result;
  return logs.length
    ? logs.join("\n") + (r !== undefined ? "\n" + String(r) : "")
    : String(r ?? "");
}

/** 执行用户脚本。js/ts 走 vm 沙箱；py/sh 走 execBackend（bwrap/docker）。 */
export async function executeUserScript(
  def: UserScriptDef,
  args: Record<string, unknown>,
  opts: ExecuteUserScriptOptions = {},
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  if (def.runtime === "js") {
    return runInVm(def.src, args, opts, timeoutMs);
  }
  if (def.runtime === "ts") {
    const js = transpileModule(def.src, { compilerOptions: { module: 1, target: 2 } }).outputText;
    return runInVm(js, args, opts, timeoutMs);
  }
  // py / sh：需 server 层注入的沙盒 exec
  if (!opts.execBackend) {
    if (def.sandboxed) {
      // M3 强沙箱：从 Market 安装的工具绝不允许在无沙箱下执行
      throw new Error(`sandboxed tool requires an isolated exec backend (bwrap/docker); execution denied`);
    }
    return `runtime '${def.runtime}' 需要调用方注入 execBackend（bwrap/docker 沙盒）`;
  }
  const command = def.runtime === "py" ? `python3 -c ${JSON.stringify(def.src)}` : def.src;
  const chunks: string[] = [];
  const { exitCode } = await opts.execBackend(command, process.cwd(), {
    onData: (d) => chunks.push(d),
    timeout: Math.ceil(timeoutMs / 1000),
  });
  return `exit=${exitCode}\n${chunks.join("")}`;
}
