// src/core/paths.ts
import path from "node:path";
import os from "node:os";
import fs from "node:fs";

/**
 * Root data directory for claw-memory. Independent of agent-claw's data/chat.db.
 * Override with CLAW_MEMORY_DIR.
 */
export const dataDir =
  process.env.CLAW_MEMORY_DIR || path.join(os.homedir(), ".claw-memory");

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

export const dbPath = path.join(dataDir, "memory.db");
