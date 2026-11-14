// Site info (the button at the left of the address bar): each engine's connection, cookies,
// storage and permissions, and clearing one site's data in every engine.
import { afterAll, beforeAll, setDefaultTimeout, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { Server } from 'bun';
import { startServer, type TriPaneServer } from '../server/server';
import type { ClientMessage, ServerMessage, SiteInfo } from '../shared/protocol';

setDefaultTimeout(90_000);

// Sets two cookies (one HttpOnly) and some storage.
const PAGE = `<!doctype html><title>site</title><script>
  localStorage.setItem('a', '1'); localStorage.setItem('b', '2'); sessionStorage.setItem('s', '1');
</script>`;

let site: Server<undefined>;
let other: Server<undefined>;
let tripane: TriPaneServer;
let ws: WebSocket;
let latest: SiteInfo | null = null;

beforeAll(async () => {
  site = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () =>
      new Response(PAGE, {
        headers: [
          ['content-type', 'text/html'],
          ['set-cookie', 'visible=1; Path=/'],
          ['set-cookie', 'secret=2; Path=/; HttpOnly; SameSite=Strict'],
        ],
      }),
  });
  // Another site, whose cookie must survive clearing the first one.
  // Its port must differ from the first site's: "localhost" may bind to ::1, which can be given the
  // same port number as 127.0.0.1, and an engine that resolves localhost to 127.0.0.1 then reaches
  // the first site under the other's name.
  const serveOther = () => Bun.serve({ hostname: 'localhost', port: 0, fetch: () => new Response('<p>other</p>', { headers: { 'content-type': 'text/html', 'set-cookie': 'keep=1; Path=/' } }) });
  other = serveOther();
  while (other.port === site.port) {
    const taken = other;
    other = serveOther();
    taken.stop(true);
  }
  tripane = await startServer({ startUrl: `http://localhost:${other.port}/`, viewport: { width: 800, height: 600 } });
  await tripane.ready;
  // Visit the other site first, then the one under test.
  await Promise.all(tripane.panes.map((p) => p.playwrightPage!.goto(`http://127.0.0.1:${site.port}/`)));
  ws = new WebSocket(`${tripane.origin.replace('http', 'ws')}/ws?token=${tripane.token}`);
  ws.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') return;
    const msg = JSON.parse(data) as ServerMessage;
    if (msg.type === 'siteInfo') latest = msg.info;
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
});

afterAll(async () => {
  ws?.close();
  await tripane?.close();
  site?.stop(true);
  other?.stop(true);
});

const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
async function ask(type: 'siteInfo' | 'clearSiteData'): Promise<SiteInfo> {
  latest = null;
  send({ type });
  const end = Date.now() + 20_000;
  while (!latest) {
    if (Date.now() > end) throw new Error('no site info');
    await Bun.sleep(25);
  }
  return latest;
}

test('each engine reports the connection, cookies, storage and permissions', async () => {
  const info = await ask('siteInfo');
  assert.equal(info.origin, `http://127.0.0.1:${site.port}`);
  assert.deepEqual(info.engines.map((e) => e.engine), ['chromium', 'firefox', 'webkit']);
  for (const e of info.engines) {
    assert.equal(e.secure, false, e.engine);
    assert.equal(e.certificate, null, e.engine);
    assert.equal(e.status, 200, e.engine);
    assert.deepEqual(e.cookies.map((c) => [c.name, c.httpOnly]).sort(), [['secret', true], ['visible', false]], e.engine);
    assert.equal(e.localStorage, 2, e.engine);
    assert.equal(e.sessionStorage, 1, e.engine);
    assert.ok('notifications' in e.permissions && 'geolocation' in e.permissions, e.engine);
  }
});

test('clearing the site’s data clears it in every engine and leaves other sites alone', async () => {
  const info = await ask('clearSiteData');
  for (const e of info.engines) {
    assert.deepEqual([e.cookies.length, e.localStorage, e.sessionStorage], [0, 0, 0], e.engine);
  }
  const kept = await Promise.all(tripane.panes.map((p) => p.playwrightPage!.context().cookies(`http://localhost:${other.port}/`)));
  assert.deepEqual(kept.map((c) => c.map((x) => x.name)), [['keep'], ['keep'], ['keep']]);
});

test('clearing a site also reaches engines on another page, without disturbing that page', async () => {
  const siteOrigin = `http://127.0.0.1:${site.port}`;
  await Promise.all(tripane.panes.map((p) => p.playwrightPage!.goto(`${siteOrigin}/`)));
  await Promise.all(tripane.panes.map((p) => p.playwrightPage!.goto(`http://localhost:${other.port}/`)));
  const before = await Promise.all(tripane.panes.map((p) => p.playwrightPage!.context().storageState()));
  assert.ok(before.every((s) => s.origins.some((o) => o.origin === siteOrigin)), 'each engine holds storage for the site');
  latest = null;
  send({ type: 'clearSiteData', origin: siteOrigin });
  while (!latest) await Bun.sleep(25);
  for (const p of tripane.panes) {
    const context = p.playwrightPage!.context();
    const state = await context.storageState();
    assert.equal(state.origins.find((o) => o.origin === siteOrigin)?.localStorage.length ?? 0, 0, `${p.engine}: storage`);
    assert.deepEqual(state.cookies.filter((c) => c.domain === '127.0.0.1'), [], `${p.engine}: cookies`);
    assert.deepEqual(state.cookies.filter((c) => c.domain === 'localhost').map((c) => c.name), ['keep'], `${p.engine}: other site's cookie`);
    assert.equal(context.pages().length, 1, `${p.engine}: the helper page is closed`);
    assert.equal(p.info.url, `http://localhost:${other.port}/`, `${p.engine}: still on the other site`);
  }
});

test('StateFile.forgetSite removes one site from an engine’s saved data', async () => {
  const { StateFile } = await import('../server/storage');
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const path = `${await mkdtemp(`${tmpdir()}/tripane-forget-`)}/firefox.json`;
  const cookie = (name: string, domain: string, path = '/') => ({ name, value: '1', domain, path, expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const });
  await Bun.write(
    path,
    JSON.stringify({
      cookies: [cookie('own', 'www.example.com'), cookie('parent', '.example.com', '/deep'), cookie('sibling', 'api.example.com'), cookie('elsewhere', 'other.test')],
      origins: [
        { origin: 'https://www.example.com', localStorage: [{ name: 'a', value: '1' }] },
        { origin: 'https://other.test', localStorage: [{ name: 'b', value: '2' }] },
      ],
    }),
  );
  const file = new StateFile(path);
  assert.equal(await file.forgetSite('https://www.example.com'), true);
  const saved = await Bun.file(path).json();
  assert.deepEqual(saved.cookies.map((c: { name: string }) => c.name), ['sibling', 'elsewhere']);
  assert.deepEqual(saved.origins.map((o: { origin: string }) => o.origin), ['https://other.test']);
  assert.equal(await file.forgetSite('https://www.example.com'), false, 'nothing left to remove');
});
