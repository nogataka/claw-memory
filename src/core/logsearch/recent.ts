// src/core/logsearch/recent.ts
//
// Enumerate Codex rollout transcripts newest-first, for batch distillation
// (claw-memory distill-codex). Read-only over ~/.codex/sessions.

import { readdir, stat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { codexSessionsRoot, chatgptExportRoot, MAX_CHATGPT_FILE_SIZE } from "./paths.js";
import { parseChatgptExport, type ChatgptConversation } from "./parse.js";

export interface CodexSessionFile {
  path: string;
  mtimeMs: number;
}

/** All Codex `*.jsonl` rollout files under ~/.codex/sessions, newest first. */
export async function listCodexSessionFiles(): Promise<CodexSessionFile[]> {
  const out: CodexSessionFile[] = [];
  const stack = [codexSessionsRoot];
  while (stack.length) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(full);
      } else if (e.isFile() && e.name.endsWith(".jsonl")) {
        const s = await stat(full).catch(() => null);
        if (s) out.push({ path: full, mtimeMs: s.mtimeMs });
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

/** Extract the session UUID from a rollout filename, else the path. */
export function codexSessionId(filePath: string): string {
  const m = filePath.match(
    /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
  );
  return m ? m[1] : filePath;
}

/** List the ChatGPT export `*.json` files (export root is a file or directory). */
async function listChatgptExportFiles(): Promise<string[]> {
  const s = await stat(chatgptExportRoot).catch(() => null);
  if (!s) return [];
  if (s.isFile()) return [chatgptExportRoot];
  if (!s.isDirectory()) return [];
  const entries = await readdir(chatgptExportRoot).catch(() => []);
  return entries
    .filter((f) => f.toLowerCase().endsWith(".json"))
    .map((f) => join(chatgptExportRoot, f));
}

/**
 * Load all ChatGPT conversations from the export bundle(s), newest write first.
 * Used by `distill-chatgpt` to feed each conversation into the distill pipeline.
 */
export async function loadChatgptConversations(): Promise<ChatgptConversation[]> {
  const files = await listChatgptExportFiles();
  const out: ChatgptConversation[] = [];
  for (const p of files) {
    const s = await stat(p).catch(() => null);
    if (!s || s.size > MAX_CHATGPT_FILE_SIZE) continue;
    let content: string;
    try {
      content = await readFile(p, "utf-8");
    } catch {
      continue;
    }
    out.push(...parseChatgptExport(content));
  }
  out.sort((a, b) => tsValue(b.updateTime) - tsValue(a.updateTime));
  return out;
}

function tsValue(ts: string | null): number {
  if (!ts) return 0;
  const n = new Date(ts).getTime();
  return Number.isNaN(n) ? 0 : n;
}
