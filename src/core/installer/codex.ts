// src/core/installer/codex.ts
//
// Codex has no third-party plugin marketplace, so "installing" claw-memory means
// idempotently editing ~/.codex config: register the MCP server in config.toml,
// drop a memory-recall skill, and add an AGENTS.md instruction. All edits live
// inside marker blocks so they can be cleanly removed and never clobber the
// user's own settings. config.toml is backed up before writing.

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  rmSync,
} from "node:fs";

const CODEX_DIR = join(homedir(), ".codex");
const CONFIG = join(CODEX_DIR, "config.toml");
const AGENTS = join(CODEX_DIR, "AGENTS.md");
const SKILL_DIR = join(CODEX_DIR, "skills", "memory-recall");

const BEGIN = "# >>> claw-memory >>>";
const END = "# <<< claw-memory <<<";
const A_BEGIN = "<!-- >>> claw-memory >>> -->";
const A_END = "<!-- <<< claw-memory <<< -->";

/** TOML basic-string literal with escaping. */
function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Prefer a globally installed `claw-memory`; otherwise run via npx. */
function resolveCommand(): { command: string; args: string[] } {
  try {
    const found = execFileSync("command", ["-v", "claw-memory"], {
      shell: "/bin/bash",
      encoding: "utf-8",
    }).trim();
    if (found) return { command: found.split("\n")[0], args: ["mcp"] };
  } catch {
    // not on PATH
  }
  return { command: "npx", args: ["-y", "@nogataka/claw-memory@latest", "mcp"] };
}

/** Insert or replace the marker-delimited block in `content`. */
function upsertBlock(content: string, begin: string, end: string, block: string): string {
  const b = content.indexOf(begin);
  const e = content.indexOf(end);
  if (b !== -1 && e !== -1 && e > b) {
    return content.slice(0, b) + block + content.slice(e + end.length);
  }
  const sep = content && !content.endsWith("\n") ? "\n\n" : content ? "\n" : "";
  return content + sep + block + "\n";
}

/** Remove the marker-delimited block (and a trailing blank line) if present. */
function removeBlock(content: string, begin: string, end: string): string {
  const b = content.indexOf(begin);
  const e = content.indexOf(end);
  if (b === -1 || e === -1 || e < b) return content;
  let out = content.slice(0, b) + content.slice(e + end.length);
  return out.replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
}

function skillSource(): string {
  // dist/core/installer/codex.js -> package root /skills/memory-recall/SKILL.md
  return fileURLToPath(
    new URL("../../../skills/memory-recall/SKILL.md", import.meta.url)
  );
}

export function installCodex(): string[] {
  const done: string[] = [];
  mkdirSync(CODEX_DIR, { recursive: true });

  // 1) MCP server registration in config.toml
  const { command, args } = resolveCommand();
  const block = [
    BEGIN,
    "[mcp_servers.claw-memory]",
    `command = ${tomlStr(command)}`,
    `args = [${args.map(tomlStr).join(", ")}]`,
    END,
  ].join("\n");
  const prev = existsSync(CONFIG) ? readFileSync(CONFIG, "utf-8") : "";
  if (existsSync(CONFIG)) copyFileSync(CONFIG, CONFIG + ".bak");
  writeFileSync(CONFIG, upsertBlock(prev, BEGIN, END, block));
  done.push(`config.toml: [mcp_servers.claw-memory] (${command})`);

  // 2) memory-recall skill
  try {
    mkdirSync(SKILL_DIR, { recursive: true });
    copyFileSync(skillSource(), join(SKILL_DIR, "SKILL.md"));
    done.push(`skill: ${SKILL_DIR}/SKILL.md`);
  } catch (e) {
    done.push(`skill: SKIPPED (${String(e)})`);
  }

  // 3) AGENTS.md recall instruction
  const agentsBlock = [
    A_BEGIN,
    "## claw-memory",
    "",
    "セッション冒頭で MCP ツール `memory_recall`（query=ユーザーの依頼）を呼び、過去の好み・要約・類似会話を取得すること。",
    "特定の話題を探すときは `memory_search`、過去の生ログ（Claude Code/Codex）は `memory_search_logs` を使う。",
    A_END,
  ].join("\n");
  const agentsPrev = existsSync(AGENTS) ? readFileSync(AGENTS, "utf-8") : "";
  writeFileSync(AGENTS, upsertBlock(agentsPrev, A_BEGIN, A_END, agentsBlock));
  done.push("AGENTS.md: recall instruction");

  return done;
}

export function uninstallCodex(): string[] {
  const done: string[] = [];
  if (existsSync(CONFIG)) {
    copyFileSync(CONFIG, CONFIG + ".bak");
    writeFileSync(CONFIG, removeBlock(readFileSync(CONFIG, "utf-8"), BEGIN, END));
    done.push("config.toml: removed claw-memory block");
  }
  if (existsSync(AGENTS)) {
    writeFileSync(AGENTS, removeBlock(readFileSync(AGENTS, "utf-8"), A_BEGIN, A_END));
    done.push("AGENTS.md: removed claw-memory block");
  }
  try {
    rmSync(SKILL_DIR, { recursive: true, force: true });
    done.push("skill: removed");
  } catch {
    // ignore
  }
  return done;
}
