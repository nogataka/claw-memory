// src/core/hooks.ts
//
// Claude Code lifecycle-hook handlers. Spawned per event (no daemon):
//   - Stop / SessionEnd     → runDistillHook  (auto-distill the finished session)
//   - SessionStart / Prompt → runRecallHook   (inject memory block into context)
// Hook input arrives as JSON on stdin; recall output goes to stdout.

import { statSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getOrCreateProjectByPath } from "./projects.js";
import { buildMemoryBlock } from "./recall.js";
import { shouldDistill } from "./watermark.js";
import { isExcludedPath } from "./excludes.js";
import { log } from "./logger.js";

export interface HookInput {
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  prompt?: string;
  hook_event_name?: string;
  source?: string;
}

export async function readStdinJson(): Promise<HookInput> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw) as HookInput;
  } catch {
    return {};
  }
}

const CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));

/**
 * Stop / SessionEnd: distill the just-finished transcript. Detached and
 * fire-and-forget so the user's session isn't blocked by the LLM call. The
 * watermark is re-checked (and stamped) inside the spawned `distill --if-stale`.
 */
export function runDistillHook(input: HookInput): void {
  const transcriptPath = input.transcript_path;
  const cwd = input.cwd ?? process.cwd();
  if (!transcriptPath || isExcludedPath(cwd)) return;

  let mtimeMs = 0;
  try {
    mtimeMs = statSync(transcriptPath).mtimeMs;
  } catch {
    return;
  }
  if (!shouldDistill(transcriptPath, mtimeMs)) return;

  log("hook.distill.spawn", { cwd, session: input.session_id });
  const child = spawn(
    process.execPath,
    [
      CLI_PATH,
      "distill",
      "--path",
      transcriptPath,
      "--cwd",
      cwd,
      "--session",
      input.session_id ?? transcriptPath,
      "--if-stale",
    ],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
}

/**
 * SessionStart / UserPromptSubmit: print the memory block to stdout. When the
 * event carries the user's prompt it also pulls semantically similar past
 * conversations; otherwise just preferences + recent summaries.
 */
export async function runRecallHook(input: HookInput): Promise<void> {
  const cwd = input.cwd ?? process.cwd();
  if (isExcludedPath(cwd)) return;
  const project = getOrCreateProjectByPath(cwd);
  const block = await buildMemoryBlock(project.id, input.prompt ?? "", 5);
  if (block.fullText.trim()) process.stdout.write(block.fullText + "\n");
}
