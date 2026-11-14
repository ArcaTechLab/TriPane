// Backspace never navigates back: Playwright's WebKit does that on Windows and macOS when the focus
// isn't in a text field, and Follow links then took all three panes back. TriPane doesn't send a
// Backspace to such an engine unless the focus is in a text field (server/backspace.ts); nothing is
// injected into the page. The guard is switched on here for every engine, so the logic is checked
// in all three on any platform.
import { afterAll, afterEach, beforeAll, setDefaultTimeout, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { Server } from 'bun';
import { BACKSPACE_NAVIGATES } from '../server/backspace';
import { startServer, type TriPaneServer } from '../server/server';
import type { ClientMessage, EngineName } from '../shared/protocol';

setDefaultTimeout(60_000);

// Records every Backspace keydown the page receives, and where it went.
const FRAME = `<!doctype html><style>body{margin:0}</style><input id="fi" value="frame" style="width:290px;height:36px">`;
const PAGE = `<!doctype html><title>keys</title>
<style>body{margin:0} #i,#ce,#own,#host,#f{position:absolute;left:20px;width:300px;height:40px;border:0}
#i{top:20px} #ce{top:100px} #own{top:180px} #host{top:260px} #f{top:340px}</style>
<input id="i" value="abc"><div id="ce" contenteditable>xyz</div><button id="own">own handler</button>
<div id="host"></div><iframe id="f" src="/frame"></iframe>
<script>
  window.__bs = [];
  addEventListener('keydown', (e) => {
    if (e.key === 'Backspace') __bs.push({ target: e.composedPath()[0].id || e.composedPath()[0].tagName, ctrl: e.ctrlKey });
  }, true);
  // The test's marker: a click in the bottom-right corner, sent after the keys (the same queue).
  window.__marker = 0;
  addEventListener('mousedown', (e) => { if (e.clientX > 780 && e.clientY > 580) __marker++; }, true);
  const shadow = document.getElementById('host').attachShadow({ mode: 'open' });
  shadow.innerHTML = '<input id="si" value="shadow" style="width:290px;height:36px">';
</script>`;

let site: Server<undefined>;
let tripane: TriPaneServer;
let ws: WebSocket;
const saved = { ...BACKSPACE_NAVIGATES };
const guard = (on: boolean) => {
  for (const e of Object.keys(BACKSPACE_NAVIGATES) as EngineName[]) BACKSPACE_NAVIGATES[e] = on;
};

beforeAll(async () => {
  site = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => new Response(new URL(req.url).pathname === '/frame' ? FRAME : PAGE, { headers: { 'content-type': 'text/html' } }),
  });
  tripane = await startServer({ startUrl: `http://127.0.0.1:${site.port}/`, viewport: { width: 800, height: 600 } });
  await tripane.ready;
  await Promise.all(tripane.panes.map((p) => p.waitForLoad()));
  ws = new WebSocket(`${tripane.origin.replace('http', 'ws')}/ws?token=${tripane.token}`);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
});

afterEach(() => Object.assign(BACKSPACE_NAVIGATES, saved));

afterAll(async () => {
  ws?.close();
  await tripane?.close();
  site?.stop(true);
});

const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
const inPages = <T>(fn: () => T) => Promise.all(tripane.panes.map((p) => p.playwrightPage!.evaluate(fn)));
const key = (action: 'down' | 'up', k: string) => send({ type: 'input', source: 0, event: { kind: 'key', action, key: k } });
const home = () => `http://127.0.0.1:${site.port}/`;

/** Waits until every pane has replayed the input sent so far: a marker click goes after it, through the same queue. */
async function settle() {
  const before = await inPages(() => (window as any).__marker as number);
  for (const action of ['down', 'up'] as const) send({ type: 'input', source: 0, event: { kind: 'mouse', action, x: 790, y: 590, button: 'left', clickCount: 1 } });
  await until('every pane replayed the input', async () => (await inPages(() => (window as any).__marker as number)).every((m, i) => m > before[i]));
}

/** Clicks a point, then presses Backspace (with modifiers held, if any); returns the Backspaces each page received. */
async function backspaceAt(x: number, y: number, modifiers: string[] = []) {
  await inPages(() => ((window as any).__bs = []));
  send({ type: 'input', source: 0, event: { kind: 'mouse', action: 'down', x, y, button: 'left', clickCount: 1 } });
  send({ type: 'input', source: 0, event: { kind: 'mouse', action: 'up', x, y, button: 'left', clickCount: 1 } });
  for (const m of modifiers) key('down', m);
  key('down', 'Backspace');
  key('up', 'Backspace');
  for (const m of [...modifiers].reverse()) key('up', m);
  await settle();
  return inPages(() => (window as any).__bs as { target: string; ctrl: boolean }[]);
}

async function until(what: string, ok: () => Promise<boolean>) {
  for (const end = Date.now() + 10_000; !(await ok()); ) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await Bun.sleep(50);
  }
}

test('outside a text field, Backspace isn’t sent where it would navigate back', async () => {
  guard(true);
  assert.deepEqual(await backspaceAt(600, 500), [[], [], []]); // empty page area
  assert.ok(tripane.panes.every((p) => p.playwrightPage!.url() === home()), 'no pane navigated');
});

test('Backspace still edits inputs, contenteditable, shadow DOM fields and fields in iframes', async () => {
  guard(true);
  await backspaceAt(310, 40); // the end of the input's text
  assert.deepEqual(await inPages(() => (document.getElementById('i') as HTMLInputElement).value), ['ab', 'ab', 'ab']);

  await backspaceAt(300, 280); // inside the open shadow root
  assert.deepEqual(await inPages(() => (document.getElementById('host')!.shadowRoot!.getElementById('si') as HTMLInputElement).value), ['shado', 'shado', 'shado']);

  await backspaceAt(310, 360); // the iframe's input
  const frameValues = () => Promise.all(tripane.panes.map((p) => p.playwrightPage!.frames()[1].evaluate(() => (document.getElementById('fi') as HTMLInputElement).value)));
  assert.deepEqual(await frameValues(), ['fram', 'fram', 'fram']);

  // Contenteditable, with the caret at the end of its text.
  await inPages(() => {
    const ce = document.getElementById('ce')!;
    ce.focus();
    getSelection()!.selectAllChildren(ce);
    getSelection()!.collapseToEnd();
  });
  key('down', 'Backspace');
  key('up', 'Backspace');
  await settle();
  assert.deepEqual(await inPages(() => document.getElementById('ce')!.textContent), ['xy', 'xy', 'xy']);
});

test('a Backspace with Ctrl held is a shortcut, not Back: it goes through', async () => {
  guard(true);
  for (const s of await backspaceAt(600, 500, ['Control'])) assert.deepEqual(s, [{ target: 'BODY', ctrl: true }]);
});

test('where Backspace doesn’t navigate, every Backspace is sent, so page handlers run', async () => {
  guard(false);
  for (const s of await backspaceAt(100, 200)) assert.deepEqual(s, [{ target: 'own', ctrl: false }]); // the button
  assert.ok(tripane.panes.every((p) => p.playwrightPage!.url() === home()), 'no pane navigated');
});

test('nothing TriPane adds to the page handles the key (no init script)', async () => {
  guard(false);
  await inPages(() => {
    (window as any).__prevented = [];
    addEventListener('keydown', (e) => setTimeout(() => (window as any).__prevented.push(e.defaultPrevented)), { once: true });
  });
  await backspaceAt(600, 500);
  assert.deepEqual(await inPages(() => (window as any).__prevented), [[false], [false], [false]]);
});
