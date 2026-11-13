// The MCP server: an AI agent drives all three engines over Streamable HTTP (POST /mcp) and stdio.
import { afterAll, beforeAll, setDefaultTimeout, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { Server } from 'bun';
import { startServer, type TriPaneServer } from '../server/server';

setDefaultTimeout(90_000);

const PAGE = `<!doctype html><title>mcp page</title>
<style>#box { width: 100px; height: 40px; }</style>
<div id="box">box</div>
<input id="name"><button id="go" onclick="document.title = 'clicked ' + document.getElementById('name').value">Go</button>
<script>console.error('boom from page')</script>`;

let site: Server<undefined>;
let tripane: TriPaneServer;
let nextId = 1;

beforeAll(async () => {
  site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }) });
  tripane = await startServer({ viewport: { width: 800, height: 600 } });
  await tripane.ready;
});

afterAll(async () => {
  await tripane?.close();
  site?.stop(true);
});

async function rpc(method: string, params: object = {}, headers: Record<string, string> = { authorization: `Bearer ${tripane.token}` }) {
  const res = await fetch(`${tripane.origin}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  return { status: res.status, body: res.status === 200 ? ((await res.json()) as any) : null };
}

async function tool(name: string, args: object = {}) {
  const { body } = await rpc('tools/call', { name, arguments: args });
  assert.ok(body.result, JSON.stringify(body));
  return body.result as { content: { type: string; text?: string; data?: string; mimeType?: string }[]; isError?: boolean };
}
const textOf = (r: Awaited<ReturnType<typeof tool>>) => r.content.map((c) => c.text ?? '').join('\n');

test('rejects requests without the token', async () => {
  assert.equal((await rpc('ping', {}, {})).status, 401);
  assert.equal((await rpc('ping', {}, { authorization: 'Bearer nope' })).status, 401);
});

test('initialize and list tools', async () => {
  const { body } = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.equal(body.result.protocolVersion, '2025-06-18');
  assert.equal(body.result.serverInfo.name, 'tripane');
  const notified = await fetch(`${tripane.origin}/mcp?token=${tripane.token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  assert.equal(notified.status, 202);
  const tools = (await rpc('tools/list')).body.result.tools.map((t: { name: string }) => t.name);
  for (const t of ['navigate', 'screenshot', 'click', 'fill', 'evaluate', 'compare_element', 'console', 'emulate', 'site_info', 'performance']) assert.ok(tools.includes(t), t);
});

test('navigate, fill and click in every engine', async () => {
  const url = `http://127.0.0.1:${site.port}/`;
  const nav = textOf(await tool('navigate', { url }));
  assert.equal(nav.match(/title: mcp page/g)?.length, 3, nav);
  assert.match(textOf(await tool('fill', { selector: '#name', text: 'tri' })), /chromium: filled\nfirefox: filled\nwebkit: filled/);
  await tool('click', { selector: '#go' });
  const titles = textOf(await tool('evaluate', { expression: 'document.title' }));
  assert.equal(titles.match(/"clicked tri"/g)?.length, 3, titles);
});

test('performance: monitor figures from each engine (all of them from Chromium)', async () => {
  const r = await tool('performance', { sample_ms: 300, format: 'json' });
  assert.ok(!r.isError, textOf(r));
  const stats = JSON.parse(textOf(r)) as Record<string, any>[];
  assert.deepEqual(stats.map((s) => s.engine), ['chromium', 'firefox', 'webkit']);
  for (const s of stats) {
    // The same DOM count everywhere: the page's elements are identical in all three engines.
    assert.ok(s.domElements >= 6, `${s.engine}: ${s.domElements} elements`);
    assert.equal(s.domElements, stats[0].domElements, `${s.engine}: same element count as chromium`);
    assert.ok(s.frames >= 1);
    assert.ok(s.network?.requests >= 1, `${s.engine}: network figures`);
  }
  const [c, f, w] = stats;
  assert.ok(c.sampledMs >= 200, `sampled ${c.sampledMs} ms`);
  for (const k of ['cpuPercent', 'jsHeapUsed', 'jsHeapTotal', 'jsEventListeners', 'documents', 'rendererFrames', 'layoutsPerSec', 'styleRecalcsPerSec', 'rendererNodes']) {
    assert.equal(typeof c[k], 'number', `chromium ${k}`);
    assert.equal(f[k], null, `firefox ${k}`);
    assert.equal(w[k], null, `webkit ${k}`);
  }
  assert.ok(c.jsHeapUsed > 0 && c.cpuPercent >= 0);
  const plain = textOf(await tool('performance', { engines: ['webkit'], sample_ms: 100 }));
  assert.match(plain, /^webkit — http/);
  assert.match(plain, /CPU usage: n\/a/);
  assert.match(plain, /DOM nodes: \d+/);
});

test('screenshot returns one image per engine', async () => {
  const r = await tool('screenshot', { engines: ['firefox', 'webkit'], format: 'png' });
  const images = r.content.filter((c) => c.type === 'image');
  assert.equal(images.length, 2);
  for (const img of images) {
    assert.equal(img.mimeType, 'image/png');
    assert.equal(Buffer.from(img.data!, 'base64').subarray(1, 4).toString(), 'PNG');
  }
});

test('console shows errors from every engine', async () => {
  const out = textOf(await tool('console', { level: 'error' }));
  for (const e of ['chromium', 'firefox', 'webkit']) assert.match(out, new RegExp(`\\[${e}\\] error console: boom from page`));
});

test('compare_element reports the box in each engine', async () => {
  const out = textOf(await tool('compare_element', { selector: '#box', all_styles: true }));
  assert.match(out, /Element: div#box/);
  assert.equal(out.match(/size 100×40/g)?.length, 3, out);
  assert.match(out, /width: chromium="100px" \| firefox="100px" \| webkit="100px"/);
});

test('emulate changes the viewport and color scheme', async () => {
  const out = textOf(await tool('emulate', { width: 500, height: 400, color_scheme: 'dark' }));
  assert.equal(out.match(/viewport 500×400/g)?.length, 3, out);
  const dark = textOf(await tool('evaluate', { expression: "matchMedia('(prefers-color-scheme: dark)').matches" }));
  assert.equal(dark.match(/: true/g)?.length, 3, dark);
});

test('tool errors are reported as results, not protocol errors', async () => {
  const r = await tool('click', { selector: '#missing', engines: ['chromium'] });
  assert.match(textOf(r), /chromium: error:/);
  const bad = await tool('compare_element', { selector: '#nothing-here' });
  assert.equal(bad.isError, true);
  const { body } = await rpc('nope/method');
  assert.equal(body.error.code, -32601);
});

test('stdio: `main.ts mcp` speaks MCP on stdout and quits when stdin closes', async () => {
  const proc = Bun.spawn(['bun', 'server/main.ts', 'mcp', '--no-window', '--no-persist', '--url', `http://127.0.0.1:${site.port}/`], {
    cwd: `${import.meta.dir}/..`,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const send = (m: object) => proc.stdin.write(`${JSON.stringify(m)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'status', arguments: {} } });
  proc.stdin.flush();
  const reader = proc.stdout.getReader();
  let out = '';
  while ((out.match(/\n/g)?.length ?? 0) < 2) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  proc.stdin.end();
  const lines = out.trim().split('\n').map((l) => JSON.parse(l)); // every stdout line is protocol
  const init = lines.find((l) => l.id === 1);
  const status = lines.find((l) => l.id === 2);
  assert.equal(init.result.serverInfo.name, 'tripane');
  assert.equal(status.result.content[0].text.match(/title: mcp page/g)?.length, 3, status.result.content[0].text);
  assert.equal(await Promise.race([proc.exited, Bun.sleep(20_000).then(() => 'still running')]), 0);
});
