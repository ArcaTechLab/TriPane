// Reloading one engine: only that engine reloads, then it's brought back in step with the others
// (their URL with Follow links on, their scroll position with Sync scroll on).
import { afterAll, beforeAll, setDefaultTimeout, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { Server } from 'bun';
import { startServer, type TriPaneServer } from '../server/server';
import type { ClientMessage, Settings } from '../shared/protocol';

setDefaultTimeout(90_000);

// A long page; each load gets a fresh random id, so a reload is visible.
const PAGE = (name: string) => `<!doctype html><title>${name}</title><style>body{margin:0} div{height:120px;border-bottom:1px solid #ccc}</style>
<script>window.__load = Math.random()</script>${'<div>row</div>'.repeat(80)}`;

let site: Server<undefined>;
let tripane: TriPaneServer;
let ws: WebSocket;
let base = '';

beforeAll(async () => {
  site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => new Response(PAGE(new URL(r.url).pathname), { headers: { 'content-type': 'text/html' } }) });
  base = `http://127.0.0.1:${site.port}`;
  tripane = await startServer({ startUrl: `${base}/a`, viewport: { width: 800, height: 600 } });
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
const settings = (s: Partial<Settings>) => send({ type: 'settings', settings: s });
const pages = () => tripane.panes.map((p) => p.playwrightPage!);
const loads = () => Promise.all(pages().map((p) => p.evaluate(() => (window as any).__load as number).catch(() => null)));
const scrollYs = () => Promise.all(pages().map((p) => p.evaluate(() => Math.round(scrollY)).catch(() => -1)));
const paths = () => pages().map((p) => new URL(p.url()).pathname);
async function until(what: string, ok: () => Promise<boolean> | boolean) {
  const end = Date.now() + 30_000;
  while (!(await Promise.resolve().then(ok).catch(() => false))) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await Bun.sleep(50);
  }
}

test('reloading one engine reloads only it, and puts it back at the same scroll position', async () => {
  await until('loaded', async () => (await loads()).every((l) => typeof l === 'number'));
  await Promise.all(pages().map((p) => p.evaluate(() => scrollTo(0, 2400))));
  const before = await loads();

  send({ type: 'reloadPane', target: 1 });
  await until('Firefox reloaded', async () => {
    const now = await loads();
    return typeof now[1] === 'number' && now[1] !== before[1];
  });
  const after = await loads();
  assert.equal(after[0], before[0], 'Chromium not reloaded');
  assert.equal(after[2], before[2], 'WebKit not reloaded');
  await until('Firefox scrolled back', async () => (await scrollYs())[1] === 2400);
  assert.deepEqual(await scrollYs(), [2400, 2400, 2400]);
});

test('an engine that drifted to another page is brought back to the others', async () => {
  // Take WebKit elsewhere on its own (Follow links off, so the others stay).
  settings({ linkFollow: false });
  await Bun.sleep(200);
  await pages()[2].goto(`${base}/elsewhere`);
  settings({ linkFollow: true });
  await Bun.sleep(200);
  assert.deepEqual(paths(), ['/a', '/a', '/elsewhere']);
  const before = await loads();

  send({ type: 'reloadPane', target: 2 });
  await until('WebKit back on /a', () => paths()[2] === '/a');
  await until('WebKit scrolled', async () => (await scrollYs())[2] === 2400);
  const after = await loads();
  assert.deepEqual(paths(), ['/a', '/a', '/a']);
  assert.equal(after[0], before[0], 'Chromium not reloaded');
  assert.equal(after[1], before[1], 'Firefox not reloaded');
});

test('with Follow links off, a drifted engine is reloaded where it is', async () => {
  settings({ linkFollow: false });
  await Bun.sleep(200);
  await pages()[0].goto(`${base}/own`);
  const before = await loads();
  send({ type: 'reloadPane', target: 0 });
  await until('Chromium reloaded', async () => {
    const now = await loads();
    return typeof now[0] === 'number' && now[0] !== before[0];
  });
  assert.deepEqual(paths(), ['/own', '/a', '/a']);
  settings({ linkFollow: true });
});
