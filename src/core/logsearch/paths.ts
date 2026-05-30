// src/core/logsearch/paths.ts
//
// Roots for raw agent transcript logs searched by the cc-search port.
// Read-only; these belong to Claude Code / Codex, not to claw-memory.

import os from "node:os";
import path from "node:path";

export const claudeProjectsRoot = path.join(os.homedir(), ".claude", "projects");
export const codexSessionsRoot = path.join(os.homedir(), ".codex", "sessions");

/** Max transcript size to scan; larger files are skipped (cc-search parity). */
export const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024;

export const UUID_JSONL_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
