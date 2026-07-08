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
let mcpClient = null;              // the connected MCP server (net socket)
let pendingReqId = null;           // reqId currently in flight to the extension
const queue = [];                  // pending IPC tool_requests waiting for the extension

function sendToExt(obj) { writeFrame(process.stdout, obj); }

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
    // extension finished the in-flight request. pair with pendingReqId, relay to MCP.
    const reqId = pendingReqId;
    pendingReqId = null;
    const isError = !!(msg.result && msg.result.error) || !!(msg.error);
    const result = msg.error || msg.result;
    if (reqId != null && mcpClient) {
      writeFrame(mcpClient, ipcToolResponse(reqId, result, isError));
      log(`>> mcp: tool_response reqId=${reqId} isError=${isError}`);
    } else {
      log(`!! tool_response with no pending reqId (reqId=${reqId}, mcpClient=${!!mcpClient})`);
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
  // the bridge is now usable: tell the MCP client (if connected) and drain any queued requests
  if (mcpClient) writeFrame(mcpClient, ipcBridgeReady());
  pumpQueue();
}

// --- IPC side (named pipe server, MCP client connects) ---
const srv = createServer((sock) => {
  log("== mcp client connected to IPC pipe");
  if (mcpClient) { try { mcpClient.end(); } catch {} }
  mcpClient = sock;
  // bridge_ready is sent once the extension handshake is done. If the MCP
  // client connects after handshake, send now; otherwise onHandshakeComplete
  // will send it when the extension becomes ready.
  if (mcpConnectedSent) writeFrame(sock, ipcBridgeReady());
  const feed = makeFrameReader((msg) => {
    if (msg.type === "tool_request" && msg.reqId != null && msg.tool) {
      log(`<< mcp: tool_request reqId=${msg.reqId} tool=${msg.tool}`);
      queue.push({ reqId: msg.reqId, tool: msg.tool, args: msg.args || {} });
      pumpQueue();
    } else if (msg.type === "ping") {
      writeFrame(sock, { type: "pong", timestamp: Date.now() });
    } else {
      log(`?? unknown ipc msg: ${JSON.stringify(msg).slice(0, 200)}`);
    }
  }, (e, text) => log(`!! ipc frame parse error: ${e.message}`));
  sock.on("data", feed);
  sock.on("error", (e) => log(`!! ipc sock error: ${e.message}`));
  sock.on("end", () => { log("== mcp client disconnected"); if (mcpClient === sock) mcpClient = null; });
});
srv.on("error", (e) => log(`!! ipc server error: ${e.message}`));
srv.listen(IPC_PIPE, () => log(`== IPC listening on ${IPC_PIPE}`));

// --- shutdown ---
let exiting = false;
function shutdown(reason) {
  if (exiting) return;
  exiting = true;
  log(`== native host shutting down: ${reason}`);
  if (mcpClient) { try { writeFrame(mcpClient, ipcBridgeGone(reason)); mcpClient.end(); } catch {} }
  try { srv.close(); } catch {}
  try { process.exit(0); } catch {}
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
