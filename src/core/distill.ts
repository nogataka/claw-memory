// src/core/distill.ts
//
// Write path: distill a conversation into a 1-2 sentence summary + user
// preferences + embedded conversation chunks. Mirrors agent-claw's summarize
// pipeline, minus the HTTP layer.

import { query } from "@anthropic-ai/claude-agent-sdk";
import { getModel, buildFullSdkEnv } from "./providers.js";
import { embedPassage } from "./embeddings.js";
import { addSessionSummary, setPreference } from "./memory.js";
import { saveChunks, deleteChunksBySession } from "./vector-memory.js";
import { loadTranscript, type TranscriptMessage } from "./transcript.js";

const MIN_MESSAGES = 2;
const MIN_TEXT_LENGTH = 100;
const MAX_CHARS_PER_MESSAGE = 500;

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
}

const PROMPT = (transcript: string) => `以下の会話を分析して JSON で回答してください。

1. summary: 会話の要約を1-2文で。会話と同じ言語で。
2. preferences: ユーザーの設定や好みが読み取れた場合のみ。
   key は必ず次のいずれかを使うこと（該当しなければそのpreferenceは出さない）:
   - language: 使用言語
   - response_style: 回答スタイル
   - detail_level: 回答の詳細度
   - code_style: コードの書き方の好み
   - framework: 好むフレームワーク・ライブラリ
   - tone: 口調・敬語の有無
   - tools: 好んで使うツール
   変更がなければ空配列。

JSON のみ回答:
{"summary": "...", "preferences": [{"key": "language|response_style|detail_level|code_style|framework|tone|tools", "value": "..."}]}

<conversation>
${transcript}
</conversation>`;

export async function distill(input: DistillInput): Promise<DistillResult> {
  const messages =
    input.messages ??
    (input.transcriptPath ? loadTranscript(input.transcriptPath) : []);

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
  const sdkStream = query({
    prompt: PROMPT(transcript),
    options: {
      model: getModel(),
      maxTurns: 1,
      allowedTools: [],
      permissionMode: "bypassPermissions",
      env: buildFullSdkEnv(),
    },
  });

  let responseText = "";
  for await (const event of sdkStream) {
    const ev = event as { type: string; message?: { role: string; content: unknown } };
    if (ev.type === "assistant" && ev.message?.role === "assistant") {
      const content = ev.message.content;
      if (typeof content === "string") responseText += content;
      else if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as { type: string; text?: string };
          if (b.type === "text" && b.text) responseText += b.text;
        }
      }
    }
  }

  const jsonMatch = responseText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("Failed to parse distill JSON response");
  const result = JSON.parse(jsonMatch[0]) as {
    summary: string;
    preferences?: Array<{ key: string; value: string }>;
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

  // --- Vector memory: re-chunk this session (idempotent) ---
  let chunkCount = 0;
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
      const toSave = [];
      for (const p of pairs) {
        const embedding = await embedPassage(
          `User: ${p.userText}\nAssistant: ${p.assistantText}`
        );
        toSave.push({
          projectId: input.projectId,
          sessionId: input.sessionId,
          userText: p.userText,
          assistantText: p.assistantText,
          embedding,
        });
      }
      saveChunks(toSave);
      chunkCount = toSave.length;
    }
  } catch (err) {
    console.error("[claw-memory] chunk embed failed:", err);
  }

  return {
    summary: result.summary,
    preferencesCount: result.preferences?.length ?? 0,
    chunks: chunkCount,
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
