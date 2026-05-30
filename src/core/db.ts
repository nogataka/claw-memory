// src/core/db.ts
//
// Storage foundation: better-sqlite3 + sqlite-vec (in-process vector search) +
// FTS5 keyword fallback. No ORM, no daemon, no Python.

import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { dbPath } from "./paths.js";

export const sqlite = new Database(dbPath);

sqlite.pragma("journal_mode = WAL");
sqlite.pragma("busy_timeout = 5000");
sqlite.pragma("foreign_keys = ON");

// Load the sqlite-vec extension (provides the vec0 virtual table).
sqliteVec.load(sqlite);

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_accessed_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS session_summaries (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    summary TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS user_preferences (
    id TEXT PRIMARY KEY,
    project_id TEXT,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS app_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS conversation_chunks (
    id TEXT PRIMARY KEY,
    vec_rowid INTEGER NOT NULL,
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    user_text TEXT NOT NULL,
    assistant_text TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS distill_watermarks (
    path TEXT PRIMARY KEY,
    mtime_ms INTEGER NOT NULL,
    distilled_at TEXT NOT NULL
  );
`);

// --- Additive, migration-less schema evolution -----------------------------
// New columns are added with try/catch so existing ~/.claw-memory/memory.db
// files keep working (SQLite ALTER TABLE ADD COLUMN can't be IF NOT EXISTS).
for (const col of [
  "obs_type TEXT",
  "concepts TEXT",
  "files_read TEXT",
  "files_modified TEXT",
  "deleted_at TEXT",
]) {
  try {
    sqlite.exec(`ALTER TABLE conversation_chunks ADD COLUMN ${col}`);
  } catch {
    // column already exists
  }
}

// vec0 virtual table — embedding + project_id metadata column so KNN can filter
// by project inside the MATCH query (no post-filter loss).
sqlite.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
    embedding float[384] distance_metric=cosine,
    project_id text
  );
`);

// FTS5 keyword index over chunk text (claude-mem-style fallback when the query
// is keyword-ish and semantic similarity is weak). Content-less; chunk_id links
// back to conversation_chunks.id. Uses the trigram tokenizer: it matches
// case-insensitive substrings (>=3 chars), which is essential for Japanese text
// that has no word spaces and for Latin words glued to CJK (e.g. "TypeScriptの").
sqlite.exec(`
  CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
    chunk_id UNINDEXED,
    text,
    tokenize = 'trigram'
  );
`);
