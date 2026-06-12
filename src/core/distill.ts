// src/core/distill.ts
//
// Write path: distill a conversation into a 1-2 sentence summary + user
// preferences + embedded conversation chunks. Mirrors agent-claw's summarize
// pipeline, minus the HTTP layer.

import { complete } from "./llm.js";
import { embedPassage } from "./embeddings.js";
import { addSessionSummary, setPreference } from "./memory.js";
import {
  saveChunks,
  deleteChunksBySession,
  chunkExists,
  type ChunkInput,
} from "./vector-memory.js";
import { loadTranscript, type TranscriptMessage } from "./transcript.js";
import { stripPrivate } from "./private.js";
import { log } from "./logger.js";
import {
  saveCandidates,
  extractDedicated,
  dedicatedEnabled,
  type LessonCandidate,
} from "./lesson-extract.js";

const MIN_MESSAGES = 2;
const MIN_TEXT_LENGTH = 100;
const MAX_CHARS_PER_MESSAGE = 500;

const OBS_TYPES = ["discovery", "bugfix", "feature", "decision", "change", "other"];

export interface DistillInput {
  projectId: string;
  sessionId: string;
  /** Either provide messages directly, or a transcript .jsonl path. */
  messages?: TranscriptMessage[];
  transcriptPath?: string;
}

export interface DistillResult {
  skipped?: boolean;
  reason?: string;
  summary?: string;
  preferencesCount?: number;
  chunks?: number;
  lessons?: number;
}

const PROMPT = (transcript: string) => `以下の会話を分析して JSON で回答してください。

1. summary: 会話の構造化要約。会話と同じ言語で、次の節を含む簡潔なMarkdown:
   "### 依頼" / "### 調査・判明" / "### 完了" / "### 次の一手"（該当が無い節は省略可）。
2. obs_type: この会話の主目的を1つ選ぶ: ${OBS_TYPES.join(" | ")}
3. concepts: 主要トピック・技術キーワードの配列（3〜8個程度）。
4. files_read: 会話中で読んだ/参照したファイルパスの配列（無ければ空配列）。
5. files_modified: 会話中で作成/編集したファイルパスの配列（無ければ空配列）。
6. preferences: ユーザーの設定や好みが読み取れた場合のみ。
   key は必ず次のいずれか（該当しなければ出さない）:
   language | response_style | detail_level | code_style | framework | tone | tools
   変更がなければ空配列。
7. lessons: 次回以降の作業で再利用できる「教訓」だけを抽出（無ければ空配列）。
   一時的な会話・未検証の推測・秘密情報・一回限りのコマンド・重複は抽出しない。
   各 lesson は実行可能・具体的・再利用可能であること。
   各要素: {"title","lesson","applies_when":[],"avoid_when":[],
   "scope":"global|project|repo|file|task|user_preference","confidence":0.0-1.0,
   "evidence","concepts":[],"files":[]}

JSON のみ回答:
{"summary": "...", "obs_type": "...", "concepts": ["..."], "files_read": ["..."], "files_modified": ["..."], "preferences": [{"key": "...", "value": "..."}], "lessons": []}

<conversation>
${transcript}
</conversation>`;

export async function distill(input: DistillInput): Promise<DistillResult> {
  const loaded =
    input.messages ??
    (input.transcriptPath ? loadTranscript(input.transcriptPath) : []);

  // Drop <private>…</private> spans before anything is persisted or sent to the LLM.
  const messages = loaded
    .map((m) => ({ ...m, text: stripPrivate(m.text) }))
    .filter((m) => m.text.trim());

  if (messages.length < MIN_MESSAGES) {
    return { skipped: true, reason: "too few messages" };
  }

  const transcript = messages
    .map(
      (m) =>
        `${m.role === "user" ? "User" : "Assistant"}: ${m.text.slice(0, MAX_CHARS_PER_MESSAGE)}`
    )
    .join("\n");

  if (transcript.length < MIN_TEXT_LENGTH) {
    return { skipped: true, reason: "too short" };
  }

  // --- LLM: summary + preferences (single tool-less turn) ---
  const responseText = await complete({
    prompt: PROMPT(transcript),
    tier: "summary",
  });

  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Failed to parse distill JSON response");
  const result = JSON.parse(jsonMatch[0]) as {
    summary: string;
    obs_type?: string;
    concepts?: string[];
    files_read?: string[];
    files_modified?: string[];
    preferences?: Array<{ key: string; value: string }>;
    lessons?: LessonCandidate[];
  };

  if (result.summary) {
    addSessionSummary(input.projectId, input.sessionId, result.summary);
  }
  if (Array.isArray(result.preferences)) {
    for (const pref of result.preferences) {
      if (pref.key && pref.value) {
        setPreference(input.projectId, pref.key, pref.value);
      }
    }
  }

  // Session-level structured metadata applied to every chunk of this session.
  const obsType =
    result.obs_type && OBS_TYPES.includes(result.obs_type)
      ? result.obs_type
      : null;
  const concepts = (result.concepts ?? []).map(String).filter(Boolean);
  const filesRead = (result.files_read ?? []).map(String).filter(Boolean);
  const filesModified = (result.files_modified ?? []).map(String).filter(Boolean);

  // --- Vector memory: re-chunk this session (idempotent) ---
  let chunkCount = 0;
  let savedChunkIds: string[] = [];
  try {
    deleteChunksBySession(input.sessionId);
    const pairs: Array<{ userText: string; assistantText: string }> = [];
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (m.role === "user" && m.text.trim()) {
        const next = messages[i + 1];
        pairs.push({
          userText: m.text.slice(0, 500),
          assistantText: next?.role === "assistant" ? next.text.slice(0, 500) : "",
        });
      }
    }
    if (pairs.length > 0) {
      const toSave: ChunkInput[] = [];
      for (const p of pairs) {
        // Cross-session dedup: skip pairs already stored verbatim.
        if (chunkExists(input.projectId, p.userText, p.assistantText)) continue;
        const embedding = await embedPassage(
          `User: ${p.userText}\nAssistant: ${p.assistantText}`
        );
        toSave.push({
          projectId: input.projectId,
          sessionId: input.sessionId,
          userText: p.userText,
          assistantText: p.assistantText,
          embedding,
          obsType,
          concepts,
          filesRead,
          filesModified,
        });
      }
      if (toSave.length > 0) savedChunkIds = saveChunks(toSave);
      chunkCount = toSave.length;
    }
  } catch (err) {
    console.error("[claw-memory] chunk embed failed:", err);
  }

  // --- Lesson layer: extract reusable lessons (best-effort) ---
  // Candidates ride along in the summary JSON above (no extra LLM call). When
  // CLAW_MEMORY_LESSON_DEDICATED=1, run a separate higher-quality extraction
  // pass instead. Failures here must never break the summary path.
  let lessonCount = 0;
  try {
    const candidates: LessonCandidate[] = dedicatedEnabled()
      ? await extractDedicated(transcript)
      : Array.isArray(result.lessons)
        ? result.lessons
        : [];
    if (candidates.length > 0) {
      const ids = await saveCandidates({
        projectId: input.projectId,
        sessionId: input.sessionId,
        candidates,
        sourceChunkIds: savedChunkIds,
      });
      lessonCount = ids.length;
    }
  } catch (err) {
    console.error("[claw-memory] lesson extract failed:", err);
  }

  log("distill", {
    projectId: input.projectId,
    sessionId: input.sessionId,
    obsType,
    chunks: chunkCount,
    preferences: result.preferences?.length ?? 0,
    lessons: lessonCount,
  });

  return {
    summary: result.summary,
    preferencesCount: result.preferences?.length ?? 0,
    chunks: chunkCount,
    lessons: lessonCount,
  };
}

/** Store a single free-text note as an embedded chunk (memory_remember). */
export async function rememberText(args: {
  projectId: string;
  sessionId: string;
  text: string;
}): Promise<string> {
  const embedding = await embedPassage(args.text);
  const [id] = saveChunks([
    {
      projectId: args.projectId,
      sessionId: args.sessionId,
      userText: args.text.slice(0, 500),
      assistantText: "",
      embedding,
    },
  ]);
  return id;
}
