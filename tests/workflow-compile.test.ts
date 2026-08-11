import { describe, it, expect } from "vitest";
import { compileWorkflow } from "../lib/workflow/compile.ts";
import { runWorkflowScript } from "../lib/workflow/sandbox.ts";

describe("M2-2 nocode workflow", () => {
  it("compiles declarative graph to JS with agent() calls", () => {
    const graph = { nodes: [{ id: "n1", tool: "summarize", prompt: "x" }], edges: [] };
    const js = compileWorkflow(graph);
    expect(js).toContain("export const meta");
    expect(js).toContain("agent(");
  });

  it("compiles to runnable script via runWorkflowScript (hostApi injected)", async () => {
    const graph = { nodes: [{ id: "n1", prompt: "hello" }], edges: [] };
    const js = compileWorkflow(graph);
    const streamed: string[] = [];
    const hostApi = {
      agent: async (prompt: string, opts: any) => { streamed.push("agent:start"); const r = { replyText: prompt }; streamed.push("agent:end"); return r; },
    };
    const result = await runWorkflowScript(js, hostApi);
    expect(result).toBeTruthy();
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
