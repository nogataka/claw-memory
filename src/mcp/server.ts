// src/mcp/server.ts
//
// stdio MCP server. The engine is imported in-process: the Xenova model loads
// once at startup and is reused for every tool call within the agent session.
// No daemon, no external services.

import { basename } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { getOrCreateProjectByPath } from "../core/projects.js";
import { getPreferences } from "../core/memory.js";
import { buildMemoryBlock } from "../core/recall.js";
import { searchIndex } from "../core/search.js";
import { getChunksByIds, forgetChunks } from "../core/vector-memory.js";
import { distill, rememberText } from "../core/distill.js";
import { resolveSessionJsonl, loadTranscript } from "../core/transcript.js";
import { searchLogs, type LogSource } from "../core/logsearch/search.js";
import { isExcludedPath } from "../core/excludes.js";
import { stripPrivate } from "../core/private.js";
import { searchLessons, injectLessons } from "../core/lesson-search.js";
import { getLesson, setStatus, supersede, getEvents, getLinks } from "../core/lessons.js";
import { saveCandidates, extractDedicated } from "../core/lesson-extract.js";

function projectFor(cwd?: string) {
  return getOrCreateProjectByPath(cwd && cwd.trim() ? cwd : process.cwd());
}

const TOOLS = [
  {
    name: "memory_recall",
    description:
      "Retrieve relevant long-term memory for the current project as a ready-to-read context block: user preferences (always-apply) plus recent session summaries and semantically similar past conversations (reference-only). Call this at the start of a conversation, passing the user's request as `query`.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "The user's latest request / topic to find related memory for." },
        cwd: { type: "string", description: "Project working directory. Defaults to the server's cwd." },
        topK: { type: "number", description: "Max similar conversations (default 5)." },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_search",
    description:
      "Token-efficient memory search. Returns a light index (id + title + date + type) of matching past conversation chunks (hybrid semantic + keyword). Optional filters: type/concept/file/date. Use the returned ids with memory_get to fetch full bodies only for what you need.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        cwd: { type: "string" },
        limit: { type: "number", description: "Max hits (default 8)." },
        type: { type: "string", description: "Filter by obs_type: discovery|bugfix|feature|decision|change|other." },
        concept: { type: "string", description: "Filter to chunks tagged with this concept (substring)." },
        file: { type: "string", description: "Filter to chunks touching this file path (substring)." },
        dateFrom: { type: "string", description: "Only chunks created on/after this ISO date." },
        dateTo: { type: "string", description: "Only chunks created on/before this ISO date." },
      },
      required: ["query"],
    },
  },
  {
    name: "memory_get",
    description: "Fetch the full text of conversation chunks by their ids (from memory_search).",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"],
    },
  },
  {
    name: "memory_remember",
    description: "Store a single free-text note into long-term memory for later semantic recall.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string" },
        cwd: { type: "string" },
        sessionId: { type: "string", description: "Optional grouping id (default 'manual')." },
      },
      required: ["text"],
    },
  },
  {
    name: "memory_distill",
    description:
      "Distill a finished session transcript into a summary + user preferences + embedded chunks. Provide a sessionId (resolved from the Claude Code transcript under the given cwd) or an explicit transcriptPath. Requires LLM credentials in the environment.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        sessionId: { type: "string" },
        transcriptPath: { type: "string" },
      },
    },
  },
  {
    name: "memory_get_preferences",
    description: "List the stored user preferences for the current project.",
    inputSchema: {
      type: "object",
      properties: { cwd: { type: "string" } },
    },
  },
  {
    name: "memory_forget",
    description:
      "Soft-delete conversation chunks by id (from memory_search). Tombstoned chunks are excluded from search, recall and the viewer. Irreversible via this tool.",
    inputSchema: {
      type: "object",
      properties: { ids: { type: "array", items: { type: "string" } } },
      required: ["ids"],
    },
  },
  {
    name: "memory_search_logs",
    description:
      "Full-text search across RAW agent transcripts (Claude Code and Codex) under ~/.claude/projects and ~/.codex/sessions. A second memory source independent of the distilled DB: finds past conversations even if they were never distilled. Returns matches with surrounding context, source, project path, session id, role and timestamp.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to search for (case-insensitive)." },
        sources: {
          type: "array",
          items: { type: "string", enum: ["claude-code", "codex"] },
          description: "Which log sources to scan (default both).",
        },
        projectPath: { type: "string", description: "Restrict to a project by working-dir path (substring)." },
        startDate: { type: "string", description: "ISO date lower bound (inclusive)." },
        endDate: { type: "string", description: "ISO date upper bound (inclusive)." },
        limit: { type: "number", description: "Max hits (default 20)." },
        offset: { type: "number", description: "Skip N hits (default 0)." },
      },
      required: ["query"],
    },
  },
  {
    name: "lesson_search",
    description:
      "Search reusable LESSONS (distilled, abstracted knowledge: bug-fix patterns, project constraints, design decisions) relevant to a task. Only approved lessons are returned, ranked by semantic + scope + confidence + recency. Use when starting a task to recall how similar problems were solved before.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Task / problem to find lessons for." },
        cwd: { type: "string" },
        limit: { type: "number", description: "Max lessons (default 5)." },
      },
      required: ["query"],
    },
  },
  {
    name: "lesson_inject",
    description:
      "Like lesson_search, but returns a ready-to-read <relevant-lessons> context block (hints, not absolute facts) to drop into an agent's context.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        cwd: { type: "string" },
        limit: { type: "number", description: "Max lessons (default 5)." },
      },
      required: ["query"],
    },
  },
  {
    name: "lesson_get",
    description:
      "Fetch one lesson's full detail (all fields + status history + linked lessons) by id.",
    inputSchema: {
      type: "object",
      properties: { lesson_id: { type: "string" } },
      required: ["lesson_id"],
    },
  },
  {
    name: "lesson_extract",
    description:
      "Run a dedicated lesson-extraction pass over a finished session transcript and store the candidates. Provide a sessionId (resolved under cwd) or an explicit transcriptPath. Requires LLM credentials.",
    inputSchema: {
      type: "object",
      properties: {
        cwd: { type: "string" },
        sessionId: { type: "string" },
        transcriptPath: { type: "string" },
      },
    },
  },
  {
    name: "lesson_approve",
    description: "Promote a candidate lesson to 'approved' (then it surfaces in lesson_search / recall).",
    inputSchema: {
      type: "object",
      properties: { lesson_id: { type: "string" } },
      required: ["lesson_id"],
    },
  },
  {
    name: "lesson_reject",
    description: "Reject a candidate lesson (wrong / too specific / temporary).",
    inputSchema: {
      type: "object",
      properties: {
        lesson_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["lesson_id"],
    },
  },
  {
    name: "lesson_archive",
    description: "Archive a lesson that is outdated but worth keeping as history.",
    inputSchema: {
      type: "object",
      properties: {
        lesson_id: { type: "string" },
        reason: { type: "string" },
      },
      required: ["lesson_id"],
    },
  },
  {
    name: "lesson_supersede",
    description: "Replace an old lesson with a newer one (old becomes 'superseded' and is linked).",
    inputSchema: {
      type: "object",
      properties: {
        old_lesson_id: { type: "string" },
        new_lesson_id: { type: "string" },
      },
      required: ["old_lesson_id", "new_lesson_id"],
    },
  },
] as const;

const server = new Server(
  { name: "claw-memory", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = (req.params.arguments ?? {}) as Record<string, unknown>;
  try {
    const text = await dispatch(name, args);
    return { content: [{ type: "text", text }] };
  } catch (err) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `claw-memory error in ${name}: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }
});

async function dispatch(name: string, args: Record<string, unknown>): Promise<string> {
  switch (name) {
    case "memory_recall": {
      const project = projectFor(args.cwd as string | undefined);
      const block = await buildMemoryBlock(
        project.id,
        String(args.query ?? ""),
        (args.topK as number) ?? 5
      );
      return block.fullText || "(記憶なし: このプロジェクトにはまだ保存された記憶がありません)";
    }
    case "memory_search": {
      const project = projectFor(args.cwd as string | undefined);
      const hits = await searchIndex(
        project.id,
        String(args.query ?? ""),
        (args.limit as number) ?? 8,
        {
          obsType: args.type as string | undefined,
          concept: args.concept as string | undefined,
          file: args.file as string | undefined,
          dateFrom: args.dateFrom as string | undefined,
          dateTo: args.dateTo as string | undefined,
        }
      );
      if (hits.length === 0) return "(該当なし)";
      return hits
        .map(
          (h) =>
            `- id=${h.id} [${h.date}] (${h.source}${h.obsType ? `/${h.obsType}` : ""}${h.distance != null ? ` d=${h.distance.toFixed(3)}` : ""}) ${h.title}`
        )
        .join("\n");
    }
    case "memory_get": {
      const ids = (args.ids as string[]) ?? [];
      const chunks = getChunksByIds(ids);
      if (chunks.length === 0) return "(該当なし)";
      return chunks
        .map((c) => {
          const tags = [
            c.obsType ? `type=${c.obsType}` : "",
            c.concepts.length ? `concepts=${c.concepts.join(", ")}` : "",
            c.filesModified.length ? `modified=${c.filesModified.join(", ")}` : "",
            c.filesRead.length ? `read=${c.filesRead.join(", ")}` : "",
          ].filter(Boolean);
          const meta = tags.length ? `\n[${tags.join(" | ")}]` : "";
          return `### ${c.id} [${c.createdAt.split("T")[0]}]${meta}\nUser: ${c.userText}\nAssistant: ${c.assistantText}`;
        })
        .join("\n\n");
    }
    case "memory_forget": {
      const ids = (args.ids as string[]) ?? [];
      const n = forgetChunks(ids);
      return `忘却しました (${n}件を削除済みにしました)`;
    }
    case "memory_remember": {
      const cwdArg = (args.cwd as string) ?? process.cwd();
      if (isExcludedPath(cwdArg)) return "(除外プロジェクトのため保存しませんでした)";
      const project = projectFor(args.cwd as string | undefined);
      const id = await rememberText({
        projectId: project.id,
        sessionId: (args.sessionId as string) ?? "manual",
        text: String(args.text ?? ""),
      });
      return `保存しました (id=${id})`;
    }
    case "memory_distill": {
      const cwd = (args.cwd as string) ?? process.cwd();
      if (isExcludedPath(cwd)) return JSON.stringify({ skipped: "excluded project" });
      const project = getOrCreateProjectByPath(cwd);
      const sessionId = (args.sessionId as string) ?? "";
      const transcriptPath =
        (args.transcriptPath as string) ??
        (sessionId ? resolveSessionJsonl(cwd, sessionId) : undefined);
      if (!transcriptPath) {
        throw new Error("memory_distill requires sessionId or transcriptPath");
      }
      const res = await distill({
        projectId: project.id,
        sessionId: sessionId || transcriptPath,
        transcriptPath,
      });
      return JSON.stringify(res);
    }
    case "memory_get_preferences": {
      const project = projectFor(args.cwd as string | undefined);
      const prefs = getPreferences(project.id);
      if (prefs.length === 0) return "(好みは未保存)";
      return prefs.map((p) => `- ${p.key}: ${p.value}`).join("\n");
    }
    case "memory_search_logs": {
      const { results, total } = await searchLogs({
        query: String(args.query ?? ""),
        sources: args.sources as LogSource[] | undefined,
        projectPath: args.projectPath as string | undefined,
        startDate: args.startDate as string | undefined,
        endDate: args.endDate as string | undefined,
        limit: (args.limit as number) ?? 20,
        offset: (args.offset as number) ?? 0,
      });
      if (results.length === 0) return "(該当なし)";
      const lines = results.map((r) => {
        const date = r.timestamp ? r.timestamp.split("T")[0] : "????-??-??";
        const ctx = `${r.contextBefore}「${r.matchedText}」${r.contextAfter}`
          .replace(/\s+/g, " ")
          .trim();
        return `- [${date}] (${r.source}/${r.role}) ${basename(r.projectPath)} #${r.sessionId.slice(0, 8)}\n  …${ctx}…`;
      });
      return `${total}件ヒット (上位${results.length}件表示):\n${lines.join("\n")}`;
    }
    case "lesson_search": {
      const project = projectFor(args.cwd as string | undefined);
      const hits = await searchLessons(
        String(args.query ?? ""),
        { projectId: project.id },
        { limit: (args.limit as number) ?? 5 }
      );
      if (hits.length === 0) return "(該当なし)";
      return hits
        .map(
          (l) =>
            `- id=${l.id} [${l.scope}] (conf=${l.confidence.toFixed(2)} score=${l.score.toFixed(2)}) ${l.title}`
        )
        .join("\n");
    }
    case "lesson_inject": {
      const project = projectFor(args.cwd as string | undefined);
      const block = await injectLessons(
        String(args.query ?? ""),
        { projectId: project.id },
        { limit: (args.limit as number) ?? 5 }
      );
      return block || "(該当する approved lesson なし)";
    }
    case "lesson_get": {
      const lesson = getLesson(String(args.lesson_id ?? ""));
      if (!lesson) return "(該当なし)";
      const events = getEvents(lesson.id);
      const links = getLinks(lesson.id);
      const parts = [
        `# ${lesson.title}`,
        `id=${lesson.id} | scope=${lesson.scope} | status=${lesson.status} | confidence=${lesson.confidence.toFixed(2)}`,
        `\n${lesson.lesson}`,
        lesson.appliesWhen.length ? `\nApplies when:\n${lesson.appliesWhen.map((s) => `- ${s}`).join("\n")}` : "",
        lesson.avoidWhen.length ? `\nAvoid when:\n${lesson.avoidWhen.map((s) => `- ${s}`).join("\n")}` : "",
        lesson.evidence ? `\nEvidence: ${lesson.evidence}` : "",
        lesson.concepts.length ? `\nConcepts: ${lesson.concepts.join(", ")}` : "",
        lesson.files.length ? `\nFiles: ${lesson.files.join(", ")}` : "",
        lesson.sessionId ? `\nSource session: ${lesson.sessionId}` : "",
        events.length ? `\nHistory: ${events.map((e) => `${e.eventType}(${e.oldStatus ?? "-"}→${e.newStatus ?? "-"})`).join(", ")}` : "",
        links.length ? `\nLinks: ${links.map((k) => `${k.relation}→${k.linkedLessonId === lesson.id ? k.lessonId : k.linkedLessonId}`).join(", ")}` : "",
      ];
      return parts.filter(Boolean).join("\n");
    }
    case "lesson_extract": {
      const cwd = (args.cwd as string) ?? process.cwd();
      if (isExcludedPath(cwd)) return JSON.stringify({ skipped: "excluded project" });
      const project = getOrCreateProjectByPath(cwd);
      const sessionId = (args.sessionId as string) ?? "";
      const transcriptPath =
        (args.transcriptPath as string) ??
        (sessionId ? resolveSessionJsonl(cwd, sessionId) : undefined);
      if (!transcriptPath) {
        throw new Error("lesson_extract requires sessionId or transcriptPath");
      }
      const messages = loadTranscript(transcriptPath)
        .map((m) => ({ ...m, text: stripPrivate(m.text) }))
        .filter((m) => m.text.trim());
      const transcript = messages
        .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text.slice(0, 500)}`)
        .join("\n");
      const candidates = await extractDedicated(transcript);
      const ids = await saveCandidates({
        projectId: project.id,
        sessionId: sessionId || transcriptPath,
        candidates,
      });
      return JSON.stringify({ extracted: candidates.length, saved: ids.length });
    }
    case "lesson_approve": {
      const ok = setStatus(String(args.lesson_id ?? ""), "approved");
      return ok ? "approved" : "(該当なし)";
    }
    case "lesson_reject": {
      const ok = setStatus(String(args.lesson_id ?? ""), "rejected", args.reason as string | undefined);
      return ok ? "rejected" : "(該当なし)";
    }
    case "lesson_archive": {
      const ok = setStatus(String(args.lesson_id ?? ""), "archived", args.reason as string | undefined);
      return ok ? "archived" : "(該当なし)";
    }
    case "lesson_supersede": {
      const ok = supersede(String(args.old_lesson_id ?? ""), String(args.new_lesson_id ?? ""));
      return ok ? "superseded" : "(該当なし)";
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export async function runMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[claw-memory] MCP server ready (stdio)");
}
