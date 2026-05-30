// src/core/memory.ts
import { randomUUID } from "node:crypto";
import { sqlite } from "./db.js";

export interface SummaryRow {
  id: string;
  project_id: string;
  session_id: string;
  summary: string;
  created_at: string;
}

export interface PreferenceRow {
  id: string;
  project_id: string | null;
  key: string;
  value: string;
  updated_at: string;
}

/**
 * Canonical preference keys. The distill prompt is instructed to choose from
 * this set, and setPreference() normalizes incoming keys toward it so synonyms
 * (e.g. "preferred_language" / "言語") don't create duplicate rows.
 */
export const CANONICAL_PREFERENCE_KEYS = [
  "language",
  "response_style",
  "detail_level",
  "code_style",
  "framework",
  "tone",
  "tools",
] as const;

const KEY_ALIASES: Record<string, string> = {
  preferred_language: "language",
  lang: "language",
  言語: "language",
  言語設定: "language",
  response_format: "response_style",
  reply_style: "response_style",
  回答スタイル: "response_style",
  応答スタイル: "response_style",
  verbosity: "detail_level",
  detail: "detail_level",
  詳細度: "detail_level",
  coding_style: "code_style",
  コードスタイル: "code_style",
  frameworks: "framework",
  フレームワーク: "framework",
  口調: "tone",
  tooling: "tools",
  ツール: "tools",
};

/** Map known aliases to a canonical key; otherwise lower/snake-case (kept, not dropped). */
export function normalizePreferenceKey(key: string): string {
  const trimmed = key.trim();
  const lower = trimmed.toLowerCase();
  if (KEY_ALIASES[trimmed]) return KEY_ALIASES[trimmed];
  if (KEY_ALIASES[lower]) return KEY_ALIASES[lower];
  if ((CANONICAL_PREFERENCE_KEYS as readonly string[]).includes(lower)) {
    return lower;
  }
  return lower.replace(/[\s-]+/g, "_");
}

export function addSessionSummary(
  projectId: string,
  sessionId: string,
  summary: string
): void {
  // Upsert by session: delete existing then insert.
  sqlite
    .prepare("DELETE FROM session_summaries WHERE session_id = ?")
    .run(sessionId);
  sqlite
    .prepare(
      "INSERT INTO session_summaries(id, project_id, session_id, summary, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(randomUUID(), projectId, sessionId, summary, new Date().toISOString());
}

export function getRecentSummaries(projectId: string, limit = 5): SummaryRow[] {
  return sqlite
    .prepare(
      "SELECT * FROM session_summaries WHERE project_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .all(projectId, limit) as SummaryRow[];
}

export function getPreferences(projectId: string): PreferenceRow[] {
  return sqlite
    .prepare("SELECT * FROM user_preferences WHERE project_id = ?")
    .all(projectId) as PreferenceRow[];
}

export function setPreference(
  projectId: string | null,
  key: string,
  value: string
): void {
  key = normalizePreferenceKey(key);
  if (projectId) {
    sqlite
      .prepare("DELETE FROM user_preferences WHERE project_id = ? AND key = ?")
      .run(projectId, key);
  }
  sqlite
    .prepare(
      "INSERT INTO user_preferences(id, project_id, key, value, updated_at) VALUES (?, ?, ?, ?, ?)"
    )
    .run(randomUUID(), projectId, key, value, new Date().toISOString());
}
