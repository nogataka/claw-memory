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

      if (hasFlag(rest, "if-stale")) {
        // Incremental mode (used by hooks): skip if the transcript hasn't grown
        // since last distill; stamp the watermark on success.
        const { statSync } = await import("node:fs");
        const { shouldDistill, markDistilled } = await import("./core/watermark.js");
        let mtimeMs = 0;
        try { mtimeMs = statSync(path).mtimeMs; } catch { console.log('{"skipped":"no transcript"}'); process.exit(0); }
        if (!shouldDistill(path, mtimeMs)) { console.log('{"skipped":"up-to-date"}'); process.exit(0); }
        const res = await distill({ projectId: project.id, sessionId: session || path, transcriptPath: path });
        markDistilled(path, mtimeMs);
        console.log(JSON.stringify(res, null, 2));
        process.exit(0);
      }

      const res = await distill({ projectId: project.id, sessionId: session || path, transcriptPath: path });
      console.log(JSON.stringify(res, null, 2));
      process.exit(0);
    }
    case "hook": {
      const { readStdinJson, runDistillHook, runRecallHook } = await import("./core/hooks.js");
      const mode = rest[0]; // "distill" | "recall"
      const input = await readStdinJson();
      if (mode === "distill") {
        runDistillHook(input);
        process.exit(0);
      }
      if (mode === "recall") {
        await runRecallHook(input);
        process.exit(0);
      }
      throw new Error("hook requires a mode: distill | recall");
    }
    case "inject-recall": {
      // Convenience alias for `hook recall` (SessionStart/UserPromptSubmit).
      const { readStdinJson, runRecallHook } = await import("./core/hooks.js");
      await runRecallHook(await readStdinJson());
      process.exit(0);
    }
    case "install": {
      const target = hasFlag(rest, "claude-code") ? "claude" : "codex";
      if (target === "codex") {
        const { installCodex } = await import("./core/installer/codex.js");
        console.log("claw-memory installed for Codex:\n  " + installCodex().join("\n  "));
        console.log("\n注意: Codex を再起動してください。recall 注入・自動 distill は hooks で自動実行されます。");
      } else {
        const { installClaude } = await import("./core/installer/claude.js");
        console.log("claw-memory installed for Claude Code (manual):\n  " + installClaude().join("\n  "));
        console.log("\n注意: Claude Code を再起動してください。プラグイン利用時はこの手動設定は不要です。");
      }
      process.exit(0);
    }
    case "uninstall": {
      const target = hasFlag(rest, "claude-code") ? "claude" : "codex";
      if (target === "codex") {
        const { uninstallCodex } = await import("./core/installer/codex.js");
        console.log("removed:\n  " + uninstallCodex().join("\n  "));
      } else {
        const { uninstallClaude } = await import("./core/installer/claude.js");
        console.log("removed:\n  " + uninstallClaude().join("\n  "));
      }
      process.exit(0);
    }
    case "distill-codex": {
      const { listCodexSessionFiles, codexSessionId } = await import("./core/logsearch/recent.js");
      const { parseCodexSession } = await import("./core/logsearch/parse.js");
      const { distill } = await import("./core/distill.js");
      const { getOrCreateProjectByPath } = await import("./core/projects.js");
      const { shouldDistill, markDistilled } = await import("./core/watermark.js");
      const { isExcludedPath } = await import("./core/excludes.js");
      const { statSync, readFileSync } = await import("node:fs");

      const all = hasFlag(rest, "all");
      const limit = Number(getFlag(rest, "limit") ?? (all ? 100000 : 20));
      const files = (await listCodexSessionFiles()).slice(0, limit);
      let distilled = 0, skipped = 0, failed = 0;
      for (const f of files) {
        let mtimeMs = 0;
        try { mtimeMs = statSync(f.path).mtimeMs; } catch { continue; }
        if (!shouldDistill(f.path, mtimeMs)) { skipped++; continue; }
        let cwd = process.cwd();
        try { const c = parseCodexSession(readFileSync(f.path, "utf-8")).cwd; if (c) cwd = c; } catch { /* keep default */ }
        if (isExcludedPath(cwd)) { markDistilled(f.path, mtimeMs); skipped++; continue; }
        const project = getOrCreateProjectByPath(cwd);
        try {
          const res = await distill({ projectId: project.id, sessionId: codexSessionId(f.path), transcriptPath: f.path });
          markDistilled(f.path, mtimeMs);
          if ((res as { skipped?: boolean }).skipped) skipped++; else distilled++;
        } catch (e) {
          failed++;
          console.error(`distill failed ${f.path}: ${String(e)}`);
        }
      }
      console.log(JSON.stringify({ scanned: files.length, distilled, skipped, failed }, null, 2));
      process.exit(0);
    }
    case "distill-chatgpt": {
      const { loadChatgptConversations } = await import("./core/logsearch/recent.js");
      const { chatgptProjectPath } = await import("./core/logsearch/paths.js");
      const { distill } = await import("./core/distill.js");
      const { getOrCreateProjectByPath } = await import("./core/projects.js");
      const { shouldDistill, markDistilled } = await import("./core/watermark.js");

      const all = hasFlag(rest, "all");
      const limit = Number(getFlag(rest, "limit") ?? (all ? 100000 : 50));
      const convos = (await loadChatgptConversations()).slice(0, limit);
      // ChatGPT has no cwd; all conversations live under one stable synthetic
      // project so they never pollute a real repository's recall.
      const project = getOrCreateProjectByPath(chatgptProjectPath);
      let distilled = 0, skipped = 0, failed = 0;
      for (const conv of convos) {
        // Watermark per conversation, keyed by id + last write time.
        const wmKey = `chatgpt:${conv.conversationId}`;
        const mtimeMs = conv.updateTime ? new Date(conv.updateTime).getTime() : 0;
        if (!shouldDistill(wmKey, mtimeMs)) { skipped++; continue; }
        try {
          const res = await distill({
            projectId: project.id,
            sessionId: conv.conversationId,
            messages: conv.messages.map((m) => ({ role: m.role, text: m.text })),
          });
          markDistilled(wmKey, mtimeMs);
          if ((res as { skipped?: boolean }).skipped) skipped++; else distilled++;
        } catch (e) {
          failed++;
          console.error(`distill failed ${conv.conversationId}: ${String(e)}`);
        }
      }
      console.log(JSON.stringify({ scanned: convos.length, distilled, skipped, failed }, null, 2));
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
    case "search-logs": {
      const { searchLogs } = await import("./core/logsearch/search.js");
      // Positional query = tokens that are neither a --flag nor a flag's value.
      const positionals: string[] = [];
      for (let i = 0; i < rest.length; i++) {
        if (rest[i].startsWith("--")) {
          i++; // skip this flag's value
          continue;
        }
        positionals.push(rest[i]);
      }
      const query = positionals.join(" ").trim();
      if (!query) throw new Error("search-logs requires a query");
      const sourcesArg = getFlag(rest, "source");
      const out = await searchLogs({
        query,
        sources: sourcesArg ? (sourcesArg.split(",") as ("claude-code" | "codex")[]) : undefined,
        projectPath: getFlag(rest, "project"),
        startDate: getFlag(rest, "start"),
        endDate: getFlag(rest, "end"),
        limit: Number(getFlag(rest, "limit") ?? 20),
        offset: Number(getFlag(rest, "offset") ?? 0),
      });
      console.log(JSON.stringify(out, null, 2));
      process.exit(0);
    }
    default:
      console.error(
        "Usage: claw-memory <command>\n" +
          "  mcp                       start stdio MCP server\n" +
          "  ui [--port N] [--open]    start memory viewer\n" +
          "  distill --cwd P --session ID [--path FILE] [--if-stale]\n" +
          "  distill-codex [--recent] [--limit N] [--all]   distill recent Codex sessions\n" +
          "  distill-chatgpt [--limit N] [--all]            distill ChatGPT web export conversations\n" +
          "  remember --cwd P \"text\"\n" +
          "  search-logs \"query\" [--source claude-code,codex,chatgpt-web] [--project P] [--start ISO] [--end ISO] [--limit N] [--offset N]\n" +
          "  hook <distill|recall>     run a Claude Code lifecycle hook (reads JSON on stdin)\n" +
          "  inject-recall             alias for `hook recall`\n" +
          "  install [--codex|--claude-code]     register MCP + hooks (default: codex)\n" +
          "  uninstall [--codex|--claude-code]   remove claw-memory config"
      );
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
