#!/usr/bin/env bash
# claw-memory lifecycle-hook wrapper.
#   Usage (in ~/.claude/settings.json): "<this>/claw-hook.sh <distill|recall>"
# Reads the hook's JSON from stdin and forwards it to the claw-memory CLI.
# For `recall`, stdout is injected into Claude's context; `distill` is detached
# and fire-and-forget. Always exits 0 so a memory hiccup never blocks a session.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
MODE="${1:-recall}"
cat | node "${DIR}/../dist/cli.js" hook "${MODE}" 2>/dev/null || true
