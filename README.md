# chrome-mcp-bridge

An **ungated** reimplementation of the "Claude in Chrome" MCP bridge. Exposes the same **22 browser-automation tools** to any MCP client (Claude Code, Codex, Cursor, …), driving the **official Claude Chrome extension** via native messaging — **no claude.ai login required**.

## Why this exists

The official "Claude in Chrome" integration is two gated binaries:

| Official binary | Role | Gate |
|---|---|---|
| `claude.exe --chrome-native-host` | native host (Chrome-spawned, talks to the extension) | account-gated (`Vni()`) |
| `claude --claude-in-chrome-mcp` | MCP server (MCP-client-spawned, stdio JSON-RPC) | account-gated (refuses to engage the bridge without login) |

Both were proven gated by reverse-engineering: the native host never connects the extension unless logged in, and the MCP server returns *"Browser extension is not connected… logged into claude.ai with the same account"* without ever touching the bridge pipe. So the real binaries **cannot** be reused ungated.

This project replaces **both** halves with ungated reimplementations. The extension itself is **not** modified — only its native-messaging host is swapped (a manifest `path` change) and a permission seed is applied to its `chrome.storage.local` (reversible).

## Architecture

```
┌─────────────┐  JSON-RPC 2.0 (stdio)   ┌──────────────────┐  named pipe        ┌─────────────────────┐  native messaging   ┌────────────┐
│  MCP client │ ───────────────────────▶ │  src/mcp-server  │ ──────────────────▶│  src/native-host     │ ───────────────────▶│ extension │
│ (Claude etc)│                          │  .mjs (22 tools) │  \\.\pipe\chrome-  │  .mjs (manifest     │  4-byte-LE + JSON   │ (chrome.   │
└─────────────┘                          └──────────────────┘   mcp-bridge-<user>  │  `path`, ungated)   │                     │  debugger) │
                                                                                    └─────────────────────┘                     └────────────┘
```

- **`src/native-host.mjs`** — Chrome spawns this (via the manifest `path`) when the extension calls `connectNative`. Handles the extension handshake (`ping`→`pong`, `get_status`→`status_response`, sends `mcp_connected`), and relays `tool_request`/`tool_response` to/from a named-pipe IPC server. One-in-flight dispatch (the extension processes requests sequentially).
- **`src/mcp-server.mjs`** — spawned by the MCP client over stdio. Speaks JSON-RPC 2.0 (protocol `2025-06-18`). Exposes all 22 tools (static catalog from `tools/list`). On `tools/call`, connects to the IPC pipe, sends a `tool_request`, awaits the matching `tool_response`, translates the result to MCP content (text + base64 images).
- **`src/protocol.mjs`** — shared 4-byte-LE-length-prefixed frame codec (used for both native messaging and IPC), message constructors, and extension→MCP content translation.
- **`src/tools.mjs`** — the 22-tool catalog, captured verbatim from the official server's `tools/list`.

Both wire protocols share the same framing (4-byte little-endian length prefix + UTF-8 JSON), so one codec serves both.

## The 22 tools

`tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`, `navigate`, `computer` (left_click/right_click/type/screenshot/wait/scroll/key/left_click_drag/double_click/triple_click/zoom/scroll_to/hover), `browser_batch`, `read_page`, `find`, `form_input`, `javascript_tool`, `get_page_text`, `resize_window`, `read_console_messages`, `read_network_requests`, `gif_creator`, `upload_image`, `file_upload`, `shortcuts_list`, `shortcuts_execute`, `switch_browser`, `list_connected_browsers`, `select_browser`.

Schemas are in [`src/tools.mjs`](src/tools.mjs) — identical to the official server's.

## Install

### 1. Native host (so Chrome spawns this bridge instead of the gated CLI host)

```bat
:: copy the launcher into Chrome's native-host dir
copy install\chrome-native-host-bridge.bat  %USERPROFILE%\.claude\chrome\

:: repoint the manifest `path` to it (edit the JSON at)
::   %APPDATA%\Claude Code\ChromeNativeHost\com.anthropic.claude_code_browser_extension.json
::   "path": "C:\\Users\\<you>\\.claude\\chrome\\chrome-native-host-bridge.bat"
```

The manifest `name` must stay `com.anthropic.claude_code_browser_extension` (the extension looks for that exact native-messaging host name) and `allowed_origins` must include `chrome-extension://fcoeoabgfenejglbffodgkkbkcdhcgfn/`.

Then **reload the Claude extension** at `chrome://extensions`. Chrome spawns `chrome-native-host-bridge.bat` → `src/native-host.mjs`, which creates the IPC pipe and completes the extension handshake.

### 2. Permission seed (one-time, per domain)

The extension's per-domain permission gate (`checkPermission`) has **no auth check** — a stored `always-allow` entry short-circuits to allowed with no prompt and no login. Seed it for any domain you want to `navigate`/interact with:

```js
// chrome://extensions → Claude extension → "Service Worker" → paste:
// (edit NETLOCS in scripts/seed-permission.js first)
```

See [`scripts/seed-permission.js`](scripts/seed-permission.js). `tabs_context_mcp` and `tabs_create_mcp` need **no** permission; `navigate` and most `computer` actions on a tab need the tab's netloc seeded.

### 3. MCP client (add this server to your MCP client)

```bash
# Claude Code example:
claude mcp add chrome-mcp-bridge -- node C:/Users/<you>/work/chrome-mcp-bridge/src/mcp-server.mjs
```

Any MCP client that can spawn a stdio command works.

## Usage / test

```bash
# offline: list the 22 tools (no bridge needed)
node test/drive-mcp-server.mjs list

# end-to-end (bridge must be up = extension reloaded):
node test/drive-mcp-server.mjs tabs                           # tabs_context_mcp
node test/drive-mcp-server.mjs navigate https://example.com   # navigate + screenshot
node test/drive-mcp-server.mjs call computer '{"action":"screenshot","tabId":123,"save_to_disk":true}'
```

## Status

- ✅ MCP server `initialize` + `tools/list` (all 22 tools, protocol `2025-06-18`).
- ✅ Native host: extension handshake (`ping`/`get_status`/`mcp_connected`) + IPC pipe + one-in-flight relay.
- ✅ End-to-end `tools/call` flow **proven ungated** (no claude.ai login): `tabs_context_mcp` → `get_page_text` → `javascript_tool` (javascript_exec), all relayed through the bridge.
- ✅ `javascript_exec` reads SPA page content that `get_page_text` misses: on a `cloud.tencent.com` doc page, `get_page_text` returned 250 chars (marketing shell only); `javascript_exec` (wait + `innerText` extract) returned 1011 chars including the real API-action list the SPA loads async. So for JS-rendered pages, prefer `javascript_exec`.
- Reversible: restore the manifest `path` to the original `chrome-native-host.bat` to return to the gated CLI host; `chrome.storage.local.remove("permissionStorage")` to undo the seed.

## How it was reverse-engineered

See [`docs/protocol.md`](docs/protocol.md). Short version:

1. **Tool catalog** — captured verbatim from the official `claude --claude-in-chrome-mcp` server's `tools/list` (it's static metadata, returned even with the bridge down).
2. **Extension native-messaging protocol** — reverse-engineered from the extension's service worker (`service-worker.ts-*.js`, `mcpPermissions-*.js`): `ping`→`pong`, `get_status`→`status_response`, `{type:"mcp_connected"}`, `{type:"tool_request",method:"execute_tool",params:{client_id:"claude-code",tool,args}}` ↔ `{type:"tool_response",result:{content:[…]}}`. 4-byte-LE-length-prefixed UTF-8 JSON on stdio.
3. **Gate location** — proven in both binaries (see above); neither can be reused, so both are reimplemented here.
4. **IPC protocol** — our own design (we control both ends), reusing the native-messaging framing for simplicity.

## License

MIT. Not affiliated with Anthropic. "Claude" and "Chrome" are trademarks of their owners. This is an independent, ungated reimplementation for authorized automation of your own browser.
