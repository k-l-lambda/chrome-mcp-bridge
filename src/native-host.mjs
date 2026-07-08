// chrome-mcp-bridge — native host (Chrome-spawned via manifest `path`).
//
// Replaces `claude.exe --chrome-native-host` (which is gated on claude.ai
// login). This host is ungated: it speaks the extension's native-messaging
// protocol directly and relays tool_request/tool_response to/from an MCP
// server over a named pipe.
//
// Lifecycle: Chrome spawns this when the extension calls connectNative.
// It lives until Chrome closes stdin (extension disconnected).
//
// Stdio is the native-messaging channel (framed). stderr is free — the
// launcher bat redirects it to a log file for debugging.
//
// Wire (both directions, native messaging AND IPC): 4-byte-LE-len + UTF-8 JSON.

import { createServer } from "node:net";
import { openSync, writeSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  writeFrame, makeFrameReader,
  extPong, extStatusResponse, extMcpConnected, extToolRequest,
  ipcBridgeReady, ipcBridgeGone, ipcToolResponse,
  IPC_PIPE,
} from "./protocol.mjs";

const LOG_DIR = process.env.CMB_LOG_DIR || "";
let logFd = -1;
if (LOG_DIR) {
  try { mkdirSync(LOG_DIR, { recursive: true }); logFd = openSync(join(LOG_DIR, "native-host.log"), "a"); } catch {}
}
function log(s) {
  const e = `[${new Date().toISOString()}] ${s}\n`;
  if (logFd >= 0) { try { writeSync(logFd, e); } catch {} }
  process.stderr.write(e);
}

log(`==== native host starting; pid=${process.pid} pipe=${IPC_PIPE} ====`);

// --- state ---
let handshakeComplete = false;     // extension sent get_status (handshake done)
let mcpConnectedSent = false;      // we've told the extension the bridge is up
const mcpClients = new Set();      // all connected MCP servers (support multiple concurrent)
const reqIdToClient = new Map();   // reqId -> the client socket that sent it (for response routing)
let pendingReqId = null;           // reqId currently in flight to the extension
const queue = [];                  // pending IPC tool_requests waiting for the extension

function sendToExt(obj) { writeFrame(process.stdout, obj); }

// broadcast a framed IPC message to ALL connected MCP clients
function broadcastToMcp(obj) {
  for (const c of mcpClients) { try { writeFrame(c, obj); } catch {} }
}

// --- extension side (stdin) ---
const feedExt = makeFrameReader((msg) => {
  log(`<< ext: ${JSON.stringify(msg).slice(0, 300)}`);
  if (msg.type === "ping") {
    sendToExt(extPong());
  } else if (msg.type === "get_status") {
    sendToExt(extStatusResponse());
    if (!handshakeComplete) {
      handshakeComplete = true;
      onHandshakeComplete();
    }
  } else if (msg.type === "tool_response") {
    // extension finished the in-flight request. pair with pendingReqId, route to the
    // owning client (not a broadcast — only the requester gets the response).
    const reqId = pendingReqId;
    pendingReqId = null;
    const isError = !!(msg.result && msg.result.error) || !!(msg.error);
    const result = msg.error || msg.result;
    const owner = reqId != null ? reqIdToClient.get(reqId) : null;
    if (reqId != null) reqIdToClient.delete(reqId);
    if (owner && mcpClients.has(owner)) {
      writeFrame(owner, ipcToolResponse(reqId, result, isError));
      log(`>> mcp: tool_response reqId=${reqId} isError=${isError} (routed to client)`);
    } else {
      log(`!! tool_response reqId=${reqId} with no live owner client (owner=${!!owner})`);
    }
    pumpQueue();
  } else {
    log(`?? unknown ext msg type: ${msg.type}`);
  }
}, (e, text) => log(`!! ext frame parse error: ${e.message} text=${text.slice(0, 120)}`));

process.stdin.on("data", feedExt);
process.stdin.on("end", () => { log("== ext stdin ended (Chrome closed)"); shutdown("ext stdin ended"); });
process.stdin.on("error", (e) => log(`!! stdin error: ${e.message}`));

// --- one-in-flight dispatch to the extension ---
// Only pump once the extension handshake is done (mcp_connected sent); the
// extension ignores tool_requests before that.
function pumpQueue() {
  if (!mcpConnectedSent) return;        // extension not ready yet
  if (pendingReqId != null) return;       // extension is busy
  const item = queue.shift();
  if (!item) return;
  pendingReqId = item.reqId;
  sendToExt(extToolRequest(item.tool, item.args));
  log(`>> ext: tool_request reqId=${item.reqId} tool=${item.tool}`);
}

// Called once after the first get_status completes the handshake.
function onHandshakeComplete() {
  if (!mcpConnectedSent) { mcpConnectedSent = true; sendToExt(extMcpConnected()); }
  log("== extension handshake complete; mcp_connected sent ==");
  // the bridge is now usable: tell ALL connected MCP clients and drain any queued requests
  broadcastToMcp(ipcBridgeReady());
  pumpQueue();
}

// --- IPC side (named pipe server, MCP clients connect) ---
// Supports MULTIPLE concurrent MCP clients. Each gets bridge_ready on connect
// (or when the handshake completes later). tool_response is routed by reqId to
// the owning client. This fixes the bug where a second MCP client (e.g. a test
// driver) would end() the session's long-lived client and corrupt its state.
const srv = createServer((sock) => {
  log("== mcp client connected to IPC pipe");
  mcpClients.add(sock);
  // bridge_ready is sent once the extension handshake is done. If the MCP
  // client connects after handshake, send now; otherwise onHandshakeComplete
  // will broadcast it when the extension becomes ready.
  if (mcpConnectedSent) { try { writeFrame(sock, ipcBridgeReady()); } catch {} }
  const feed = makeFrameReader((msg) => {
    if (msg.type === "tool_request" && msg.reqId != null && msg.tool) {
      log(`<< mcp: tool_request reqId=${msg.reqId} tool=${msg.tool}`);
      reqIdToClient.set(msg.reqId, sock);
      queue.push({ reqId: msg.reqId, tool: msg.tool, args: msg.args || {} });
      pumpQueue();
    } else if (msg.type === "ping") {
      try { writeFrame(sock, { type: "pong", timestamp: Date.now() }); } catch {}
    } else {
      log(`?? unknown ipc msg: ${JSON.stringify(msg).slice(0, 200)}`);
    }
  }, (e, text) => log(`!! ipc frame parse error: ${e.message}`));
  sock.on("data", feed);
  sock.on("error", (e) => log(`!! ipc sock error: ${e.message}`));
  sock.on("end", () => {
    log("== mcp client disconnected");
    mcpClients.delete(sock);
    // drop any reqId ownership pointing at this client (the in-flight request,
    // if any, stays in the queue/extension and its response will be logged as
    // no-live-owner — harmless).
    for (const [rid, c] of reqIdToClient) if (c === sock) reqIdToClient.delete(rid);
  });
});
srv.on("error", (e) => log(`!! ipc server error: ${e.message}`));
srv.listen(IPC_PIPE, () => log(`== IPC listening on ${IPC_PIPE}`));

// --- shutdown ---
let exiting = false;
function shutdown(reason) {
  if (exiting) return;
  exiting = true;
  log(`== native host shutting down: ${reason}`);
  broadcastToMcp(ipcBridgeGone(reason));
  for (const c of mcpClients) { try { c.end(); } catch {} }
  mcpClients.clear();
  reqIdToClient.clear();
  try { srv.close(); } catch {}
  try { process.exit(0); } catch {}
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
