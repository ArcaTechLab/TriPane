// Engine update checks, against a local stand-in for the npm registry and CDN (no internet).
import { afterAll, beforeAll, describe, setDefaultTimeout, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { Server } from 'bun';
import { startServer, type TriPaneServer } from '../server/server';
import { compareVersions, installedVersions } from '../server/updates';
import type { ServerMessage, UpdateStatus } from '../shared/protocol';

setDefaultTimeout(60_000);

let registry: Server<undefined>;
let mode: 'newer' | 'same' | 'down' = 'newer';
let installed: Awaited<ReturnType<typeof installedVersions>>;

beforeAll(async () => {
  installed = await installedVersions();
  registry = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (mode === 'down') return new Response('unavailable', { status: 503 });
      if (path === '/registry/playwright-core/latest') {
        return Response.json({ version: mode === 'newer' ? '99.1.0' : installed.playwright });
      }
      if (path === '/cdn/playwright-core@99.1.0/browsers.json') {
        // A newer Chromium and WebKit; Firefox unchanged.
        return Response.json({
          browsers: [
            { name: 'chromium', browserVersion: '999.0.1.2' },
            { name: 'chromium-headless-shell', browserVersion: '999.0.1.2' },
            { name: 'firefox', browserVersion: installed.engines.firefox },
            { name: 'webkit', browserVersion: '99.0' },
          ],
        });
      }
      return new Response('not found', { status: 404 });
    },
  });
});

afterAll(() => registry?.stop(true));

const sources = () => ({ registry: `http://127.0.0.1:${registry.port}/registry`, cdn: `http://127.0.0.1:${registry.port}/cdn` });

/** Starts TriPane, connects like the UI, and returns its messages. */
async function connect(extra: Parameters<typeof startServer>[0] = {}) {
  const server = await startServer({ updateSources: sources(), ...extra });
  await server.ready;
  const messages: ServerMessage[] = [];
  const ws = new WebSocket(`${server.origin.replace('http', 'ws')}/ws?token=${server.token}`);
  ws.addEventListener('message', ({ data }) => typeof data === 'string' && messages.push(JSON.parse(data)));
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  const finished = async (): Promise<UpdateStatus> => {
    const end = Date.now() + 20_000;
    for (;;) {
      const done = messages.findLast((m) => m.type === 'updates' && !m.checking && m.status);
      if (done && done.type === 'updates') return done.status!;
      if (Date.now() > end) throw new Error('no update result');
      await Bun.sleep(25);
    }
  };
  return { server, ws, messages, finished, close: async () => (ws.close(), await server.close()) };
}

describe('version comparison', () => {
  test('dotted versions compare numerically', () => {
    assert.equal(compareVersions('158.0.8127.18', '158.0.8127.9'), 1);
    assert.equal(compareVersions('1.65.0', '1.66.0'), -1);
    assert.equal(compareVersions('27.2', '27.2.0'), 0);
    assert.equal(compareVersions('1.66.0-beta-1', '1.66.0'), 0);
  });
});

test('a newer Playwright shows which engines it updates, and how to update', async () => {
  mode = 'newer';
  const t = await connect();
  try {
    t.ws.send(JSON.stringify({ type: 'checkUpdates' }));
    const status = await t.finished();
    assert.deepEqual(status.playwright, { installed: installed.playwright, latest: '99.1.0' });
    assert.deepEqual(
      status.engines.map((e) => [e.engine, e.latest, e.update]),
      [['chromium', '999.0.1.2', true], ['firefox', installed.engines.firefox, false], ['webkit', '99.0', true]],
    );
    assert.equal(status.command, 'bun add playwright@99.1.0 && bunx playwright install chromium firefox webkit');
    assert.ok(t.messages.some((m) => m.type === 'updates' && m.checking), 'the UI is told a check is running');
    assert.ok(!t.messages.some((m) => m.type === 'notice'), 'a manual check shows results without a notice');
  } finally {
    await t.close();
  }
});

test('when up to date, nothing is offered', async () => {
  mode = 'same';
  const t = await connect();
  try {
    t.ws.send(JSON.stringify({ type: 'checkUpdates' }));
    const status = await t.finished();
    assert.equal(status.command, null);
    assert.ok(status.engines.every((e) => !e.update && e.latest === e.installed));
  } finally {
    await t.close();
  }
});

test('a failed check reports the error and TriPane carries on', async () => {
  mode = 'down';
  const t = await connect();
  try {
    t.ws.send(JSON.stringify({ type: 'checkUpdates' }));
    const status = await t.finished();
    assert.match(status.error ?? '', /answered 503/);
    assert.ok(status.engines.every((e) => !e.update));
  } finally {
    await t.close();
  }
});

test('automatic checks notify once, and respect the setting', async () => {
  mode = 'newer';
  const t = await connect({ autoCheckUpdates: true, firstUpdateCheckMs: 1000 });
  try {
    await t.finished();
    const notice = t.messages.find((m) => m.type === 'notice');
    assert.ok(notice && notice.type === 'notice');
    assert.equal(notice.message, 'Engine updates available: Chromium 999.0.1.2, WebKit 99.0. See Settings → Engine updates.');
  } finally {
    await t.close();
  }
  const off = await connect({ autoCheckUpdates: true, firstUpdateCheckMs: 1000 });
  try {
    off.ws.send(JSON.stringify({ type: 'settings', settings: { autoUpdateCheck: false } }));
    await Bun.sleep(1500);
    assert.ok(!off.messages.some((m) => m.type === 'updates' && m.checking), 'no automatic check when switched off');
  } finally {
    await off.close();
  }
});
