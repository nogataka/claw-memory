// src/core/watermark.ts
//
// Incremental distill bookkeeping: remember the mtime of each transcript we've
// already distilled so hooks can skip sessions with no new content.

import { sqlite } from "./db.js";

/** True if the transcript at `path` is newer than the last time we distilled it. */
export function shouldDistill(path: string, mtimeMs: number): boolean {
  const row = sqlite
    .prepare("SELECT mtime_ms FROM distill_watermarks WHERE path = ?")
    .get(path) as { mtime_ms: number } | undefined;
  return !row || mtimeMs > row.mtime_ms;
}

export function markDistilled(path: string, mtimeMs: number): void {
  sqlite
    .prepare(
      `INSERT INTO distill_watermarks(path, mtime_ms, distilled_at)
       VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET mtime_ms = excluded.mtime_ms, distilled_at = excluded.distilled_at`
    )
    .run(path, mtimeMs, new Date().toISOString());
}
