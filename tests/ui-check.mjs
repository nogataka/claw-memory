// UI API smoke test (no model, no real port — Hono apps are fetch-callable).
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "clawmem-ui-"));
process.env.CLAW_MEMORY_DIR = tmp;

const { getOrCreateProjectByPath } = await import("../dist/core/projects.js");
const { saveChunks } = await import("../dist/core/vector-memory.js");
const { setPreference, addSessionSummary } = await import("../dist/core/memory.js");
const { buildUiApp } = await import("../dist/ui/server.js");

const A = getOrCreateProjectByPath("/tmp/uiProject");
saveChunks([{ projectId: A.id, sessionId: "s1", userText: "テスト発言", assistantText: "応答", embedding: new Float32Array(384) }]);
setPreference(A.id, "language", "日本語");
addSessionSummary(A.id, "s1", "UI検証用の要約");

const app = buildUiApp();
let pass = 0, fail = 0;
const ok = (c, m) => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"}: ${m}`); };
const get = async (u) => { const r = await app.fetch(new Request("http://x" + u)); return { status: r.status, body: await r.json().catch(() => null), text: r }; };

const root = await app.fetch(new Request("http://x/"));
ok(root.status === 200 && (await root.text()).includes("claw-memory"), "GET / serves the viewer HTML");

const stats = await get("/api/stats");
ok(stats.status === 200 && stats.body.projects >= 1 && stats.body.chunks >= 1, "GET /api/stats returns counts");

const projects = await get("/api/projects");
ok(projects.status === 200 && projects.body[0].counts.summaries >= 1 && projects.body[0].counts.preferences >= 1, "GET /api/projects returns per-project counts");

const mem = await get("/api/memory?project=" + A.id);
ok(mem.status === 200 && mem.body.summaries.length >= 1 && mem.body.chunks.length >= 1 && mem.body.preferences.length >= 1, "GET /api/memory returns summaries+chunks+preferences");

const bad = await get("/api/memory");
ok(bad.status === 400, "GET /api/memory without project -> 400");

console.log(`\n${pass} passed, ${fail} failed`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(fail ? 1 : 0);
