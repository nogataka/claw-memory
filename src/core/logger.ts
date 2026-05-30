// src/core/logger.ts
//
// Best-effort structured daily log at ~/.claw-memory/logs/claw-YYYY-MM-DD.log.
// Never throws — logging must not break a memory operation or a hook.

import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { dataDir } from "./paths.js";

const logsDir = path.join(dataDir, "logs");

export function log(event: string, data?: Record<string, unknown>): void {
  try {
    mkdirSync(logsDir, { recursive: true });
    const now = new Date().toISOString();
    const line = JSON.stringify({ t: now, event, ...(data ?? {}) }) + "\n";
    appendFileSync(path.join(logsDir, `claw-${now.slice(0, 10)}.log`), line);
  } catch {
    // logging is non-critical
  }
}
