// Start page shown in every pane. It works offline and has a few things that render
// differently across engines (native form controls, fonts, color-scheme), plus something to
// click, type into and scroll so the sync features can be tried straight away.
export const WELCOME_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>TriPane</title>
<style>
  :root { --bg:#f7f7f5; --fg:#1d1d1f; --muted:#6b6b70; --card:#fff; --line:#e3e3e0; --accent:#3b6cf6; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#16171a; --fg:#ececee; --muted:#9a9aa2; --card:#1f2024; --line:#2e3036; --accent:#7c9bff; }
  }
  * { box-sizing: border-box; }
  body { margin:0; font: 16px/1.55 system-ui, sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width: 760px; margin: 0 auto; padding: 48px 24px 96px; }
  h1 { font-size: clamp(28px, 5vw, 44px); line-height:1.1; margin: 0 0 8px; letter-spacing: -0.02em; }
  .lede { color: var(--muted); margin: 0 0 32px; }
  .engine { display:inline-block; padding:2px 10px; border-radius:999px; background:var(--accent); color:#fff; font-weight:600; }
  section { background:var(--card); border:1px solid var(--line); border-radius:14px; padding:20px 22px; margin: 0 0 16px; }
  h2 { font-size: 15px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin:0 0 12px; }
  .row { display:flex; flex-wrap:wrap; gap:12px; align-items:center; }
  button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 1px solid var(--line); background: var(--accent); color: #fff; cursor: pointer; }
  input, select { font: inherit; }
  code { font-family: ui-monospace, monospace; font-size: .9em; }
  #ua { font-size: 13px; color: var(--muted); word-break: break-all; }
  .item { padding: 10px 0; border-bottom: 1px solid var(--line); }
  .item:last-child { border: 0; }
</style>
</head>
<body>
<main>
  <h1>TriPane <span class="engine" id="engine">…</span></h1>
  <p class="lede">The same page in Chromium, Firefox and WebKit. Type a URL above to compare any site.</p>

  <section>
    <h2>Try sync</h2>
    <div class="row">
      <button id="count" type="button">Clicked 0 times</button>
      <input id="text" placeholder="Type here: it appears in all three" size="32">
    </div>
  </section>

  <section>
    <h2>Native controls (these differ per engine)</h2>
    <div class="row">
      <input type="date"> <input type="range"> <input type="color" value="#3b6cf6">
      <select><option>Select</option><option>Option two</option></select>
      <label><input type="checkbox" checked> Checkbox</label>
      <progress value="60" max="100"></progress>
    </div>
  </section>

  <section>
    <h2>User agent</h2>
    <div id="ua"></div>
  </section>

  <section>
    <h2>Scroll me</h2>
    <div id="list"></div>
  </section>
</main>
<script>
  const ua = navigator.userAgent;
  document.getElementById('ua').textContent = ua;
  // Feature detection, not the user agent: device emulation changes the UA (an emulated iPhone
  // claims to be Safari in every engine).
  document.getElementById('engine').textContent =
    CSS.supports('-moz-appearance', 'none') ? 'Firefox' : 'chrome' in window ? 'Chromium' : 'WebKit';
  let n = 0;
  const btn = document.getElementById('count');
  btn.addEventListener('click', () => { n++; btn.textContent = 'Clicked ' + n + (n === 1 ? ' time' : ' times'); });
  const list = document.getElementById('list');
  for (let i = 1; i <= 40; i++) {
    const d = document.createElement('div');
    d.className = 'item';
    d.textContent = 'Row ' + i + ' — scroll position stays in step across the panes.';
    list.append(d);
  }
</script>
</body>
</html>`;
