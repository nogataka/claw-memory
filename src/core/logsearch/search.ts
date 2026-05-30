// src/core/logsearch/search.ts
//
// cc-search port: full-text substring search across the RAW agent transcripts of
// Claude Code and Codex — a second memory source, independent of claw-memory's
// distilled DB. Surfaces conversations that were never distilled. Read-only,
// dependency-free (node stdlib only).

import { readdir, readFile, stat } from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { createInterface } from "node:readline";
import { createReadStream } from "node:fs";
import {
  claudeProjectsRoot,
  codexSessionsRoot,
  MAX_LOG_FILE_SIZE,
  UUID_JSONL_RE,
} from "./paths.js";
import { parseClaudeCodeLine, parseCodexSession } from "./parse.js";

export type LogSource = "claude-code" | "codex";

export interface LogSearchResult {
  source: LogSource;
  projectPath: string;
  sessionId: string;
  matchedText: string;
  contextBefore: string;
  contextAfter: string;
  timestamp: string | null;
  role: "user" | "assistant";
}

export interface LogSearchOptions {
  query: string;
  sources?: LogSource[];
  limit?: number;
  offset?: number;
  /** Restrict to a project by its working-directory path (substring match). */
  projectPath?: string;
  /** ISO date (inclusive) lower/upper bounds on message timestamp. */
  startDate?: string;
  endDate?: string;
}

const CONTEXT = 100;

export async function searchLogs(
  opts: LogSearchOptions
): Promise<{ results: LogSearchResult[]; total: number }> {
  const query = opts.query.trim();
  if (!query) return { results: [], total: 0 };
  const sources = opts.sources ?? ["claude-code", "codex"];
  const limit = opts.limit ?? 20;
  const offset = opts.offset ?? 0;

  const all: LogSearchResult[] = [];
  if (sources.includes("claude-code")) {
    all.push(...(await searchClaudeCode(query, opts)));
  }
  if (sources.includes("codex")) {
    all.push(...(await searchCodex(query, opts)));
  }

  all.sort((a, b) => tsValue(b.timestamp) - tsValue(a.timestamp));
  return { results: all.slice(offset, offset + limit), total: all.length };
}

function tsValue(ts: string | null): number {
  if (!ts) return 0;
  const n = new Date(ts).getTime();
  return Number.isNaN(n) ? 0 : n;
}

function inDateRange(ts: string | null, start?: string, end?: string): boolean {
  if (!start && !end) return true;
  if (!ts) return false;
  const t = tsValue(ts);
  if (start && t < new Date(start).getTime()) return false;
  if (end && t > new Date(end).getTime() + 86_400_000) return false; // end-of-day
  return true;
}

function matchAll(
  text: string,
  query: string
): Array<{ index: number; length: number }> {
  const out: Array<{ index: number; length: number }> = [];
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  let from = 0;
  while (true) {
    const i = hay.indexOf(needle, from);
    if (i === -1) break;
    out.push({ index: i, length: query.length });
    from = i + query.length;
  }
  return out;
}

function buildResult(
  base: Omit<
    LogSearchResult,
    "matchedText" | "contextBefore" | "contextAfter"
  >,
  text: string,
  index: number,
  length: number
): LogSearchResult {
  return {
    ...base,
    matchedText: text.slice(index, index + length),
    contextBefore: text.slice(Math.max(0, index - CONTEXT), index),
    contextAfter: text.slice(index + length, index + length + CONTEXT),
  };
}

// --- Claude Code ------------------------------------------------------------

async function readClaudeCwd(filePath: string): Promise<string | null> {
  try {
    const rl = createInterface({
      input: createReadStream(filePath, { encoding: "utf-8" }),
    });
    for await (const line of rl) {
      try {
        const data = JSON.parse(line);
        if (typeof data.cwd === "string") {
          rl.close();
          return data.cwd;
        }
      } catch {
        // skip
      }
    }
  } catch {
    // unreadable
  }
  return null;
}

async function resolveClaudeProjectPath(dir: string): Promise<string> {
  // sessions-index.json → first jsonl cwd → lossy dir-name conversion.
  try {
    const idx = JSON.parse(
      await readFile(join(dir, "sessions-index.json"), "utf-8")
    ) as { originalPath?: string; entries?: Array<{ projectPath?: string }> };
    if (idx.originalPath) return idx.originalPath;
    if (idx.entries?.[0]?.projectPath) return idx.entries[0].projectPath;
  } catch {
    // none
  }
  try {
    const files = await readdir(dir);
    const f = files.find((x) => UUID_JSONL_RE.test(x));
    if (f) {
      const cwd = await readClaudeCwd(join(dir, f));
      if (cwd) return cwd;
    }
  } catch {
    // none
  }
  return basename(dir).replace(/-/g, "/");
}

async function searchClaudeCode(
  query: string,
  opts: LogSearchOptions
): Promise<LogSearchResult[]> {
  const results: LogSearchResult[] = [];
  let dirs: string[];
  try {
    dirs = await readdir(claudeProjectsRoot);
  } catch {
    return results;
  }

  for (const dirName of dirs) {
    const dir = resolve(claudeProjectsRoot, dirName);
    const ds = await stat(dir).catch(() => null);
    if (!ds?.isDirectory()) continue;

    const projectPath = await resolveClaudeProjectPath(dir);
    if (opts.projectPath && !projectPath.includes(opts.projectPath)) continue;

    const files = (await readdir(dir).catch(() => [])).filter((f) =>
      UUID_JSONL_RE.test(f)
    );
    for (const file of files) {
      const p = resolve(dir, file);
      const fs = await stat(p).catch(() => null);
      if (!fs || fs.size > MAX_LOG_FILE_SIZE) continue;
      const sessionId = file.replace(".jsonl", "");
      let content: string;
      try {
        content = await readFile(p, "utf-8");
      } catch {
        continue;
      }
      for (const line of content.split("\n")) {
        if (!line.trim()) continue;
        const msg = parseClaudeCodeLine(line);
        if (!msg) continue;
        if (!inDateRange(msg.timestamp, opts.startDate, opts.endDate)) continue;
        for (const m of matchAll(msg.text, query)) {
          results.push(
            buildResult(
              {
                source: "claude-code",
                projectPath,
                sessionId,
                timestamp: msg.timestamp,
                role: msg.role,
              },
              msg.text,
              m.index,
              m.length
            )
          );
        }
      }
    }
  }
  return results;
}

// --- Codex ------------------------------------------------------------------

async function listCodexFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  const stack = [root];
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
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(full);
    }
  }
  return out;
}

async function searchCodex(
  query: string,
  opts: LogSearchOptions
): Promise<LogSearchResult[]> {
  const results: LogSearchResult[] = [];
  const files = await listCodexFiles(codexSessionsRoot);

  for (const p of files) {
    const fs = await stat(p).catch(() => null);
    if (!fs || fs.size > MAX_LOG_FILE_SIZE) continue;
    let content: string;
    try {
      content = await readFile(p, "utf-8");
    } catch {
      continue;
    }
    const { cwd, messages } = parseCodexSession(content);
    const projectPath = cwd ?? basename(p);
    if (opts.projectPath && !projectPath.includes(opts.projectPath)) continue;
    // sessionUuid is embedded in the rollout filename: rollout-<ts>-<uuid>.jsonl
    const m = basename(p).match(
      /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i
    );
    const sessionId = m ? m[1] : basename(p).replace(".jsonl", "");

    for (const msg of messages) {
      if (!inDateRange(msg.timestamp, opts.startDate, opts.endDate)) continue;
      for (const hit of matchAll(msg.text, query)) {
        results.push(
          buildResult(
            {
              source: "codex",
              projectPath,
              sessionId,
              timestamp: msg.timestamp,
              role: msg.role,
            },
            msg.text,
            hit.index,
            hit.length
          )
        );
      }
    }
  }
  return results;
}
