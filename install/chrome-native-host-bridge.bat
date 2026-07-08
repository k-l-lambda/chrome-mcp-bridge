@echo off
REM chrome-mcp-bridge — native host launcher (Chrome spawns this via the manifest).
REM Stdio = native-messaging channel (framed). stderr redirected here for debugging.
REM
REM Install: copy this file + the manifest JSON, set the manifest `path` to this bat.
REM See install/README.md.
setlocal
set "CMB_LOG_DIR=%APPDATA%\Claude Code\ChromeNativeHost\logs"
if not exist "%CMB_LOG_DIR%" mkdir "%CMB_LOG_DIR%"
"C:\Program Files\nodejs\node.exe" "C:\Users\kllam\work\chrome-mcp-bridge\src\native-host.mjs" 2>>"%CMB_LOG_DIR%\native-host.stderr.log"
endlocal
