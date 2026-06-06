// src/ui/server.ts
//
// On-demand, read-only memory viewer. Tiny Hono server — started only when the
// user runs `claw-memory ui`, never a persistent daemon.

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { streamSSE } from "hono/streaming";
import { sqlite } from "../core/db.js";
import { listProjects } from "../core/projects.js";
import { getRecentSummaries, getPreferences } from "../core/memory.js";
import { listChunks, getChunkCount } from "../core/vector-memory.js";
import { searchLogs, type LogSource } from "../core/logsearch/search.js";
import {
  listLessons,
  listConflicts,
  getConflictCount,
  getLesson,
  getLessonCount,
  getEvents,
  getLinks,
  setStatus,
  supersede,
  updateLesson,
  type LessonStatus,
} from "../core/lessons.js";
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

  // Server-Sent Events: push a "change" whenever the DB is modified by any
  // connection (the MCP server runs in a separate process). PRAGMA data_version
  // increments on commits from other connections, so polling it in-process is a
  // cheap, I/O-free change signal — no client-side polling required.
  app.get("/api/events", (c) => {
    return streamSSE(c, async (stream) => {
      const dataVersion = () =>
        sqlite.pragma("data_version", { simple: true }) as number;
      let last = dataVersion();
      await stream.writeSSE({ event: "ready", data: String(last) });
      while (!stream.closed && !stream.aborted) {
        await stream.sleep(1500);
        const v = dataVersion();
        if (v !== last) {
          last = v;
          await stream.writeSSE({ event: "change", data: String(v) });
        } else {
          // heartbeat keeps proxies/browser from dropping an idle connection
          await stream.writeSSE({ event: "ping", data: "" });
        }
      }
    });
  });

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
        lessons: getLessonCount({ projectId: p.id }),
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

  // --- Lesson layer -------------------------------------------------------
  // The viewer is read-only for chunks/summaries, but lessons are reviewable:
  // these POST routes are the only writes the UI performs, and only ever touch
  // the lessons tables.
  app.get("/api/lessons", (c) => {
    const projectId = c.req.query("project") || undefined;
    const status = c.req.query("status") || undefined;
    // "conflicts" is a virtual view (lessons in a conflicts_with link), not a
    // real status column value.
    const lessons =
      status === "conflicts"
        ? listConflicts(projectId, 500)
        : listLessons({ projectId, status }, 500);
    return c.json({
      lessons,
      counts: {
        candidate: getLessonCount({ projectId, status: "candidate" }),
        approved: getLessonCount({ projectId, status: "approved" }),
        rejected: getLessonCount({ projectId, status: "rejected" }),
        archived: getLessonCount({ projectId, status: "archived" }),
        superseded: getLessonCount({ projectId, status: "superseded" }),
        conflicts: getConflictCount(projectId),
      },
    });
  });

  app.get("/api/lessons/:id", (c) => {
    const lesson = getLesson(c.req.param("id"));
    if (!lesson) return c.json({ error: "not found" }, 404);
    return c.json({ lesson, events: getEvents(lesson.id), links: getLinks(lesson.id) });
  });

  app.post("/api/lessons/:id/:action", async (c) => {
    const id = c.req.param("id");
    const action = c.req.param("action");
    const body = await c.req.json().catch(() => ({}) as Record<string, unknown>);
    let ok = false;
    switch (action) {
      case "approve":
        ok = setStatus(id, "approved");
        break;
      case "reject":
        ok = setStatus(id, "rejected", body.reason as string | undefined);
        break;
      case "archive":
        ok = setStatus(id, "archived", body.reason as string | undefined);
        break;
      case "status":
        ok = setStatus(id, body.status as LessonStatus, body.note as string | undefined);
        break;
      case "scope":
        ok = updateLesson(id, { scope: String(body.scope) });
        break;
      case "confidence":
        ok = updateLesson(id, { confidence: Number(body.confidence) });
        break;
      case "supersede":
        ok = supersede(id, String(body.newId));
        break;
      default:
        return c.json({ error: "unknown action" }, 400);
    }
    return c.json({ ok }, ok ? 200 : 404);
  });

  // Raw transcript search (cc-search port) — Claude Code + Codex logs.
  app.get("/api/logs", async (c) => {
    const query = c.req.query("q") ?? "";
    if (!query.trim()) return c.json({ results: [], total: 0 });
    const sourcesParam = c.req.query("sources");
    const out = await searchLogs({
      query,
      sources: sourcesParam ? (sourcesParam.split(",") as LogSource[]) : undefined,
      projectPath: c.req.query("project") || undefined,
      limit: Number(c.req.query("limit") ?? 30),
    });
    return c.json(out);
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
