// Backspace never navigates back: Playwright's WebKit does that on Windows and macOS when the
// focus isn't in a text field, and Follow links then took all three panes back. TriPane turns the
// browser's default action off outside editable elements; typing and page handlers still work.
import { afterAll, beforeAll, setDefaultTimeout, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { Server } from 'bun';
import { startServer, type TriPaneServer } from '../server/server';
import type { ClientMessage } from '../shared/protocol';

setDefaultTimeout(60_000);

// Records, for every Backspace, the target and whether its default action was prevented (read
// after dispatch, so it includes TriPane's listener, which runs last on window).
const PAGE = `<!doctype html><title>keys</title>
<style>body{margin:0} #i{position:absolute;left:20px;top:20px;width:300px;height:40px} #ce{position:absolute;left:20px;top:100px;width:300px;height:40px}
#own{position:absolute;left:20px;top:180px;width:300px;height:40px}</style>
<input id="i" value="abc"><div id="ce" contenteditable>xyz</div><button id="own">own handler</button>
<script>
  window.__bs = [];
  addEventListener('keydown', (e) => {
    if (e.key !== 'Backspace') return;
    const t = e.composedPath()[0];
    setTimeout(() => __bs.push({ target: t.id || t.tagName, prevented: e.defaultPrevented }));
  }, true);
  // A page that handles Backspace itself (e.g. a game or an editor) still gets it.
  document.getElementById('own').addEventListener('keydown', (e) => { if (e.key === 'Backspace') window.__own = (window.__own || 0) + 1; });
</script>`;

let site: Server<undefined>;
let tripane: TriPaneServer;
let ws: WebSocket;

beforeAll(async () => {
  site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }) });
  tripane = await startServer({ startUrl: `http://127.0.0.1:${site.port}/`, viewport: { width: 800, height: 600 } });
  await tripane.ready;
  ws = new WebSocket(`${tripane.origin.replace('http', 'ws')}/ws?token=${tripane.token}`);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
});

afterAll(async () => {
  ws?.close();
  await tripane?.close();
  site?.stop(true);
});

const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
const inPages = <T>(fn: () => T) => Promise.all(tripane.panes.map((p) => p.playwrightPage!.evaluate(fn)));

async function backspaceAt(x: number, y: number) {
  await inPages(() => ((window as any).__bs = []));
  send({ type: 'input', source: 0, event: { kind: 'mouse', action: 'down', x, y, button: 'left', clickCount: 1 } });
  send({ type: 'input', source: 0, event: { kind: 'mouse', action: 'up', x, y, button: 'left', clickCount: 1 } });
  send({ type: 'input', source: 0, event: { kind: 'key', action: 'down', key: 'Backspace' } });
  send({ type: 'input', source: 0, event: { kind: 'key', action: 'up', key: 'Backspace' } });
  const end = Date.now() + 10_000;
  for (;;) {
    const seen = await inPages(() => (window as any).__bs as { target: string; prevented: boolean }[]);
    if (seen.every((s) => s.length)) return seen.map((s) => s[0]);
    if (Date.now() > end) throw new Error(`no Backspace seen: ${JSON.stringify(seen)}`);
    await Bun.sleep(50);
  }
}

test('Backspace outside a text field has no default action (no back navigation) in any engine', async () => {
  const seen = await backspaceAt(600, 500); // empty page area
  for (const s of seen) assert.deepEqual(s, { target: 'BODY', prevented: true });
});

test('Backspace still edits inputs and contenteditable in every engine', async () => {
  for (const s of await backspaceAt(100, 40)) assert.deepEqual(s, { target: 'i', prevented: false });
  assert.deepEqual(await inPages(() => (document.getElementById('i') as HTMLInputElement).value), ['ab', 'ab', 'ab']);
  // Put the caret at the end of the editable text, then Backspace.
  await inPages(() => {
    const ce = document.getElementById('ce')!;
    ce.focus();
    getSelection()!.selectAllChildren(ce);
    getSelection()!.collapseToEnd();
  });
  await inPages(() => ((window as any).__bs = []));
  send({ type: 'input', source: 0, event: { kind: 'key', action: 'down', key: 'Backspace' } });
  send({ type: 'input', source: 0, event: { kind: 'key', action: 'up', key: 'Backspace' } });
  const end = Date.now() + 10_000;
  while ((await inPages(() => document.getElementById('ce')!.textContent)).some((t) => t !== 'xy')) {
    if (Date.now() > end) throw new Error(`contenteditable: ${await inPages(() => document.getElementById('ce')!.textContent)}`);
    await Bun.sleep(50);
  }
});

test("a page's own Backspace handler still runs", async () => {
  await inPages(() => ((window as any).__own = 0));
  await backspaceAt(100, 200);
  assert.deepEqual(await inPages(() => (window as any).__own), [1, 1, 1]);
  assert.ok(tripane.panes.every((p) => p.playwrightPage!.url() === `http://127.0.0.1:${site.port}/`), 'no pane navigated');
});
