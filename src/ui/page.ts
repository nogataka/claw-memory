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
</style>
</head>
<body>
<header>
  <h1>🧠 claw-memory</h1>
  <span class="muted" id="stats"></span>
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
  if (projects.length) select(projects[0].id);
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
      + (c.createdAt||"").split("T")[0]+'</div>'
      + '<pre><span class="u">User:</span> '+esc(c.userText)
      + (c.assistantText ? '\\n<span class="u">Assistant:</span> '+esc(c.assistantText) : "")
      + '</pre></div>').join("") + '</div>';
  el("main").innerHTML = h || '<div class="empty">記憶がありません</div>';
}
function esc(s){ return (s==null?"":String(s)).replace(/[&<>]/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;'}[m])); }
el("search").addEventListener("input", e => { filter = e.target.value; if (current) select(current); });
boot();
</script>
</body>
</html>`;
