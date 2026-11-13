// Browsing history: the server records visits from the panes (once for all three engines), saves
// them with the profile, removes and clears them; the address bar ranks and completes from them.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { startServer, type TriPaneServer } from '../server/server';
import type { HistoryEntry, ServerMessage } from '../shared/protocol';
import { displayUrl, inlineCompletion, suggest, visitedUrlFor } from '../ui/src/omnibox';

setDefaultTimeout(90_000);

// ---- suggestions (pure) -------------------------------------------------------------------------

const now = Date.now();
const H = (url: string, title = '', visits = 1, daysAgo = 0): HistoryEntry => ({ url, title, visits, lastVisit: now - daysAgo * 86_400_000 });
const sample = [
  H('https://github.com/', 'GitHub', 20),
  H('https://github.com/anthropics/claude-code', 'Claude Code', 3),
  H('https://www.gitlab.com/', 'GitLab', 1, 30),
  H('https://developer.mozilla.org/en-US/docs/Web/CSS/text-box', 'text-box - CSS | MDN', 2),
  H('http://localhost:3000/dashboard', 'Dashboard', 5),
];

test('displayUrl drops scheme, www and a bare trailing slash', () => {
  expect(displayUrl('https://www.github.com/')).toBe('github.com');
  expect(displayUrl('http://localhost:3000/dashboard')).toBe('localhost:3000/dashboard');
});

test('suggest: URL prefix (site first), then host parts, then words in title or URL', () => {
  // Same tier (host starts with "git"): frequent and recent beats a page visited once a month ago.
  expect(suggest(sample, 'git').map((e) => e.url)).toEqual(['https://github.com/', 'https://github.com/anthropics/claude-code', 'https://www.gitlab.com/']);
  expect(suggest(sample, 'gitl')[0].url).toBe('https://www.gitlab.com/');
  expect(suggest(sample, 'mozilla')[0].url).toContain('mozilla');
  expect(suggest(sample, 'css mdn').map((e) => e.title)).toEqual(['text-box - CSS | MDN']);
  expect(suggest(sample, 'nothing-like-this')).toEqual([]);
  expect(suggest(sample, '', 2)).toHaveLength(2);
});

test('inline completion finishes the host first, then the URL', () => {
  expect(inlineCompletion(sample, 'git')).toBe('hub.com');
  expect(inlineCompletion(sample, 'github.com/a')).toBe('nthropics/claude-code');
  expect(inlineCompletion(sample, 'https://git')).toBe('hub.com');
  expect(inlineCompletion(sample, 'loc')).toBe('alhost:3000');
  expect(inlineCompletion(sample, 'github.com/')).toBe('');
  expect(inlineCompletion(sample, 'two words')).toBe('');
});

test('a typed address opens the URL that was visited', () => {
  expect(visitedUrlFor(sample, 'gitlab.com')).toBe('https://www.gitlab.com/');
  expect(visitedUrlFor(sample, 'localhost:3000/dashboard')).toBe('http://localhost:3000/dashboard');
  expect(visitedUrlFor(sample, 'example.com')).toBeNull();
});

// ---- server -------------------------------------------------------------------------------------

let site: Server<undefined>;
let profile: string;
let tripane: TriPaneServer;
let ws: WebSocket;
let history: HistoryEntry[] = [];

beforeAll(async () => {
  site = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      if (path === '/icon.svg') return new Response('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>', { headers: { 'content-type': 'image/svg+xml' } });
      const link = path === '/c' ? '<link rel="icon" href="/icon.svg">' : '';
      return new Response(`<!doctype html><title>Page ${path}</title>${link}<p>hi`, { headers: { 'content-type': 'text/html' } });
    },
  });
  profile = await mkdtemp(join(tmpdir(), 'tripane-history-'));
  tripane = await startServer({ profileDir: profile, viewport: { width: 800, height: 600 } });
  await tripane.ready;
  ws = new WebSocket(`${tripane.origin.replace('http', 'ws')}/ws?token=${tripane.token}`);
  ws.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') return;
    const msg = JSON.parse(data) as ServerMessage;
    if (msg.type === 'hello') history = msg.history;
    if (msg.type === 'historyEntry') history = [msg.entry, ...history.filter((e) => e.url !== msg.entry.url)];
    if (msg.type === 'historyRemoved') history = msg.urls === 'all' ? [] : history.filter((e) => !msg.urls.includes(e.url));
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
});

afterAll(async () => {
  ws?.close();
  await tripane?.close();
  site?.stop(true);
  await rm(profile, { recursive: true, force: true });
});

async function until(check: () => boolean, what: string) {
  const end = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}: ${JSON.stringify(history)}`);
    await Bun.sleep(50);
  }
}
const navigate = (url: string) => ws.send(JSON.stringify({ type: 'navigate', url }));

test('a page visited in all three engines is one visit, with its title; TriPane pages are skipped', async () => {
  expect(history.some((e) => e.url.startsWith(tripane.origin))).toBe(false); // the welcome page
  const a = `http://127.0.0.1:${site.port}/a`;
  navigate(a);
  await until(() => history[0]?.url === a && history[0].title === 'Page /a', 'page a');
  await Bun.sleep(1000);
  expect(history.filter((e) => e.url === a)).toEqual([expect.objectContaining({ visits: 1 })]);
  const b = `http://127.0.0.1:${site.port}/b`;
  navigate(b);
  await until(() => history[0]?.url === b && history[0].title === 'Page /b', 'page b');
  expect(history.map((e) => e.url)).toEqual([b, a]);
});

test('a page’s icon is recorded and served through /favicon (token required, images only)', async () => {
  const icon = `http://127.0.0.1:${site.port}/icon.svg`;
  const c = `http://127.0.0.1:${site.port}/c`;
  navigate(c);
  await until(() => history[0]?.url === c && history[0].icon === icon, 'icon of page c');
  // Without a <link rel=icon>, the site's /favicon.ico is assumed.
  expect(history.find((e) => e.url.endsWith('/a'))?.icon).toBe(`http://127.0.0.1:${site.port}/favicon.ico`);

  const get = (u: string, token = tripane.token) => fetch(`${tripane.origin}/favicon?token=${token}&u=${encodeURIComponent(u)}`);
  expect((await get(icon, 'wrong')).status).toBe(401);
  const res = await get(icon);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('image/svg+xml');
  expect(res.headers.get('content-security-policy')).toContain('sandbox');
  expect((await get(`http://127.0.0.1:${site.port}/favicon.ico`)).status).toBe(404); // an HTML page, not an image
  expect((await get('file:///etc/passwd')).status).toBe(404);
});

test('history is saved with the profile, and can be removed and cleared', async () => {
  const a = `http://127.0.0.1:${site.port}/a`;
  await tripane.close(); // flushes history.json
  const saved = (await Bun.file(join(profile, 'history.json')).json()) as HistoryEntry[];
  expect(saved.map((e) => e.title)).toEqual(['Page /c', 'Page /b', 'Page /a']);

  tripane = await startServer({ profileDir: profile, startUrl: 'about:blank', viewport: { width: 800, height: 600 } });
  await tripane.ready;
  ws = new WebSocket(`${tripane.origin.replace('http', 'ws')}/ws?token=${tripane.token}`);
  ws.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') return;
    const msg = JSON.parse(data) as ServerMessage;
    if (msg.type === 'hello') history = msg.history;
    if (msg.type === 'historyRemoved') history = msg.urls === 'all' ? [] : history.filter((e) => !msg.urls.includes(e.url));
  });
  history = [];
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  await until(() => history.length === 3, 'saved history');

  ws.send(JSON.stringify({ type: 'removeHistory', urls: [a] }));
  await until(() => history.length === 2, 'removal');
  ws.send(JSON.stringify({ type: 'clearHistory' }));
  await until(() => history.length === 0, 'clear');
  expect(await Bun.file(join(profile, 'history.json')).exists()).toBe(false);
});
