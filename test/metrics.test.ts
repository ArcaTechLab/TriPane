// Network figures (the address bar's chip): measured from Playwright's network events in every engine.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Server } from 'bun';
import { startServer, type TriPaneServer } from '../server/server';

setDefaultTimeout(120_000);

// A 50 kB document, in an iframe: it delays the load event but not DOMContentLoaded. (Not a fake
// image: Chromium stops downloading an image it can't decode, so fewer bytes arrive.)
const BIG = `<!--${'x'.repeat(50_000)}-->`;
let site: Server<undefined>;
let tripane: TriPaneServer;
let closedPort = 0;

beforeAll(async () => {
  // A port nothing listens on, for a request that fails.
  const tmp = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  closedPort = tmp.port!;
  tmp.stop(true);
  site = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const { pathname } = new URL(req.url);
      if (pathname === '/start') return Response.redirect('/page', 302); // one navigation, two hops
      if (pathname === '/app.js') return new Response('window.ran = 1;', { headers: { 'content-type': 'text/javascript' } });
      if (pathname === '/style.css') return new Response('body { color: #333 }', { headers: { 'content-type': 'text/css' } });
      if (pathname === '/big.html') {
        await Bun.sleep(300);
        return new Response(BIG, { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } });
      }
      if (pathname === '/favicon.ico') return new Response(null, { status: 404 });
      return new Response(
        `<!doctype html><title>m</title><link rel=stylesheet href=/style.css><script src=/app.js></script>
         <iframe src=/big.html></iframe><img src="http://127.0.0.1:${closedPort}/nothing.png">`,
        { headers: { 'content-type': 'text/html', 'cache-control': 'no-store' } },
      );
    },
  });
  tripane = await startServer({ startUrl: 'about:blank', viewport: { width: 800, height: 600 } });
  await tripane.ready;
});

afterAll(async () => {
  await tripane?.close();
  site?.stop(true);
});

test('each engine reports requests, bytes, failures and its load timings; a redirect is one navigation', async () => {
  await Promise.all(tripane.panes.map((p) => p.goto(`http://127.0.0.1:${site.port}/start`)));
  await Promise.all(tripane.panes.map((p) => p.waitForLoad()));
  // Late events (sizes, the failed request) settle, then the batched update goes out.
  const end = Date.now() + 15_000;
  while (Date.now() < end && tripane.panes.some((p) => !p.info.metrics || p.info.metrics.failed < 1 || p.info.metrics.transferred < BIG.length)) await Bun.sleep(100);
  for (const p of tripane.panes) {
    const m = p.info.metrics!;
    const at = p.engine;
    expect(m, at).toBeTruthy();
    // redirect + page + css + js + iframe + failing image (favicon requests vary by engine)
    expect(m.requests, at).toBeGreaterThanOrEqual(6);
    expect(m.failed, at).toBeGreaterThanOrEqual(1);
    expect(m.transferred, at).toBeGreaterThanOrEqual(BIG.length);
    expect(m.domContentLoaded, at).not.toBeNull();
    expect(m.load, at).not.toBeNull();
    expect(m.load!, at).toBeGreaterThanOrEqual(m.domContentLoaded!);
    expect(m.load!, at).toBeGreaterThanOrEqual(250); // the delayed iframe
    expect(m.ttfb, at).not.toBeNull();
  }
});

test('a new navigation starts new figures; about:blank has none', async () => {
  const before = tripane.panes.map((p) => p.info.metrics!.startedAt);
  await Promise.all(tripane.panes.map((p) => p.goto(`http://127.0.0.1:${site.port}/page`)));
  await Promise.all(tripane.panes.map((p) => p.waitForLoad()));
  tripane.panes.forEach((p, i) => expect(p.info.metrics!.startedAt, p.engine).toBeGreaterThan(before[i]));
  await Promise.all(tripane.panes.map((p) => p.goto('about:blank')));
  await Bun.sleep(300);
  for (const p of tripane.panes) expect(p.info.metrics ?? null, p.engine).toBeNull();
});
