/**
 * compile.ts — M2-2 服务端工作流编译器
 *
 * 把声明式工作流图（nodes/edges）编译为可在 runWorkflowScript 沙箱里执行的 JS。
 * 编译器归服务端（不是 lib/workflow 运行时），lib/workflow 内核零改动。
 *
 * 图结构：{ nodes: [{ id, tool, prompt, opts? }], edges: [{ from, to }] }
 *   - 节点用 agent(prompt, opts) 执行（tool 字段决定 agentType/工具过滤，可选）
 *   - edges 决定执行顺序（拓扑排序；环时退化为声明顺序）
 *   - 每个节点结果收集到 results[id]，最终返回 { nodes: results }
 */

export interface WorkflowNode {
  id: string;
  tool?: string;
  prompt: string;
  opts?: Record<string, unknown>;
}
export interface WorkflowEdge {
  from: string;
  to: string;
}
export interface WorkflowGraph {
  name?: string;
  nodes: WorkflowNode[];
  edges?: WorkflowEdge[];
}

/** 拓扑排序节点 id；有环则保留声明顺序兜底。 */
function orderNodeIds(nodes: WorkflowNode[], edges: WorkflowEdge[] = []): string[] {
  const ids = nodes.map((n) => n.id);
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (!indeg.has(e.from) || !indeg.has(e.to)) continue;
    adj.set(e.from, [...(adj.get(e.from) || []), e.to]);
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  }
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const ordered: string[] = [];
  const seen = new Set<string>();
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    ordered.push(id);
    for (const nxt of adj.get(id) || []) {
      indeg.set(nxt, (indeg.get(nxt) ?? 0) - 1);
      if ((indeg.get(nxt) ?? 0) === 0) queue.push(nxt);
    }
  }
  // 环：剩余未访问的按声明顺序补上
  for (const id of ids) if (!seen.has(id)) ordered.push(id);
  return ordered;
}

export function compileWorkflow(graph: WorkflowGraph): string {
  const ordered = orderNodeIds(graph.nodes, graph.edges);
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const lines: string[] = [];
  const results: string[] = [];
  for (const id of ordered) {
    const node = byId.get(id);
    if (!node) continue;
    const optsLiteral = node.opts ? JSON.stringify(node.opts) : "{}";
    const varName = `n_${id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
    lines.push(`  const ${varName} = await agent(${JSON.stringify(node.prompt)}, ${optsLiteral});`);
    results.push(`    ${JSON.stringify(id)}: ${varName}`);
  }
  return [
    `export const meta = { name: ${JSON.stringify(graph.name || "compiled-workflow")}, description: "compiled declarative workflow" };`,
    `export default async function(api) {`,
    `  const { agent } = api;`,
    ...lines,
    `  return { nodes: {`,
    ...results,
    `  } };`,
    `}`,
  ].join("\n");
}
