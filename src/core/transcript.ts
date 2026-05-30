// src/core/transcript.ts
//
// Load a conversation transcript. Supports an explicit .jsonl path or a Claude
// Code session id resolved under ~/.claude/projects/<encoded-cwd>/<id>.jsonl.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseCodexSession } from "./logsearch/parse.js";

export interface TranscriptMessage {
  role: "user" | "assistant";
  text: string;
}

const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

export function encodeCwdToDir(cwd: string): string {
  return path.resolve(cwd).replace(/\//g, "-");
}

export function resolveSessionJsonl(cwd: string, sessionId: string): string {
  return path.join(CLAUDE_PROJECTS_DIR, encodeCwdToDir(cwd), `${sessionId}.jsonl`);
}

/**
 * Parse a transcript into ordered user/assistant text messages. Auto-detects
 * the format: Codex rollout logs (first line is `session_meta`, or path under
 * ~/.codex) are delegated to the Codex parser; otherwise Claude Code JSONL.
 */
export function loadTranscript(filePath: string): TranscriptMessage[] {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf-8");

  if (isCodexTranscript(filePath, raw)) {
    const { messages } = parseCodexSession(raw);
    return messages.map((m) => ({ role: m.role, text: m.text }));
  }

  const out: TranscriptMessage[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.parent_tool_use_id) continue;
    const role = entry?.message?.role;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (role !== "user" && role !== "assistant") continue;

    const content = entry.message.content;
    let text = "";
    if (typeof content === "string") {
      text = content;
    } else if (Array.isArray(content)) {
      // Skip tool_result-only user turns.
      if (content.some((b: any) => b?.type === "tool_result")) continue;
      text = content
        .filter((b: any) => b?.type === "text")
        .map((b: any) => b.text)
        .join("");
    }
    if (text.trim()) out.push({ role, text });
  }
  return out;
}

/** Heuristic: a Codex rollout log lives under ~/.codex or starts with session_meta. */
function isCodexTranscript(filePath: string, raw: string): boolean {
  if (filePath.includes(`${path.sep}.codex${path.sep}`)) return true;
  const firstLine = raw.slice(0, raw.indexOf("\n") + 1 || undefined).trim();
  if (!firstLine) return false;
  try {
    return (JSON.parse(firstLine) as { type?: string }).type === "session_meta";
  } catch {
    return false;
  }
}
