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

```bash
cd claw-memory
npm install      # builds native better-sqlite3 / sqlite-vec
npm run build    # tsc -> dist/
```

First run downloads the e5 model (~100 MB, cached in `~/.cache`).

## MCP tools

| Tool | Purpose |
|------|---------|
| `memory_recall(query, cwd?, topK?)` | Ready-to-read context block: preferences + summaries + similar past conversations |
| `memory_search(query, cwd?, limit?)` | Token-efficient hit index (id + title + date) |
| `memory_get(ids)` | Full text for given chunk ids |
| `memory_remember(text, cwd?, sessionId?)` | Store a free-text note |
| `memory_distill(cwd, sessionId? \| transcriptPath?)` | Summarize a session into memory (needs LLM creds) |
| `memory_get_preferences(cwd?)` | List stored preferences |

`memory_distill` uses the Claude Agent SDK; set `AGENT_SDK_MODEL` and the relevant
`ANTHROPIC_*` credentials in the environment. All other tools are fully local.

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
