// Device emulation: pixel ratio, touch, mobile mode and user agent in all three engines, by
// rebuilding each engine's browser context; storage, URL and DevTools carry over.
import { afterAll, beforeAll, setDefaultTimeout, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { Server } from 'bun';
import { startServer, type TriPaneServer } from '../server/server';
import type { ClientMessage, PaneInfo, ServerMessage } from '../shared/protocol';

setDefaultTimeout(90_000);

const PAGE = `<!doctype html><title>dev</title><meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{margin:0} button{display:block;width:100%;height:200px}</style>
<button id="b">tap</button>
<script>
  const b = document.getElementById('b');
  b.addEventListener('touchstart', () => (b.dataset.touch = (+b.dataset.touch || 0) + 1));
  b.addEventListener('click', () => (b.dataset.click = (+b.dataset.click || 0) + 1));
</script>`;

let site: Server<undefined>;
let tripane: TriPaneServer;
let ws: WebSocket;
const panes = new Map<number, PaneInfo>();
let hello: Extract<ServerMessage, { type: 'hello' }> | undefined;

beforeAll(async () => {
  site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }) });
  tripane = await startServer({ startUrl: `http://127.0.0.1:${site.port}/page`, viewport: { width: 800, height: 600 } });
  await tripane.ready;
  ws = new WebSocket(`${tripane.origin.replace('http', 'ws')}/ws?token=${tripane.token}`);
  ws.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') return;
    const msg = JSON.parse(data) as ServerMessage;
    if (msg.type === 'hello') {
      hello = msg;
      for (const p of msg.panes) panes.set(p.id, p);
    }
    if (msg.type === 'pane') panes.set(msg.pane.id, msg.pane);
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
});

afterAll(async () => {
  ws?.close();
  await tripane?.close();
  site?.stop(true);
});

const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
async function until(what: string, ok: () => boolean | Promise<boolean>) {
  const end = Date.now() + 30_000;
  // An evaluate that lands mid-navigation throws; that just means "not yet".
  while (!(await Promise.resolve().then(ok).catch(() => false))) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await Bun.sleep(50);
  }
}
const inPages = <T>(fn: () => T) => Promise.all(tripane.panes.map((p) => p.playwrightPage!.evaluate(fn)));

test('the Device menu lists Playwright presets', () => {
  assert.ok(hello);
  const names = hello!.devices.map((d) => d.name);
  assert.ok(names.includes('iPhone 15') && names.includes('Pixel 7') && names.includes('iPad Mini'), names.join(', '));
});

test('choosing a device emulates it in all three engines and keeps the page and its storage', async () => {
  await inPages(() => localStorage.setItem('kept', 'yes'));
  send({ type: 'settings', settings: { device: 'iPhone 15' } });
  await until('device applied', () => [0, 1, 2].every((i) => panes.get(i)?.device === 'iPhone 15' && panes.get(i)?.generation === 1));
  await until('page reloaded', async () =>
    [0, 1, 2].every((i) => !panes.get(i)?.loading) && (await inPages(() => document.readyState)).every((s) => s === 'complete'),
  );

  const env = await inPages(() => ({
    dpr: devicePixelRatio,
    width: innerWidth,
    iphone: navigator.userAgent.includes('iPhone'),
    // The media queries are the signal all three engines agree on. (Under emulation only Chromium
    // sets navigator.maxTouchPoints and only WebKit has window.ontouchstart.)
    touch: matchMedia('(pointer: coarse)').matches && matchMedia('(hover: none)').matches,
    kept: localStorage.getItem('kept'),
    path: location.pathname,
  }));
  for (const e of env) assert.deepEqual(e, { dpr: 3, width: 393, iphone: true, touch: true, kept: 'yes', path: '/page' });
  for (const p of panes.values()) assert.deepEqual(p.viewport, { width: 393, height: 659 });
});

test('on a touch device a click is a real tap', async () => {
  send({ type: 'input', source: 0, event: { kind: 'mouse', action: 'down', x: 150, y: 100, button: 'left' } });
  send({ type: 'input', source: 0, event: { kind: 'mouse', action: 'up', x: 150, y: 100, button: 'left' } });
  await until('tap in every engine', async () =>
    (await inPages(() => [document.getElementById('b')!.dataset.touch, document.getElementById('b')!.dataset.click])).every(
      ([t, c]) => t === '1' && c === '1',
    ),
  );
});

test('DevTools reconnects to the new page (Chromium target and the Firefox/WebKit adapter)', async () => {
  for (const id of [0, 1, 2]) {
    const dt = new WebSocket(`${tripane.origin.replace('http', 'ws')}/cdp/${tripane.token}/${id}`);
    const reply = new Promise<any>((resolve) => dt.addEventListener('message', ({ data }) => resolve(JSON.parse(data as string))));
    await new Promise((r) => dt.addEventListener('open', r, { once: true }));
    dt.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'navigator.userAgent.includes("iPhone")', returnByValue: true } }));
    const msg = await reply;
    assert.equal(msg.result.result.value, true, `pane ${id}`);
    dt.close();
  }
});

test('back to desktop restores the viewport and default emulation', async () => {
  send({ type: 'settings', settings: { device: null } });
  await until('desktop', () => [0, 1, 2].every((i) => panes.get(i)?.device === null && panes.get(i)?.generation === 2));
  await until('page reloaded', async () =>
    [0, 1, 2].every((i) => !panes.get(i)?.loading) && (await inPages(() => document.readyState)).every((s) => s === 'complete'),
  );
  const env = await inPages(() => ({ dpr: devicePixelRatio, iphone: navigator.userAgent.includes('iPhone'), width: innerWidth }));
  for (const e of env) assert.deepEqual(e, { dpr: 1, iphone: false, width: 800 });
});
