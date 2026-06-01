# claw-memory

**English** | [日本語](README.ja.md)

**Local, in-process long-term memory for AI coding agents (Claude Code & Codex).**
Your agent remembers past sessions, your preferences, and prior decisions — and can
search every raw transcript you've ever recorded. No daemon, no Python, no external
vector database, no data leaving your machine (except the LLM call that summarizes a
session, which you control).

```bash
npm install -g @nogataka/claw-memory
```

- **Storage**: `better-sqlite3` + `sqlite-vec` — vectors live *inside* one SQLite file
- **Embeddings**: local `Xenova/multilingual-e5-small` (384-dim, multilingual, offline)
- **Two memory sources**: a distilled semantic DB **and** full-text search over raw
  Claude Code + Codex transcripts
- **Auto-capture**: lifecycle hooks distill finished sessions and inject relevant memory
  back into new ones
- **Pluggable LLM**: distill via your Claude or Codex subscription (no API key), or any
  Anthropic / OpenAI-compatible endpoint

---

## Table of contents

- [Features](#features)
- [Installation guide](#installation-guide)
- [MCP tools](#mcp-tools)
- [Configuration](#configuration-environment-variables)
- [CLI reference](#cli-reference)
- [How it works](#how-it-works)
- [Memory viewer](#memory-viewer)
- [Uninstall](#uninstall)
- [Notes](#notes)

---

## Features

### 1. Two independent memory sources

| Source | What it is | Tooling |
|--------|-----------|---------|
| **Distilled DB** | LLM-summarized sessions → summaries, preferences, and embedded conversation chunks with structured metadata. Semantically searchable. | `memory_recall`, `memory_search`, `memory_get` |
| **Raw transcript search** | Full-text grep over your *actual* Claude Code (`~/.claude/projects`) and Codex (`~/.codex/sessions`) logs — including sessions that were never distilled. | `memory_search_logs` |

The distilled DB is curated and fast to recall; raw search is a safety net that finds
anything you ever discussed, even before claw-memory was installed.

### 2. Automatic capture (distill)

When a session ends, claw-memory distills the transcript into:

- a **structured summary** (`### 依頼 / 調査・判明 / 完了 / 次の一手`),
- **user preferences** (language, response style, frameworks, tone, …) applied as
  always-on context,
- **conversation chunks** embedded for semantic search, each tagged with an
  **observation type** (`discovery` / `bugfix` / `feature` / `decision` / `change`),
  **concepts**, and **files read / modified**.

Distillation is **incremental** (a watermark skips sessions with no new content) and
**idempotent** (re-distilling a session replaces, never duplicates). Cross-session
duplicate chunks are dropped.

### 3. Automatic recall injection

At the start of a session (and on each prompt), claw-memory injects a memory block:

- **Preferences** as `instruction="always-apply"` — the agent follows them.
- **Recent summaries + semantically similar past conversations** as
  `instruction="reference-only"` — used as background, not parroted back.

This means the agent picks up where you left off without you re-explaining context.

### 4. Structured, filterable search

`memory_search` returns a token-light index (id + title + date + type). Filter by
`type`, `concept`, `file`, or date range, then pull full bodies with `memory_get` only
for what you need — keeping context usage minimal.

### 5. Privacy & safety, by design

- **Fully local**: storage and embeddings never leave your machine. Only `distill`
  calls an LLM, and you choose which one.
- **`<private>…</private>`** spans are stripped before anything is persisted or sent
  to the LLM.
- **`CLAW_MEMORY_EXCLUDED_PROJECTS`**: never record or recall listed paths.
- **`memory_forget`**: soft-delete chunks; they vanish from search, recall, and the viewer.

### 6. Pluggable LLM backend (distill only)

Use a subscription login (no API key) or any HTTP endpoint — see
[Configuration](#configuration-environment-variables). Tier routing lets cheap models
handle the high-frequency distill work.

### 7. On-demand web viewer

A zero-build, read-only viewer (`claw-memory ui`) to browse projects, summaries,
chunks (with their metadata), preferences, and to run raw-log search — with live
updates via SSE. It runs only when you start it.

---

## Installation guide

### Prerequisites

- **Node.js ≥ 20**
- For the subscription LLM backends: **Claude Code CLI** (logged in) and/or **Codex CLI** (logged in)
- First `distill` downloads the embedding model (~100 MB, cached under `~/.cache`)

### Step 1 — install the package globally

```bash
npm install -g @nogataka/claw-memory
```

Installing globally makes hooks and the MCP server start instantly. (Without it, the
plugin falls back to `npx -y @nogataka/claw-memory@latest`, which is slower on first run.)

### Step 2a — Claude Code (plugin, recommended)

```text
/plugin marketplace add nogataka/claw-memory
/plugin install claw-memory
```

Restart Claude Code. This auto-registers:

- the **MCP server** (8 memory tools), and
- the **hooks**: `SessionStart` / `UserPromptSubmit` → recall injection, `Stop` → auto-distill.

No manual config. To verify, run `/mcp` and look for `claw-memory`.

> **Not using the plugin?** Run `claw-memory install --claude-code` to merge the MCP
> server and hooks into `~/.claude/settings.json` (idempotent, backs up the file).

### Step 2b — Codex (plugin)

Codex supports the same plugin format as Claude Code. claw-memory ships a
`.codex-plugin/plugin.json` manifest, so installing it as a Codex plugin wires up
the MCP server **and** the lifecycle hooks — full parity with Claude Code:

```
codex
/plugins
```

The plugin registers, via Codex's `${CLAUDE_PLUGIN_ROOT}` (provided for compatibility):

- the `claw-memory` MCP server (`.mcp.json`),
- `SessionStart` / `UserPromptSubmit` → **auto recall injection** (memory block as developer context),
- `Stop` → **auto distill** of recent Codex sessions (watermark-deduped, async), and
- the `memory-recall` skill.

### Step 2b (alt) — Codex (installer, no marketplace)

If you install from npm instead of the plugin marketplace, register via the CLI:

```bash
claw-memory install --codex
```

This idempotently:

- adds `[mcp_servers.claw-memory]` to `~/.codex/config.toml` (backed up to `config.toml.bak`),
- merges recall/distill hooks into `~/.codex/hooks.json` (backed up; your own hooks are preserved),
- installs the `memory-recall` skill, and
- appends an `AGENTS.md` instruction telling the agent to call `memory_recall` at session start.

Restart Codex. **Recall injection and auto-distill now run via hooks** — no manual step needed.
You can still backfill on demand:

```bash
claw-memory distill-codex --recent     # distill recent Codex sessions (watermark-deduped)
claw-memory distill-codex --all        # backfill everything
```

### Step 2c — from source (development)

```bash
git clone https://github.com/nogataka/claw-memory
cd claw-memory
npm install          # builds native better-sqlite3 / sqlite-vec
npm run build        # tsc -> dist/
npm link             # optional: expose the `claw-memory` binary
```

---

## MCP tools

| Tool | Purpose |
|------|---------|
| `memory_recall(query, cwd?, topK?)` | Ready-to-read context block: preferences + recent summaries + similar past conversations. Call at the start of a task. |
| `memory_search(query, cwd?, limit?, type?, concept?, file?, dateFrom?, dateTo?)` | Token-light hit index (id + title + date + type), with metadata filters. |
| `memory_get(ids)` | Full text + metadata for given chunk ids. |
| `memory_remember(text, cwd?, sessionId?)` | Store a durable free-text note. |
| `memory_distill(cwd, sessionId? \| transcriptPath?)` | Summarize a session into memory (needs an LLM backend). |
| `memory_get_preferences(cwd?)` | List stored preferences for the project. |
| `memory_search_logs(query, sources?, projectPath?, startDate?, endDate?, limit?, offset?)` | Full-text search over RAW Claude Code + Codex transcripts. |
| `memory_forget(ids)` | Soft-delete chunks (hidden from search / recall / viewer). |

All tools are fully local except `memory_distill` (LLM) and `memory_search_logs`
(reads `~/.claude/projects` and `~/.codex/sessions` directly).

---

## Configuration (environment variables)

| Variable | Default | Purpose |
|----------|---------|---------|
| `CLAW_MEMORY_DIR` | `~/.claw-memory` | Data directory (holds `memory.db` and `logs/`). |
| `CLAW_MEMORY_LLM_BACKEND` | `agent-sdk` | `agent-sdk` \| `codex-sdk` \| `anthropic` \| `openai-compatible`. |
| `CLAW_MEMORY_MODEL` / `AGENT_SDK_MODEL` | `claude-sonnet-4-5` | Default distill model (agent-sdk / anthropic). |
| `CLAW_MEMORY_TIER_SMART` / `_SUMMARY` / `_SIMPLE` | — | Per-tier model override (route cheap models to simple work). |
| `CLAW_MEMORY_CODEX_MODEL` | Codex default | Model for the `codex-sdk` backend. |
| `CLAW_MEMORY_CODEX_API_KEY` | — | Optional; otherwise the Codex CLI login is used. |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` | — | For the `anthropic` backend. |
| `CLAW_MEMORY_OPENAI_API_KEY` / `CLAW_MEMORY_OPENAI_BASE_URL` | — | For the `openai-compatible` backend (Gemini / OpenRouter / LM Studio). |
| `CLAW_MEMORY_EXCLUDED_PROJECTS` | — | Comma/colon-separated path substrings to never record or recall. |
| `MEMORY_SIMILARITY_MAX_DISTANCE` | `0.6` | Max cosine distance for a semantic hit (lower = stricter). |
| `CLAW_MEMORY_UI_PORT` | `4319` | Viewer port. |

### LLM backends

| Backend | Auth | Notes |
|---------|------|-------|
| `agent-sdk` (default) | Claude CLI login (Pro/Max/Team/Enterprise) | zero-config, no API key |
| `codex-sdk` | Codex CLI login (ChatGPT/Codex plan) | `@openai/codex-sdk`; runs read-only, no tools |
| `anthropic` | `ANTHROPIC_API_KEY` | plain Messages API over fetch |
| `openai-compatible` | `CLAW_MEMORY_OPENAI_API_KEY` + base URL + `CLAW_MEMORY_MODEL` | Gemini / OpenRouter / LM Studio |

```bash
export CLAW_MEMORY_LLM_BACKEND=codex-sdk   # distill using the Codex subscription
```

---

## CLI reference

```bash
claw-memory mcp                                  # stdio MCP server (what agents spawn)
claw-memory ui [--port N] [--open]               # read-only web viewer
claw-memory distill --cwd P --session ID [--path FILE] [--if-stale]
claw-memory distill-codex [--recent] [--limit N] [--all]
claw-memory remember --cwd P "a note"
claw-memory search-logs "query" [--source claude-code,codex] [--project P]
                                 [--start ISO] [--end ISO] [--limit N] [--offset N]
claw-memory hook <recall|distill>               # lifecycle hook (reads JSON on stdin)
claw-memory install   [--codex | --claude-code] # register MCP + hooks (default: codex)
claw-memory uninstall [--codex | --claude-code]
```

---

## How it works

```
[write path]                              [read path]
session ends (Stop hook / distill-codex)   session starts (SessionStart hook / memory_recall)
   └ distill                                   └ buildMemoryBlock
       ├ summary  ───────────► session_summaries ──► <previous-session-summaries>
       ├ preferences ────────► user_preferences ───► <user-preferences> (always-apply)
       └ chunks (embed+meta) ─► vec_chunks + ────────► <relevant-past-conversations>
                                conversation_chunks    (cosine KNN, per-project, filtered)

[separate source] raw logs (~/.claude/projects, ~/.codex/sessions) ──► memory_search_logs
```

- **One SQLite file** at `~/.claw-memory/memory.db`. `sqlite-vec` stores 384-dim vectors
  inside it; metadata lives in a parallel table; FTS5 provides a keyword fallback.
- **Embeddings** run locally via `Xenova/multilingual-e5-small` (multilingual, offline,
  e5 `query:`/`passage:` prefixing). The model loads once per MCP process.
- **Search** is hybrid: cosine KNN (filtered by project + metadata) augmented with FTS5
  keyword hits, de-duplicated and distance-sorted.
- Daily structured logs are written to `~/.claw-memory/logs/`.

---

## Memory viewer

```bash
claw-memory ui --open        # http://localhost:4319
```

Read-only. Browse projects, session summaries, conversation chunks (with type /
concepts / files), and preferences; toggle **🔎 ログ検索** to full-text search raw
Claude Code + Codex transcripts. Live-updates via SSE while open. Nothing runs in the
background otherwise — start it only when you want to inspect.

---

## Uninstall

```bash
claw-memory uninstall --codex          # remove config.toml block + hooks + skill + AGENTS note
claw-memory uninstall --claude-code    # remove mcp + hooks from settings.json
# Claude Code plugin: /plugin uninstall claw-memory
npm uninstall -g @nogataka/claw-memory
```

Your memory database is left untouched; delete `~/.claw-memory` to wipe it.

---

## Notes

- `better-sqlite3` / `sqlite-vec` are native modules; run `npm rebuild` after a Node ABI change.
- The MCP server is long-lived per agent session, so the embedding model loads once.
- Viewer + MCP can run simultaneously — SQLite WAL handles concurrent read/write.
- On install, dependencies resolve with `legacy-peer-deps=true` (a zod peer-range overlap
  between bundled SDKs); this is configured in `.npmrc` and is harmless.
