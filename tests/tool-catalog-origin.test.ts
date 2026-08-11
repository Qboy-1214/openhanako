import { describe, it, expect } from "vitest";
import { ToolCatalog, type ToolCatalogOrigin } from "../core/tool-catalog.ts";

describe("M2-1 ToolCatalogOrigin probe", () => {
  it("enum includes user origin (no silent downgrade)", () => {
    const origins: ToolCatalogOrigin[] = ["mcp", "builtin", "user"];
    expect(origins).toContain("user");
  });

  it("user-script entries keep origin 'user' (not downgraded to mcp)", () => {
    const catalog = new ToolCatalog();
    catalog.registerSource("user:u_alice", [{
      name: "myScript",
      serverId: "user:u_alice",
      origin: "user",
      schemaRef: () => ({}),
    }]);
    const entry = catalog.all().find((e) => e.name === "myScript");
    expect(entry?.origin).toBe("user");
  });

  it("builtin stays builtin, unknown stays mcp", () => {
    const catalog = new ToolCatalog();
    catalog.registerSource("s", [
      { name: "b", serverId: "s", origin: "builtin", schemaRef: () => ({}) },
      { name: "x", serverId: "s", schemaRef: () => ({}) },
    ]);
    const all = catalog.all();
    expect(all.find((e) => e.name === "b")?.origin).toBe("builtin");
    expect(all.find((e) => e.name === "x")?.origin).toBe("mcp");
  });
});
