// src/ui/server.ts
//
// On-demand, read-only memory viewer. Tiny Hono server — started only when the
// user runs `claw-memory ui`, never a persistent daemon.

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { sqlite } from "../core/db.js";
import { listProjects } from "../core/projects.js";
import { getRecentSummaries, getPreferences } from "../core/memory.js";
import { listChunks, getChunkCount } from "../core/vector-memory.js";
import { PAGE } from "./page.js";

function countSummaries(projectId: string): number {
  return (
    sqlite
      .prepare("SELECT COUNT(*) c FROM session_summaries WHERE project_id = ?")
      .get(projectId) as { c: number }
  ).c;
}
function countPreferences(projectId: string): number {
  return (
    sqlite
      .prepare("SELECT COUNT(*) c FROM user_preferences WHERE project_id = ?")
      .get(projectId) as { c: number }
  ).c;
}

export function buildUiApp(): Hono {
  const app = new Hono();

  app.get("/", (c) => c.html(PAGE));

  app.get("/api/stats", (c) => {
    const projects = listProjects();
    const chunks = (
      sqlite.prepare("SELECT COUNT(*) c FROM conversation_chunks").get() as { c: number }
    ).c;
    const summaries = (
      sqlite.prepare("SELECT COUNT(*) c FROM session_summaries").get() as { c: number }
    ).c;
    return c.json({ projects: projects.length, chunks, summaries });
  });

  app.get("/api/projects", (c) => {
    const out = listProjects().map((p) => ({
      id: p.id,
      name: p.name,
      path: p.path,
      counts: {
        summaries: countSummaries(p.id),
        chunks: getChunkCount(p.id),
        preferences: countPreferences(p.id),
      },
    }));
    return c.json(out);
  });

  app.get("/api/memory", (c) => {
    const projectId = c.req.query("project");
    if (!projectId) return c.json({ error: "project required" }, 400);
    return c.json({
      summaries: getRecentSummaries(projectId, 100),
      preferences: getPreferences(projectId),
      chunks: listChunks(projectId, 300),
    });
  });

  return app;
}

export function runUiServer(port: number, open: boolean): void {
  const app = buildUiApp();
  serve({ fetch: app.fetch, port }, (info) => {
    const url = `http://localhost:${info.port}`;
    console.error(`[claw-memory] viewer running at ${url}`);
    if (open) {
      const cmd =
        process.platform === "darwin"
          ? "open"
          : process.platform === "win32"
            ? "start"
            : "xdg-open";
      import("node:child_process").then(({ spawn }) =>
        spawn(cmd, [url], { stdio: "ignore", detached: true }).unref()
      );
    }
  });
}
