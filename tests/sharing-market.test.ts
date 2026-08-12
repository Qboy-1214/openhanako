import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { SharingAssetStore } from "../server/sharing/store.ts";
import { SharingMarket, makeMarket } from "../server/sharing/index.ts";
import { createSharingRoute } from "../server/routes/sharing.ts";
import { readUserScript } from "../core/user-script-runtime.ts";

let tmpRoot: string | null = null;
const openStores: SharingAssetStore[] = [];

function localOwner() {
  return {
    kind: "local_user" as const,
    credentialKind: "loopback_token",
    connectionKind: "local",
    serverId: "server_market",
    serverNodeId: "server_market",
    userId: "user_owner",
    studioId: "studio_home",
    scopes: ["market.read", "market.write"] as string[],
  };
}

/** per-user 引擎：hanakoHome = <baseDir>/users/<userId>（仿 EngineLifecycle）。 */
function makeEngine() {
  const baseDir = tmpRoot!;
  const hanakoHome = path.join(baseDir, "users", "user_owner");
  return {
    userId: "user_owner",
    hanakoHome,
    hub: { buildBridge: () => ({}) },
  };
}

function makeApp(market: SharingMarket, engine: any) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("authPrincipal", localOwner());
    await next();
  });
  app.route("/api", createSharingRoute(() => market, () => engine));
  return app;
}

function newStore(): SharingAssetStore {
  const store = new SharingAssetStore(path.join(tmpRoot!, "system", "shared-assets.db"));
  openStores.push(store);
  return store;
}

beforeEach(async () => {
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hana-sharing-market-"));
});

afterEach(async () => {
  for (const s of openStores) {
    try { s.close(); } catch { /* ignore */ }
  }
  openStores.length = 0;
  if (tmpRoot) {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = null;
  }
});

describe("M3 Sharing Market", () => {
  it("rejects requests without an authenticated principal (401)", async () => {
    const store = newStore();
    const market = makeMarket({ store, baseDir: tmpRoot! });
    const engine = makeEngine();

    const app = new Hono();
    // 不注入 principal
    app.route("/api", createSharingRoute(() => market, () => engine));
    const res = await app.request("/api/sharing/mine");
    expect(res.status).toBe(401);
  });

  it("publishes a tool, lists it under mine, discovers it, installs it sandboxed, then unpublishes", async () => {
    const store = newStore();
    const market = makeMarket({ store, baseDir: tmpRoot! });
    const engine = makeEngine();
    const app = makeApp(market, engine);

    // 先落盘一个本地 tool 源（含 manifest.json），供 publish 读取
    const toolId = "greeter";
    const toolDir = path.join(engine.hanakoHome, "tools", toolId);
    await fs.mkdir(toolDir, { recursive: true });
    const src = "export default () => 'hi'";
    await fs.writeFile(path.join(toolDir, "src"), src, "utf-8");
    await fs.writeFile(
      path.join(toolDir, "manifest.json"),
      JSON.stringify({ id: toolId, name: toolId, description: "", runtime: "js", src }),
      "utf-8",
    );

    // publish
    const pubRes = await app.request("/api/sharing/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "tool", sourceId: toolId, title: "Greeter", summary: "says hi" }),
    });
    if (pubRes.status !== 201) {
      // eslint-disable-next-line no-console
      console.log("PUBLISH ERROR BODY:", await pubRes.text());
    }
    expect(pubRes.status).toBe(201);
    const pub = await pubRes.json();
    expect(pub.id).toBe(`tool:${toolId}`);
    expect(pub.status).toBe("published");

    // mine
    const mineRes = await app.request("/api/sharing/mine");
    expect(mineRes.status).toBe(200);
    const mine = await mineRes.json();
    expect(mine.assets).toHaveLength(1);
    expect(mine.assets[0].ownerHandle).toBe("user_owner");

    // discover
    const discRes = await app.request("/api/sharing/discover");
    const disc = await discRes.json();
    expect(disc.assets).toHaveLength(1);

    // install
    const instRes = await app.request("/api/sharing/install", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: `tool:${toolId}` }),
    });
    expect(instRes.status).toBe(201);
    const inst = await instRes.json();
    expect(inst.localId).toBe("tool_greeter_user_owner");

    // 安装产物：sandboxed 工具落盘且 manifest 标记 sandboxed
    const localDir = path.join(engine.hanakoHome, "tools", inst.localId);
    const manifest = JSON.parse(await fs.readFile(path.join(localDir, "manifest.json"), "utf-8"));
    expect(manifest.sandboxed).toBe(true);
    expect(manifest.forkedFrom).toBe(`tool:${toolId}`);

    // 引擎启动扫描能读到它
    const def = readUserScript("user_owner", inst.localId, engine.hanakoHome);
    expect(def?.sandboxed).toBe(true);

    // unpublish
    const unpubRes = await app.request(`/api/sharing/unpublish/${encodeURIComponent(`tool:${toolId}`)}`, {
      method: "DELETE",
    });
    expect(unpubRes.status).toBe(200);
    const discAfter = await (await app.request("/api/sharing/discover")).json();
    expect(discAfter.assets).toHaveLength(0);
  });

  it("returns 404 when publishing a missing source", async () => {
    const store = newStore();
    const market = makeMarket({ store, baseDir: tmpRoot! });
    const engine = makeEngine();
    const app = makeApp(market, engine);

    const res = await app.request("/api/sharing/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "tool", sourceId: "nope", title: "x", summary: "" }),
    });
    expect(res.status).toBe(404);
  });
});
