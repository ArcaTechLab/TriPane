// End-to-end check of the engine: real Chromium, Firefox and WebKit, driven over the
// WebSocket exactly like the UI does.
import { afterAll, beforeAll, setDefaultTimeout, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { startServer, type TriPaneServer } from '../server/server';
import type { ClientMessage, PaneInfo, ServerMessage } from '../shared/protocol';

// A page whose button fills the top of the viewport, so the same click lands on it in every
// engine regardless of small layout differences. Tall enough to scroll.
const PAGE = `<!doctype html><title>Smoke</title>
<style>body{margin:0} #btn{display:block;width:100%;height:300px;font-size:40px} #pad{height:4000px}</style>
<button id="btn" onclick="this.dataset.n = (+this.dataset.n || 0) + 1">click</button>
<input id="field" style="width:100%;height:60px">
<div id="pad"></div>`;

// Launching three browsers takes a few seconds; Bun's default per-test timeout is 5 s.
setDefaultTimeout(60_000);

let site: Server<undefined>;
let siteUrl: string;
let tripane: TriPaneServer;
let shots: string;
let ws: WebSocket;
const frames = new Map<number, number>();
const panes = new Map<number, PaneInfo>();
const messages: ServerMessage[] = [];

function send(msg: ClientMessage) {
  ws.send(JSON.stringify(msg));
}

async function until<T>(what: string, check: () => T | undefined | false, timeoutMs = 30_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

const allPages = () => tripane.panes.map((p) => p.playwrightPage!);

beforeAll(async () => {
  site = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) =>
      new Response(PAGE.replace('Smoke', `Smoke ${new URL(req.url).pathname}`), { headers: { 'content-type': 'text/html' } }),
  });
  siteUrl = `http://127.0.0.1:${site.port}`;
  shots = await mkdtemp(join(tmpdir(), 'tripane-test-'));

  tripane = await startServer({ startUrl: `${siteUrl}/start`, screenshotDir: shots, viewport: { width: 800, height: 600 } });
  await tripane.ready;

  ws = new WebSocket(`${tripane.origin.replace('http', 'ws')}/ws?token=${tripane.token}`);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('message', ({ data }) => {
    if (data instanceof ArrayBuffer) {
      const buf = new Uint8Array(data);
      frames.set(buf[0], (frames.get(buf[0]) ?? 0) + 1);
      // Firefox (pane 1) sends PNG; the others send JPEG.
      if (buf[0] === 1) assert.deepEqual([...buf.subarray(1, 5)], [0x89, 0x50, 0x4e, 0x47], 'Firefox frame should be a PNG');
      else assert.deepEqual([...buf.subarray(1, 3)], [0xff, 0xd8], 'frame should be a JPEG');
      return;
    }
    const msg = JSON.parse(data as string) as ServerMessage;
    messages.push(msg);
    if (msg.type === 'hello') for (const p of msg.panes) panes.set(p.id, p);
    if (msg.type === 'pane') panes.set(msg.pane.id, msg.pane);
  });
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
});

afterAll(async () => {
  ws?.close();
  await tripane?.close();
  site?.stop(true);
  await rm(shots, { recursive: true, force: true });
});

test('all three engines launch and stream frames', async () => {
  await until('hello', () => panes.size === 3);
  for (const p of panes.values()) assert.equal(p.failed, undefined, `${p.engine} failed: ${p.failed}`);
  assert.deepEqual([...panes.values()].map((p) => p.engine), ['chromium', 'firefox', 'webkit']);
  await until('a frame from every engine', () => [0, 1, 2].every((id) => (frames.get(id) ?? 0) > 0));
  // Chromium pushes frames (CDP screencast); Firefox and WebKit are polled at a known interval.
  assert.deepEqual(
    [...panes.values()].map((p) => [p.capture?.method, p.capture?.format, typeof p.capture?.intervalMs]),
    [['screencast', 'jpeg', 'object'], ['screenshot', 'png', 'number'], ['screenshot', 'jpeg', 'number']],
  );
});

test('navigate loads the URL in every pane', async () => {
  send({ type: 'navigate', url: `${siteUrl}/two` });
  await until('all panes on /two and loaded', () =>
    [...panes.values()].every((p) => p.url === `${siteUrl}/two` && !p.loading && p.title === 'Smoke /two'),
  );
});

test('a synced click reaches all three engines', async () => {
  const ev = { kind: 'mouse', x: 400, y: 150, button: 'left' } as const;
  send({ type: 'input', source: 0, event: { ...ev, action: 'down' } });
  send({ type: 'input', source: 0, event: { ...ev, action: 'up' } });
  const counts = async () => Promise.all(allPages().map((p) => p.$eval('#btn', (b) => (b as HTMLElement).dataset.n ?? '0')));
  let last: string[] = [];
  await until('click counted in every engine', () => {
    void counts().then((c) => (last = c));
    return last.length === 3 && last.every((n) => n === '1');
  });
});

test('typing is replayed in every engine', async () => {
  const at = { x: 400, y: 330, button: 'left' } as const;
  send({ type: 'input', source: 1, event: { kind: 'mouse', action: 'down', ...at } });
  send({ type: 'input', source: 1, event: { kind: 'mouse', action: 'up', ...at } });
  for (const key of ['H', 'i', '!']) {
    send({ type: 'input', source: 1, event: { kind: 'key', action: 'down', key } });
    send({ type: 'input', source: 1, event: { kind: 'key', action: 'up', key } });
  }
  send({ type: 'input', source: 1, event: { kind: 'text', text: ' ✓' } });
  let values: string[] = [];
  await until('text in every engine', () => {
    void Promise.all(allPages().map((p) => p.inputValue('#field'))).then((v) => (values = v));
    return values.length === 3 && values.every((v) => v === 'Hi! ✓');
  });
});

test('scroll sync keeps panes at the same scroll percentage', async () => {
  send({ type: 'input', source: 2, event: { kind: 'wheel', x: 400, y: 300, dx: 0, dy: 1200 } });
  let ys: number[] = [];
  // Wheel scrolling settles over a few frames, so wait for every pane to land on the same spot.
  await until('every pane scrolled to the same place', () => {
    void Promise.all(allPages().map((p) => p.evaluate(() => window.scrollY))).then((v) => (ys = v));
    return ys.length === 3 && ys.every((y) => y > 600) && Math.max(...ys) - Math.min(...ys) < 20;
  }, 5_000);
});

test('viewport and color scheme apply to every pane', async () => {
  send({ type: 'viewport', target: 'all', viewport: { width: 375, height: 812 } });
  send({ type: 'settings', settings: { colorScheme: 'dark' } });
  await until('mobile viewport', () => [...panes.values()].every((p) => p.viewport.width === 375));
  let dark: boolean[] = [];
  await until('dark mode in every engine', () => {
    void Promise.all(
      allPages().map((p) => p.evaluate(() => [innerWidth, matchMedia('(prefers-color-scheme: dark)').matches] as const)),
    ).then((v) => (dark = v.map(([w, d]) => w === 375 && d)));
    return dark.length === 3 && dark.every(Boolean);
  });
});

test('screenshot all writes one PNG per engine', async () => {
  send({ type: 'screenshot' });
  const msg = await until('screenshots message', () => messages.find((m) => m.type === 'screenshots'));
  assert.equal(msg.type, 'screenshots');
  assert.equal(msg.files.length, 3);
  for (const f of msg.files) assert.ok(Bun.file(f).size > 1000, `${f} should be a real image`);
});

test('the WebSocket needs the right token', async () => {
  const ws = (token: string) => fetch(`${tripane.origin}/ws?token=${token}`).then((r) => r.status);
  assert.equal(await ws('nope'), 401);
  assert.equal(await ws(''), 401);
  // The right token without a WebSocket handshake gets "upgrade required", not the socket.
  assert.equal(await ws(tripane.token), 426);
});

test('the UI is served and bundled by Bun', async () => {
  const html = await fetch(tripane.origin + '/').then((r) => r.text());
  const script = html.match(/<script[^>]+src="([^"]+)"/)?.[1];
  assert.ok(script, 'index.html should reference the bundled script');
  const js = await fetch(new URL(script, tripane.origin)).then((r) => r.text());
  assert.ok(js.includes('Screenshot all'), 'bundle should contain the React UI');
});
