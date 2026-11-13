// Settings → Frame format: each engine starts on its default; JPEG or PNG applies live, screencast included.
// Checked on the frames actually streamed to the UI (PNG starts with 0x89 'P', JPEG with FF D8).
import { afterAll, beforeAll, setDefaultTimeout, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { Server } from 'bun';
import { startServer, type TriPaneServer } from '../server/server';
import type { ClientMessage, FrameFormat, PaneInfo, ServerMessage, EngineName } from '../shared/protocol';

setDefaultTimeout(90_000);

// Keeps changing, so every engine keeps sending frames.
const PAGE = `<!doctype html><title>frames</title><style>
  @keyframes spin { to { transform: rotate(360deg) } }
  div { width: 200px; height: 200px; margin: 40px; background: linear-gradient(90deg, red, blue); animation: spin 1s linear infinite }
</style><div></div>`;

let site: Server<undefined>;
let tripane: TriPaneServer;
let ws: WebSocket;
const panes = new Map<number, PaneInfo>();
/** The format of the latest frame received per pane id. */
const latest = new Map<number, { format: 'png' | 'jpeg'; at: number }>();

beforeAll(async () => {
  site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }) });
  tripane = await startServer({ startUrl: `http://127.0.0.1:${site.port}/`, viewport: { width: 640, height: 400 } });
  await tripane.ready;
  ws = new WebSocket(`${tripane.origin.replace('http', 'ws')}/ws?token=${tripane.token}`);
  ws.binaryType = 'arraybuffer';
  ws.addEventListener('message', ({ data }) => {
    if (typeof data !== 'string') {
      const bytes = new Uint8Array(data as ArrayBuffer);
      const fmt = bytes[1] === 0x89 && bytes[2] === 0x50 ? 'png' : bytes[1] === 0xff && bytes[2] === 0xd8 ? 'jpeg' : null;
      if (fmt) latest.set(bytes[0], { format: fmt, at: Date.now() });
      return;
    }
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

/** Waits until every pane streams the expected format (frames sent after `since`) and reports it. */
async function expectFormats(want: [string, string, string], since: number) {
  const end = Date.now() + 30_000;
  for (;;) {
    const got = [0, 1, 2].map((i) => {
      const f = latest.get(i);
      return f && f.at > since ? f.format : '…';
    });
    const badges = [0, 1, 2].map((i) => panes.get(i)?.capture?.format);
    if (got.join() === want.join() && badges.join() === want.join()) return;
    if (Date.now() > end) throw new Error(`frames ${got.join()} badges ${badges.join()}, want ${want.join()}`);
    await Bun.sleep(50);
  }
}

test('by default Chromium and WebKit stream JPEG, Firefox PNG', async () => {
  await expectFormats(['jpeg', 'png', 'jpeg'], 0);
});

test('choosing a format applies live in every engine, including the Chromium screencast', async () => {
  const set = (f: Record<EngineName, FrameFormat>) => send({ type: 'settings', settings: { frameFormat: f } });
  let since = Date.now();
  set({ chromium: 'png', firefox: 'jpeg', webkit: 'png' });
  await expectFormats(['png', 'jpeg', 'png'], since);
  assert.deepEqual([0, 1, 2].map((i) => panes.get(i)?.capture?.quality), [null, 70, null]);

  since = Date.now();
  set({ chromium: 'jpeg', firefox: 'png', webkit: 'jpeg' });
  await expectFormats(['jpeg', 'png', 'jpeg'], since);
});

test("a saved 'auto' (from before it was removed) means the engine's default", async () => {
  const since = Date.now();
  send({ type: 'settings', settings: { frameFormat: { chromium: 'png', firefox: 'jpeg', webkit: 'png' } } });
  await expectFormats(['png', 'jpeg', 'png'], since);
  const back = Date.now();
  ws.send(JSON.stringify({ type: 'settings', settings: { frameFormat: { chromium: 'auto', firefox: 'auto', webkit: 'auto' } } }));
  await expectFormats(['jpeg', 'png', 'jpeg'], back);
});
