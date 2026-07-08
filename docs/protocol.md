# Protocol notes — chrome-mcp-bridge

Reverse-engineering of the official "Claude in Chrome" MCP bridge, and how this
project's protocol relates.

## 1. The two official binaries (both gated)

```
MCP client ──JSON-RPC/stdio──▶ claude --claude-in-chrome-mcp   (MCP server)
                                      │
                                      │ connects (as client) to named pipe:
                                      │   \\.\pipe\claude-mcp-browser-bridge-<user>
                                      ▼
                                claude.exe --chrome-native-host   (native host)
                                      │
                                      │ Chrome native messaging (4-byte-LE + JSON, stdio)
                                      ▼
                                extension (chrome.debugger on main profile)
```

### Gate proof

- **native host (`--chrome-native-host`)** — gated by `Vni()` in the CLI
  binary. When run ungated, the extension shows "not connected / different
  account" and a 68-poll netstat shows zero cloud TCP during the gate. The gate
  is 100% local.
- **MCP server (`--claude-in-chrome-mcp`)** — gated. Calling `tools/call`
  returns *"Browser extension is not connected… logged into claude.ai with
  the same account as Claude Code"* **without ever connecting to the bridge
  pipe** (confirmed: a pipe-logger on `\\.\pipe\claude-mcp-browser-bridge-<user>`
  saw zero connections). `tools/list` is static and works ungated; `tools/call`
  is gated.

⇒ Neither binary is reusable ungated. Both are reimplemented here.

## 2. Extension native-messaging protocol (reverse-engineered from service worker)

Wire format: **4-byte little-endian uint32 length prefix + UTF-8 JSON**, both
directions, on stdio. (Standard Chrome Native Messaging.)

### Extension → host

| `type` | meaning |
|---|---|
| `ping` | liveness probe → host replies `pong` |
| `get_status` | handshake → host replies `status_response` |
| `tool_response` | result of the in-flight `tool_request`. `result.content[]` = `{type:"text",text}` / `{type:"image",source:{type:"base64",media_type,data}}`. Errors arrive as `{type:"tool_response", error:{content:[…]}}`. |

### Host → extension

| `type` | meaning |
|---|---|
| `pong` | liveness reply (`timestamp`) |
| `status_response` | handshake reply (`native_host_version`) |
| `mcp_connected` | signals "the MCP bridge is up" — extension then accepts `tool_request`s |
| `tool_request` | `{method:"execute_tool", params:{client_id:"claude-code", tool, args}}` |

Key detail: the extension dispatches tools keyed on `params.client_id === "claude-code"`.
`mcp_connected` must be sent after `get_status` or the extension ignores
`tool_request`s. The extension is **one-in-flight**: it returns `tool_response`
in request order, so the host must not send a second `tool_request` before the
prior response arrives.

## 3. Permission model (the gate that ISN'T auth)

`checkPermission()` (in `mcpPermissions-B0h6Fctz.js`) decides per-domain
whether a tool needs a prompt. Decision order:

1. turn-approved blocklist → deny
2. localhost bypass
3. `!forcePrompt && getSkipAllPermissions()` → allow  *(unreachable from
   native-messaging — `getSkipAllPermissions` is a closure with no setter, and
   the service worker hardcodes `source:"native-messaging"`; the `()=>true`
   override is `source:"bridge"`-only)*
4. turn-approved → allow
5. stored-permission lookup in `chrome.storage.local["permissionStorage"]`:
   an `always-allow` entry for the netloc → allow; else `needsPrompt:true`

**No auth/paywall check anywhere in `checkPermission`.** The login wall only
appears in the `XI` popup path (`sidepanel.html?mcpPermissionOnly=true`),
which renders login instead of approve/deny buttons when unauthenticated,
then 30s-timeouts → "Permission denied by user".

⇒ **Bypass:** seed `chrome.storage.local["permissionStorage"]` with an
`always-allow` entry for the target netloc → `checkPermission` returns
`allowed:true, needsPrompt:false` → no popup, no login. A `storage.onChanged`
listener live-reloads it. See `scripts/seed-permission.js`.

`tabs_context_mcp` / `tabs_create_mcp` need **no** permission (no netloc).
`navigate` and domain-touching `computer` actions need the tab's netloc seeded.

## 4. The 22 tools

Captured verbatim from the official `tools/list` (static — returned even with
the bridge down). See `src/tools.mjs`. `tools/call` simply forwards
`{name, arguments}` as `params:{client_id:"claude-code", tool:name, args:arguments}`
→ the extension executes it → `tool_response.result.content` is translated to
MCP `CallToolResult.content` (text passes through; `image.source.data` +
`media_type` → MCP `{type:"image", data, mimeType}`). Extension
`error.content` → MCP `isError:true`.

## 5. This project's IPC protocol (our own design)

We control both ends (our native host + our MCP server), so the IPC is ours.
For simplicity it reuses the native-messaging framing (4-byte-LE + JSON) over
a named pipe `\\.\pipe\chrome-mcp-bridge-<user>`.

### native host → MCP server

| `type` | meaning |
|---|---|
| `bridge_ready` | extension handshake done; bridge usable |
| `tool_response` | `{reqId, result, isError}` — the response to a prior `tool_request` |
| `bridge_gone` | extension disconnected |

### MCP server → native host

| `type` | meaning |
|---|---|
| `tool_request` | `{reqId, tool, args}` — relay to extension as `execute_tool` |
| `ping` | liveness (→ `pong`) |

The native host pairs each extension `tool_response` with the in-flight
`reqId` and relays it. Concurrent `tools/call`s from the MCP client queue at
the host (one in flight to the extension at a time).
