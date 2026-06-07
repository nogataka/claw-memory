// src/core/logsearch/paths.ts
//
// Roots for raw agent transcript logs searched by the cc-search port.
// Read-only; these belong to Claude Code / Codex, not to claw-memory.

import os from "node:os";
import path from "node:path";

export const claudeProjectsRoot = path.join(os.homedir(), ".claude", "projects");
export const codexSessionsRoot = path.join(os.homedir(), ".codex", "sessions");

/**
 * Where to look for ChatGPT web "Export data" bundles (`conversations.json`).
 * Unlike Claude Code / Codex, ChatGPT web conversations are NOT stored locally —
 * the user downloads the official export and drops the file(s) here. Override
 * `CLAW_MEMORY_CHATGPT_EXPORT` with either a single file or a directory.
 */
export const chatgptExportRoot =
  process.env.CLAW_MEMORY_CHATGPT_EXPORT ||
  path.join(os.homedir(), ".claw-memory", "chatgpt");

/** Max transcript size to scan; larger files are skipped (cc-search parity). */
export const MAX_LOG_FILE_SIZE = 10 * 1024 * 1024;

/**
 * ChatGPT exports are a single JSON file holding the whole account history, so
 * they can be much larger than a per-session transcript. JSON.parse reads the
 * whole file into memory; this cap (default 200 MB) bounds that. Override with
 * `CLAW_MEMORY_CHATGPT_MAX_BYTES`.
 */
export const MAX_CHATGPT_FILE_SIZE = Number(
  process.env.CLAW_MEMORY_CHATGPT_MAX_BYTES ?? 200 * 1024 * 1024
);

export const UUID_JSONL_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jsonl$/i;
