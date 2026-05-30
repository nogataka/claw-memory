// Engine smoke test (no LLM). Run after `npm run build`.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// Isolated temp store so we never touch ~/.claw-memory.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawmem-"));
process.env.CLAW_MEMORY_DIR = tmp;

const { getOrCreateProjectByPath } = await import("../dist/core/projects.js");
const { embedPassage, embedQuery } = await import("../dist/core/embeddings.js");
const { saveChunks, searchSimilar, searchKeyword } = await import("../dist/core/vector-memory.js");
const { searchIndex } = await import("../dist/core/search.js");
const { setPreference, addSessionSummary } = await import("../dist/core/memory.js");
const { buildMemoryBlock } = await import("../dist/core/recall.js");

let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}: ${m}`); };

const A = getOrCreateProjectByPath("/tmp/projectA");
const B = getOrCreateProjectByPath("/tmp/projectB");
ok(A.id !== B.id, "distinct projects for distinct paths");
ok(getOrCreateProjectByPath("/tmp/projectA/").id === A.id, "path normalization (trailing slash) maps to same project");

console.log("Loading embedding model (first run downloads ~100MB)...");
async function store(project, session, u, a) {
  const embedding = await embedPassage(`User: ${u}\nAssistant: ${a}`);
  return saveChunks([{ projectId: project.id, sessionId: session, userText: u, assistantText: a, embedding }]);
}

await store(A, "s1", "犬の散歩のスケジュールを管理したい", "毎朝7時にリマインドします");
await store(A, "s1", "TypeScriptのジェネリクスについて教えて", "ジェネリクスは型をパラメータ化する仕組みです");
// Identical content in B — must NOT leak into A's search.
await store(B, "s2", "犬の散歩のスケジュールを管理したい", "毎朝7時にリマインドします");

const q = await embedQuery("ペットの散歩の予定");
const simA = searchSimilar(q, A.id, 5, 1.0);
ok(simA.length > 0 && simA[0].userText.includes("犬の散歩"), "semantic search finds the dog-walking chunk in A");
ok(simA.every((c) => c.projectId === A.id), "project isolation: B's identical chunk never appears in A's results");

const tight = searchSimilar(q, A.id, 5, 0.05);
ok(tight.length <= simA.length, "maxDistance threshold prunes loose matches");

const kw = searchKeyword("TypeScript", A.id, 5);
ok(kw.length > 0, "FTS5 keyword search finds the TypeScript chunk");

const idx = await searchIndex(A.id, "ジェネリクス 型", 8);
ok(idx.length > 0 && idx[0].id && idx[0].title, "searchIndex returns light hits (id+title)");

setPreference(A.id, "preferred_language", "日本語");
addSessionSummary(A.id, "s1", "犬の散歩管理とTypeScriptの相談をした");
const block = await buildMemoryBlock(A.id, "散歩の予定を確認したい", 5);
ok(block.fullText.includes('instruction="always-apply"'), "memory block has always-apply preferences");
ok(block.preferences.some((p) => p.key === "language"), "preference key normalized preferred_language -> language");
ok(block.fullText.includes("previous-session-summaries"), "memory block includes session summaries");
ok(block.similar.length > 0, "memory block includes similar past conversations");

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
