/**
 * register-user-script.ts — M2-1 用户脚本工具热注册（server 层）
 *
 * 落盘（persistUserScript）属于 core 层纯文件系统操作，保留在
 * core/user-script-runtime.ts；本文件负责把用户脚本转成 ToolCatalogEntryInput
 * 并以 origin="user" 幂等热注册到该用户的 catalog（replaceSource，无需重启）。
 *
 * 双根模型（open-root.ts:21）：per-user engine 的 hanakoHome = users/<userId>，
 * 已含 users 段，故落盘直接 path.join(hanakoHome, "tools", id)。
 */

import { persistUserScript, type UserScriptDef } from "../../core/user-script-runtime.ts";

export { persistUserScript };
export type { UserScriptDef };

/**
 * 将用户脚本转为 ToolCatalogEntryInput 并幂等热注册到该用户的 catalog。
 * origin="user"（不会静默降级为 mcp，端到端走 user 调用分支）。
 *
 * 注意：本函数只负责注册元数据；实际执行由 tool-catalog-bridge 按
 * origin==="user" 分派到 userScriptExecutor（engine 注入），不经 handler。
 */
export function registerUserScript(toolCatalog: any, userId: string, def: UserScriptDef): void {
  toolCatalog.replaceSource(`user:${userId}`, [{
    name: def.name,
    serverId: `user:${userId}`,
    origin: "user",
    description: def.description,
    paramsSummary: def.paramsSummary,
    schemaRef: () => def.schema ?? { type: "object", properties: {} },
  }]);
}
