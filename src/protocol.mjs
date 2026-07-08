// Shared protocol for chrome-mcp-bridge: frame codec, IPC message types,
// and translation between MCP CallToolResult and the extension's tool_response.
//
// TWO wire protocols use the SAME 4-byte-LE-length-prefixed UTF-8 JSON framing:
//   1. Chrome Native Messaging (extension <-> native host, over stdio)
//   2. Our IPC (native host <-> MCP server, over a named pipe)
// So one codec serves both.

import { userInfo } from "node:os";

// --- constants -------------------------------------------------------------
export const EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
export const NATIVE_HOST_NAME = "com.anthropic.claude_code_browser_extension"; // extension looks for this exact name
export const IPC_PIPE = `\\\\.\\pipe\\chrome-mcp-bridge-${userInfo().username || "user"}`;
export const CLIENT_ID = "claude-code"; // the extension keys tool dispatch on this

// --- frame codec -----------------------------------------------------------
// writeFrame(stream, obj): frame obj as 4-byte-LE-len + UTF-8 JSON, write to stream.
export function writeFrame(stream, obj) {
  const json = JSON.stringify(obj);
  const buf = Buffer.from(json, "utf8");
  const hdr = Buffer.alloc(4);
  hdr.writeUInt32LE(buf.length, 0);
  stream.write(Buffer.concat([hdr, buf]));
}

// makeFrameReader(onObj): returns a feed(chunk) function. Accumulates bytes,
// extracts complete frames, parses JSON, calls onObj(obj) for each.
export function makeFrameReader(onObj, onParseError) {
  let buf = Buffer.alloc(0);
  return function feed(chunk) {
    buf = Buffer.concat([buf, chunk]);
    let off = 0;
    for (;;) {
      if (off + 4 > buf.length) break;
      const len = buf.readUInt32LE(off);
      if (off + 4 + len > buf.length) break;
      const text = buf.subarray(off + 4, off + 4 + len).toString("utf8");
      try {
        onObj(JSON.parse(text));
      } catch (e) {
        if (onParseError) onParseError(e, text);
      }
      off += 4 + len;
    }
    if (off > 0) buf = buf.subarray(off);
  };
}

// --- extension-side messages (native messaging) ----------------------------
// host -> extension
export const extPong = () => ({ type: "pong", timestamp: Date.now() });
export const extStatusResponse = () => ({ type: "status_response", native_host_version: "1.0.0" });
export const extMcpConnected = () => ({ type: "mcp_connected" });
export const extToolRequest = (tool, args) => ({
  type: "tool_request",
  method: "execute_tool",
  params: { client_id: CLIENT_ID, tool, args },
});

// --- IPC messages (native host <-> MCP server) -----------------------------
// bridge -> mcp
export const ipcBridgeReady = () => ({ type: "bridge_ready" });
export const ipcBridgeGone = (reason) => ({ type: "bridge_gone", reason });
export const ipcToolResponse = (reqId, result, isError) => ({ type: "tool_response", reqId, result, isError: !!isError });
// mcp -> bridge
export const ipcToolRequest = (reqId, tool, args) => ({ type: "tool_request", reqId, tool, args });
export const ipcPing = () => ({ type: "ping" });

// --- translation: extension tool_response -> MCP CallToolResult content ----
// Extension result.content: array of
//   { type:"text", text }                       -> MCP { type:"text", text }
//   { type:"image", source:{ type:"base64", media_type, data } }
//                                               -> MCP { type:"image", data, mimeType }
// Extension error: { type:"tool_response", error:{ content:[...] } } -> isError=true
export function extensionResultToMcpContent(result) {
  const content = [];
  const src = (result && Array.isArray(result.content)) ? result.content : [];
  for (const c of src) {
    if (!c) continue;
    if (c.type === "text" && typeof c.text === "string") {
      content.push({ type: "text", text: c.text });
    } else if (c.type === "image" && c.source && c.source.type === "base64" && c.source.data) {
      content.push({ type: "image", data: c.source.data, mimeType: c.source.media_type || "image/jpeg" });
    }
  }
  return content;
}
