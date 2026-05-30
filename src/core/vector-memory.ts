// src/core/vector-memory.ts
//
// Vector store (sqlite-vec) + keyword index (FTS5). Vectors and readable
// metadata are split across vec_chunks (vec0) and conversation_chunks.
// Chunks carry optional structured metadata (obs_type / concepts / files) and a
// deleted_at tombstone; all reads exclude tombstoned rows.

import { randomUUID } from "node:crypto";
import { sqlite } from "./db.js";

export interface ChunkInput {
  projectId: string;
  sessionId: string;
  userText: string;
  assistantText: string;
  embedding: Float32Array;
  obsType?: string | null;
  concepts?: string[];
  filesRead?: string[];
  filesModified?: string[];
}

export interface ChunkRow {
  id: string;
  sessionId: string;
  projectId: string;
  userText: string;
  assistantText: string;
  createdAt: string;
  obsType: string | null;
  concepts: string[];
  filesRead: string[];
  filesModified: string[];
}

export interface SimilarChunk extends ChunkRow {
  distance: number;
}

/** Metadata filters applied on top of vector / keyword search. */
export interface ChunkFilter {
  obsType?: string;
  concept?: string; // substring within concepts
  file?: string; // substring within files_read/files_modified
  dateFrom?: string; // created_at >= (ISO)
  dateTo?: string; // created_at <= (ISO, end-of-day exclusive handled by caller)
}

function jsonArr(v?: string[]): string | null {
  return v && v.length ? JSON.stringify(v) : null;
}
function parseArr(v: unknown): string[] {
  if (typeof v !== "string" || !v) return [];
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
}

/** True if an identical (project, user, assistant) chunk already exists (live). */
export function chunkExists(
  projectId: string,
  userText: string,
  assistantText: string
): boolean {
  const row = sqlite
    .prepare(
      `SELECT 1 FROM conversation_chunks
       WHERE project_id = ? AND user_text = ? AND assistant_text = ? AND deleted_at IS NULL
       LIMIT 1`
    )
    .get(projectId, userText, assistantText);
  return !!row;
}

/** Save conversation chunks: vec0 embedding + metadata row + FTS keyword row, atomically. */
export function saveChunks(chunks: ChunkInput[]): string[] {
  const insertVec = sqlite.prepare(
    "INSERT INTO vec_chunks(embedding, project_id) VALUES (?, ?)"
  );
  const insertMeta = sqlite.prepare(
    `INSERT INTO conversation_chunks(
        id, vec_rowid, project_id, session_id, user_text, assistant_text, created_at,
        obs_type, concepts, files_read, files_modified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertFts = sqlite.prepare(
    "INSERT INTO chunks_fts(chunk_id, text) VALUES (?, ?)"
  );

  const ids: string[] = [];
  const tx = sqlite.transaction(() => {
    for (const chunk of chunks) {
      const res = insertVec.run(
        Buffer.from(chunk.embedding.buffer),
        chunk.projectId
      );
      const vecRowid = res.lastInsertRowid as number;
      const id = randomUUID();
      const now = new Date().toISOString();
      insertMeta.run(
        id,
        vecRowid,
        chunk.projectId,
        chunk.sessionId,
        chunk.userText,
        chunk.assistantText,
        now,
        chunk.obsType ?? null,
        jsonArr(chunk.concepts),
        jsonArr(chunk.filesRead),
        jsonArr(chunk.filesModified)
      );
      insertFts.run(id, `${chunk.userText}\n${chunk.assistantText}`);
      ids.push(id);
    }
  });
  tx();
  return ids;
}

const CHUNK_COLS = `c.id, c.session_id, c.project_id, c.user_text, c.assistant_text,
  c.created_at, c.obs_type, c.concepts, c.files_read, c.files_modified`;

/** Build the metadata WHERE fragment (always excludes tombstones). */
function metaWhere(filter?: ChunkFilter): { sql: string; params: string[] } {
  const clauses = ["c.deleted_at IS NULL"];
  const params: string[] = [];
  if (filter?.obsType) {
    clauses.push("c.obs_type = ?");
    params.push(filter.obsType);
  }
  if (filter?.concept) {
    clauses.push("c.concepts LIKE ?");
    params.push(`%${filter.concept}%`);
  }
  if (filter?.file) {
    clauses.push("(c.files_read LIKE ? OR c.files_modified LIKE ?)");
    params.push(`%${filter.file}%`, `%${filter.file}%`);
  }
  if (filter?.dateFrom) {
    clauses.push("c.created_at >= ?");
    params.push(filter.dateFrom);
  }
  if (filter?.dateTo) {
    clauses.push("c.created_at <= ?");
    params.push(filter.dateTo);
  }
  return { sql: clauses.join(" AND "), params };
}

/** KNN semantic search, filtered by project inside the MATCH query. */
export function searchSimilar(
  queryEmbedding: Float32Array,
  projectId: string,
  topK = 5,
  maxDistance?: number,
  filter?: ChunkFilter
): SimilarChunk[] {
  const meta = metaWhere(filter);
  const distClause = maxDistance != null ? " AND v.distance <= ?" : "";
  const stmt = sqlite.prepare(`
    SELECT ${CHUNK_COLS}, v.distance
    FROM (
      SELECT rowid, distance FROM vec_chunks
      WHERE embedding MATCH ? AND k = ? AND project_id = ?
    ) v
    INNER JOIN conversation_chunks c ON c.vec_rowid = v.rowid
    WHERE ${meta.sql}${distClause}
    ORDER BY v.distance
  `);

  const params: Array<Buffer | number | string> = [
    Buffer.from(queryEmbedding.buffer),
    topK,
    projectId,
    ...meta.params,
  ];
  if (maxDistance != null) params.push(maxDistance);

  return (stmt.all(...params) as RawRow[]).map(mapRow);
}

/** FTS5 keyword search (fallback / augmentation for keyword-ish queries). */
export function searchKeyword(
  query: string,
  projectId: string,
  limit = 5,
  filter?: ChunkFilter
): ChunkRow[] {
  const match = toFtsQuery(query);
  if (!match) return [];
  const meta = metaWhere(filter);
  const rows = sqlite
    .prepare(
      `SELECT ${CHUNK_COLS}
       FROM chunks_fts f
       INNER JOIN conversation_chunks c ON c.id = f.chunk_id
       WHERE f.text MATCH ? AND c.project_id = ? AND ${meta.sql}
       LIMIT ?`
    )
    .all(match, projectId, ...meta.params, limit) as RawRow[];
  return rows.map(mapRow);
}

export function getChunksByIds(ids: string[]): ChunkRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = sqlite
    .prepare(
      `SELECT ${CHUNK_COLS} FROM conversation_chunks c
       WHERE c.id IN (${placeholders}) AND c.deleted_at IS NULL`
    )
    .all(...ids) as RawRow[];
  return rows.map(mapRow);
}

export function listChunks(projectId: string, limit = 200): ChunkRow[] {
  const rows = sqlite
    .prepare(
      `SELECT ${CHUNK_COLS} FROM conversation_chunks c
       WHERE c.project_id = ? AND c.deleted_at IS NULL
       ORDER BY c.created_at DESC LIMIT ?`
    )
    .all(projectId, limit) as RawRow[];
  return rows.map(mapRow);
}

export function deleteChunksBySession(sessionId: string): void {
  const rows = sqlite
    .prepare("SELECT id, vec_rowid FROM conversation_chunks WHERE session_id = ?")
    .all(sessionId) as Array<{ id: string; vec_rowid: number }>;
  if (rows.length === 0) return;

  const deleteVec = sqlite.prepare("DELETE FROM vec_chunks WHERE rowid = ?");
  const deleteFts = sqlite.prepare("DELETE FROM chunks_fts WHERE chunk_id = ?");
  const deleteMeta = sqlite.prepare(
    "DELETE FROM conversation_chunks WHERE session_id = ?"
  );
  const tx = sqlite.transaction(() => {
    for (const row of rows) {
      deleteVec.run(row.vec_rowid);
      deleteFts.run(row.id);
    }
    deleteMeta.run(sessionId);
  });
  tx();
}

/** Soft-delete chunks by id (memory_forget). Returns the number tombstoned. */
export function forgetChunks(ids: string[]): number {
  if (ids.length === 0) return 0;
  const placeholders = ids.map(() => "?").join(",");
  const res = sqlite
    .prepare(
      `UPDATE conversation_chunks SET deleted_at = ?
       WHERE id IN (${placeholders}) AND deleted_at IS NULL`
    )
    .run(new Date().toISOString(), ...ids);
  return res.changes;
}

export function getChunkCount(projectId: string): number {
  const row = sqlite
    .prepare(
      "SELECT COUNT(*) as count FROM conversation_chunks WHERE project_id = ? AND deleted_at IS NULL"
    )
    .get(projectId) as { count: number };
  return row.count;
}

interface RawRow {
  id: string;
  session_id: string;
  project_id: string;
  user_text: string;
  assistant_text: string;
  created_at: string;
  obs_type: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  distance?: number;
}

function mapRow(r: RawRow): SimilarChunk {
  return {
    id: r.id,
    sessionId: r.session_id,
    projectId: r.project_id,
    userText: r.user_text,
    assistantText: r.assistant_text,
    createdAt: r.created_at,
    obsType: r.obs_type ?? null,
    concepts: parseArr(r.concepts),
    filesRead: parseArr(r.files_read),
    filesModified: parseArr(r.files_modified),
    distance: r.distance ?? 0,
  };
}

/**
 * Turn a free-text query into a safe FTS5 OR-query of quoted terms. The trigram
 * tokenizer needs terms of >=3 chars; shorter tokens are dropped.
 */
function toFtsQuery(query: string): string | null {
  const terms = query
    .replace(/["()*:^]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 3)
    .map((t) => `"${t.replace(/"/g, "")}"`);
  if (terms.length === 0) return null;
  return terms.join(" OR ");
}
