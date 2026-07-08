// chrome-mcp-bridge — MCP server (MCP-client-spawned over stdio).
//
// Replaces `claude --claude-in-chrome-mcp` (which is gated on claude.ai
// login). This server is ungated: it speaks JSON-RPC 2.0 to any MCP client
// and drives the official Chrome extension via the native-host bridge over
// a named pipe.
//
// stdin/stdout: newline-delimited JSON-RPC 2.0 (MCP, protocol 2025-06-18).
// Capabilities: { tools, logging }. No resources/prompts.
//
// Lifecycle: the MCP client spawns this (e.g. `claude mcp add chrome node src/mcp-server.mjs`).
// It connects to the IPC pipe (created by the Chrome-spawned native host) and
// relays tools/call -> tool_request -> tool_response.

import { connect as netConnect } from "node:net";
import { openSync, writeSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { TOOLS, TOOL_NAMES } from "./tools.mjs";
import {
  writeFrame, makeFrameReader,
  ipcToolRequest, ipcBridgeReady,
  ipcBridgeGone, IPC_PIPE,
  extensionResultToMcpContent,
} from "./protocol.mjs";

const LOG_DIR = process.env.CMB_LOG_DIR || "";
let logFd = -1;
if (LOG_DIR) {
  try { mkdirSync(LOG_DIR, { recursive: true }); logFd = openSync(join(LOG_DIR, "mcp-server.log"), "a"); } catch {}
}
function log(s) {
  const e = `[${new Date().toISOString()}] ${s}\n`;
  if (logFd >= 0) { try { writeSync(logFd, e); } catch {} }
  // DO NOT write to stdout (that's the JSON-RPC channel). stderr is ok.
  process.stderr.write(e);
}

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "chrome-mcp-bridge", version: "0.1.0" };
const TOOL_TIMEOUT_MS = 120_000;

// --- IPC client state ---
let pipe = null;
let bridgeReady = false;
let resolveBridgeReady = null;
let bridgeReadyPromise = new Promise((r) => { resolveBridgeReady = r; });
let nextReqId = 1;
const pending = new Map(); // reqId -> {resolve, reject, timer}

function ensurePipe() {
  if (pipe) return Promise.resolve(pipe);
  return new Promise((resolve, reject) => {
    log(`connecting to IPC pipe ${IPC_PIPE} ...`);
    const sock = netConnect(IPC_PIPE);
    let settled = false;
    sock.on("connect", () => {
      if (settled) return; settled = true;
      pipe = sock;
      const feed = makeFrameReader((msg) => handleIpc(msg));
      sock.on("data", feed);
      log("connected to IPC pipe (awaiting bridge_ready)");
      resolve(sock);
    });
    sock.on("error", (e) => {
      if (settled) return; settled = true;
      log(`!! IPC connect error: ${e.message}`);
      reject(e);
    });
    sock.on("end", () => {
      log("== IPC pipe ended (native host gone)");
      pipe = null; bridgeReady = false;
      const err = new Error("Browser extension is not connected (native host gone). Ensure the Chrome extension is installed, enabled, and has connected to its native host.");
      for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(err); }
      pending.clear();
    });
  });
}

function handleIpc(msg) {
  if (msg.type === "bridge_ready") {
    if (!bridgeReady) { bridgeReady = true; resolveBridgeReady(); log("<< bridge_ready"); }
  } else if (msg.type === "bridge_gone") {
    bridgeReady = false; pipe = null;
    // reset the ready promise so the next connect can await it again
    bridgeReadyPromise = new Promise((r) => { resolveBridgeReady = r; });
    log(`<< bridge_gone: ${msg.reason}`);
    const err = new Error(`Browser extension disconnected: ${msg.reason}`);
    for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(err); }
    pending.clear();
  } else if (msg.type === "tool_response" && msg.reqId != null) {
    const p = pending.get(msg.reqId);
    if (p) {
      pending.delete(msg.reqId);
      clearTimeout(p.timer);
      log(`<< tool_response reqId=${msg.reqId} isError=${!!msg.isError}`);
      // translate the extension's result.content into MCP content, then resolve
      // with the {content, isError} shape that callTool's caller expects.
      const content = extensionResultToMcpContent(msg.result || {});
      p.resolve({ content, isError: !!msg.isError });
    }
  } else if (msg.type === "pong") {
    // liveness ack
  } else {
    log(`?? unknown ipc msg: ${JSON.stringify(msg).slice(0, 200)}`);
  }
}

async function callTool(name, args) {
  if (!TOOL_NAMES.has(name)) {
    return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
  try {
    await ensurePipe();
  } catch (e) {
    return {
      content: [{ type: "text", text: `Browser extension is not connected. Ensure the Chrome extension is installed and running, and that the native host (chrome-mcp-bridge) is installed as the extension's native-messaging host. (${e.message})` }],
      isError: true,
    };
  }
  if (!bridgeReady) {
    // wait for bridge_ready (native host sends it once the extension handshake completes)
    const timedOut = await Promise.race([
      bridgeReadyPromise.then(() => false),
      new Promise((r) => setTimeout(() => r(true), 8000)),
    ]);
    if (timedOut || !bridgeReady) {
      return { content: [{ type: "text", text: "Browser extension is not connected (bridge not ready after 8s). Open Chrome and ensure the extension is enabled and reloaded." }], isError: true };
    }
  }
  const reqId = nextReqId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (pending.has(reqId)) {
        pending.delete(reqId);
        log(`!! tool reqId=${reqId} (${name}) timed out`);
        resolve({ content: [{ type: "text", text: `Tool ${name} timed out after ${TOOL_TIMEOUT_MS/1000}s` }], isError: true });
      }
    }, TOOL_TIMEOUT_MS);
    pending.set(reqId, { resolve, reject: (e) => resolve({ content: [{ type: "text", text: `Tool ${name} failed: ${e.message}` }], isError: true }), timer });
    writeFrame(pipe, ipcToolRequest(reqId, name, args));
    log(`>> tool_request reqId=${reqId} tool=${name}`);
  });
}

// --- JSON-RPC over stdio (newline-delimited) ---
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handleLine(line);
  }
});
process.stdin.on("end", () => { log("== stdin ended; exiting"); process.exit(0); });

function send(obj) { process.stdout.write(JSON.stringify(obj) + "\n"); }

function ok(id, result) { send({ jsonrpc: "2.0", id, result }); }
function err(id, code, message) { send({ jsonrpc: "2.0", id, error: { code, message } }); }

async function handleLine(line) {
  let req;
  try { req = JSON.parse(line); } catch (e) { log(`!! bad json: ${line.slice(0,120)}`); return; }
  const id = req.id; // may be undefined (notification)
  if (req.method === "initialize") {
    log("<< initialize");
    ok(id, { protocolVersion: PROTOCOL_VERSION, capabilities: { tools: {}, logging: {} }, serverInfo: SERVER_INFO });
    return;
  }
  if (req.method === "notifications/initialized") { log("<< notifications/initialized"); return; }
  if (req.method === "ping") { if (id != null) ok(id, {}); return; }
  if (req.method === "tools/list") {
    log("<< tools/list");
    ok(id, { tools: TOOLS });
    return;
  }
  if (req.method === "tools/call") {
    const name = req.params?.name;
    const args = req.params?.arguments || {};
    log(`<< tools/call name=${name}`);
    const res = await callTool(name, args);
    ok(id, { content: res.content, isError: res.isError || undefined });
    return;
  }
  // unknown method
  if (id != null) err(id, -32601, `Method not found: ${req.method}`);
}

log(`==== mcp server starting; pid=${process.pid} pipe=${IPC_PIPE} ====`);

// keep alive
setInterval(() => { /* idle */ }, 60000);
