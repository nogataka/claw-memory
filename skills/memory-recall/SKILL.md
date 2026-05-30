---
name: memory-recall
description: >-
  Recall and search long-term memory across past sessions (claw-memory).
  Use when the user asks about previous sessions, past discussions, prior
  decisions, or to find something discussed before.
  Triggers: "前回の会話", "前のセッション", "過去の会話", "以前話した", "前に決めた",
  "履歴", "recall", "previous session", "what did we discuss", "past decision".
user_invocable: true
---

# Memory Recall

claw-memory stores long-term memory locally (per project): user preferences,
session summaries, and embedded conversation chunks, plus raw Claude Code /
Codex transcripts. Use its MCP tools — do not read the DB directly.

## Which tool to use

- **`memory_recall(query, cwd?)`** — start here. Returns a ready-to-read block:
  always-apply preferences + recent summaries + semantically similar past
  conversations. Best at the start of a task or when the user references the past.
- **`memory_search(query, cwd?, type?, concept?, file?, dateFrom?, dateTo?)`** —
  token-efficient index (id + title + date + type) of matching chunks. Filter by
  `type` (discovery|bugfix|feature|decision|change), `concept`, `file`, or date.
  Then fetch only what you need with **`memory_get(ids)`**.
- **`memory_search_logs(query, sources?, projectPath?, startDate?, endDate?)`** —
  full-text search over RAW transcripts (Claude Code + Codex), including sessions
  that were never distilled. Use when distilled memory has no hit.
- **`memory_remember(text, cwd?)`** — store a durable note.
- **`memory_forget(ids)`** — soft-delete chunks surfaced by `memory_search`.

## Tips

- Pass the user's actual request as `query`; keep it natural language.
- Prefer `memory_recall` for context, `memory_search`→`memory_get` for digging,
  `memory_search_logs` for "we talked about X somewhere" across raw logs.
- Treat recalled past conversations as reference-only: don't volunteer them
  unless the user is clearly continuing a prior topic.
