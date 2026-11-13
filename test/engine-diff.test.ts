// Compare engines (visual diff, accessibility tree diff), the line diff, and CSS support data.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import type { Server } from 'bun';
import { lineDiff } from '../server/engine-diff';
import { startServer, type TriPaneServer } from '../server/server';
import { compatFor } from '../ui/src/compat';

setDefaultTimeout(120_000);

// ---- pure ---------------------------------------------------------------------------------------

test('lineDiff marks lines only in one side', () => {
  const d = lineDiff(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e']);
  expect(d.map((l) => `${l.op[0]}${l.text}`)).toEqual(['sa', 'db', 'ax', 'sc', 'sd', 'ae']);
  expect(lineDiff(['same'], ['same'])).toEqual([{ op: 'same', text: 'same' }]);
});

test('compatFor: Baseline, a property an engine version lacks, and a keyword value', () => {
  const engines = [
    { engine: 'chromium' as const, version: '158.0.1' },
    { engine: 'firefox' as const, version: '150.0' },
    { engine: 'webkit' as const, version: '26.0' },
  ];
  const tb = compatFor('text-box-trim', ['trim-both', 'trim-both', 'trim-both'], engines)!;
  expect(tb.baseline).toEqual({ level: 'low', feature: 'text-box' });
  expect(tb.engines[0]).toBeNull();
  expect(tb.engines[1]).toMatchObject({ state: 'later', short: 'Firefox 154+' });
  expect(tb.engines[2]).toBeNull();
  const us = compatFor('user-select', ['none', 'none', 'none'], engines)!;
  expect(us.engines[2]).toMatchObject({ state: 'prefixed' });
  expect(compatFor('display', ['flex', 'flex', 'flex'], engines)!.baseline?.level).toBe('high');
  expect(compatFor('not-a-property', [], engines)).toBeNull();
});

// ---- engines ------------------------------------------------------------------------------------

// No text (anti-aliasing would vary); Firefox gets a red block and a differently named button.
const PAGE = `<!doctype html><title>diff</title>
<style>body{margin:0;background:#fff} .b{width:400px;height:300px;background:#2563eb;margin:40px}</style>
<div class="b" id="block"></div>
<nav aria-label="Main"><a href="/a">A</a></nav>
<button id="go" aria-label="Go">x</button>
<script>
  if (navigator.userAgent.includes('Firefox')) {
    document.getElementById('block').style.background = '#e11d48';
    document.getElementById('go').setAttribute('aria-label', 'Start');
  }
</script>`;

let site: Server<undefined>;
let tripane: TriPaneServer;

beforeAll(async () => {
  site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }) });
  tripane = await startServer({ startUrl: `http://127.0.0.1:${site.port}/`, viewport: { width: 800, height: 600 } });
  await tripane.ready;
  await Promise.all(tripane.panes.map((p) => p.waitForLoad()));
});

afterAll(async () => {
  await tripane?.close();
  site?.stop(true);
});

async function call(name: string, args: object) {
  const res = (await tripane.mcp.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })) as {
    result: { content: { type: string; text?: string; data?: string }[]; isError?: boolean };
  };
  return res.result;
}

test('visual_diff: the engine that renders differently stands out; diff images come back', async () => {
  const r = await call('visual_diff', { reference: 'chromium' });
  expect(r.isError).toBeUndefined();
  const summary = r.content[0].text!;
  const pct = (e: string) => Number(summary.match(new RegExp(`${e} vs chromium: ([\\d.]+)%`))?.[1]);
  expect(pct('firefox')).toBeGreaterThan(20); // the 400×300 block of 800×600, plus
  expect(pct('webkit')).toBeLessThan(1);
  const images = r.content.filter((c) => c.type === 'image');
  expect(images).toHaveLength(2);
  expect(Buffer.from(images[0].data!, 'base64').subarray(1, 4).toString()).toBe('PNG');
});

test('aria_diff: a name that differs in one engine shows as a line diff', async () => {
  const r = await call('aria_diff', { reference: 'chromium' });
  const out = r.content[0].text!;
  expect(out).toMatch(/webkit: identical/);
  expect(out).toMatch(/firefox: \+1 −1/);
  expect(out).toMatch(/- .*button "Go"/);
  expect(out).toMatch(/\+ .*button "Start"/);
  const scoped = (await call('aria_diff', { reference: 'chromium', selector: 'nav' })).content[0].text!;
  expect(scoped).toMatch(/firefox: identical/);
});
