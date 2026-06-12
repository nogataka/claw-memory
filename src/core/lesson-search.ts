// src/core/lesson-search.ts
//
// Lesson retrieval. Unlike conversation search (pure vector distance), lessons
// are ranked by a weighted blend (design doc section 20): semantic similarity,
// scope fit, confidence, recency, repo match and file match. Only 'approved'
// lessons are surfaced by default — candidates stay out of agent context until
// a human/rule promotes them.

import { embedQuery } from "./embeddings.js";
import {
  searchSimilarLessons,
  searchKeywordLessons,
  markUsed,
  type LessonRow,
} from "./lessons.js";
import { resolveRepoId } from "./lesson-extract.js";

const MAX_DISTANCE = Number(process.env.LESSON_SIMILARITY_MAX_DISTANCE ?? 0.6);
const RECENCY_HALF_DAYS = Number(process.env.LESSON_RECENCY_DAYS ?? 180);

// Section-20 weights (sum = 1.0).
const W = {
  semantic: 0.4,
  scope: 0.2,
  confidence: 0.15,
  recency: 0.1,
  repo: 0.1,
  file: 0.05,
};

export interface LessonSearchContext {
  projectId?: string | null;
  repoId?: string | null;
  files?: string[];
}

export interface RankedLesson extends LessonRow {
  distance: number;
  score: number;
}

function fileOverlap(a: string[], b?: string[]): boolean {
  if (!b || b.length === 0 || a.length === 0) return false;
  return a.some((f) => b.some((g) => f.includes(g) || g.includes(f)));
}

/** How well a lesson's scope applies to the current context (0..1). */
function scopeMatch(lesson: LessonRow, ctx: LessonSearchContext): number {
  switch (lesson.scope) {
    case "global":
    case "user_preference":
      return 0.7;
    case "team":
      return 0.6;
    case "project":
      return ctx.projectId && lesson.projectId === ctx.projectId ? 1 : 0.2;
    case "repo":
      return ctx.repoId && lesson.repoId === ctx.repoId ? 1 : 0.2;
    case "file":
      return fileOverlap(lesson.files, ctx.files) ? 1 : 0.2;
    case "task":
      return 0.3;
    default:
      return 0.3;
  }
}

function recencyScore(lesson: LessonRow): number {
  const ref = lesson.lastUsedAt ?? lesson.createdAt;
  const ageMs = Date.now() - new Date(ref).getTime();
  const ageDays = ageMs / 86_400_000;
  if (!Number.isFinite(ageDays) || ageDays < 0) return 1;
  return Math.max(0, 1 - ageDays / RECENCY_HALF_DAYS);
}

/** Cosine distance (0..2) → similarity (0..1). Keyword-only hits get a baseline. */
function semanticScore(distance: number | undefined): number {
  if (distance == null) return 0.5;
  return Math.max(0, Math.min(1, 1 - distance));
}

function computeScore(
  lesson: LessonRow,
  distance: number | undefined,
  ctx: LessonSearchContext
): number {
  const repoMatch = ctx.repoId && lesson.repoId === ctx.repoId ? 1 : 0;
  const fMatch = fileOverlap(lesson.files, ctx.files) ? 1 : 0;
  return (
    W.semantic * semanticScore(distance) +
    W.scope * scopeMatch(lesson, ctx) +
    W.confidence * lesson.confidence +
    W.recency * recencyScore(lesson) +
    W.repo * repoMatch +
    W.file * fMatch
  );
}

export interface LessonSearchOptions {
  limit?: number;
  status?: string; // default "approved"
  /** Bump last_used_at on surfaced lessons (default true). */
  touch?: boolean;
}

/**
 * Hybrid lesson search: semantic (vector) + FTS keyword, de-duplicated by id,
 * re-ranked by the section-20 blend. Returns highest-scoring first.
 */
export async function searchLessons(
  query: string,
  ctx: LessonSearchContext = {},
  opts: LessonSearchOptions = {}
): Promise<RankedLesson[]> {
  const limit = opts.limit ?? 5;
  const status = opts.status ?? "approved";
  const repoId = ctx.repoId ?? resolveRepoId(ctx.projectId);
  const fullCtx: LessonSearchContext = { ...ctx, repoId };

  const byId = new Map<string, { lesson: LessonRow; distance?: number }>();
  if (query.trim()) {
    try {
      const emb = await embedQuery(query);
      for (const l of searchSimilarLessons(emb, {
        topK: limit * 3,
        maxDistance: MAX_DISTANCE,
        status,
      })) {
        byId.set(l.id, { lesson: l, distance: l.distance });
      }
    } catch (err) {
      console.error("[claw-memory] lesson semantic search failed:", err);
    }
    for (const l of searchKeywordLessons(query, { topK: limit * 3, status })) {
      if (!byId.has(l.id)) byId.set(l.id, { lesson: l });
    }
  }

  const ranked: RankedLesson[] = [...byId.values()]
    .map(({ lesson, distance }) => ({
      ...lesson,
      distance: distance ?? 1,
      score: computeScore(lesson, distance, fullCtx),
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  if (opts.touch !== false && ranked.length > 0) {
    markUsed(ranked.map((l) => l.id));
  }
  return ranked;
}

/**
 * Format lessons as an agent-ready context block (design doc section 21).
 * Lessons are presented as HINTS, not absolute facts — the agent must verify
 * against current repository state before applying.
 */
export function formatLessonBlock(lessons: RankedLesson[]): string {
  if (lessons.length === 0) return "";
  let text = "<relevant-lessons>\n";
  text +=
    "以下は、過去の類似セッションから抽出されたレッスンです。\n" +
    "絶対的な事実ではなく、作業時のヒントとして扱ってください。\n" +
    "適用前に現在のリポジトリ状態を確認してください。\n\n";
  lessons.forEach((l, i) => {
    text += `${i + 1}. ${l.lesson}\n`;
    if (l.appliesWhen.length > 0) {
      text += `   Applies when: ${l.appliesWhen.join("; ")}\n`;
    }
    if (l.avoidWhen.length > 0) {
      text += `   Avoid when: ${l.avoidWhen.join("; ")}\n`;
    }
    text += `   Scope: ${l.scope} | Confidence: ${l.confidence.toFixed(2)}\n`;
    if (l.sessionId) text += `   Source: ${l.sessionId}\n`;
  });
  text += "</relevant-lessons>";
  return text;
}

/** Convenience: search + format in one call (lesson_inject). */
export async function injectLessons(
  query: string,
  ctx: LessonSearchContext = {},
  opts: LessonSearchOptions = {}
): Promise<string> {
  const lessons = await searchLessons(query, ctx, opts);
  return formatLessonBlock(lessons);
}
