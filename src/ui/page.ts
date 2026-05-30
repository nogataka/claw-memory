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
         background:var(--bg); color:var(--fg); }
  header { display:flex; align-items:center; gap:12px; padding:12px 18px;
           border-bottom:1px solid var(--border); background:var(--panel); position:sticky; top:0; }
  header h1 { font-size:15px; margin:0; font-weight:600; }
  header .muted { color:var(--muted); font-size:12px; }
  #search { margin-left:auto; background:var(--bg); border:1px solid var(--border); color:var(--fg);
            border-radius:6px; padding:6px 10px; width:280px; }
  .layout { display:flex; min-height:calc(100vh - 50px); }
  nav { width:240px; border-right:1px solid var(--border); padding:10px; overflow:auto; }
  nav button { display:block; width:100%; text-align:left; background:transparent; color:var(--fg);
               border:0; border-radius:6px; padding:8px 10px; cursor:pointer; font-size:13px; }
  nav button:hover { background:var(--chip); }
  nav button.active { background:var(--chip); border:1px solid var(--border); }
  nav .nm { font-weight:600; }
  nav .pth { color:var(--muted); font-size:11px; word-break:break-all; }
  main { flex:1; padding:18px; overflow:auto; }
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
  header button#logsBtn { background:var(--chip); color:var(--fg); border:1px solid var(--border);
    border-radius:6px; padding:6px 10px; cursor:pointer; font-size:12px; }
  header button#logsBtn.on { background:var(--accent); color:#0d1117; border-color:var(--accent); }
  .src { color:var(--accent); font-size:10px; }
  .hl { background:#9e6a03; color:#fff; border-radius:2px; padding:0 1px; }
</style>
</head>
<body>
<header>
  <h1>🧠 claw-memory</h1>
  <span class="muted" id="stats"></span>
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
    + '<div class="pth">'+p.counts.summaries+' sum · '+p.counts.chunks+' chunk · '+p.counts.preferences+' pref</div>'
    + '</button>').join("");
  el("nav").querySelectorAll("button").forEach(b =>
    b.onclick = () => select(b.dataset.id));
}
async function select(id) {
  current = id; renderNav();
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

boot();
connectEvents();
</script>
</body>
</html>`;
