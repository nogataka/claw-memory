// src/core/lesson-extract.ts
//
// Turn distilled session signal into candidate lessons. Two entry points:
//
//  - saveCandidates(): persist already-extracted LessonCandidate[] (the default
//    path — candidates ride along in distill()'s existing summary JSON, so no
//    extra LLM call).
//  - extractDedicated(): a separate, higher-quality extraction pass over the
//    transcript using the section-12 prompt + the "smart" tier. Opt-in via
//    CLAW_MEMORY_LESSON_DEDICATED=1.
//
// All lessons are saved as status='candidate'; only human/rule approval promotes
// them to 'approved' (the status that lesson_search / recall actually surface).

import { execFileSync } from "node:child_process";
import { complete } from "./llm.js";
import { embedPassage } from "./embeddings.js";
import { saveLesson, type LessonScope } from "./lessons.js";
import { getProject } from "./projects.js";
import { log } from "./logger.js";

const VALID_SCOPES: LessonScope[] = [
  "global",
  "project",
  "repo",
  "file",
  "task",
  "user_preference",
  "team",
];

/** Shape the LLM is asked to produce (per lesson). */
export interface LessonCandidate {
  title: string;
  lesson: string;
  applies_when?: string[];
  avoid_when?: string[];
  scope?: string;
  confidence?: number;
  evidence?: string;
  concepts?: string[];
  files?: string[];
}

export function normalizeScope(scope?: string): LessonScope {
  const s = (scope ?? "").trim().toLowerCase();
  return (VALID_SCOPES as string[]).includes(s) ? (s as LessonScope) : "repo";
}

export function clampConfidence(c?: number): number {
  if (typeof c !== "number" || Number.isNaN(c)) return 0.5;
  return Math.max(0, Math.min(1, c));
}

/**
 * Resolve a stable repo id for a project: the git top-level path, falling back
 * to the project's own path. Best-effort — git failures are non-fatal. Cached
 * per project path so repeated distills don't re-spawn git.
 */
const repoCache = new Map<string, string>();
export function resolveRepoId(projectId?: string | null): string | null {
  if (!projectId) return null;
  const project = getProject(projectId);
  if (!project) return null;
  const cached = repoCache.get(project.path);
  if (cached !== undefined) return cached;
  let repo = project.path;
  try {
    repo = execFileSync("git", ["-C", project.path, "rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || project.path;
  } catch {
    // not a git repo — repo id is the project path itself
  }
  repoCache.set(project.path, repo);
  return repo;
}

export interface SaveCandidatesInput {
  projectId?: string | null;
  sessionId?: string | null;
  candidates: LessonCandidate[];
  sourceChunkIds?: string[];
}

/** Persist candidate lessons (embed + saveLesson as 'candidate'). */
export async function saveCandidates(input: SaveCandidatesInput): Promise<string[]> {
  const repoId = resolveRepoId(input.projectId);
  const ids: string[] = [];
  for (const c of input.candidates) {
    const title = (c.title ?? "").trim();
    const lesson = (c.lesson ?? "").trim();
    if (!title || !lesson) continue;
    const embedding = await embedPassage(`${title}\n${lesson}`);
    const id = saveLesson({
      projectId: input.projectId ?? null,
      repoId,
      sessionId: input.sessionId ?? null,
      title: title.slice(0, 200),
      lesson: lesson.slice(0, 2000),
      appliesWhen: (c.applies_when ?? []).map(String).filter(Boolean),
      avoidWhen: (c.avoid_when ?? []).map(String).filter(Boolean),
      evidence: c.evidence ? String(c.evidence).slice(0, 1000) : null,
      scope: normalizeScope(c.scope),
      concepts: (c.concepts ?? []).map(String).filter(Boolean),
      files: (c.files ?? []).map(String).filter(Boolean),
      confidence: clampConfidence(c.confidence),
      sourceChunkIds: input.sourceChunkIds ?? [],
      status: "candidate",
      embedding,
    });
    ids.push(id);
  }
  log("lesson-extract", {
    projectId: input.projectId,
    sessionId: input.sessionId,
    saved: ids.length,
  });
  return ids;
}

const DEDICATED_PROMPT = (transcript: string) => `あなたはAIコーディングセッションから、将来再利用可能なレッスンを抽出する役割です。

抽出するのは、次回以降の作業で役立つ可能性が高い教訓だけです。

抽出しないもの:
- 一時的な会話
- 検証されていない推測
- 秘密情報（APIキー・トークン・個人情報）
- 生ログの丸写し
- 再利用性の低い一回限りのコマンド
- 既存レッスンと重複する内容

各レッスンは、実行可能で、具体的で、再利用可能である必要があります。
該当が無ければ空配列を返してください。

JSON のみ回答:
{"lessons": [{"title": "...", "lesson": "...", "applies_when": ["..."], "avoid_when": ["..."], "scope": "global|project|repo|file|task|user_preference", "confidence": 0.0, "evidence": "...", "concepts": ["..."], "files": ["..."]}]}

<conversation>
${transcript}
</conversation>`;

/** Dedicated extraction pass (opt-in). Returns parsed candidates. */
export async function extractDedicated(transcript: string): Promise<LessonCandidate[]> {
  const responseText = await complete({
    prompt: DEDICATED_PROMPT(transcript),
    tier: "smart",
  });
  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { lessons?: LessonCandidate[] };
    return Array.isArray(parsed.lessons) ? parsed.lessons : [];
  } catch {
    return [];
  }
}

export function dedicatedEnabled(): boolean {
  return process.env.CLAW_MEMORY_LESSON_DEDICATED === "1";
}
