#!/usr/bin/env node
// src/cli.ts
//
// claw-memory CLI. Subcommands:
//   mcp                       start the stdio MCP server (what agents spawn)
//   ui [--port N] [--open]    start the on-demand memory viewer
//   distill --cwd P --session ID [--path FILE]
//   remember --cwd P "text"

function getFlag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  switch (cmd) {
    case "mcp": {
      const { runMcpServer } = await import("./mcp/server.js");
      await runMcpServer();
      return; // stays alive on stdio
    }
    case "ui": {
      const { runUiServer } = await import("./ui/server.js");
      const port = Number(getFlag(rest, "port") ?? process.env.CLAW_MEMORY_UI_PORT ?? 4319);
      runUiServer(port, hasFlag(rest, "open"));
      return;
    }
    case "distill": {
      const { getOrCreateProjectByPath } = await import("./core/projects.js");
      const { distill } = await import("./core/distill.js");
      const { resolveSessionJsonl } = await import("./core/transcript.js");
      const cwd = getFlag(rest, "cwd") ?? process.cwd();
      const session = getFlag(rest, "session") ?? "";
      const path = getFlag(rest, "path") ?? (session ? resolveSessionJsonl(cwd, session) : undefined);
      if (!path) throw new Error("distill requires --session or --path");
      const project = getOrCreateProjectByPath(cwd);
      const res = await distill({ projectId: project.id, sessionId: session || path, transcriptPath: path });
      console.log(JSON.stringify(res, null, 2));
      process.exit(0);
    }
    case "remember": {
      const { getOrCreateProjectByPath } = await import("./core/projects.js");
      const { rememberText } = await import("./core/distill.js");
      const cwd = getFlag(rest, "cwd") ?? process.cwd();
      const text = rest.filter((a) => !a.startsWith("--") && a !== cwd).join(" ").trim();
      if (!text) throw new Error("remember requires text");
      const project = getOrCreateProjectByPath(cwd);
      const id = await rememberText({ projectId: project.id, sessionId: "manual", text });
      console.log(`saved id=${id}`);
      process.exit(0);
    }
    default:
      console.error(
        "Usage: claw-memory <mcp|ui|distill|remember>\n" +
          "  mcp                       start stdio MCP server\n" +
          "  ui [--port N] [--open]    start memory viewer\n" +
          "  distill --cwd P --session ID [--path FILE]\n" +
          "  remember --cwd P \"text\""
      );
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
