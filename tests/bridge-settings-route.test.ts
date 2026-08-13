import { describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

import { createBridgeRoute } from "../server/routes/bridge.ts";

function makeApp() {
  let readOnly = false;
  let receiptEnabled = false;
  let richStreamingEnabled = true;
  let permissionMode = "operate";
  const agent = {
    id: "hana",
    sessionDir: "/tmp/hana-bridge-settings",
    config: { bridge: {} },
    updateConfig: vi.fn(),
  };
  const engine = {
    currentAgentId: "hana",
    getAgent: vi.fn((id) => id === "hana" ? agent : null),
    getBridgeIndex: vi.fn(() => ({})),
    getBridgeReadOnly: vi.fn(() => readOnly),
    setBridgeReadOnly: vi.fn((next) => { readOnly = !!next; }),
    getBridgePermissionMode: vi.fn(() => permissionMode),
    setBridgePermissionMode: vi.fn((next) => { permissionMode = next; }),
    getBridgeReceiptEnabled: vi.fn(() => receiptEnabled),
    setBridgeReceiptEnabled: vi.fn((next) => { receiptEnabled = !!next; }),
    getBridgeRichStreamingEnabled: vi.fn(() => richStreamingEnabled),
    setBridgeRichStreamingEnabled: vi.fn((next) => { richStreamingEnabled = !!next; }),
  };
  const bridgeManager = {
    getStatus: vi.fn(() => ({})),
    getMessages: vi.fn(() => []),
    stopPlatform: vi.fn(),
    startPlatformFromConfig: vi.fn(),
  };
  const app = new Hono();
  app.route("/api", createBridgeRoute(engine, bridgeManager));
  return { app, engine };
}

describe("bridge settings route", () => {
  it("returns the persisted global bridge settings after saving", async () => {
    const { app, engine } = makeApp();

    const res = await app.request("/api/bridge/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ readOnly: true, receiptEnabled: true }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(engine.setBridgeReadOnly).toHaveBeenCalledWith(true);
    expect(engine.setBridgeReceiptEnabled).toHaveBeenCalledWith(true);
    expect(body).toEqual({
      ok: true,
      readOnly: true,
      permissionMode: "read_only",
      receiptEnabled: true,
      richStreamingEnabled: true,
    });
  });

  it("persists the explicit bridge permission mode while preserving legacy readOnly shape", async () => {
    const { app, engine } = makeApp();

    const res = await app.request("/api/bridge/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ permissionMode: "auto" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(engine.setBridgePermissionMode).toHaveBeenCalledWith("auto");
    expect(engine.setBridgeReadOnly).not.toHaveBeenCalled();
    expect(body).toEqual({
      ok: true,
      readOnly: false,
      permissionMode: "auto",
      receiptEnabled: false,
      richStreamingEnabled: true,
    });
  });

  it("persists the bridge rich streaming compatibility switch", async () => {
    const { app, engine } = makeApp();

    const res = await app.request("/api/bridge/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ richStreamingEnabled: false }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(engine.setBridgeRichStreamingEnabled).toHaveBeenCalledWith(false);
    expect(body).toEqual({
      ok: true,
      readOnly: false,
      permissionMode: "operate",
      receiptEnabled: false,
      richStreamingEnabled: false,
    });
  });

  it("writes a users binding via POST /bridge/binding", async () => {
    const { app, engine } = makeApp();
    const agent = engine.getAgent("hana");

    const res = await app.request("/api/bridge/binding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "telegram", userId: "tg-user", defaultAgent: "agent-2", role: "user" }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(agent.updateConfig).toHaveBeenCalledWith({
      bridge: { telegram: { users: { "tg-user": { defaultAgent: "agent-2", role: "user" } } } },
    });
    const binding = body.status.bindings.telegram.find((b) => b.userId === "tg-user");
    expect(binding).toEqual({ userId: "tg-user", defaultAgent: "agent-2", role: "user" });
  });

  it("removes a users binding via remove flag", async () => {
    const { app, engine } = makeApp();
    const agent = engine.getAgent("hana");
    agent.config = { bridge: { telegram: { users: { "tg-user": { defaultAgent: "agent-2", role: "user" } } } } };

    const res = await app.request("/api/bridge/binding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "telegram", userId: "tg-user", remove: true }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status.bindings.telegram).toEqual([]);
  });

  it("rejects a binding without userId", async () => {
    const { app } = makeApp();

    const res = await app.request("/api/bridge/binding", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ platform: "telegram" }),
    });

    expect(res.status).toBe(400);
  });
});
