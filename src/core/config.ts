// src/core/config.ts
import { sqlite } from "./db.js";

export function getConfig(key: string): string | undefined {
  const row = sqlite
    .prepare("SELECT value FROM app_config WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setConfig(key: string, value: string): void {
  sqlite
    .prepare(
      `INSERT INTO app_config(key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
    .run(key, value);
}
