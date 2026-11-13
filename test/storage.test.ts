// Saved logins: each engine's cookies, localStorage and IndexedDB survive a restart when a
// profile folder is used, and "Clear saved data" removes them for good.
import { afterAll, beforeAll, setDefaultTimeout, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { startServer, type TriPaneServer } from '../server/server';
import type { ServerMessage } from '../shared/protocol';

setDefaultTimeout(90_000);

let site: Server<undefined>;
let profile: string;
let base: string;

beforeAll(async () => {
  site = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const html = new Response('<!doctype html><title>store</title><p>ok</p>', { headers: { 'content-type': 'text/html' } });
      if (new URL(req.url).pathname === '/login') {
        html.headers.set('set-cookie', 'session=signed-in; Path=/; Max-Age=3600; HttpOnly; SameSite=Lax');
      }
      return html;
    },
  });
  base = `http://127.0.0.1:${site.port}`;
  profile = await mkdtemp(join(tmpdir(), 'tripane-profile-'));
});

afterAll(async () => {
  site?.stop(true);
  await rm(profile, { recursive: true, force: true });
});

const start = () => startServer({ startUrl: `${base}/`, profileDir: profile }).then(async (s) => (await s.ready, s));

/** What each engine remembers about the test site: cookie, localStorage, IndexedDB. */
async function remembered(t: TriPaneServer) {
  return Promise.all(
    t.panes.map(async (p) => {
      const page = p.playwrightPage!;
      const cookies = await page.context().cookies(base);
      const stored = await page.evaluate(
        () =>
          new Promise<{ local: string | null; idb: string | null }>((resolve) => {
            const local = localStorage.getItem('theme');
            const open = indexedDB.open('tp', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('kv');
            open.onsuccess = () => {
              const get = open.result.transaction('kv').objectStore('kv').get('k');
              get.onsuccess = () => {
                open.result.close();
                resolve({ local, idb: (get.result as string) ?? null });
              };
            };
          }),
      );
      return { engine: p.engine, session: cookies.find((c) => c.name === 'session')?.value ?? null, ...stored };
    }),
  );
}

test('cookies, localStorage and IndexedDB are restored after a restart, per engine', async () => {
  const first = await start();
  for (const p of first.panes) {
    const page = p.playwrightPage!;
    await page.goto(`${base}/login`);
    await page.evaluate(
      (engine) =>
        new Promise<void>((resolve) => {
          localStorage.setItem('theme', `dark-${engine}`);
          const open = indexedDB.open('tp', 1);
          open.onupgradeneeded = () => open.result.createObjectStore('kv');
          open.onsuccess = () => {
            const tx = open.result.transaction('kv', 'readwrite');
            tx.objectStore('kv').put(`v-${engine}`, 'k');
            tx.oncomplete = () => {
              open.result.close();
              resolve();
            };
          };
        }),
      p.engine,
    );
  }
  await first.close(); // saves

  const files = (await readdir(profile)).sort();
  assert.deepEqual(files, ['chromium.json', 'firefox.json', 'history.json', 'webkit.json']);
  for (const f of files) assert.equal((await stat(join(profile, f))).mode & 0o777, 0o600, `${f} is private`);

  const second = await start();
  try {
    // Each engine got its own values back; nothing leaked between engines.
    assert.deepEqual(await remembered(second), [
      { engine: 'chromium', session: 'signed-in', local: 'dark-chromium', idb: 'v-chromium' },
      { engine: 'firefox', session: 'signed-in', local: 'dark-firefox', idb: 'v-firefox' },
      { engine: 'webkit', session: 'signed-in', local: 'dark-webkit', idb: 'v-webkit' },
    ]);

    // "Clear saved data" from the UI.
    const ws = new WebSocket(`${second.origin.replace('http', 'ws')}/ws?token=${second.token}`);
    const notice = new Promise<string>((resolve) =>
      ws.addEventListener('message', ({ data }) => {
        if (typeof data !== 'string') return; // image frames
        const msg = JSON.parse(data) as ServerMessage;
        if (msg.type === 'notice') resolve(msg.message);
      }),
    );
    await new Promise((r) => ws.addEventListener('open', r, { once: true }));
    ws.send(JSON.stringify({ type: 'clearStorage' }));
    assert.match(await notice, /Cleared cookies and site storage/);
    ws.close();
    assert.deepEqual((await remembered(second)).map((r) => [r.session, r.local, r.idb]), [[null, null, null], [null, null, null], [null, null, null]]);
  } finally {
    await second.close();
  }

  // Still gone after another restart.
  const third = await start();
  try {
    assert.deepEqual((await remembered(third)).map((r) => [r.session, r.local, r.idb]), [[null, null, null], [null, null, null], [null, null, null]]);
  } finally {
    await third.close();
  }
});

test('settings (themes, layout, sync) are saved in the profile and restored', async () => {
  const seen: string[] = [];
  const first = await startServer({ startUrl: `${base}/`, profileDir: profile, onSettings: (s) => seen.push(s.uiTheme) });
  await first.ready;
  assert.deepEqual(seen, ['dark'], 'the app window is themed once at start (default dark)');
  const ws = new WebSocket(`${first.origin.replace('http', 'ws')}/ws?token=${first.token}`);
  let settingsSeen = 0;
  let onSettings = () => {};
  ws.addEventListener('message', ({ data }) => {
    if (typeof data === 'string' && JSON.parse(data).type === 'settings') {
      settingsSeen++;
      onSettings();
    }
  });
  const applied = (n: number) => new Promise<void>((resolve) => (onSettings = () => settingsSeen >= n && resolve()));
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.send(JSON.stringify({ type: 'settings', settings: { uiTheme: 'light', layout: 'rows', colorScheme: 'dark', sync: false, webkitNoticeSeen: true, bogus: 1 } }));
  await applied(1);
  // DevTools dock: side and sizes arrive separately and merge (one doesn't reset the others).
  ws.send(JSON.stringify({ type: 'settings', settings: { devtoolsDock: { side: 'right' } } }));
  await applied(2);
  ws.send(JSON.stringify({ type: 'settings', settings: { devtoolsDock: { width: 512.4, side: 'top' } } }));
  await applied(3);
  ws.close();
  assert.deepEqual(seen, ['dark', 'light', 'light', 'light'], 'theme changes reach the app window');
  await first.close();

  const second = await startServer({ startUrl: `${base}/`, profileDir: profile });
  try {
    await second.ready;
    assert.deepEqual({ ...second.settings }, {
      sync: false,
      scrollSync: true,
      linkFollow: true,
      colorScheme: 'dark',
      uiTheme: 'light',
      layout: 'rows',
      highlight: true,
      device: null,
      sizePerEngine: false,
      engineDevice: { chromium: null, firefox: null, webkit: null },
      autoUpdateCheck: true,
      showClicks: true,
      deviceFrames: true,
      engines: { chromium: true, firefox: true, webkit: true },
      frameFormat: { chromium: 'jpeg', firefox: 'png', webkit: 'jpeg' },
      devtoolsDock: { side: 'right', height: null, width: 512 },
      webkitNoticeSeen: true, // the first-start notice stays dismissed
    });
    // The restored page theme is applied to the engines from the start.
    const dark = await Promise.all(second.panes.map((p) => p.playwrightPage!.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches)));
    assert.deepEqual(dark, [true, true, true]);
  } finally {
    await second.close();
  }
});
