// src/core/recall.ts
//
// Build the formatted memory block injected into an agent's context. Mirrors
// agent-claw's buildSystemPrompt memory section: preferences (always-apply) +
// summaries & similar conversations (reference-only).

import { embedQuery } from "./embeddings.js";
import { searchSimilar, type SimilarChunk } from "./vector-memory.js";
import { getPreferences, getRecentSummaries } from "./memory.js";
import {
  searchLessons,
  formatLessonBlock,
  type RankedLesson,
} from "./lesson-search.js";

const MEMORY_MAX_DISTANCE = Number(
  process.env.MEMORY_SIMILARITY_MAX_DISTANCE ?? 0.4
);
// Approved lessons injected into the recall block. Kept small to avoid context
// bloat; 0 disables lesson injection entirely.
const RECALL_LESSON_LIMIT = Number(process.env.LESSON_RECALL_LIMIT ?? 3);

export interface MemoryBlock {
  fullText: string;
  preferences: Array<{ key: string; value: string }>;
  summaries: string[];
  similar: SimilarChunk[];
  lessons: RankedLesson[];
}

export async function buildMemoryBlock(
  projectId: string,
  query: string,
  topK = 5
): Promise<MemoryBlock> {
  const prefs = getPreferences(projectId);
  const summaries = getRecentSummaries(projectId, 5);

  let similar: SimilarChunk[] = [];
  if (query.trim()) {
    try {
      const emb = await embedQuery(query);
      similar = searchSimilar(emb, projectId, topK, MEMORY_MAX_DISTANCE);
    } catch (err) {
      console.error("[claw-memory] semantic search failed:", err);
    }
  }

  // Approved, reusable lessons relevant to this request (best-effort).
  let lessons: RankedLesson[] = [];
  if (query.trim() && RECALL_LESSON_LIMIT > 0) {
    try {
      lessons = await searchLessons(
        query,
        { projectId },
        { limit: RECALL_LESSON_LIMIT }
      );
    } catch (err) {
      console.error("[claw-memory] lesson recall failed:", err);
    }
  }

  let text = "";

  if (prefs.length > 0) {
    text += '<user-preferences instruction="always-apply">\n';
    text += "以下のユーザー設定は常に従ってください。\n";
    for (const p of prefs) text += `- ${p.key}: ${p.value}\n`;
    text += "</user-preferences>\n";
  }

  if (summaries.length > 0 || similar.length > 0) {
    text += '\n<memory-context instruction="reference-only">\n';
    text +=
      "以下は過去の会話から得られた参考情報です。\n" +
      "背景知識として参照する程度に留め、自発的に言及しないでください。\n" +
      "ユーザーが明示的に過去の話題に触れた場合にのみ活用してください。\n";

    if (summaries.length > 0) {
      text += "\n<previous-session-summaries>\n";
      for (const s of summaries) text += `- ${s.summary}\n`;
      text += "</previous-session-summaries>\n";
    }
    if (similar.length > 0) {
      text += "\n<relevant-past-conversations>\n";
      for (const c of similar) {
        const date = c.createdAt.split("T")[0];
        text += `- [${date}] User: ${c.userText}\n  Assistant: ${c.assistantText}\n`;
      }
      text += "</relevant-past-conversations>\n";
    }
    text += "</memory-context>\n";
  }

  const lessonBlock = formatLessonBlock(lessons);
  if (lessonBlock) text += `\n${lessonBlock}\n`;

  return {
    fullText: text.trim(),
    preferences: prefs.map((p) => ({ key: p.key, value: p.value })),
    summaries: summaries.map((s) => s.summary),
    similar,
    lessons,
  };
}
