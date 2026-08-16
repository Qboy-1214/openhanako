// Local dev:web seed — configures the "hanako" agent to use the Agnes AI
// provider. The API key is read ONLY from process.env.AGNES_API_KEY at runtime
// and is NEVER written to any git-tracked file.
//
// Usage:
//   $env:AGNES_API_KEY="sk-..."; node scripts/seed-agnes-dev.mjs
//
// This script is a localhost dev helper and is intentionally NOT committed.

const BASE = process.env.HANA_DEV_WEB_URL || "http://127.0.0.1:5173";
const AGENT = process.env.HANA_AGENT_ID || "hanako";
const KEY = process.env.AGNES_API_KEY;

if (!KEY) {
  console.error("ERROR: AGNES_API_KEY env var is required");
  process.exit(1);
}

const payload = {
  providers: {
    agnes: {
      api: "agnes",
      base_url: "https://api.agnes-ai.cn/v1",
      api_key: KEY,
      models: ["agnes-2.5-flash"],
    },
  },
  models: {
    chat: { id: "agnes-2.5-flash", provider: "agnes" },
  },
};

const res = await fetch(`${BASE}/api/agents/${AGENT}/config`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(payload),
});

const text = await res.text();
console.log(`PUT /api/agents/${AGENT}/config -> ${res.status}`);
console.log(text.slice(0, 500));

if (!res.ok) process.exit(1);

// Verify the agent now reports a default model.
const cfg = await fetch(`${BASE}/api/agents/${AGENT}/config`).then((r) => r.json());
const chat = cfg?.config?.models?.chat;
console.log("agent.models.chat =", JSON.stringify(chat));
