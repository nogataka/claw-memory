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
import { resolveSessionJsonl } from "../core/transcript.js";
import { searchLogs, type LogSource } from "../core/logsearch/search.js";
import { isExcludedPath } from "../core/excludes.js";

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
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export async function runMcpServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[claw-memory] MCP server ready (stdio)");
}
