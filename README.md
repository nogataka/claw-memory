# claw-memory

Independent, **in-process** semantic memory for any MCP-capable agent (Claude Code, Codex, …).
No daemon, no Python, no external vector DB.

- **Storage**: `better-sqlite3` + `sqlite-vec` (vectors live *inside* the SQLite file)
- **Embeddings**: local `Xenova/multilingual-e5-small` (384-dim, multilingual, offline)
- **Search**: semantic (cosine KNN, per-project metadata filter) + FTS5 keyword fallback
- **Write**: LLM distillation of session transcripts → summary + preferences + chunks
- **Viewer**: optional, on-demand lightweight web UI (no framework, no build)

Data lives at `~/.claw-memory/memory.db` (override with `CLAW_MEMORY_DIR`). Completely
separate from any other app.

## Install

Published as `@nogataka/claw-memory`. Install once globally so hooks/MCP resolve fast
(otherwise they fall back to `npx`):

```bash
npm install -g @nogataka/claw-memory
```

First run downloads the e5 model (~100 MB, cached in `~/.cache`).

### Claude Code (plugin)

```
/plugin marketplace add nogataka/claw-memory
/plugin install claw-memory
```

Restart Claude Code. This auto-registers the MCP server and the hooks
(SessionStart/UserPromptSubmit → recall injection, Stop → auto-distill).
No manual setup. (Not using the plugin? Run `claw-memory install --claude-code`
to merge the MCP server + hooks into `~/.claude/settings.json`.)

### Codex (installer)

Codex has no third-party plugin marketplace, so register via the installer:

```bash
claw-memory install --codex      # adds [mcp_servers.claw-memory] to ~/.codex/config.toml
                                 # + memory-recall skill + AGENTS.md recall instruction
```

Restart Codex. Recall is available via the `memory_recall` MCP tool (the AGENTS.md
note tells the agent to call it at session start). **Auto-distill is manual on Codex**
(no notify hook); run periodically:

```bash
claw-memory distill-codex --recent     # distill recent Codex sessions (watermark-deduped)
claw-memory distill-codex --all        # backfill everything
```

Remove with `claw-memory uninstall --codex` (or `--claude-code`).

### From source

```bash
cd claw-memory
npm install      # builds native better-sqlite3 / sqlite-vec
npm run build    # tsc -> dist/
```

## MCP tools

| Tool | Purpose |
|------|---------|
| `memory_recall(query, cwd?, topK?)` | Ready-to-read context block: preferences + summaries + similar past conversations |
| `memory_search(query, cwd?, limit?)` | Token-efficient hit index (id + title + date) |
| `memory_get(ids)` | Full text for given chunk ids |
| `memory_remember(text, cwd?, sessionId?)` | Store a free-text note |
| `memory_distill(cwd, sessionId? \| transcriptPath?)` | Summarize a session into memory (needs LLM creds) |
| `memory_get_preferences(cwd?)` | List stored preferences |
| `memory_search_logs(query, sources?, projectPath?, startDate?, endDate?, limit?, offset?)` | Full-text search over RAW Claude Code + Codex transcripts (second memory source; finds undistilled history) |
| `memory_forget(ids)` | Soft-delete chunks (hidden from search/recall/viewer) |

`memory_distill` uses an LLM (see *LLM backend* below). `memory_search_logs` reads
`~/.claude/projects` and `~/.codex/sessions` directly. All other tools are fully local.

## LLM backend (distill only)

distill needs a single tool-less completion, selectable via `CLAW_MEMORY_LLM_BACKEND`:

| Backend | Auth | Notes |
|---------|------|-------|
| `agent-sdk` (default) | Claude Code CLI login (Claude Pro/Max/Team/Enterprise) | zero-config, no API key |
| `codex-sdk` | Codex CLI login (ChatGPT/Codex plan) | `@openai/codex-sdk`, no API key; requires Codex CLI. Model via `CLAW_MEMORY_CODEX_MODEL` |
| `anthropic` | `ANTHROPIC_API_KEY` (`ANTHROPIC_BASE_URL` optional) | plain Messages API |
| `openai-compatible` | `CLAW_MEMORY_OPENAI_API_KEY` + `CLAW_MEMORY_OPENAI_BASE_URL` | Gemini / OpenRouter / LM Studio (set `CLAW_MEMORY_MODEL`) |

```bash
export CLAW_MEMORY_LLM_BACKEND=codex-sdk    # use the Codex subscription for distill
```

Both SDK backends reuse a subscription login (no API key). Tier routing (cheap models for
simple work): `CLAW_MEMORY_TIER_SMART` / `_SUMMARY` / `_SIMPLE`, else `AGENT_SDK_MODEL` /
`CLAW_MEMORY_MODEL` (agent-sdk/anthropic default `claude-sonnet-4-5`; codex-sdk uses the Codex default).

## Automatic capture & recall (Claude Code hooks)

No daemon — hooks spawn the CLI per event. Register in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "/Volumes/Data/dev/claw-memory/hooks/claw-hook.sh recall" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "/Volumes/Data/dev/claw-memory/hooks/claw-hook.sh recall" }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "/Volumes/Data/dev/claw-memory/hooks/claw-hook.sh distill" }] }]
  }
}
```

- **recall** (SessionStart / UserPromptSubmit): prints the memory block to stdout → injected into context. Preferences + recent summaries, plus semantically similar past conversations when the prompt is present.
- **distill** (Stop): detached, fire-and-forget. Incremental via a watermark (skips sessions with no new content). Honors `CLAW_MEMORY_EXCLUDED_PROJECTS` and `<private>…</private>`.

## Register with an agent

### Claude Code — `.mcp.json` (project root) or `~/.claude.json`

```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["/Volumes/Data/dev/claw-memory/dist/cli.js", "mcp"]
    }
  }
}
```

### Codex — `~/.codex/config.toml`

```toml
[mcp_servers.memory]
command = "node"
args = ["/Volumes/Data/dev/claw-memory/dist/cli.js", "mcp"]
```

Then add to your `CLAUDE.md` / `AGENTS.md`:
> 会話の冒頭で `memory_recall` を呼び、過去の文脈と好みを取得すること。

## Memory viewer

```bash
npm run ui            # http://localhost:4319 , opens browser
# or
node dist/cli.js ui --port 4319 --open
```

Read-only. Browse projects, session summaries, conversation chunks and preferences.
Start it only when you want to inspect; nothing runs in the background otherwise.

## CLI

```bash
node dist/cli.js mcp                                   # stdio MCP server
node dist/cli.js ui [--port N] [--open]                # viewer
node dist/cli.js distill --cwd <dir> --session <id>    # distill a CC session
node dist/cli.js remember --cwd <dir> "a note"         # store a note
```

## Notes

- `better-sqlite3` / `sqlite-vec` are native; rebuild on Node ABI changes (`npm rebuild`).
- The MCP server is long-lived per agent session, so the embedding model loads once.
- Viewer + MCP can run simultaneously (SQLite WAL handles concurrent read/write).
