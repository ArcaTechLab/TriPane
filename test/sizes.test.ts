// Screen size per engine: each engine its own size or device, synced clicks mapped to the same
// element when sizes differ, and going back to one size for all.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Server } from 'bun';
import { startServer, type TriPaneServer } from '../server/server';
import type { ClientMessage, InputEvent, PaneId } from '../shared/protocol';

setDefaultTimeout(120_000);

// The button sits at half the viewport's width: a different x in every engine.
const PAGE = `<!doctype html><title>sizes</title>
<style>body{margin:0;height:200vh} #b{position:absolute;left:50vw;top:300px;width:80px;height:40px}</style>
<button id="b" onclick="window.clicks=(window.clicks||0)+1">B</button>`;

let site: Server<undefined>;
let tripane: TriPaneServer;
let ws: WebSocket;

beforeAll(async () => {
  site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }) });
  tripane = await startServer({ startUrl: `http://127.0.0.1:${site.port}/`, viewport: { width: 1280, height: 800 } });
  await tripane.ready;
  await Promise.all(tripane.panes.map((p) => p.waitForLoad()));
  ws = new WebSocket(`${tripane.origin.replace('http', 'ws')}/ws?token=${tripane.token}`);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
});

afterAll(async () => {
  ws?.close();
  await tripane?.close();
  site?.stop(true);
});

const send = (m: ClientMessage) => ws.send(JSON.stringify(m));
async function until(check: () => boolean | Promise<boolean>, what: string, ms = 30_000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out: ${what}: ${JSON.stringify(tripane.panes.map((p) => [p.info.device, p.info.viewport]))}`);
    await Bun.sleep(100);
  }
}
const sizes = () => tripane.panes.map((p) => [p.info.device, `${p.info.viewport.width}x${p.info.viewport.height}`]);
const clicks = () => Promise.all(tripane.panes.map((p) => p.playwrightPage!.evaluate(() => (window as unknown as { clicks?: number }).clicks ?? 0)));

test('each engine gets its own device or size', async () => {
  send({ type: 'settings', settings: { sizePerEngine: true, engineDevice: { chromium: 'iPhone 15', firefox: null, webkit: null } } });
  send({ type: 'viewport', target: 1, viewport: { width: 768, height: 1024 } });
  await until(() => JSON.stringify(sizes()) === JSON.stringify([['iPhone 15', '393x659'], [null, '768x1024'], [null, '1280x800']]), 'per-engine sizes');
  expect(tripane.settings.sizePerEngine).toBe(true);
});

test('a synced click lands on the same element in every engine, whatever its size', async () => {
  await Promise.all(tripane.panes.map((p) => p.waitForLoad())); // Chromium's page was rebuilt for the device
  await Bun.sleep(500);
  expect(await clicks()).toEqual([0, 0, 0]);
  // In WebKit (1280 wide) the button is at x = 640..720; in the others it's elsewhere.
  const press = (action: 'down' | 'up'): InputEvent => ({ kind: 'mouse', action, x: 680, y: 320, button: 'left', clickCount: 1 });
  send({ type: 'input', source: 2 as PaneId, event: press('down') });
  send({ type: 'input', source: 2 as PaneId, event: press('up') });
  await until(async () => (await clicks()).every((n) => n === 1), 'one click in each engine', 15_000);
});

test('back to "All engines": every engine takes the first engine’s device and size', async () => {
  send({ type: 'settings', settings: { sizePerEngine: false } });
  await until(() => sizes().every(([d, s]) => d === 'iPhone 15' && s === '393x659'), 'all like Chromium');
  expect(tripane.settings.device).toBe('iPhone 15');
  // And plain desktop sizes stay one size for all.
  send({ type: 'settings', settings: { device: null } });
  await until(() => sizes().every(([d]) => d === null), 'desktop again');
  send({ type: 'viewport', target: 'all', viewport: { width: 1000, height: 700 } });
  await until(() => sizes().every(([, s]) => s === '1000x700'), 'one size');
});
