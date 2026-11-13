// Element compare and synced highlight: the same element is found in all three engines from a
// point picked in one of them; hovering outlines it everywhere.
import { afterAll, beforeAll, setDefaultTimeout, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { Server } from 'bun';
import { startServer, type TriPaneServer } from '../server/server';
import type { ClientMessage, CompareResult, ServerMessage } from '../shared/protocol';

setDefaultTimeout(60_000);

// No ids on the target: it's found by its path. The <select> renders natively, so its size and
// some styles differ between engines.
const PAGE = `<!doctype html><title>cmp</title>
<style>body{margin:0;font:16px serif} .card{margin:20px;padding:10px;border:2px solid #333} .card button{width:200px;height:50px}</style>
<div class="card"><p>intro</p><button class="primary">Buy</button><select><option>One option</option></select></div>`;

let site: Server<undefined>;
let tripane: TriPaneServer;
let ws: WebSocket;
const messages: ServerMessage[] = [];

beforeAll(async () => {
  site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }) });
  tripane = await startServer({ startUrl: `http://127.0.0.1:${site.port}/`, viewport: { width: 800, height: 600 } });
  await tripane.ready;
  ws = new WebSocket(`${tripane.origin.replace('http', 'ws')}/ws?token=${tripane.token}`);
  ws.addEventListener('message', ({ data }) => typeof data === 'string' && messages.push(JSON.parse(data)));
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
});

afterAll(async () => {
  ws?.close();
  await tripane?.close();
  site?.stop(true);
});

const send = (m: ClientMessage) => ws.send(JSON.stringify(m));

async function nextCompare(): Promise<CompareResult> {
  const start = messages.length;
  const end = Date.now() + 10_000;
  for (;;) {
    const m = messages.slice(start).find((x) => x.type === 'compare');
    if (m && m.type === 'compare') return m.result;
    if (Date.now() > end) throw new Error('no compare result');
    await Bun.sleep(25);
  }
}

async function centerOf(selector: string, pane = 0) {
  const box = (await tripane.panes[pane].playwrightPage!.locator(selector).boundingBox())!;
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

test('picking an element in one engine finds the same element in all three', async () => {
  const at = await centerOf('button', 1); // picked in Firefox
  const pending = nextCompare();
  send({ type: 'compare', source: 1, ...at });
  const result = await pending;
  assert.equal(result.source, 1);
  assert.deepEqual(result.ref, { anchorId: null, path: [1, 0, 1] }); // html > body > div.card > button
  for (const e of result.engines) {
    assert.equal(e.found, true, `${e.engine} found it`);
    assert.equal(e.label, 'button.primary');
    assert.equal(e.box!.width, 200);
    assert.equal(e.box!.height, 50);
    assert.equal(e.styles!.display, 'inline-block');
    assert.ok(Object.keys(e.styles!).length > 200, 'all computed styles are included');
  }
});

test('re-running a compare from its ref works, and engine differences show up', async () => {
  const pending = nextCompare();
  send({ type: 'compare', ref: { anchorId: null, path: [1, 0, 2] } }); // the <select>
  const result = await pending;
  assert.equal(result.source, null);
  assert.ok(result.engines.every((e) => e.found && e.label === 'select'));
  const heights = new Set(result.engines.map((e) => e.box!.height));
  assert.ok(heights.size > 1, `native <select> heights differ between engines: ${[...heights]}`);
});

test('an element missing in an engine is reported as not found', async () => {
  const pending = nextCompare();
  send({ type: 'compare', ref: { anchorId: null, path: [1, 0, 9] } });
  const result = await pending;
  assert.ok(result.engines.every((e) => !e.found));
});

test('hovering outlines the element in every engine (Chromium natively, without touching its DOM)', async () => {
  send({ type: 'settings', settings: { highlight: true } });
  const at = await centerOf('p');
  send({ type: 'input', source: 0, event: { kind: 'mouse', action: 'move', ...at, button: 'left' } });
  const overlayIn = (i: number) =>
    tripane.panes[i].playwrightPage!.evaluate(() => {
      const host = document.querySelector('tripane-overlay');
      return host ? 'present' : 'none';
    });
  const end = Date.now() + 10_000;
  while ((await overlayIn(1)) === 'none' || (await overlayIn(2)) === 'none') {
    if (Date.now() > end) throw new Error('no overlay in Firefox/WebKit');
    await Bun.sleep(50);
  }
  assert.equal(await overlayIn(0), 'none', 'Chromium uses its native overlay, not an injected element');

  // probeEnd (pointer left the pane) clears the outline; the empty host stays for reuse.
  send({ type: 'probeEnd' });
  await Bun.sleep(300);
  for (const i of [1, 2]) {
    const drawn = await tripane.panes[i].playwrightPage!.evaluate(() => {
      const ui = (window as unknown as { __tripaneHover?: { root: ShadowRoot } }).__tripaneHover;
      return ui ? ui.root.childElementCount : 0;
    });
    assert.equal(drawn, 0);
  }
});
