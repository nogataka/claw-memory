// src/core/lessons.ts
//
// Lesson store: reusable, abstracted knowledge distilled from sessions. Mirrors
// vector-memory.ts (vec0 embedding + readable metadata row + FTS5 keyword row),
// but adds lifecycle (candidate → approved/rejected/archived/superseded), an
// event audit trail, and inter-lesson links (duplicate / conflict / supersede).
//
// JSON-array fields (applies_when / avoid_when / concepts / files /
// source_chunk_ids) are stored as TEXT, parsed on read — same convention as
// conversation_chunks.concepts.

import { randomUUID } from "node:crypto";
import { sqlite } from "./db.js";

export type LessonScope =
  | "global"
  | "project"
  | "repo"
  | "file"
  | "task"
  | "user_preference"
  | "team";

export type LessonStatus =
  | "candidate"
  | "approved"
  | "rejected"
  | "archived"
  | "superseded";

export type LessonRelation =
  | "duplicate"
  | "conflicts_with"
  | "supersedes"
  | "related_to"
  | "derived_from";

export interface LessonInput {
  projectId?: string | null;
  repoId?: string | null;
  sessionId?: string | null;
  title: string;
  lesson: string;
  appliesWhen?: string[];
  avoidWhen?: string[];
  evidence?: string | null;
  scope?: LessonScope;
  obsType?: string | null;
  concepts?: string[];
  files?: string[];
  confidence?: number;
  sourceChunkIds?: string[];
  status?: LessonStatus;
  embedding: Float32Array;
}

export interface LessonRow {
  id: string;
  projectId: string | null;
  repoId: string | null;
  sessionId: string | null;
  title: string;
  lesson: string;
  appliesWhen: string[];
  avoidWhen: string[];
  evidence: string | null;
  scope: string;
  obsType: string | null;
  concepts: string[];
  files: string[];
  confidence: number;
  sourceChunkIds: string[];
  status: string;
  supersededBy: string | null;
  validUntil: string | null;
  lastUsedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SimilarLesson extends LessonRow {
  distance: number;
}

export interface LessonFilter {
  status?: string;
  scope?: string;
  projectId?: string | null;
  concept?: string; // substring within concepts
  file?: string; // substring within files
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

const LESSON_COLS = `l.id, l.project_id, l.repo_id, l.session_id, l.title, l.lesson,
  l.applies_when, l.avoid_when, l.evidence, l.scope, l.obs_type, l.concepts, l.files,
  l.confidence, l.source_chunk_ids, l.status, l.superseded_by, l.valid_until,
  l.last_used_at, l.created_at, l.updated_at`;

interface RawLessonRow {
  id: string;
  project_id: string | null;
  repo_id: string | null;
  session_id: string | null;
  title: string;
  lesson: string;
  applies_when: string | null;
  avoid_when: string | null;
  evidence: string | null;
  scope: string;
  obs_type: string | null;
  concepts: string | null;
  files: string | null;
  confidence: number;
  source_chunk_ids: string | null;
  status: string;
  superseded_by: string | null;
  valid_until: string | null;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
  distance?: number;
}

function mapRow(r: RawLessonRow): SimilarLesson {
  return {
    id: r.id,
    projectId: r.project_id,
    repoId: r.repo_id,
    sessionId: r.session_id,
    title: r.title,
    lesson: r.lesson,
    appliesWhen: parseArr(r.applies_when),
    avoidWhen: parseArr(r.avoid_when),
    evidence: r.evidence,
    scope: r.scope,
    obsType: r.obs_type,
    concepts: parseArr(r.concepts),
    files: parseArr(r.files),
    confidence: r.confidence,
    sourceChunkIds: parseArr(r.source_chunk_ids),
    status: r.status,
    supersededBy: r.superseded_by,
    validUntil: r.valid_until,
    lastUsedAt: r.last_used_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    distance: r.distance ?? 0,
  };
}

/** Record a lifecycle event (status change, decay, scope edit, …). */
export function recordEvent(
  lessonId: string,
  eventType: string,
  opts: { oldStatus?: string | null; newStatus?: string | null; note?: string } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO lesson_events(id, lesson_id, event_type, old_status, new_status, note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      randomUUID(),
      lessonId,
      eventType,
      opts.oldStatus ?? null,
      opts.newStatus ?? null,
      opts.note ?? null,
      new Date().toISOString()
    );
}

/** Save one lesson: vec0 embedding + metadata row + FTS keyword row, atomically. */
export function saveLesson(input: LessonInput): string {
  const insertVec = sqlite.prepare(
    "INSERT INTO lesson_vec(embedding, project_id, scope) VALUES (?, ?, ?)"
  );
  const insertMeta = sqlite.prepare(
    `INSERT INTO lessons(
        id, vec_rowid, project_id, repo_id, session_id, title, lesson,
        applies_when, avoid_when, evidence, scope, obs_type, concepts, files,
        confidence, source_chunk_ids, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertFts = sqlite.prepare(
    "INSERT INTO lessons_fts(lesson_id, text) VALUES (?, ?)"
  );

  const id = randomUUID();
  const now = new Date().toISOString();
  const scope = input.scope ?? "repo";
  const status = input.status ?? "candidate";
  const confidence = input.confidence ?? 0.5;

  const tx = sqlite.transaction(() => {
    const res = insertVec.run(
      Buffer.from(input.embedding.buffer),
      input.projectId ?? null,
      scope
    );
    const vecRowid = res.lastInsertRowid as number;
    insertMeta.run(
      id,
      vecRowid,
      input.projectId ?? null,
      input.repoId ?? null,
      input.sessionId ?? null,
      input.title,
      input.lesson,
      jsonArr(input.appliesWhen),
      jsonArr(input.avoidWhen),
      input.evidence ?? null,
      scope,
      input.obsType ?? null,
      jsonArr(input.concepts),
      jsonArr(input.files),
      confidence,
      jsonArr(input.sourceChunkIds),
      status,
      now,
      now
    );
    insertFts.run(id, `${input.title}\n${input.lesson}`);
    recordEvent(id, "created", { newStatus: status });
  });
  tx();
  return id;
}

export function getLesson(id: string): LessonRow | null {
  const row = sqlite
    .prepare(`SELECT ${LESSON_COLS} FROM lessons l WHERE l.id = ?`)
    .get(id) as RawLessonRow | undefined;
  return row ? mapRow(row) : null;
}

export function getLessonsByIds(ids: string[]): LessonRow[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = sqlite
    .prepare(`SELECT ${LESSON_COLS} FROM lessons l WHERE l.id IN (${placeholders})`)
    .all(...ids) as RawLessonRow[];
  return rows.map(mapRow);
}

/** Build a WHERE fragment from a LessonFilter. */
function lessonWhere(filter?: LessonFilter): { sql: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (filter?.status) {
    clauses.push("l.status = ?");
    params.push(filter.status);
  }
  if (filter?.scope) {
    clauses.push("l.scope = ?");
    params.push(filter.scope);
  }
  if (filter?.projectId) {
    clauses.push("l.project_id = ?");
    params.push(filter.projectId);
  }
  if (filter?.concept) {
    clauses.push("l.concepts LIKE ?");
    params.push(`%${filter.concept}%`);
  }
  if (filter?.file) {
    clauses.push("l.files LIKE ?");
    params.push(`%${filter.file}%`);
  }
  return { sql: clauses.length ? clauses.join(" AND ") : "1=1", params };
}

export function listLessons(filter?: LessonFilter, limit = 200): LessonRow[] {
  const w = lessonWhere(filter);
  const rows = sqlite
    .prepare(
      `SELECT ${LESSON_COLS} FROM lessons l
       WHERE ${w.sql}
       ORDER BY l.updated_at DESC LIMIT ?`
    )
    .all(...w.params, limit) as RawLessonRow[];
  return rows.map(mapRow);
}

export function getLessonCount(filter?: LessonFilter): number {
  const w = lessonWhere(filter);
  const row = sqlite
    .prepare(`SELECT COUNT(*) c FROM lessons l WHERE ${w.sql}`)
    .get(...w.params) as { c: number };
  return row.c;
}

/** KNN semantic search over lessons, filtered by project/scope inside MATCH. */
export function searchSimilarLessons(
  queryEmbedding: Float32Array,
  opts: {
    projectId?: string | null;
    topK?: number;
    maxDistance?: number;
    status?: string;
    scopes?: string[];
  } = {}
): SimilarLesson[] {
  const topK = opts.topK ?? 8;
  // vec0 MATCH metadata filters: project must match OR be a cross-project scope.
  const stmt = sqlite.prepare(`
    SELECT ${LESSON_COLS}, v.distance
    FROM (
      SELECT rowid, distance FROM lesson_vec
      WHERE embedding MATCH ? AND k = ?
    ) v
    INNER JOIN lessons l ON l.vec_rowid = v.rowid
    WHERE ${opts.status ? "l.status = ?" : "1=1"}
      ${opts.maxDistance != null ? "AND v.distance <= ?" : ""}
    ORDER BY v.distance
  `);
  const params: Array<Buffer | number | string> = [
    Buffer.from(queryEmbedding.buffer),
    topK,
  ];
  if (opts.status) params.push(opts.status);
  if (opts.maxDistance != null) params.push(opts.maxDistance);
  const rows = stmt.all(...params) as RawLessonRow[];
  return rows.map(mapRow);
}

/** FTS5 keyword search over lesson title + body. */
export function searchKeywordLessons(
  query: string,
  opts: { topK?: number; status?: string } = {}
): LessonRow[] {
  const match = toFtsQuery(query);
  if (!match) return [];
  const rows = sqlite
    .prepare(
      `SELECT ${LESSON_COLS}
       FROM lessons_fts f
       INNER JOIN lessons l ON l.id = f.lesson_id
       WHERE f.text MATCH ? ${opts.status ? "AND l.status = ?" : ""}
       LIMIT ?`
    )
    .all(
      match,
      ...(opts.status ? [opts.status] : []),
      opts.topK ?? 8
    ) as RawLessonRow[];
  return rows.map(mapRow);
}

/** Transition a lesson's status, stamping updated_at and recording the event. */
export function setStatus(
  id: string,
  newStatus: LessonStatus,
  note?: string
): boolean {
  const current = sqlite
    .prepare("SELECT status FROM lessons WHERE id = ?")
    .get(id) as { status: string } | undefined;
  if (!current) return false;
  const now = new Date().toISOString();
  sqlite
    .prepare("UPDATE lessons SET status = ?, updated_at = ? WHERE id = ?")
    .run(newStatus, now, id);
  recordEvent(id, "status_change", {
    oldStatus: current.status,
    newStatus,
    note,
  });
  return true;
}

/** Mark `oldId` superseded by `newId` and link them. */
export function supersede(oldId: string, newId: string): boolean {
  const current = sqlite
    .prepare("SELECT status FROM lessons WHERE id = ?")
    .get(oldId) as { status: string } | undefined;
  if (!current) return false;
  const now = new Date().toISOString();
  const tx = sqlite.transaction(() => {
    sqlite
      .prepare(
        "UPDATE lessons SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?"
      )
      .run(newId, now, oldId);
    recordEvent(oldId, "superseded", {
      oldStatus: current.status,
      newStatus: "superseded",
      note: `superseded_by=${newId}`,
    });
    linkLessons(newId, oldId, "supersedes");
  });
  tx();
  return true;
}

/** Update one or more editable fields (scope / confidence / valid_until). */
export function updateLesson(
  id: string,
  fields: { scope?: string; confidence?: number; validUntil?: string | null }
): boolean {
  const sets: string[] = [];
  const params: Array<string | number | null> = [];
  if (fields.scope !== undefined) {
    sets.push("scope = ?");
    params.push(fields.scope);
  }
  if (fields.confidence !== undefined) {
    sets.push("confidence = ?");
    params.push(fields.confidence);
  }
  if (fields.validUntil !== undefined) {
    sets.push("valid_until = ?");
    params.push(fields.validUntil);
  }
  if (sets.length === 0) return false;
  sets.push("updated_at = ?");
  params.push(new Date().toISOString());
  params.push(id);
  const res = sqlite
    .prepare(`UPDATE lessons SET ${sets.join(", ")} WHERE id = ?`)
    .run(...params);
  if (res.changes > 0) recordEvent(id, "edited", { note: sets.join(",") });
  return res.changes > 0;
}

/** Bump last_used_at when a lesson is surfaced by search/inject. */
export function markUsed(ids: string[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const stmt = sqlite.prepare("UPDATE lessons SET last_used_at = ? WHERE id = ?");
  const tx = sqlite.transaction(() => {
    for (const id of ids) stmt.run(now, id);
  });
  tx();
}

export function linkLessons(
  lessonId: string,
  linkedLessonId: string,
  relation: LessonRelation
): void {
  sqlite
    .prepare(
      `INSERT INTO lesson_links(id, lesson_id, linked_lesson_id, relation, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(randomUUID(), lessonId, linkedLessonId, relation, new Date().toISOString());
}

export interface LessonEvent {
  id: string;
  eventType: string;
  oldStatus: string | null;
  newStatus: string | null;
  note: string | null;
  createdAt: string;
}

export function getEvents(lessonId: string): LessonEvent[] {
  const rows = sqlite
    .prepare(
      `SELECT id, event_type, old_status, new_status, note, created_at
       FROM lesson_events WHERE lesson_id = ? ORDER BY created_at ASC`
    )
    .all(lessonId) as Array<{
    id: string;
    event_type: string;
    old_status: string | null;
    new_status: string | null;
    note: string | null;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    oldStatus: r.old_status,
    newStatus: r.new_status,
    note: r.note,
    createdAt: r.created_at,
  }));
}

export interface LessonLink {
  id: string;
  lessonId: string;
  linkedLessonId: string;
  relation: string;
  createdAt: string;
}

/** Links where this lesson is either side (incoming + outgoing). */
export function getLinks(lessonId: string): LessonLink[] {
  const rows = sqlite
    .prepare(
      `SELECT id, lesson_id, linked_lesson_id, relation, created_at
       FROM lesson_links WHERE lesson_id = ? OR linked_lesson_id = ?
       ORDER BY created_at ASC`
    )
    .all(lessonId, lessonId) as Array<{
    id: string;
    lesson_id: string;
    linked_lesson_id: string;
    relation: string;
    created_at: string;
  }>;
  return rows.map((r) => ({
    id: r.id,
    lessonId: r.lesson_id,
    linkedLessonId: r.linked_lesson_id,
    relation: r.relation,
    createdAt: r.created_at,
  }));
}

/**
 * Turn a free-text query into a safe FTS5 OR-query of quoted terms (trigram
 * tokenizer needs >=3-char terms). Mirrors vector-memory.toFtsQuery.
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
