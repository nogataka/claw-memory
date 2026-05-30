// src/core/logsearch/recent.ts
//
// Enumerate Codex rollout transcripts newest-first, for batch distillation
// (claw-memory distill-codex). Read-only over ~/.codex/sessions.

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { codexSessionsRoot } from "./paths.js";

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
