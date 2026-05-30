// src/core/installer/claude.ts
//
// Manual (non-plugin) Claude Code setup: merge the claw-memory MCP server and
// the recall/distill hooks into ~/.claude/settings.json. Use this only if you
// are NOT installing the Claude Code plugin (the plugin wires these up itself).
// Idempotent and reversible; settings.json is backed up before writing.

import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from "node:fs";

const CLAUDE_DIR = join(homedir(), ".claude");
const SETTINGS = join(CLAUDE_DIR, "settings.json");

const HOOK_EVENTS: Array<["SessionStart" | "UserPromptSubmit" | "Stop", string, boolean]> = [
  ["SessionStart", "hook recall", false],
  ["UserPromptSubmit", "hook recall", false],
  ["Stop", "hook distill", true],
];

/** Resolve how to invoke claw-memory: global binary or npx. */
function invoker(): { mcp: { command: string; args: string[] }; cli: string } {
  try {
    const found = execFileSync("command", ["-v", "claw-memory"], {
      shell: "/bin/bash",
      encoding: "utf-8",
    }).trim().split("\n")[0];
    if (found) return { mcp: { command: found, args: ["mcp"] }, cli: "claw-memory" };
  } catch {
    // not on PATH
  }
  return {
    mcp: { command: "npx", args: ["-y", "@nogataka/claw-memory@latest", "mcp"] },
    cli: "npx -y @nogataka/claw-memory@latest",
  };
}

type Settings = {
  mcpServers?: Record<string, unknown>;
  hooks?: Record<string, Array<{ hooks: Array<{ type: string; command: string; async?: boolean }> }>>;
};

function read(): Settings {
  if (!existsSync(SETTINGS)) return {};
  try {
    return JSON.parse(readFileSync(SETTINGS, "utf-8")) as Settings;
  } catch {
    return {};
  }
}

function isOurs(cmd: string): boolean {
  return cmd.includes("claw-memory") && cmd.includes("hook ");
}

function save(s: Settings): void {
  mkdirSync(CLAUDE_DIR, { recursive: true });
  if (existsSync(SETTINGS)) copyFileSync(SETTINGS, SETTINGS + ".bak");
  writeFileSync(SETTINGS, JSON.stringify(s, null, 2) + "\n");
}

export function installClaude(): string[] {
  const { mcp, cli } = invoker();
  const s = read();

  s.mcpServers = { ...(s.mcpServers ?? {}), "claw-memory": mcp };

  s.hooks = s.hooks ?? {};
  for (const [event, sub, isAsync] of HOOK_EVENTS) {
    const list = (s.hooks[event] ?? []).filter(
      (g) => !g.hooks?.some((h) => isOurs(h.command))
    );
    const entry = { hooks: [{ type: "command", command: `${cli} ${sub}`, async: isAsync }] };
    list.push(entry);
    s.hooks[event] = list;
  }

  save(s);
  return [
    `settings.json: mcpServers.claw-memory (${mcp.command})`,
    "settings.json: SessionStart/UserPromptSubmit→recall, Stop→distill",
  ];
}

export function uninstallClaude(): string[] {
  const s = read();
  if (s.mcpServers) delete (s.mcpServers as Record<string, unknown>)["claw-memory"];
  if (s.hooks) {
    for (const event of Object.keys(s.hooks)) {
      s.hooks[event] = s.hooks[event]
        .map((g) => ({ ...g, hooks: (g.hooks ?? []).filter((h) => !isOurs(h.command)) }))
        .filter((g) => g.hooks.length > 0);
      if (s.hooks[event].length === 0) delete s.hooks[event];
    }
  }
  save(s);
  return ["settings.json: removed claw-memory mcp + hooks"];
}
