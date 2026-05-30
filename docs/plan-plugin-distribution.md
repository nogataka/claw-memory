# claw-memory プラグイン化計画（Claude Code + Codex 配布）

## なぜやるか

現状 claw-memory は手動の MCP 登録でしか使えない。Claude Code には正式なプラグイン、Codex にはインストーラ コマンドを用意し、MCP 登録・フック有効化・skill 導入までをワンステップ化して両環境へ配布できるようにする。

## 前提（調査で確定した制約）

- **配布**: npm 公開 `@nogataka/claw-memory`。プラグイン/設定は `npx`/グローバル `claw-memory` を呼ぶ（better-sqlite3 等ネイティブ依存は npm の prebuilt で解決。git clone だけの素のプラグインでは動かないため）。
- **Claude Code**: 正式プラグイン（`.claude-plugin/` + `.mcp.json` + `hooks/` + `skills/`）。`/plugin marketplace add` → `/plugin install` で MCP・フック・skill が自動有効化。
- **Codex**: 第三者プラグインの install 機構なし。`claw-memory install --codex` が `~/.codex/config.toml` に `[mcp_servers.claw-memory]` を冪等追記し、skill と AGENTS.md スニペットを配置。
- **Codex 自動 distill**: 手動のみ（`claw-memory distill-codex --recent`）。notify は単一スロット競合のため不使用。

## 何を変えるか

| ファイル | 操作 | 変更内容 |
|----------|------|----------|
| `package.json` | 修正 | `private` 除去、`name:@nogataka/claw-memory`、`files`(dist/,hooks/,skills/,.claude-plugin/,.mcp.json)、`prepare`/`prepublishOnly:build`、`engines` |
| `.npmignore` | 新規 | src/・docs/・テスト等を公開物から除外 |
| `.claude-plugin/plugin.json` | 新規 | プラグイン定義（name/version/description） |
| `.claude-plugin/marketplace.json` | 新規 | `/plugin marketplace add` 用ラッパ |
| `.mcp.json` | 新規 | `claw-memory` MCP を `npx -y @nogataka/claw-memory mcp` で登録（`${CLAUDE_PLUGIN_ROOT}` 経由のラッパ優先） |
| `hooks/hooks.json` | 新規 | SessionStart/UserPromptSubmit→recall、Stop→distill |
| `hooks/run-hook.cmd` | 新規 | Windows/Unix 両対応ラッパ（cc-search-plugin 流用） |
| `hooks/claw-hook.sh` | 修正 | グローバル `claw-memory` を優先、無ければ `npx` フォールバック |
| `skills/memory-recall/SKILL.md` | 新規 | 過去記憶検索 skill（Claude Code・Codex 共用） |
| `src/cli.ts` | 修正 | `install [--claude-code\|--codex]` `uninstall` `distill-codex` サブコマンド追加 |
| `src/core/installer/codex.ts` | 新規 | config.toml のマーカ区間冪等編集、skill/AGENTS スニペット配置 |
| `src/core/installer/claude.ts` | 新規 | 非プラグイン手動導入用（settings.json への hook/mcp 追記、任意） |
| `src/core/logsearch/recent.ts` | 新規 | 未処理 Codex セッション列挙（watermark 連携） |
| `src/core/distill.ts` 周辺 | 修正 | `distillCodexRecent()` を追加（loadTranscript は Codex 対応済み） |
| `README.md` | 修正 | 両環境のインストール手順・アンインストール |

## どう実装するか

1. **npm パッケージ化**: `package.json` の `private` 除去・スコープ名・`files`・`prepublishOnly` 設定。`.npmignore` 作成。`npm pack` で同梱物を確認。
2. **Claude Code プラグイン**: `.claude-plugin/plugin.json` + `marketplace.json`、`.mcp.json`（MCP=claw-memory）、`hooks/hooks.json`（recall/distill）を追加。`claw-hook.sh` を「グローバル優先→npx フォールバック」に改修。
3. **Codex インストーラ** (`installer/codex.ts`): `config.toml` に `# >>> claw-memory >>>` … `# <<< claw-memory <<<` のマーカ区間を冪等に挿入/更新（既存内容は破壊しない、編集前にバックアップ）。`memory-recall` skill を Codex の skill 探索先へ配置。AGENTS.md に「セッション冒頭で memory_recall を呼ぶ」スニペットをマーカ付きで追記。
4. **手動 distill** (`distill-codex`): `recent.ts` で `~/.codex/sessions/**/*.jsonl` を新しい順に列挙し、watermark 未処理のものを `--limit N` 分だけ `distill()`（Codex 形式は判別済み）。`--recent` で直近、`--all` で全件。
5. **install/uninstall CLI**: `claw-memory install --codex`（config.toml/skill/AGENTS 設定）、`--claude-code`（プラグイン未使用時の手動設定）、`uninstall` で各マーカ区間を除去。
6. **skill**: `skills/memory-recall/SKILL.md`（history-recall 相当。`memory_recall`/`memory_search`/`memory_search_logs` の使い分けを記載）。
7. **ドキュメント**: README にインストール手順（Claude=plugin、Codex=installer）、必要要件（Node20+/Codex CLI/Claude サブスク）を追記。

## 検証方法

- [ ] `npm pack` の中身に dist/hooks/skills/.claude-plugin/.mcp.json が含まれ、src/docs が除外される
- [ ] グローバル `npm i -g`（or `npm link`）後、`claw-memory mcp` / `hook recall` / `hook distill` が動作
- [ ] Claude Code: `/plugin marketplace add` → `/plugin install` → 再起動で MCP 8ツールが見え、SessionStart で recall 注入、Stop で自動 distill
- [ ] Codex: `claw-memory install --codex` 実行後 `config.toml` に `[mcp_servers.claw-memory]` が冪等追記（再実行で重複しない）。Codex 起動で memory ツールが使える
- [ ] `claw-memory distill-codex --recent` で未処理 Codex ログが distill され、再実行で watermark により重複しない
- [ ] `claw-memory uninstall` で config.toml/AGENTS の claw-memory 区間のみ除去され他設定は無傷
- [ ] 既存機能（6→8 MCP ツール、UI/SSE）にリグレッションなし

## リスク・注意点

- **ネイティブ依存**: better-sqlite3 の prebuilt が対象 OS/Node ABI に無いとビルド失敗。対象を Node20/22 に明記し、`npm i -g` を推奨（npx 初回は遅い）。
- **npx 初回遅延**: hooks 毎回 `npx -y` は遅い。グローバル `claw-memory` を優先し npx はフォールバックに留める。
- **config.toml 破壊防止**: TOML パーサは追加せず、マーカ区間の挿入/置換のみ。編集前に `config.toml.bak` を保存。失敗時はロールバック。
- **Codex 自動化は手動のみ**: 自動 distill は無い（notify 不使用）。`distill-codex` の手動実行が前提であることを README に明示。
- **スコープ名の確定**: `@nogataka/claw-memory` で公開（他パッケージと統一）。公開可否（npm ログイン/権限）は要確認。
- **モデルDL**: 初回 distill 時に Xenova モデルがDLされる（オフライン初回は失敗しうる）。

## 段階リリース

1. npm パッケージ化 + グローバル動作（土台）
2. Claude Code プラグイン（marketplace/install）
3. Codex インストーラ + distill-codex
4. skill + ドキュメント
