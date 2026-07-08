// Minimal MCP client to test chrome-mcp-bridge end-to-end.
// Spawns src/mcp-server.mjs, does initialize -> tools/list -> tools/call.
//
// Usage:
//   node test/drive-mcp-server.mjs list
//   node test/drive-mcp-server.mjs tabs
//   node test/drive-mcp-server.mjs navigate <url>
//   node test/drive-mcp-server.mjs screenshot
//   node test/drive-mcp-server.mjs call <tool> <json-args>

import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const NODE = process.execPath;
const SERVER = new URL("../src/mcp-server.mjs", import.meta.url).pathname.replace(/^\//, "");

const child = spawn(NODE, [SERVER], { stdio: ["pipe", "pipe", "inherit"] });

let buf = "";
let nextId = 1;
const pending = new Map();

child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.id != null && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});
child.on("exit", (code) => { if (process.env.DEBUG) process.stderr.write(`[drive] server exited code=${code}\n`); });

function send(method, params) {
  const id = nextId++;
  const line = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";
  child.stdin.write(line);
  return new Promise((resolve) => pending.set(id, { resolve }));
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

async function main() {
  const mode = process.argv[2] || "list";

  const init = await send("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: { roots: { listChanged: false } },
    clientInfo: { name: "chrome-mcp-bridge-test-driver", version: "1.0" },
  });
  console.log("=== initialize ===");
  console.log(`server: ${init.result?.serverInfo?.name} v${init.result?.serverInfo?.version} (proto ${init.result?.protocolVersion})`);
  notify("notifications/initialized");

  if (mode === "list" || !mode) {
    const t = await send("tools/list", {});
    console.log(`\n=== tools/list: ${t.result?.tools?.length} tools ===`);
    for (const tool of t.result.tools) console.log(`  • ${tool.name}`);
    child.kill();
    return;
  }

  const call = (name, args) => send("tools/call", { name, arguments: args });

  if (mode === "tabs") {
    const r = await call("tabs_context_mcp", { createIfEmpty: true });
    console.log("\n=== tabs_context_mcp ===");
    console.log(JSON.stringify(r.result, null, 2).slice(0, 2000));
  } else if (mode === "navigate") {
    const url = process.argv[3] || "https://example.com";
    const ctx = await call("tabs_context_mcp", { createIfEmpty: true });
    const tabId = extractTabId(ctx.result);
    if (tabId == null) throw new Error("no tabId from tabs_context_mcp");
    console.log(`>> tabId=${tabId}`);
    const nav = await call("navigate", { url, tabId });
    console.log("\n=== navigate ===");
    console.log(JSON.stringify(nav.result, null, 2).slice(0, 1500));
    await new Promise((r) => setTimeout(r, 2500));
    const shot = await call("computer", { action: "screenshot", tabId, save_to_disk: true });
    console.log("\n=== screenshot ===");
    const img = (shot.result?.content || []).find((c) => c.type === "image");
    if (img) {
      writeFileSync("test/screenshot.jpg", Buffer.from(img.data, "base64"));
      console.log(`saved test/screenshot.jpg (${img.mimeType}, ${Math.round(img.data.length*3/4/1024)}KB)`);
    }
    console.log(JSON.stringify((shot.result?.content || []).filter((c) => c.type === "text"), null, 2).slice(0, 800));
  } else if (mode === "screenshot") {
    const ctx = await call("tabs_context_mcp", { createIfEmpty: true });
    const tabId = extractTabId(ctx.result);
    const shot = await call("computer", { action: "screenshot", tabId, save_to_disk: true });
    const img = (shot.result?.content || []).find((c) => c.type === "image");
    if (img) { writeFileSync("test/screenshot.jpg", Buffer.from(img.data, "base64")); console.log(`saved test/screenshot.jpg`); }
    console.log(JSON.stringify(shot.result, null, 2).slice(0, 800));
  } else if (mode === "call") {
    const name = process.argv[3];
    const args = process.argv[4] ? JSON.parse(process.argv[4]) : {};
    const r = await call(name, args);
    console.log(JSON.stringify(r.result, null, 2).slice(0, 3000));
  } else {
    console.error("usage: list | tabs | navigate <url> | screenshot | call <tool> <json-args>");
  }
  child.kill();
}

function extractTabId(result) {
  if (!result || !Array.isArray(result.content)) return null;
  for (const c of result.content) {
    if (c && c.type === "text") {
      try {
        const j = JSON.parse(c.text);
        if (Array.isArray(j.availableTabs) && j.availableTabs.length) return j.availableTabs[0].tabId;
      } catch {}
      const m = c.text.match(/\b(\d{6,})\b/);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

main().catch((e) => { console.error("DRIVER ERROR:", e.message || e); child.kill(); process.exit(1); });
