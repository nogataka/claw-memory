// src/ui/page.ts
// Single-file viewer (vanilla JS, no build step). Served as-is by the UI server.

export const PAGE = /* html */ `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>claw-memory viewer</title>
<style>
  :root { --bg:#0d1117; --panel:#161b22; --border:#30363d; --fg:#e6edf3; --muted:#8b949e;
          --accent:#58a6ff; --chip:#21262d; }
  * { box-sizing:border-box; }
  body { margin:0; font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
         background:var(--bg); color:var(--fg);
         height:100vh; overflow:hidden; display:flex; flex-direction:column; }
  header { display:flex; align-items:center; gap:12px; padding:12px 18px;
           border-bottom:1px solid var(--border); background:var(--panel); flex:0 0 auto; }
  header h1 { font-size:15px; margin:0; font-weight:600; }
  header .muted { color:var(--muted); font-size:12px; }
  #search { margin-left:auto; background:var(--bg); border:1px solid var(--border); color:var(--fg);
            border-radius:6px; padding:6px 10px; width:280px; }
  .layout { display:flex; flex:1; min-height:0; }
  nav { width:240px; border-right:1px solid var(--border); padding:10px; overflow-y:auto; min-height:0; }
  nav button { display:block; width:100%; text-align:left; background:transparent; color:var(--fg);
               border:0; border-radius:6px; padding:8px 10px; cursor:pointer; font-size:13px; }
  nav button:hover { background:var(--chip); }
  nav button.active { background:var(--chip); border:1px solid var(--border); }
  nav .nm { font-weight:600; }
  nav .pth { color:var(--muted); font-size:11px; word-break:break-all; }
  main { flex:1; padding:18px; overflow-y:auto; min-height:0; }
  .sect { margin-bottom:26px; }
  .sect h2 { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:var(--muted);
             margin:0 0 10px; }
  .card { background:var(--panel); border:1px solid var(--border); border-radius:8px;
          padding:12px 14px; margin-bottom:10px; }
  .card .meta { color:var(--muted); font-size:11px; margin-bottom:6px; display:flex; gap:8px; }
  .tag { background:var(--chip); border-radius:4px; padding:1px 6px; font-size:10px; }
  .card .u { color:var(--accent); }
  .card pre { white-space:pre-wrap; word-break:break-word; margin:4px 0 0; font:inherit; }
  .pref { display:inline-flex; gap:6px; background:var(--panel); border:1px solid var(--border);
          border-radius:6px; padding:6px 10px; margin:0 8px 8px 0; }
  .pref b { color:var(--accent); }
  .empty { color:var(--muted); padding:30px; text-align:center; }
  .cmeta { color:var(--muted); font-size:11px; margin:2px 0; word-break:break-all; }
  header button#logsBtn, header button#lessonsBtn { background:var(--chip); color:var(--fg);
    border:1px solid var(--border); border-radius:6px; padding:6px 10px; cursor:pointer; font-size:12px; }
  header button#logsBtn.on, header button#lessonsBtn.on { background:var(--accent); color:#0d1117; border-color:var(--accent); }
  .src { color:var(--accent); font-size:10px; }
  .hl { background:#9e6a03; color:#fff; border-radius:2px; padding:0 1px; }
  .lstatus { border-radius:4px; padding:1px 6px; font-size:10px; font-weight:600; }
  .lstatus.candidate { background:#3a2d00; color:#e3b341; }
  .lstatus.approved  { background:#03361a; color:#3fb950; }
  .lstatus.rejected  { background:#3a0d0d; color:#f85149; }
  .lstatus.archived  { background:#21262d; color:#8b949e; }
  .lstatus.superseded{ background:#26203a; color:#a371f7; }
  .lact { display:flex; flex-wrap:wrap; gap:6px; margin-top:10px; }
  .lact button, .lact select { background:var(--chip); color:var(--fg); border:1px solid var(--border);
    border-radius:6px; padding:4px 9px; cursor:pointer; font-size:11px; }
  .lact button:hover { background:var(--accent); color:#0d1117; }
  .lact button.danger:hover { background:#f85149; color:#fff; }
  .lbody { white-space:pre-wrap; word-break:break-word; margin:6px 0; }
  .lcond { font-size:12px; color:var(--muted); margin:3px 0; }
  .lcond b { color:var(--fg); font-weight:600; }
  .lhist { font-size:11px; color:var(--muted); margin-top:8px; border-top:1px solid var(--border); padding-top:6px; }
  .lfilter { display:flex; gap:6px; margin-bottom:14px; flex-wrap:wrap; }
  .lfilter button { background:var(--chip); color:var(--fg); border:1px solid var(--border);
    border-radius:14px; padding:4px 12px; cursor:pointer; font-size:12px; }
  .lfilter button.on { background:var(--accent); color:#0d1117; border-color:var(--accent); }
</style>
</head>
<body>
<header>
  <h1>🧠 claw-memory</h1>
  <span class="muted" id="stats"></span>
  <button id="lessonsBtn" title="レッスン (再利用可能な知識のレビュー)">📚 Lessons</button>
  <button id="logsBtn" title="生ログ全文検索 (Claude Code + Codex)">🔎 ログ検索</button>
  <input id="search" placeholder="フィルタ (本文を絞り込み)" />
</header>
<div class="layout">
  <nav id="nav"></nav>
  <main id="main"><div class="empty">プロジェクトを選択してください</div></main>
</div>
<script>
let projects = [], current = null, filter = "";
const el = (id) => document.getElementById(id);

async function boot() {
  const s = await (await fetch("/api/stats")).json();
  el("stats").textContent = s.projects + " projects · " + s.chunks + " chunks · " + s.summaries + " summaries";
  projects = await (await fetch("/api/projects")).json();
  renderNav();
  if (projects.length && !current) select(projects[0].id);
  else if (current) select(current);
}

// Live updates: the server pushes a "change" event whenever the DB is written
// (e.g. the MCP server stores a new memory). Refresh in place — keep the
// selected project and scroll position so the view doesn't jump.
function connectEvents() {
  const es = new EventSource("/api/events");
  es.addEventListener("change", () => {
    const main = el("main");
    const y = main ? main.scrollTop : 0;
    boot().then(() => { const m = el("main"); if (m) m.scrollTop = y; });
  });
  es.onerror = () => {}; // EventSource auto-reconnects
}
function renderNav() {
  el("nav").innerHTML = projects.map(p =>
    '<button data-id="'+p.id+'" class="'+(p.id===current?'active':'')+'">'
    + '<div class="nm">'+esc(p.name)+'</div>'
    + '<div class="pth">'+esc(p.path)+'</div>'
    + '<div class="pth">'+p.counts.summaries+' sum · '+p.counts.chunks+' chunk · '+p.counts.preferences+' pref · '+(p.counts.lessons||0)+' lesson</div>'
    + '</button>').join("");
  el("nav").querySelectorAll("button").forEach(b =>
    b.onclick = () => select(b.dataset.id));
}
async function select(id) {
  current = id; renderNav();
  if (lessonMode) { loadLessons(); return; }
  const d = await (await fetch("/api/memory?project="+encodeURIComponent(id))).json();
  render(d);
}
function render(d) {
  const f = filter.toLowerCase();
  const match = (t) => !f || (t||"").toLowerCase().includes(f);
  const prefs = d.preferences.filter(p => match(p.key+" "+p.value));
  const sums = d.summaries.filter(s => match(s.summary));
  const chunks = d.chunks.filter(c => match(c.userText+" "+c.assistantText));
  let h = "";
  if (prefs.length) h += '<div class="sect"><h2>User Preferences (always-apply)</h2>'
    + prefs.map(p => '<span class="pref"><b>'+esc(p.key)+'</b> '+esc(p.value)+'</span>').join("") + '</div>';
  if (sums.length) h += '<div class="sect"><h2>Session Summaries</h2>'
    + sums.map(s => '<div class="card"><div class="meta"><span class="tag">summary</span>'
      + (s.created_at||"").split("T")[0]+'</div><pre>'+esc(s.summary)+'</pre></div>').join("") + '</div>';
  if (chunks.length) h += '<div class="sect"><h2>Conversation Chunks</h2>'
    + chunks.map(c => '<div class="card"><div class="meta"><span class="tag">chunk</span>'
      + (c.obsType ? '<span class="tag">'+esc(c.obsType)+'</span>' : "")
      + (c.createdAt||"").split("T")[0]+'</div>'
      + chunkMeta(c)
      + '<pre><span class="u">User:</span> '+esc(c.userText)
      + (c.assistantText ? '\\n<span class="u">Assistant:</span> '+esc(c.assistantText) : "")
      + '</pre></div>').join("") + '</div>';
  el("main").innerHTML = h || '<div class="empty">記憶がありません</div>';
}
function chunkMeta(c) {
  const parts = [];
  if (c.concepts && c.concepts.length) parts.push('<div class="cmeta">🏷 '+c.concepts.map(esc).join(", ")+'</div>');
  const files = [].concat(c.filesModified||[], c.filesRead||[]);
  if (files.length) parts.push('<div class="cmeta">📄 '+files.map(esc).join(", ")+'</div>');
  return parts.join("");
}
function esc(s){ return (s==null?"":String(s)).replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m])); }
let logMode = false, logTimer = null;
function currentPath() { const p = projects.find(x => x.id === current); return p ? p.path : ""; }

el("logsBtn").addEventListener("click", () => {
  logMode = !logMode;
  el("logsBtn").classList.toggle("on", logMode);
  if (logMode && lessonMode) { lessonMode = false; el("lessonsBtn").classList.remove("on"); }
  el("search").value = "";
  el("search").placeholder = logMode
    ? "生ログ全文検索 (このプロジェクトのCC+Codexログ)"
    : "フィルタ (本文を絞り込み)";
  if (logMode) el("main").innerHTML = '<div class="empty">検索語を入力してください (Claude Code + Codex の生ログを全文検索)</div>';
  else if (current) select(current);
});

el("search").addEventListener("input", e => {
  const v = e.target.value;
  if (logMode) {
    clearTimeout(logTimer);
    logTimer = setTimeout(() => runLogSearch(v), 300);
  } else {
    filter = v;
    if (current) select(current);
  }
});

async function runLogSearch(q) {
  if (!q.trim()) { el("main").innerHTML = '<div class="empty">検索語を入力してください</div>'; return; }
  el("main").innerHTML = '<div class="empty">検索中…</div>';
  const url = "/api/logs?q=" + encodeURIComponent(q) + "&project=" + encodeURIComponent(currentPath()) + "&limit=50";
  let d;
  try { d = await (await fetch(url)).json(); }
  catch { el("main").innerHTML = '<div class="empty">検索に失敗しました</div>'; return; }
  if (!d.results || d.results.length === 0) { el("main").innerHTML = '<div class="empty">該当なし</div>'; return; }
  const cards = d.results.map(r => {
    const date = r.timestamp ? r.timestamp.split("T")[0] : "????-??-??";
    const ctx = esc(r.contextBefore) + '<span class="hl">' + esc(r.matchedText) + '</span>' + esc(r.contextAfter);
    return '<div class="card"><div class="meta">'
      + '<span class="tag">' + esc(r.source) + '</span>'
      + '<span class="tag">' + esc(r.role) + '</span>' + date + '</div>'
      + '<div class="cmeta">' + esc(r.projectPath) + ' · #' + esc((r.sessionId||"").slice(0,8)) + '</div>'
      + '<pre>…' + ctx + '…</pre></div>';
  }).join("");
  el("main").innerHTML = '<div class="sect"><h2>Raw Log Search — ' + d.total + ' hits (showing ' + d.results.length + ')</h2>' + cards + '</div>';
}

// --- Lessons view ---------------------------------------------------------
let lessonMode = false, lessonStatus = "candidate";
const LSTATUSES = ["candidate","approved","conflicts","rejected","archived","superseded"];

el("lessonsBtn").addEventListener("click", () => {
  lessonMode = !lessonMode;
  el("lessonsBtn").classList.toggle("on", lessonMode);
  if (lessonMode && logMode) { logMode = false; el("logsBtn").classList.remove("on"); }
  el("search").value = ""; filter = "";
  el("search").placeholder = lessonMode ? "レッスンを絞り込み (本文)" : "フィルタ (本文を絞り込み)";
  if (current) select(current);
  else el("main").innerHTML = '<div class="empty">プロジェクトを選択してください</div>';
});

async function loadLessons() {
  if (!current) return;
  el("main").innerHTML = '<div class="empty">読み込み中…</div>';
  const url = "/api/lessons?project=" + encodeURIComponent(current) + "&status=" + encodeURIComponent(lessonStatus);
  let d;
  try { d = await (await fetch(url)).json(); }
  catch { el("main").innerHTML = '<div class="empty">読み込みに失敗しました</div>'; return; }
  renderLessons(d);
}

function lfilterBar(counts) {
  return '<div class="lfilter">' + LSTATUSES.map(s =>
    '<button class="' + (s===lessonStatus?'on':'') + '" data-st="' + s + '">'
    + s + ' (' + (counts[s]||0) + ')</button>').join("") + '</div>';
}

function renderLessons(d) {
  const f = filter.toLowerCase();
  const match = (t) => !f || (t||"").toLowerCase().includes(f);
  const lessons = (d.lessons||[]).filter(l => match(l.title + " " + l.lesson));
  const heading = lessonStatus === "candidate" ? "Candidate Review" : (lessonStatus + " lessons");
  let h = lfilterBar(d.counts||{});
  h += '<div class="sect"><h2>' + esc(heading) + '</h2>';
  h += lessons.length ? lessons.map(lessonCard).join("") : '<div class="empty">該当するレッスンがありません</div>';
  h += '</div>';
  el("main").innerHTML = h;
  el("main").querySelectorAll(".lfilter button").forEach(b =>
    b.onclick = () => { lessonStatus = b.dataset.st; loadLessons(); });
  bindLessonActions();
}

function lessonCard(l) {
  const cond = (label, arr) => (arr && arr.length)
    ? '<div class="lcond"><b>' + label + ':</b> ' + arr.map(esc).join("; ") + '</div>' : "";
  const tags = [];
  if (l.concepts && l.concepts.length) tags.push('🏷 ' + l.concepts.map(esc).join(", "));
  if (l.files && l.files.length) tags.push('📄 ' + l.files.map(esc).join(", "));
  return '<div class="card" data-id="' + l.id + '">'
    + '<div class="meta">'
    + '<span class="lstatus ' + esc(l.status) + '">' + esc(l.status) + '</span>'
    + '<span class="tag">' + esc(l.scope) + '</span>'
    + '<span class="tag">conf ' + Number(l.confidence).toFixed(2) + '</span>'
    + (l.createdAt||"").split("T")[0] + '</div>'
    + '<div class="u" style="font-weight:600">' + esc(l.title) + '</div>'
    + '<div class="lbody">' + esc(l.lesson) + '</div>'
    + cond("Applies when", l.appliesWhen)
    + cond("Avoid when", l.avoidWhen)
    + (l.evidence ? '<div class="lcond"><b>Evidence:</b> ' + esc(l.evidence) + '</div>' : "")
    + (tags.length ? '<div class="cmeta">' + tags.join(" · ") + '</div>' : "")
    + lessonActions(l)
    + '</div>';
}

function lessonActions(l) {
  const scopeOpts = ["global","project","repo","file","task","user_preference","team"]
    .map(s => '<option ' + (s===l.scope?'selected':'') + '>' + s + '</option>').join("");
  let btns = "";
  if (l.status !== "approved") btns += '<button data-act="approve">✓ Approve</button>';
  if (l.status !== "rejected") btns += '<button class="danger" data-act="reject">✕ Reject</button>';
  if (l.status !== "archived") btns += '<button data-act="archive">🗄 Archive</button>';
  btns += '<select data-act="scope" title="scope変更">' + scopeOpts + '</select>';
  return '<div class="lact">' + btns + '</div>';
}

function bindLessonActions() {
  el("main").querySelectorAll(".card[data-id]").forEach(card => {
    const id = card.dataset.id;
    card.querySelectorAll(".lact button").forEach(b =>
      b.onclick = () => lessonAction(id, b.dataset.act));
    const sel = card.querySelector('select[data-act="scope"]');
    if (sel) sel.onchange = () => lessonAction(id, "scope", { scope: sel.value });
  });
}

async function lessonAction(id, action, body) {
  try {
    await fetch("/api/lessons/" + encodeURIComponent(id) + "/" + action, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body||{}),
    });
  } catch { /* ignore */ }
  loadLessons();
}

boot();
connectEvents();
</script>
</body>
</html>`;
