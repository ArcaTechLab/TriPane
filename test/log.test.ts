// Unified log: console output, errors, failed requests and navigations from all three engines,
// formatted identically so the same message can be compared (and grouped) across engines.
import { afterAll, beforeAll, describe, setDefaultTimeout, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { Server } from 'bun';
import { startServer, type TriPaneServer } from '../server/server';
import type { LogEntry, PaneId, ServerMessage } from '../shared/protocol';
import { applyNavigations, groupAcrossEngines } from '../ui/src/UnifiedLog';

setDefaultTimeout(60_000);

let site: Server<undefined>;
let tripane: TriPaneServer;
let ws: WebSocket;
const log: LogEntry[] = [];
let cleared = false;

beforeAll(async () => {
  site = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === '/missing'
        ? new Response('nope', { status: 404 })
        : new Response('<!doctype html><title>log</title><p>hi</p>', { headers: { 'content-type': 'text/html' } }),
  });
  tripane = await startServer({ startUrl: `http://127.0.0.1:${site.port}/` });
  await tripane.ready;
  ws = new WebSocket(`${tripane.origin.replace('http', 'ws')}/ws?token=${tripane.token}`);
  ws.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') return;
    const msg = JSON.parse(data) as ServerMessage;
    if (msg.type === 'hello') log.push(...msg.log);
    if (msg.type === 'log') log.push(msg.entry);
    if (msg.type === 'logCleared') cleared = true;
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
});

afterAll(async () => {
  ws?.close();
  await tripane?.close();
  site?.stop(true);
});

async function waitFor<T>(what: string, fn: () => T | undefined | false): Promise<T> {
  const end = Date.now() + 15_000;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(25);
  }
}

const fromAll = (pred: (e: LogEntry) => boolean) =>
  ([0, 1, 2] as PaneId[]).map((id) => log.find((e) => e.paneId === id && pred(e)));

test('the start page navigation is logged for every engine', async () => {
  const navs = await waitFor('navigations', () => {
    const n = fromAll((e) => e.source === 'navigation');
    return n.every(Boolean) && n;
  });
  for (const n of navs) assert.equal(n!.text, `http://127.0.0.1:${site.port}/`);
});

test('console output is formatted identically in Chromium, Firefox and WebKit', async () => {
  await Promise.all(
    tripane.panes.map((p) =>
      p.playwrightPage!.evaluate(() => {
        console.log('hello', { a: 1, b: [1, 2, 'x'], nested: { deep: { er: 1 } } }, 42, null);
        console.warn('%s has %d items %c(styled)', 'cart', 3, 'color: red');
        console.info(new Map([['k', 1]]), new Set([1]), document.querySelector('p'));
      }),
    ),
  );
  const hello = await waitFor('hello', () => {
    const r = fromAll((e) => e.text.startsWith('hello'));
    return r.every(Boolean) && r;
  });
  for (const e of hello) {
    assert.equal(e!.level, 'log');
    // Chrome's console preview style: nested arrays and objects are abbreviated.
    assert.equal(e!.text, 'hello {a: 1, b: Array(3), nested: {…}} 42 null');
  }
  const warn = await waitFor('warn', () => {
    const r = fromAll((e) => e.level === 'warning');
    return r.every(Boolean) && r;
  });
  // Firefox applies printf formatting itself and splits %c segments into separate arguments, so
  // spacing can differ; the log groups on whitespace-normalized text.
  for (const e of warn) assert.equal(e!.text.replace(/\s+/g, ' '), 'cart has 3 items (styled)');
  assert.equal(groupAcrossEngines(warn.map((e) => e!), true).length, 1, 'the three warnings group into one row');
  const info = await waitFor('info', () => {
    const r = fromAll((e) => e.level === 'info' && e.text.startsWith('Map'));
    return r.every(Boolean) && r;
  });
  for (const e of info) assert.equal(e!.text, "Map(1) {'k' => 1} Set(1) {1} <p>");
});

test('uncaught errors and failed requests are logged as errors', async () => {
  await Promise.all(
    tripane.panes.map((p) =>
      p.playwrightPage!.evaluate(() => {
        fetch('/missing');
        setTimeout(() => {
          throw new TypeError('kaboom');
        });
      }),
    ),
  );
  const uncaught = await waitFor('uncaught', () => {
    const r = fromAll((e) => e.source === 'exception');
    return r.every(Boolean) && r;
  });
  for (const e of uncaught) assert.equal(e!.text, 'Uncaught TypeError: kaboom');
  const missing = await waitFor('404', () => {
    const r = fromAll((e) => e.source === 'network');
    return r.every(Boolean) && r;
  });
  for (const e of missing) assert.match(e!.text, /^GET http:\/\/127\.0\.0\.1:\d+\/missing 404/);
});

test('entries are buffered for windows that connect later, and Clear empties them', async () => {
  const late = new WebSocket(`${tripane.origin.replace('http', 'ws')}/ws?token=${tripane.token}`);
  const hello = await new Promise<Extract<ServerMessage, { type: 'hello' }>>((resolve) =>
    late.addEventListener('message', ({ data }) => {
      const msg = JSON.parse(data as string);
      if (msg.type === 'hello') resolve(msg);
    }),
  );
  assert.ok(hello.log.some((e) => e.text.startsWith('hello')));
  late.close();

  ws.send(JSON.stringify({ type: 'clearLog' }));
  await waitFor('logCleared', () => cleared);
});

describe('grouping (UI logic)', () => {
  const e = (id: number, paneId: PaneId, ts: number, text: string, source: LogEntry['source'] = 'console'): LogEntry => ({
    id,
    paneId,
    ts,
    level: 'log',
    source,
    text,
  });

  test('identical messages from different engines merge; the same engine repeating does not', () => {
    const rows = groupAcrossEngines([e(1, 0, 0, 'a'), e(2, 2, 10, 'a'), e(3, 1, 20, 'b'), e(4, 0, 30, 'a')], true);
    assert.deepEqual(rows.map((r) => [r.first.text, r.panes]), [['a', [0, 2]], ['b', [1]], ['a', [0]]]);
  });

  test('messages far apart in time stay separate', () => {
    const rows = groupAcrossEngines([e(1, 0, 0, 'a'), e(2, 1, 5000, 'a')], true);
    assert.equal(rows.length, 2);
  });

  test('without Preserve log, a navigation drops that engine’s earlier messages only', () => {
    const entries = [e(1, 0, 0, 'old0'), e(2, 1, 1, 'old1'), e(3, 0, 2, 'http://x/', 'navigation'), e(4, 0, 3, 'new0')];
    assert.deepEqual(applyNavigations(entries, false).map((x) => x.text), ['old1', 'http://x/', 'new0']);
    assert.equal(applyNavigations(entries, true).length, 4);
  });
});
