// Tools → Record trace: a Playwright trace per engine, with only what the user did in it (not
// TriPane's own frame captures, hover and scroll sync), served to Playwright's Trace Viewer.
import { afterAll, beforeAll, setDefaultTimeout, test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import type { Server } from 'bun';
import { quietly } from '../server/quiet';
import { startServer, type TriPaneServer } from '../server/server';
import type { ClientMessage, ServerMessage, Settings } from '../shared/protocol';

setDefaultTimeout(120_000);

const PAGE = `<!doctype html><title>t</title><button id=b style="width:200px;height:80px" onclick="this.textContent='clicked'">go</button>
<div style="height:3000px"></div><script>console.log('hello from the page')</script>`;

let site: Server<undefined>;
let tripane: TriPaneServer;
let traceDir: string;
let ws: WebSocket;
const messages: ServerMessage[] = [];

beforeAll(async () => {
  traceDir = await mkdtemp(join(tmpdir(), 'tripane-traces-'));
  site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }) });
  tripane = await startServer({ startUrl: 'about:blank', viewport: { width: 800, height: 600 }, traceDir });
  await tripane.ready;
  ws = new WebSocket(`${tripane.origin.replace('http', 'ws')}/ws?token=${tripane.token}`);
  ws.addEventListener('message', ({ data }) => {
    if (typeof data === 'string') messages.push(JSON.parse(data));
  });
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
});

afterAll(async () => {
  ws?.close();
  await tripane?.close();
  site?.stop(true);
  await rm(traceDir, { recursive: true, force: true });
});

const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
async function next<T extends ServerMessage['type']>(type: T, ok: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true) {
  const end = Date.now() + 60_000;
  for (;;) {
    const i = messages.findIndex((m) => m.type === type && ok(m as Extract<ServerMessage, { type: T }>));
    if (i >= 0) return messages.splice(i, 1)[0] as Extract<ServerMessage, { type: T }>;
    if (Date.now() > end) throw new Error(`timed out waiting for ${type}`);
    await Bun.sleep(50);
  }
}

/** Reads one file from a zip (stored or deflated), enough for Playwright's trace archives. */
function unzip(zip: Uint8Array, name: string): string {
  const buf = Buffer.from(zip);
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const skip = nameLen + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    if (buf.toString('utf8', at + 46, at + 46 + nameLen) === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + size);
      return (method === 8 ? inflateRawSync(data) : data).toString('utf8');
    }
    at += 46 + skip;
  }
  throw new Error(`${name} isn't in the zip`);
}

/** The API calls a trace recorded (method names), in order. */
async function actions(file: string): Promise<string[]> {
  const events = unzip(await Bun.file(file).bytes(), 'trace.trace')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  return events.filter((e) => e.type === 'before').map((e) => e.method as string);
}

test('a recording has each engine’s navigations and input, and none of TriPane’s own calls', async () => {
  send({ type: 'trace', action: 'start' });
  const started = await next('tracing', (m) => !!m.tracing);
  assert.equal(started.tracing!.saving, false);

  send({ type: 'navigate', url: `http://127.0.0.1:${site.port}/` });
  for (let end = Date.now() + 30_000; tripane.panes.some((p) => !p.info.url.startsWith('http')) && Date.now() < end; ) await Bun.sleep(50);
  await Promise.all(tripane.panes.map((p) => p.waitForLoad()));
  await Bun.sleep(500); // frames, titles, icons: TriPane's own calls, while recording
  // Hover (sync replays it everywhere), then a click on the button; then a scroll.
  for (const x of [20, 40, 60, 80]) send({ type: 'input', source: 0, event: { kind: 'mouse', action: 'move', x, y: 30, button: 'left' } });
  send({ type: 'input', source: 0, event: { kind: 'mouse', action: 'down', x: 60, y: 40, button: 'left', clickCount: 1 } });
  send({ type: 'input', source: 0, event: { kind: 'mouse', action: 'up', x: 60, y: 40, button: 'left', clickCount: 1 } });
  // (The test's own checks run quietly too, or they'd be in the trace.)
  const clicked = async () =>
    (await Promise.all(tripane.panes.map((p) => quietly(p.playwrightPage, () => p.playwrightPage!.evaluate(() => document.getElementById('b')?.textContent)).catch(() => '')))).every((t) => t === 'clicked');
  for (let end = Date.now() + 15_000; !(await clicked()) && Date.now() < end; ) await Bun.sleep(100);
  assert.ok(await clicked(), 'the click reached every engine');
  // (Not sent with the click: scroll sync would move a page before it has replayed the click.)
  send({ type: 'input', source: 0, event: { kind: 'wheel', x: 100, y: 100, dx: 0, dy: 400 } });
  await Bun.sleep(800); // scroll sync and frames run in the meantime

  // A device switch replaces WebKit's context: its trace continues in a second file.
  const webkit = tripane.panes.find((p) => p.engine === 'webkit')!;
  const generation = webkit.info.generation;
  send({ type: 'settings', settings: { sizePerEngine: true, engineDevice: { webkit: 'iPhone 15' } as Settings['engineDevice'] } });
  // The new page is in place (and reloaded) once its generation goes up.
  for (let end = Date.now() + 30_000; webkit.info.generation === generation && Date.now() < end; ) await Bun.sleep(100);
  await webkit.waitForLoad();
  await Bun.sleep(300);

  send({ type: 'trace', action: 'stop' });
  await next('tracing', (m) => !!m.tracing?.saving);
  const saved = await next('traces');
  await next('tracing', (m) => m.tracing === null);

  assert.deepEqual(saved.traces.map((t) => t.engine).sort(), ['chromium', 'firefox', 'webkit']);
  assert.ok(saved.dir.startsWith(traceDir), saved.dir);
  for (const t of saved.traces) {
    const at = t.engine;
    for (const f of t.files) assert.ok(await Bun.file(f).exists(), `${at}: ${f}`);
    const calls = (await Promise.all(t.files.map(actions))).flat();
    assert.ok(calls.includes('goto'), `${at}: the navigation is in the trace (${calls.join(', ')})`);
    assert.ok(calls.includes('mouseDown') && calls.includes('mouseUp'), `${at}: the click is in the trace`);
    // The wheel goes to the pane it was used in; the others follow through scroll sync, which (like
    // hover) is TriPane's own doing: their snapshots show the scrolled page.
    if (at === 'chromium') assert.ok(calls.includes('mouseWheel'), `${at}: the scroll is in the trace`);
    // TriPane's own calls stay out: frame captures, hover, scroll sync, titles, icons, highlight.
    for (const own of ['screenshot', 'evaluateExpression', 'title', 'storageState', 'sizes', 'send'])
      assert.ok(!calls.includes(own), `${at}: no ${own} in the trace (${calls.join(', ')})`);
    assert.ok(calls.filter((c) => c === 'mouseMove').length <= 1, `${at}: only the move that leads to the press (${calls.join(', ')})`);
  }
  const wk = saved.traces.find((t) => t.engine === 'webkit')!;
  assert.equal(wk.files.length, 2, 'WebKit: one file per context');
  assert.ok(wk.files[1].endsWith('webkit-2.zip'));
  assert.equal(new URL(wk.viewer, tripane.origin).searchParams.getAll('trace').length, 2, 'the viewer opens both parts');

  // The Trace Viewer is served, and it can fetch the traces (with the token, and only with it).
  const viewer = await fetch(new URL(wk.viewer, tripane.origin));
  assert.equal(viewer.status, 200);
  assert.match(viewer.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await viewer.text(), /<html/i);
  for (const asset of ['sw.bundle.js', 'snapshot.html']) assert.equal((await fetch(`${tripane.origin}/trace/${asset}`)).status, 200, asset);
  assert.equal((await fetch(`${tripane.origin}/trace/../package.json`)).status, 404);
  const traceUrl = new URL(new URL(wk.viewer, tripane.origin).searchParams.get('trace')!);
  const withToken = await fetch(traceUrl);
  assert.equal(withToken.status, 200);
  assert.equal(withToken.headers.get('content-type'), 'application/zip');
  traceUrl.searchParams.delete('token');
  assert.equal((await fetch(traceUrl)).status, 401);

  send({ type: 'settings', settings: { sizePerEngine: false, engineDevice: { webkit: null } as Settings['engineDevice'] } });
});

test('a client that connects while recording hears about it', async () => {
  send({ type: 'trace', action: 'start' });
  await next('tracing', (m) => !!m.tracing && !m.tracing.saving);
  const late = new WebSocket(`${tripane.origin.replace('http', 'ws')}/ws?token=${tripane.token}`);
  const hello = await new Promise<Extract<ServerMessage, { type: 'hello' }>>((resolve) =>
    late.addEventListener('message', ({ data }) => {
      const m = JSON.parse(String(data));
      if (m.type === 'hello') resolve(m);
    }),
  );
  late.close();
  assert.ok(hello.tracing && !hello.tracing.saving);
  send({ type: 'trace', action: 'stop' });
  const saved = await next('traces');
  assert.deepEqual(saved.traces.map((t) => t.engine).sort(), ['chromium', 'firefox', 'webkit'], 'a recording with nothing in it is still saved');
});
