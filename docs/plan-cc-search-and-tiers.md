# claw-memory 機能拡張計画: cc-search移植 + Tier 1〜3

> **実装ステータス: 全フェーズ完了（2026-05-30）**。フェーズ0〜4を実装・ビルド・スモーク検証済み。
> MCPツールは6→8個（`memory_search_logs` / `memory_forget` 追加）。`npm run build` 通過。

## なぜやるか

claw-memory は agent-claw の DB記憶（要約/好み/ベクトル）を移植済みだが、(1) agent-claw の第2記憶ソース「生ログ全文検索(cc-search)」が欠落、(2) 記憶の取り込みが手動、(3) 記憶の構造化・安全装置が未整備。本計画でこの3点を埋め、デーモンレス・Pythonレス・依存ゼロの思想を維持したまま claude-mem 級の体験に近づける。

## 何を変えるか

| ファイル | 操作 | 変更内容 |
|----------|------|----------|
| `src/core/logsearch/paths.ts` | 新規 | CC `~/.claude/projects`、Codex `~/.codex/sessions`・`history.jsonl` のパス定義 |
| `src/core/logsearch/parseClaudeCode.ts` | 新規 | CC jsonl 1行→{role,text,timestamp} 抽出（cc-search移植） |
| `src/core/logsearch/parseCodex.ts` | 新規 | Codex rollout jsonl 解析（session_meta→cwd、response_item.payload.message）(cc-search移植) |
| `src/core/logsearch/search.ts` | 新規 | 両ソース横断の部分一致検索 + 前後コンテキスト + フィルタ |
| `src/core/llm.ts` | 新規 | LLM呼び出し抽象。Agent SDK / Anthropic Messages / OpenAI互換 を切替（#11対応） |
| `src/core/providers.ts` | 修正 | tierルーティング（simple/summary）とモデル選択をllm.tsへ委譲 |
| `src/core/distill.ts` | 修正 | 構造化observation、`<private>`除去、重複排除、構造化要約、llm.ts利用 |
| `src/core/transcript.ts` | 修正 | `<private>`区間除去、Codexセッションも読めるよう分岐 |
| `src/core/db.ts` | 修正 | conversation_chunks 拡張列(kind/obs_type/concepts/files/deleted_at)、watermarkテーブル、ALTER try/catch |
| `src/core/vector-memory.ts` | 修正 | メタフィルタ検索(type/date/concept/file)、近傍重複検出、soft-delete対応 |
| `src/core/watermark.ts` | 新規 | セッション処理位置(mtime/offset)記録で増分distill |
| `src/core/excludes.ts` | 新規 | `CLAW_MEMORY_EXCLUDED_PROJECTS` 判定 |
| `src/core/logger.ts` | 新規 | `~/.claw-memory/logs/claw-YYYY-MM-DD.log` 日次ログ |
| `src/mcp/server.ts` | 修正 | 新ツール `memory_search_logs` `memory_forget`、検索フィルタ引数追加 |
| `src/cli.ts` | 修正 | `search-logs` `inject-recall` `hook` サブコマンド追加 |
| `src/hooks/` | 新規 | session-start(recall注入) / stop(自動distill) 用ラッパ + hooks.json雛形 |
| `src/ui/*` | 修正 | 構造化observation表示、生ログ検索タブ(任意) |
| `README.md` | 修正 | フック登録手順・新ツール・新CLI |

## どう実装するか

### フェーズ0: LLM抽象化（#11の回答・他フェーズの前提）
1. `src/core/llm.ts` に `complete({prompt, tier}): Promise<string>` を定義。バックエンド3種:
   - `agent-sdk`(既定): 現行 `query()` をラップ。CLI認証情報でゼロ設定。
   - `anthropic`: `@anthropic-ai/sdk` Messages API（`ANTHROPIC_API_KEY`）。
   - `openai-compatible`: Gemini/OpenRouter/LM Studio（`baseURL`+`apiKey`）。
2. 環境変数 `CLAW_MEMORY_LLM_BACKEND` で選択。tierルーティング `CLAW_MEMORY_TIER_*` で simple系を安価モデルへ。
3. `distill.ts` の `query()` 直呼びを `complete()` に置換。

### フェーズ1: cc-search移植（Claude Code + Codex 生ログ横断検索）
4. `logsearch/parseClaudeCode.ts`・`parseCodex.ts` を cc-search の `parseClaudeCodeSession`/`parseCodexSession` から移植（依存ゼロ・node標準のみ）。
5. `logsearch/search.ts`: `searchLogs({query, sources, limit, offset, projectPath, startDate, endDate})` → `{source,projectPath,sessionId,matchedText,contextBefore,contextAfter,timestamp,role}[]`。
6. MCPツール `memory_search_logs` と CLI `search-logs` を追加。distill済みDBとは別系統の「生ログ検索」として提供。

### フェーズ2: Tier 1（自動化）
7. `watermark.ts`: 各セッションのファイルmtime/最終offsetを記録し、未処理分のみ distill（増分）。
8. `src/hooks/` に Claude Code フック用ラッパ（cc-search-pluginの run-hook 方式踏襲）:
   - `Stop`/`SessionEnd` → `claw-memory hook distill`（現セッションを増分distill、fire-and-forget）。
   - `SessionStart`/`UserPromptSubmit` → `claw-memory inject-recall`（recallブロックをstdoutへ→additionalContext注入）。
9. README にフック登録手順（`~/.claude/settings.json`）を記載。常駐デーモンは作らない。

### フェーズ3: Tier 2（記憶の質）
10. `db.ts`: conversation_chunks に `kind, obs_type, concepts(JSON), files_read(JSON), files_modified(JSON)` を ALTER追加（try/catch、既存DB互換）。
11. distill プロンプトを構造化observation化（type=discovery/bugfix/feature/decision/change + concepts + files）。要約も request/investigated/learned/completed/next_steps の節へ。
12. `vector-memory.ts`+`search.ts`: type/日付/concept/file フィルタを WHERE追加。`memory_search` に対応引数。
13. 重複排除: save前に同projectの近傍(距離<閾値)or同一テキストhashをスキップ。

### フェーズ4: Tier 3（運用・安全）
14. `<private>...</private>` を transcript/distill 取り込み前に除去。
15. `excludes.ts`: 除外プロジェクトは distill/remember をskip。
16. soft-delete: `deleted_at` 列 + MCP `memory_forget(ids)`。検索は deleted を除外。物理削除は別CLI。
17. `logger.ts`: distill/hook/検索の構造化日次ログ。

## 検証方法

- [ ] フェーズ0: `CLAW_MEMORY_LLM_BACKEND` を3種切替で distill が同等JSONを返す（最低 agent-sdk と anthropic）
- [ ] フェーズ1: `node dist/cli.js search-logs "<既知の語>"` が CC・Codex 両方からヒットを返す（手動既知ログで確認）
- [ ] フェーズ1: `memory_search_logs` をMCP越しに呼びJSON取得
- [ ] フェーズ2: Stopフック登録後に実セッション終了→DBに要約/チャンクが増分追加され、再実行で重複しない（watermark効）
- [ ] フェーズ2: SessionStartで recall ブロックが context に注入される
- [ ] フェーズ3: distill 後 chunk に type/concepts/files が入る。`memory_search` の type/date フィルタが効く。重複投入で件数が増えない
- [ ] フェーズ4: `<private>`本文が保存されない。除外プロジェクトが記録されない。`memory_forget` 後に検索/UIから消える
- [ ] 既存6ツールのリグレッションなし（recall/search/get/remember/distill/get_preferences）
- [ ] `npm run build` 通過、UI(SSE)が引き続き動作

## リスク・注意点

- **Codexログ形式の揺れ**: cli_version差で payload構造が変わりうる。パーサは未知typeをskipし、壊れ行はcatch継続。
- **生ログ検索のI/Oコスト**: 全プロジェクト走査は重い。10MB超skip・projectPath/date事前フィルタ・limit/offsetで抑制（cc-search準拠）。
- **フックの多重起動/競合**: distillはfire-and-forget。SQLite WALで並行読み書き可だが、同一セッション同時distillはwatermark+session単位delete-insertで冪等化。
- **DBマイグレーション**: ALTERはtry/catchで既存`~/.claw-memory/memory.db`を壊さない。列追加のみ（破壊的変更なし）。
- **LLMバックエンドの認証差**: anthropic/openai系はAPIキー必須。未設定時は明示エラーで agent-sdk へフォールバック可能にする。
- **スコープが大きい**: フェーズ単位で独立リリース可能に設計。0→1→2→3→4 の順で、各フェーズ完了時点で動作する状態を保つ。

## 段階リリースの推奨順

1. **フェーズ0+1**（LLM抽象化 + cc-search移植）= 即効性が高く独立。まずここを完成・検証。
2. **フェーズ2**（自動化）= 体験が最も変わる。
3. **フェーズ3**（構造化）→ **フェーズ4**（安全）。
