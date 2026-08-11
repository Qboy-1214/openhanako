import { describe, it, expect } from "vitest";
import { compileWorkflow } from "../../server/workflows/compile";
import { runWorkflowScript } from "../../lib/workflow/sandbox";

describe("M2-2 nocode workflow", () => {
  it("compiles declarative graph to JS and runs via runWorkflowScript", async () => {
    const graph = { nodes: [{ id: "n1", tool: "summarize", prompt: "x" }], edges: [] };
    const js = compileWorkflow(graph);
    expect(js).toContain("agent(");
    // runWorkflowScript(script, hostApi, opts) — 第 2 参为注入沙箱全局的 hostApi 对象，opts 仅 {signal,deadlineMs}
    const hostApi = { agent: async (prompt: string, opts: any) => ({ result: "ok" }) };
    const { result } = await runWorkflowScript(js, hostApi);
    expect(result).toBeTruthy();
    expect((result as any).nodes.n1).toBeTruthy();
  });

  it("streams partial results through lib/workflow kernel unchanged", async () => {
    const graph = { nodes: [{ id: "n1", tool: "echo", prompt: "hello" }], edges: [] };
    const js = compileWorkflow(graph);
    // 流式结果通过 hostApi 注入的全局函数透传，非 opts.onEvent
    const streamed: string[] = [];
    const hostApi = {
      agent: async (prompt: string, opts: any) => { streamed.push("agent:start"); const r = { replyText: prompt }; streamed.push("agent:end"); return r; },
    };
    await runWorkflowScript(js, hostApi);
    expect(streamed.length).toBeGreaterThan(0); // 内核流式事件透传，lib/workflow 零改动
  });

  it("respects edge ordering (topological)", () => {
    const graph = {
      nodes: [
        { id: "a", prompt: "first" },
        { id: "b", prompt: "second" },
      ],
      edges: [{ from: "a", to: "b" }],
    };
    const js = compileWorkflow(graph);
    expect(js.indexOf("n_a")).toBeLessThan(js.indexOf("n_b")); // a 在 b 前
  });
});
