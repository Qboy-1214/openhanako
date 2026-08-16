import fs from "node:fs";
import WebSocket from "ws";

const home = process.env.USERPROFILE + "/.hanako-dev";
const info = JSON.parse(fs.readFileSync(home + "/server-info.json", "utf8"));
const baseUrl = `http://127.0.0.1:${info.port}`;
const token = info.token;

const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

async function rest(path, method = "GET", body) {
  const res = await fetch(baseUrl + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  // 1) 建 session
  const created = await rest("/api/sessions/new", "POST", {});
  const sessionPath = created.path || created.sessionPath;
  const sessionId = created.sessionId || created.id;
  console.log("NEW SESSION", JSON.stringify(created).slice(0, 200));

  // 2) 连 WS
  const wsUrl = `ws://127.0.0.1:${info.port}/ws?token=${encodeURIComponent(token)}`;
  const ws = new WebSocket(wsUrl);
  let fullText = "";
  let done = false;
  ws.on("unexpected-response", (req, res) => {
    console.log("UNEXPECTED-RESPONSE status=", res.statusCode, "body=", res.read().toString().slice(0, 200));
  });
  ws.on("close", (code, reason) => {
    console.log("WS CLOSE code=", code, "reason=", reason.toString());
  });

  const reply = new Promise((resolve, reject) => {
    const timer = setTimeout(() => { console.log("TIMEOUT, fullText len=", fullText.length); reject(new Error("timeout waiting for turn_end")); }, 90000);
    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { console.log("NONJSON:", raw.toString().slice(0,120)); return; }
      console.log("MSG type=", msg.type, "keys=", Object.keys(msg).join(","));
      if (msg.type === "text_delta") {
        fullText += msg.delta || msg.text || "";
      } else if (msg.type === "turn_end") {
        clearTimeout(timer);
        done = true;
        resolve();
      } else if (msg.type === "error") {
        clearTimeout(timer);
        reject(new Error("WS error: " + JSON.stringify(msg).slice(0, 400)));
      }
    });
    ws.on("error", (e) => { clearTimeout(timer); reject(e); });
  });

  await new Promise((r) => ws.on("open", r));
  console.log("WS OPEN");

  // 3) 发 prompt
  const prompt = {
    type: "prompt",
    text: "用一句话介绍你自己，你是谁？",
    sessionId,
    sessionPath,
  };
  ws.send(JSON.stringify(prompt));
  console.log("SENT PROMPT:", prompt.text);

  // 不依赖 WS turn_end：固定等待 25s，让 engine 处理（含 agnes 调用），
  // 然后直接读 session 文件判断 engine 是否真实落盘了 assistant 回复。
  await new Promise((r) => setTimeout(r, 25000));
  console.log("=== AGNES REPLY (via WS deltas) len=", fullText.length, "===");
  console.log(fullText.slice(0, 800));

  // 诊断：读取 session 文件看 engine 是否实际落盘了 assistant 回复
  try {
    const fsm = await import("node:fs");
    const raw = fsm.readFileSync(sessionPath, "utf8");
    const lines = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const assistantMsgs = lines.filter((m) => m.role === "assistant" || m.type === "assistant");
    console.log("=== SESSION FILE assistant messages:", assistantMsgs.length, "===");
    for (const m of assistantMsgs.slice(-2)) {
      const text = m.content || m.text || JSON.stringify(m).slice(0, 200);
      console.log("  >", String(text).slice(0, 400));
    }
    if (assistantMsgs.length === 0) {
      console.log("  (no assistant message -> engine did not produce a reply)");
      console.log("  session lines:", lines.length, "roles:", lines.map((l) => l.role || l.type).join(","));
    }
  } catch (e) {
    console.log("session file read err:", e.message);
  }
  ws.close();
  process.exit(0);
}

main().catch((e) => { console.error("CHAT FAILED:", e.message); process.exit(1); });
