// DevTools bridge: the proxied Chrome DevTools frontend, the Chromium pass-through, and the CDP
// adapter for Firefox and WebKit, driven with raw CDP messages the way the frontend sends them.
import { afterAll, beforeAll, describe, setDefaultTimeout, test } from 'bun:test';
import assert from 'node:assert/strict';
import type { Server } from 'bun';
import { startServer, type TriPaneServer } from '../server/server';
import type { PaneId } from '../shared/protocol';

setDefaultTimeout(60_000);

const PAGE = `<!doctype html><title>DT</title>
<style>#box { color: rgb(255, 0, 0); padding: 4px } body { font-family: serif }</style>
<div id="box" class="a b" style="margin: 2px">hello</div>
<script>console.log('boot', { n: 1 }); console.error('bad thing');</script>`;

let site: Server<undefined>;
let tripane: TriPaneServer;

beforeAll(async () => {
  site = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: (req) =>
      new URL(req.url).pathname === '/data.json'
        ? Response.json({ ok: true })
        : new Response(PAGE, { headers: { 'content-type': 'text/html' } }),
  });
  tripane = await startServer({ startUrl: `http://127.0.0.1:${site.port}/` });
  await tripane.ready;
  // Network activity before any DevTools connects; the adapter should replay it.
  await Promise.all(tripane.panes.map((p) => p.playwrightPage!.evaluate(() => fetch('/data.json').then((r) => r.json()))));
});

afterAll(async () => {
  await tripane?.close();
  site?.stop(true);
});

/** A minimal CDP client over the TriPane endpoint. */
async function cdp(paneId: PaneId) {
  const ws = new WebSocket(`${tripane.origin.replace('http', 'ws')}/cdp/${tripane.token}/${paneId}`);
  const events: { method: string; params: any }[] = [];
  const waiting = new Map<number, (msg: any) => void>();
  let nextId = 1;
  ws.addEventListener('message', ({ data }) => {
    const msg = JSON.parse(data as string);
    if (msg.id) waiting.get(msg.id)?.(msg);
    else events.push(msg);
  });
  await new Promise((r, j) => {
    ws.addEventListener('open', r, { once: true });
    ws.addEventListener('error', j, { once: true });
  });
  return {
    events,
    async send(method: string, params: object = {}): Promise<any> {
      const id = nextId++;
      const reply = new Promise<any>((r) => waiting.set(id, r));
      ws.send(JSON.stringify({ id, method, params }));
      const msg = await reply;
      if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
      return msg.result;
    },
    async waitFor(method: string, pred: (p: any) => boolean = () => true) {
      const end = Date.now() + 10_000;
      for (;;) {
        const e = events.find((x) => x.method === method && pred(x.params));
        if (e) return e.params;
        if (Date.now() > end) throw new Error(`no ${method} event`);
        await Bun.sleep(25);
      }
    },
    close: () => ws.close(),
  };
}

test('the Chrome DevTools frontend is served from the Chromium pane', async () => {
  const res = await fetch(`${tripane.origin}/devtools/devtools_app.html`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<!DOCTYPE html>/i);
});

test('CDP endpoints require the token', async () => {
  assert.equal((await fetch(`${tripane.origin}/cdp/wrong/1`)).status, 401);
});

test('Chromium is passed straight through to its own DevTools socket', async () => {
  const c = await cdp(0);
  const { result } = await c.send('Runtime.evaluate', { expression: 'navigator.userAgent' });
  assert.match(result.value, /Chrome\//);
  c.close();
});

for (const [paneId, engine] of [[1, 'firefox'], [2, 'webkit']] as const) {
  describe(`${engine} through the adapter`, () => {
    test('Console: replays earlier messages and evaluates expressions', async () => {
      const c = await cdp(paneId);
      await c.send('Runtime.enable');
      const ctx = await c.waitFor('Runtime.executionContextCreated');
      assert.equal(ctx.context.auxData.isDefault, true);

      const boot = await c.waitFor('Runtime.consoleAPICalled', (p) => p.args[0]?.value === 'boot');
      assert.equal(boot.type, 'log');
      assert.equal(boot.args[1].type, 'object');
      assert.deepEqual(boot.args[1].preview.properties, [{ name: 'n', type: 'number', value: '1' }]);
      await c.waitFor('Runtime.consoleAPICalled', (p) => p.type === 'error');

      const sum = await c.send('Runtime.evaluate', { expression: '6 * 7' });
      assert.deepEqual(sum.result, { type: 'number', value: 42, description: '42' });

      const obj = await c.send('Runtime.evaluate', { expression: '({ engine: navigator.userAgent, list: [1, 2] })', objectGroup: 'console' });
      assert.ok(obj.result.objectId);
      const props = await c.send('Runtime.getProperties', { objectId: obj.result.objectId, ownProperties: true });
      assert.deepEqual(props.result.map((p: any) => p.name), ['engine', 'list']);
      assert.equal(props.result[1].value.subtype, 'array');
      assert.equal(props.internalProperties[0].name, '[[Prototype]]');

      const err = await c.send('Runtime.evaluate', { expression: 'notDefined.x' });
      assert.match(err.exceptionDetails.exception.description, /ReferenceError/);

      // As-you-type previews must not run code that could have side effects.
      const preview = await c.send('Runtime.evaluate', { expression: 'document.title = "x"', throwOnSideEffect: true });
      assert.ok(preview.exceptionDetails);
      assert.equal(await tripane.panes[paneId].playwrightPage!.title(), 'DT');
      c.close();
    });

    test('Network: replays requests made before DevTools opened, with bodies', async () => {
      const c = await cdp(paneId);
      await c.send('Network.enable');
      const sent = await c.waitFor('Network.requestWillBeSent', (p) => p.request.url.endsWith('/data.json'));
      assert.equal(sent.type, 'Fetch');
      const res = await c.waitFor('Network.responseReceived', (p) => p.requestId === sent.requestId);
      assert.equal(res.response.status, 200);
      assert.equal(res.response.mimeType, 'application/json');
      await c.waitFor('Network.loadingFinished', (p) => p.requestId === sent.requestId);
      const body = await c.send('Network.getResponseBody', { requestId: sent.requestId });
      assert.deepEqual(JSON.parse(body.body), { ok: true });
      c.close();
    });

    test('Elements: DOM tree, styles, live updates and highlight', async () => {
      const c = await cdp(paneId);
      const { root } = await c.send('DOM.getDocument', { depth: 1 });
      assert.equal(root.nodeName, '#document');
      const html = root.children.find((n: any) => n.nodeName === 'HTML');
      await c.send('DOM.requestChildNodes', { nodeId: html.nodeId });
      const htmlKids = await c.waitFor('DOM.setChildNodes', (p) => p.parentId === html.nodeId);
      const body = htmlKids.nodes.find((n: any) => n.nodeName === 'BODY');
      await c.send('DOM.requestChildNodes', { nodeId: body.nodeId });
      const bodyKids = await c.waitFor('DOM.setChildNodes', (p) => p.parentId === body.nodeId);
      const box = bodyKids.nodes.find((n: any) => n.attributes?.includes('box'));
      assert.deepEqual(box.attributes, ['id', 'box', 'class', 'a b', 'style', 'margin: 2px']);

      const matched = await c.send('CSS.getMatchedStylesForNode', { nodeId: box.nodeId });
      assert.equal(matched.inlineStyle.cssProperties[0].name, 'margin');
      const rule = matched.matchedCSSRules.find((m: any) => m.rule.selectorList.text === '#box');
      assert.ok(rule, 'the #box rule matches');
      assert.deepEqual(rule.rule.style.cssProperties.map((p: any) => p.name), ['color', 'padding']);
      assert.ok(matched.inherited[0].matchedCSSRules.some((m: any) => m.rule.selectorList.text === 'body'));

      const { computedStyle } = await c.send('CSS.getComputedStyleForNode', { nodeId: box.nodeId });
      assert.equal(computedStyle.find((p: any) => p.name === 'color').value, 'rgb(255, 0, 0)');

      // Editing a rule in the Styles pane changes the page.
      await c.send('CSS.setStyleTexts', { edits: [{ styleSheetId: rule.rule.styleSheetId, range: rule.rule.style.range, text: 'color: rgb(0, 128, 0);' }] });
      const page = tripane.panes[paneId].playwrightPage!;
      assert.equal(await page.$eval('#box', (e) => getComputedStyle(e).color), 'rgb(0, 128, 0)');

      // The page changes the DOM; DevTools hears about it.
      await page.evaluate(() => document.getElementById('box')!.setAttribute('data-x', '1'));
      await c.waitFor('DOM.attributeModified', (p) => p.nodeId === box.nodeId && p.name === 'data-x');
      await page.evaluate(() => document.body.append(Object.assign(document.createElement('p'), { id: 'added' })));
      const inserted = await c.waitFor('DOM.childNodeInserted', (p) => p.parentNodeId === body.nodeId);
      assert.deepEqual(inserted.node.attributes, ['id', 'added']);

      await c.send('Overlay.highlightNode', { nodeId: box.nodeId, highlightConfig: { showInfo: true } });
      assert.equal(await page.evaluate(() => !!document.querySelector('tripane-overlay')), true);
      await c.send('Overlay.hideHighlight');

      const { outerHTML } = await c.send('DOM.getOuterHTML', { nodeId: box.nodeId });
      assert.match(outerHTML, /^<div id="box"/);
      c.close();
    });
  });
}
