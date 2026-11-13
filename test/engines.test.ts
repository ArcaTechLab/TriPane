// Settings → Engines: engines can be turned off (not running, not shown) and back on.
import { afterAll, beforeAll, setDefaultTimeout, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { startServer, type TriPaneServer } from '../server/server';
import type { ClientMessage, PaneInfo, ServerMessage, Settings } from '../shared/protocol';

setDefaultTimeout(90_000);

const PAGE = (name: string) => `<!doctype html><title>${name}</title><style>body{margin:0} button{display:block;width:100%;height:200px}</style>
<button id="b" onclick="this.dataset.n=(+this.dataset.n||0)+1">click</button>`;

let site: Server<undefined>;
let tripane: TriPaneServer;
let ws: WebSocket;
let base = '';
const panes = new Map<number, PaneInfo>();
let settings: Settings | undefined;

beforeAll(async () => {
  site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (r) => new Response(PAGE(new URL(r.url).pathname), { headers: { 'content-type': 'text/html' } }) });
  base = `http://127.0.0.1:${site.port}`;
  tripane = await startServer({ startUrl: `${base}/a`, viewport: { width: 800, height: 600 } });
  await tripane.ready;
  ws = new WebSocket(`${tripane.origin.replace('http', 'ws')}/ws?token=${tripane.token}`);
  ws.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') return;
    const msg = JSON.parse(data) as ServerMessage;
    if (msg.type === 'hello') {
      settings = msg.settings;
      for (const p of msg.panes) panes.set(p.id, p);
    }
    if (msg.type === 'pane') panes.set(msg.pane.id, msg.pane);
    if (msg.type === 'settings') settings = msg.settings;
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
  while (!(await Promise.resolve().then(ok).catch(() => false))) {
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await Bun.sleep(50);
  }
}
const clicks = (i: number) => tripane.panes[i].playwrightPage!.evaluate(() => document.getElementById('b')!.dataset.n ?? '0');

test('turning an engine off stops it and leaves the others working', async () => {
  send({ type: 'settings', settings: { engines: { chromium: true, firefox: false, webkit: true } } });
  await until('Firefox off', () => panes.get(1)?.disabled === true);
  assert.equal(tripane.panes[1].playwrightPage, undefined, 'Firefox has no page');
  assert.equal(tripane.panes[1].ready, false);

  // Synced input still reaches the engines that are on.
  send({ type: 'input', source: 0, event: { kind: 'mouse', action: 'down', x: 100, y: 100, button: 'left', clickCount: 1 } });
  send({ type: 'input', source: 0, event: { kind: 'mouse', action: 'up', x: 100, y: 100, button: 'left', clickCount: 1 } });
  await until('clicked in Chromium and WebKit', async () => (await clicks(0)) === '1' && (await clicks(2)) === '1');
});

test('turning it back on opens the page the others show', async () => {
  // The others moved on while Firefox was off.
  send({ type: 'navigate', url: `${base}/b` });
  await until('others on /b', () => [0, 2].every((i) => panes.get(i)?.url.endsWith('/b')));
  send({ type: 'settings', settings: { engines: { chromium: true, firefox: true, webkit: true } } });
  await until('Firefox back on /b', () => !panes.get(1)?.disabled && !!panes.get(1)?.url.endsWith('/b') && tripane.panes[1].ready);
  assert.ok(panes.get(1)?.version, 'Firefox reports its version again');
});

test('the last engine can’t be turned off', async () => {
  send({ type: 'settings', settings: { engines: { chromium: false, firefox: false, webkit: false } } });
  await Bun.sleep(500);
  assert.deepEqual(settings?.engines, { chromium: true, firefox: true, webkit: true });
  assert.ok([0, 1, 2].every((i) => !panes.get(i)?.disabled));
});

test('an engine saved as off isn’t launched at the next start', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'tripane-engines-'));
  try {
    await Bun.write(join(profile, 'settings.json'), JSON.stringify({ engines: { chromium: true, firefox: true, webkit: false } }));
    const t = await startServer({ startUrl: `${base}/a`, profileDir: profile });
    try {
      await t.ready;
      assert.equal(t.panes[2].info.disabled, true);
      assert.equal(t.panes[2].playwrightPage, undefined, 'WebKit was not launched');
      assert.ok(t.panes[0].ready && t.panes[1].ready);
    } finally {
      await t.close();
    }
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
});
