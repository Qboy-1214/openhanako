/**
 * workflows.ts — M2-2 无代码工作流管理路由（POST /api/workflows）
 *
 * 接收声明式工作流图，服务端编译为 JS，落盘到 per-user 根的
 * users/<userId>/workflows/<id>/script.js。workflow-tool 经 workflowId 读回执行。
 */

import { Hono } from "hono";
import * as fs from "fs";
import * as path from "path";
import { compileWorkflow, type WorkflowGraph } from "../../lib/workflow/compile.ts";

export function createWorkflowRoute(getEngine: (c: any) => any) {
  const route = new Hono();

  route.post("/workflows", async (c) => {
    const engine = getEngine(c);
    if (!engine) return c.json({ error: "unauthorized" }, 401);
    let graph: WorkflowGraph;
    try {
      graph = await c.req.json();
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (!graph?.nodes || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
      return c.json({ error: "missing nodes" }, 400);
    }
    const js = compileWorkflow(graph); // 编译器归属服务端
    const id = (globalThis.crypto?.randomUUID?.() ?? `wf_${Date.now()}`).toString();
    const dir = path.join(engine.hanakoHome, "workflows", id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "script.js"), js);
    return c.json({ id, status: "compiled" });
  });

  return route;
}

/** server 层注入到 workflow-tool deps：按 workflowId 从 per-user 根读回编译产物。 */
export function makeLoadWorkflowScript(getEngine: (c: any) => any) {
  return (workflowId: string, ctx?: any): string | null => {
    // engine 通过 ctx 解析（若可用），否则用当前请求的 engine
    const engine = (ctx && getEngine(ctx)) || null;
    if (!engine) return null;
    const file = path.join(engine.hanakoHome, "workflows", workflowId, "script.js");
    if (!fs.existsSync(file)) return null;
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
}
