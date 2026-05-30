#!/usr/bin/env bash
# claw-memory binary resolver — used by plugin hooks and the plugin MCP server.
#   hooks:  claw-hook.sh hook <recall|distill>   (hook JSON on stdin)
#   mcp:    claw-hook.sh mcp                      (stdio MCP server)
# Prefers a globally installed `claw-memory`; falls back to npx. stdin/stdout are
# inherited so hook input and MCP stdio pass through. Never blocks a session:
# hook failures are swallowed, but `mcp` must exec directly (no error masking).
set -euo pipefail

run() {
  if command -v claw-memory >/dev/null 2>&1; then
    exec claw-memory "$@"
  fi
  exec npx -y @nogataka/claw-memory@latest "$@"
}

if [ "${1:-}" = "mcp" ]; then
  run "$@"
else
  run "$@" 2>/dev/null || true
fi
