// The error counters start again on each page load (reload, navigation), as in Chrome DevTools;
// same-document navigations (hash links) keep them.
import { afterAll, beforeAll, setDefaultTimeout, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { Server } from 'bun';
import { startServer, type TriPaneServer } from '../server/server';
import type { ClientMessage, PaneInfo, ServerMessage } from '../shared/protocol';

setDefaultTimeout(90_000);

// Every load logs exactly one error.
const PAGE = (name: string) =>
  `<!doctype html><title>${name}</title><a id="hash" href="#later">hash</a><script>console.error('boom on ${name}')</script>`;

let site: Server<undefined>;
let tripane: TriPaneServer;
let ws: WebSocket;
const panes = new Map<number, PaneInfo>();
let loads = 0;

beforeAll(async () => {
  site = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (r) => {
      loads++;
      return new Response(PAGE(new URL(r.url).pathname), { headers: { 'content-type': 'text/html' } });
    },
  });
  tripane = await startServer({ startUrl: `http://127.0.0.1:${site.port}/a`, viewport: { width: 800, height: 600 } });
  await tripane.ready;
  ws = new WebSocket(`${tripane.origin.replace('http', 'ws')}/ws?token=${tripane.token}`);
  ws.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') return;
    const msg = JSON.parse(data) as ServerMessage;
    if (msg.type === 'hello') for (const p of msg.panes) panes.set(p.id, p);
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
const counts = () => [0, 1, 2].map((i) => panes.get(i)?.errors);
async function settle(what: string, ok: () => boolean) {
  const end = Date.now() + 30_000;
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out: ${what} (errors ${JSON.stringify(counts())})`);
    await Bun.sleep(50);
  }
  await Bun.sleep(500); // and nothing more arrives
}

test('reloading starts the error count again', async () => {
  await settle('first load', () => counts().every((n) => n === 1));
  for (let i = 0; i < 3; i++) {
    const before = loads;
    send({ type: 'history', action: 'reload' });
    await settle(`reload ${i + 1}`, () => loads >= before + 3 && [0, 1, 2].every((p) => !panes.get(p)?.loading));
    assert.deepEqual(counts(), [1, 1, 1], `after reload ${i + 1}`);
  }
});

test('navigating to another page starts it again too', async () => {
  send({ type: 'navigate', url: `http://127.0.0.1:${site.port}/b` });
  await settle('page b', () => [0, 1, 2].every((p) => panes.get(p)?.url.endsWith('/b') && !panes.get(p)?.loading));
  assert.deepEqual(counts(), [1, 1, 1]);
});

test('a hash link (same document) keeps the count', async () => {
  await Promise.all(tripane.panes.map((p) => p.playwrightPage!.evaluate(() => console.error('second error'))));
  await settle('second error', () => counts().every((n) => n === 2));
  await Promise.all(tripane.panes.map((p) => p.playwrightPage!.click('#hash')));
  await settle('hash', () => [0, 1, 2].every((p) => panes.get(p)?.url.endsWith('#later')));
  assert.deepEqual(counts(), [2, 2, 2]);
});
