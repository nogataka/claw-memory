// src/core/vector-memory.ts
//
// Vector store (sqlite-vec) + keyword index (FTS5). Vectors and readable
// metadata are split across vec_chunks (vec0) and conversation_chunks.

import { randomUUID } from "node:crypto";
import { sqlite } from "./db.js";

export interface ChunkInput {
  projectId: string;
  sessionId: string;
  userText: string;
  assistantText: string;
  embedding: Float32Array;
}

export interface ChunkRow {
  id: string;
  sessionId: string;
  projectId: string;
  userText: string;
  assistantText: string;
  createdAt: string;
}

export interface SimilarChunk extends ChunkRow {
  distance: number;
}

/** Save conversation chunks: vec0 embedding + metadata row + FTS keyword row, atomically. */
export function saveChunks(chunks: ChunkInput[]): string[] {
  const insertVec = sqlite.prepare(
    "INSERT INTO vec_chunks(embedding, project_id) VALUES (?, ?)"
  );
  const insertMeta = sqlite.prepare(
    `INSERT INTO conversation_chunks(id, vec_rowid, project_id, session_id, user_text, assistant_text, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
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
        now
      );
      insertFts.run(id, `${chunk.userText}\n${chunk.assistantText}`);
      ids.push(id);
    }
  });
  tx();
  return ids;
}

/** KNN semantic search, filtered by project inside the MATCH query. */
export function searchSimilar(
  queryEmbedding: Float32Array,
  projectId: string,
  topK = 5,
  maxDistance?: number
): SimilarChunk[] {
  const stmt = sqlite.prepare(`
    SELECT c.id, c.session_id, c.project_id, c.user_text, c.assistant_text, c.created_at, v.distance
    FROM (
      SELECT rowid, distance FROM vec_chunks
      WHERE embedding MATCH ? AND k = ? AND project_id = ?
    ) v
    INNER JOIN conversation_chunks c ON c.vec_rowid = v.rowid
    ${maxDistance != null ? "WHERE v.distance <= ?" : ""}
    ORDER BY v.distance
  `);

  const params: Array<Buffer | number | string> = [
    Buffer.from(queryEmbedding.buffer),
    topK,
    projectId,
  ];
  if (maxDistance != null) params.push(maxDistance);

  const rows = stmt.all(...params) as Array<{
    id: string;
    session_id: string;
    project_id: string;
    user_text: string;
    assistant_text: string;
    created_at: string;
    distance: number;
  }>;
  return rows.map(mapRow);
}

/** FTS5 keyword search (fallback / augmentation for keyword-ish queries). */
export function searchKeyword(
  query: string,
  projectId: string,
  limit = 5
): ChunkRow[] {
  const match = toFtsQuery(query);
  if (!match) return [];
  const rows = sqlite
    .prepare(
      `SELECT c.id, c.session_id, c.project_id, c.user_text, c.assistant_text, c.created_at
       FROM chunks_fts f
       INNER JOIN conversation_chunks c ON c.id = f.chunk_id
       WHERE f.text MATCH ? AND c.project_id = ?
       LIMIT ?`
    )
    .all(match, projectId, limit) as Array<{
    id: string;
    session_id: string;
    project_id: string;
    user_text: string;
    assistant_text: string;
    created_at: string;
  }>;
  return rows.map((r) => mapRow({ ...r, distance: 0 }));
}

export function getChunksByIds(ids: string[]): ChunkRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = sqlite
    .prepare(
      `SELECT id, session_id, project_id, user_text, assistant_text, created_at
       FROM conversation_chunks WHERE id IN (${placeholders})`
    )
    .all(...ids) as Array<{
    id: string;
    session_id: string;
    project_id: string;
    user_text: string;
    assistant_text: string;
    created_at: string;
  }>;
  return rows.map((r) => mapRow({ ...r, distance: 0 }));
}

export function listChunks(projectId: string, limit = 200): ChunkRow[] {
  const rows = sqlite
    .prepare(
      `SELECT id, session_id, project_id, user_text, assistant_text, created_at
       FROM conversation_chunks WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`
    )
    .all(projectId, limit) as Array<{
    id: string;
    session_id: string;
    project_id: string;
    user_text: string;
    assistant_text: string;
    created_at: string;
  }>;
  return rows.map((r) => mapRow({ ...r, distance: 0 }));
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

export function getChunkCount(projectId: string): number {
  const row = sqlite
    .prepare("SELECT COUNT(*) as count FROM conversation_chunks WHERE project_id = ?")
    .get(projectId) as { count: number };
  return row.count;
}

function mapRow(r: {
  id: string;
  session_id: string;
  project_id: string;
  user_text: string;
  assistant_text: string;
  created_at: string;
  distance: number;
}): SimilarChunk {
  return {
    id: r.id,
    sessionId: r.session_id,
    projectId: r.project_id,
    userText: r.user_text,
    assistantText: r.assistant_text,
    createdAt: r.created_at,
    distance: r.distance,
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
