// src/core/lesson-share.ts
//
// Team sharing (design doc section 8 / Phase 8). claw-memory is local-first, so
// there is no daemon and no automatic external sync. Sharing is explicit and
// file-based: export a portable JSON bundle, import it elsewhere. Embeddings are
// NOT exported — they are recomputed on import (the local e5 model is
// deterministic), keeping bundles small and engine-version-independent.
//
// Imported lessons default to status 'candidate' so shared knowledge is
// reviewed before it enters another developer's recall — the "public/team
// 共有時の追加レビュー" requirement.

import { embedPassage } from "./embeddings.js";
import {
  listLessons,
  saveLesson,
  type LessonRow,
  type LessonScope,
  type LessonStatus,
} from "./lessons.js";

export const EXPORT_VERSION = 1;

export interface ExportedLesson {
  title: string;
  lesson: string;
  applies_when: string[];
  avoid_when: string[];
  evidence: string | null;
  scope: string;
  obs_type: string | null;
  concepts: string[];
  files: string[];
  confidence: number;
  status: string;
  created_at: string;
}

export interface LessonBundle {
  version: number;
  exported_at: string;
  count: number;
  lessons: ExportedLesson[];
}

function toExported(l: LessonRow): ExportedLesson {
  return {
    title: l.title,
    lesson: l.lesson,
    applies_when: l.appliesWhen,
    avoid_when: l.avoidWhen,
    evidence: l.evidence,
    scope: l.scope,
    obs_type: l.obsType,
    concepts: l.concepts,
    files: l.files,
    confidence: l.confidence,
    status: l.status,
    created_at: l.createdAt,
  };
}

export interface ExportOptions {
  projectId?: string | null;
  status?: string; // default: only approved are worth sharing
}

/** Build a portable bundle. Defaults to approved lessons. */
export function exportLessons(opts: ExportOptions = {}): LessonBundle {
  const status = opts.status ?? "approved";
  const rows = listLessons({ projectId: opts.projectId ?? undefined, status }, 100_000);
  return {
    version: EXPORT_VERSION,
    exported_at: new Date().toISOString(),
    count: rows.length,
    lessons: rows.map(toExported),
  };
}

export interface ImportOptions {
  projectId?: string | null;
  sessionId?: string | null;
  /** Status to assign imported lessons. Default 'candidate' (review first). */
  status?: string;
}

export interface ImportResult {
  imported: number;
  skipped: number;
}

/** Import a bundle: re-embed each lesson and store it (default 'candidate'). */
export async function importLessons(
  bundle: LessonBundle,
  opts: ImportOptions = {}
): Promise<ImportResult> {
  if (!bundle || !Array.isArray(bundle.lessons)) {
    throw new Error("invalid lesson bundle: missing lessons[]");
  }
  if (bundle.version !== EXPORT_VERSION) {
    throw new Error(
      `unsupported bundle version ${bundle.version} (expected ${EXPORT_VERSION})`
    );
  }
  const status = (opts.status as LessonStatus) ?? "candidate";
  let imported = 0;
  let skipped = 0;
  for (const it of bundle.lessons) {
    const title = (it.title ?? "").trim();
    const lesson = (it.lesson ?? "").trim();
    if (!title || !lesson) {
      skipped++;
      continue;
    }
    const embedding = await embedPassage(`${title}\n${lesson}`);
    saveLesson({
      projectId: opts.projectId ?? null,
      sessionId: opts.sessionId ?? "import",
      title: title.slice(0, 200),
      lesson: lesson.slice(0, 2000),
      appliesWhen: (it.applies_when ?? []).map(String),
      avoidWhen: (it.avoid_when ?? []).map(String),
      evidence: it.evidence ?? null,
      scope: (it.scope as LessonScope) ?? "repo",
      obsType: it.obs_type ?? null,
      concepts: (it.concepts ?? []).map(String),
      files: (it.files ?? []).map(String),
      confidence: typeof it.confidence === "number" ? it.confidence : 0.5,
      status,
      embedding,
    });
    imported++;
  }
  return { imported, skipped };
}
