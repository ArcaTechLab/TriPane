// MCP (Model Context Protocol) server: lets an AI agent drive TriPane's three engines.
//
// Two transports share one handler:
//   - stdio:  `tripane mcp` (or `bun server/main.ts mcp`), for clients that launch the server.
//   - HTTP:   POST /mcp on a running TriPane (Streamable HTTP, JSON responses), token-protected.
//
// Everything an agent does goes through the same paths as the UI, so the user sees it happen:
// navigation, clicks and emulation changes show up in the panes, compare results in DevTools.
// The protocol is small enough (initialize, ping, tools/list, tools/call) to implement here
// without the SDK, which keeps the standalone build simple.
import type { Page } from 'playwright';
import { ENGINES, normalizeUrl, type AriaDiffResult, type ClientMessage, type CompareResult, type VisualDiffResult, type DevicePreset, type ElementRef, type EngineName, type LogEntry, type NetworkMetrics, type Settings } from '../shared/protocol';
import { formatDiff, type AriaDiffOptions, type VisualDiffOptions } from './engine-diff';
import type { PaneSession } from './pane';
import { formatPerformance } from './perf';

/** What the MCP server needs from the TriPane server. */
export interface McpHost {
  panes: PaneSession[];
  settings: Readonly<Settings>;
  devices: DevicePreset[];
  /** Runs a UI protocol message, exactly as if the UI had sent it. */
  run(msg: ClientMessage): Promise<void>;
  /** The unified log (console, errors, navigations from every engine). */
  log(): readonly LogEntry[];
  /** Compares an element across engines and shows the result in the UI too. */
  compare(ref: ElementRef): Promise<CompareResult>;
  /** Whole-page comparisons: pixels and accessibility trees, against a reference engine. */
  visualDiff(opts: VisualDiffOptions): Promise<VisualDiffResult>;
  ariaDiff(opts: AriaDiffOptions): Promise<AriaDiffResult>;
  /** Clears a site's cookies and storage in every engine, running or off; says what was done. */
  forgetSite(origin?: string): Promise<string>;
  version: string;
  /** Resolves once every engine has launched (tools wait for it). */
  ready: Promise<void>;
}

type JsonRpcId = string | number | null;
interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
}
type JsonRpcResponse = { jsonrpc: '2.0'; id: JsonRpcId; result: unknown } | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string } };

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
interface ToolResult {
  content: Content[];
  isError?: boolean;
}

const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_TEXT = 40_000;
const ACTION_TIMEOUT = 5_000;
const LOAD_TIMEOUT = 30_000;

const INSTRUCTIONS = `TriPane shows one page side by side in Chromium, Firefox and WebKit. Actions apply to every running engine at once unless you pass "engines". Use it to find cross-browser differences: navigate, take a screenshot of each engine, compare an element's computed styles, read console errors.`;

const enginesParam = {
  type: 'array',
  items: { type: 'string', enum: [...ENGINES] },
  description: 'Limit to these engines (default: every running engine).',
};

class ToolError extends Error {}

export class McpServer {
  /** Engines launched and the first page loaded: tools wait for this (a client may call right at startup). */
  private started?: Promise<void>;

  constructor(private readonly host: McpHost) {}

  /** Handles one JSON-RPC message; returns the response, or null for a notification. */
  async handle(message: unknown): Promise<JsonRpcResponse | null> {
    const req = message as JsonRpcRequest;
    if (!req || typeof req !== 'object' || typeof req.method !== 'string') {
      return { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } };
    }
    const isNotification = req.id === undefined;
    try {
      const result = await this.dispatch(req.method, req.params ?? {});
      return isNotification ? null : { jsonrpc: '2.0', id: req.id!, result };
    } catch (err) {
      if (isNotification) return null;
      const code = err instanceof MethodNotFound ? -32601 : -32603;
      return { jsonrpc: '2.0', id: req.id!, error: { code, message: err instanceof Error ? err.message : String(err) } };
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    switch (method) {
      case 'initialize': {
        const asked = String(params.protocolVersion ?? '');
        return {
          protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'tripane', title: 'TriPane', version: this.host.version },
          instructions: INSTRUCTIONS,
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: this.tools() };
      case 'tools/call':
        return this.call(String(params.name), (params.arguments ?? {}) as Record<string, unknown>);
      default:
        if (method.startsWith('notifications/')) return {};
        throw new MethodNotFound(`Method not found: ${method}`);
    }
  }

  // ---- tools ----------------------------------------------------------------------------------

  private tools() {
    const devices = this.host.devices.map((d) => d.name);
    const ro = { readOnlyHint: true, openWorldHint: false };
    return [
      {
        name: 'status',
        description: 'Each engine: version, URL, title, loading state, viewport, device and console error count. Also the sync settings.',
        inputSchema: { type: 'object', properties: {} },
        annotations: ro,
      },
      {
        name: 'navigate',
        description: 'Opens a URL in every engine and waits for it to load. Accepts "example.com" or "localhost:3000" too.',
        inputSchema: {
          type: 'object',
          properties: { url: { type: 'string' }, wait: { type: 'boolean', description: 'Wait for the load event (default true).' } },
          required: ['url'],
        },
      },
      {
        name: 'history',
        description: 'Back, forward or reload in every engine.',
        inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['back', 'forward', 'reload'] } }, required: ['action'] },
      },
      {
        name: 'reload_engine',
        description: 'Reloads one engine only, then brings it back in step with the others (URL and scroll).',
        inputSchema: { type: 'object', properties: { engine: { type: 'string', enum: [...ENGINES] } }, required: ['engine'] },
      },
      {
        name: 'screenshot',
        description: "A screenshot of each engine's viewport (or the full page), to compare rendering.",
        inputSchema: {
          type: 'object',
          properties: {
            engines: enginesParam,
            full_page: { type: 'boolean', description: 'The whole scrollable page instead of the viewport.' },
            selector: { type: 'string', description: 'Only this element (CSS selector).' },
            format: { type: 'string', enum: ['jpeg', 'png'], description: 'Default jpeg (smaller).' },
          },
        },
        annotations: ro,
      },
      {
        name: 'click',
        description: 'Clicks the first element matching a CSS or Playwright selector (e.g. "text=Sign in", "role=button[name=Save]") in each engine.',
        inputSchema: { type: 'object', properties: { selector: { type: 'string' }, engines: enginesParam }, required: ['selector'] },
      },
      {
        name: 'fill',
        description: 'Types into an input, textarea or contenteditable in each engine, replacing its value.',
        inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, engines: enginesParam }, required: ['selector', 'text'] },
      },
      {
        name: 'press_key',
        description: 'Presses a key or chord (e.g. "Enter", "Tab", "Control+A") in each engine, on an element if a selector is given.',
        inputSchema: { type: 'object', properties: { key: { type: 'string' }, selector: { type: 'string' }, engines: enginesParam }, required: ['key'] },
      },
      {
        name: 'scroll',
        description: 'Scrolls each engine: to an element, to the top or bottom, or by a number of pixels.',
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'Scroll this element into view.' },
            to: { type: 'string', enum: ['top', 'bottom'] },
            by: { type: 'number', description: 'Pixels down (negative: up).' },
            engines: enginesParam,
          },
        },
      },
      {
        name: 'evaluate',
        description: 'Runs a JavaScript expression in each engine\'s page and returns the results as JSON (await is allowed: "(async () => …)()").',
        inputSchema: { type: 'object', properties: { expression: { type: 'string' }, engines: enginesParam }, required: ['expression'] },
      },
      {
        name: 'compare_element',
        description: "Compares one element across engines: its box model and the computed styles that differ. Also outlines it and shows the result in TriPane's Compare tab.",
        inputSchema: {
          type: 'object',
          properties: {
            selector: { type: 'string', description: 'CSS selector; the first match is used.' },
            all_styles: { type: 'boolean', description: 'List every computed style, not just the ones that differ.' },
            include_prefixed: { type: 'boolean', description: 'Include vendor-prefixed properties (-webkit-, -moz-).' },
          },
          required: ['selector'],
        },
        annotations: ro,
      },
      {
        name: 'visual_diff',
        description:
          "Compares every engine's rendering with a reference engine, pixel by pixel (anti-aliasing ignored). Returns the % of pixels that differ per engine and diff images: changed pixels in red/blue over a faded copy of the reference.",
        inputSchema: {
          type: 'object',
          properties: {
            reference: { type: 'string', enum: [...ENGINES], description: 'Engine to compare against (default: the first running one).' },
            full_page: { type: 'boolean', description: 'The whole scrollable page instead of the viewport.' },
            threshold: { type: 'number', description: 'Colour difference that counts, 0 (exact) to 1. Default 0.1.' },
            images: { type: 'boolean', description: 'Include the diff images (default true).' },
          },
        },
        annotations: ro,
      },
      {
        name: 'aria_diff',
        description:
          "Compares each engine's accessibility tree (roles, names, states, as Playwright's ARIA snapshot) with a reference engine, as a line diff: '-' only in the reference, '+' only in that engine.",
        inputSchema: {
          type: 'object',
          properties: {
            reference: { type: 'string', enum: [...ENGINES], description: 'Engine to compare against (default: the first running one).' },
            selector: { type: 'string', description: 'Only this part of the page (CSS or Playwright selector). Default: the whole page.' },
            full_tree: { type: 'boolean', description: "Also return the reference engine's full tree." },
          },
        },
        annotations: ro,
      },
      {
        name: 'console',
        description: 'The unified console: logs, warnings, errors, failed requests and navigations from every engine.',
        inputSchema: {
          type: 'object',
          properties: {
            level: { type: 'string', enum: ['all', 'warning', 'error'], description: '"warning" includes errors. Default all.' },
            engine: { type: 'string', enum: [...ENGINES] },
            after_id: { type: 'number', description: 'Only entries newer than this id (each line starts with #id).' },
            limit: { type: 'number', description: 'Most recent entries to return (default 100).' },
            clear: { type: 'boolean', description: 'Empty the log after reading it.' },
          },
        },
      },
      {
        name: 'emulate',
        description:
          'Changes the emulated viewport, device or color scheme. Size and device apply to every engine, or with "engines" only to those (each engine can have its own size, e.g. Chromium as a phone and WebKit as a desktop; clicks are then synced by element).',
        inputSchema: {
          type: 'object',
          properties: {
            engines: { ...enginesParam, description: 'Give these engines their own size or device (default: one size for all).' },
            width: { type: 'number' },
            height: { type: 'number' },
            device: { type: 'string', enum: ['none', ...devices], description: '"none" goes back to desktop.' },
            color_scheme: { type: 'string', enum: ['light', 'dark'] },
          },
        },
      },
      {
        name: 'performance',
        description:
          "Performance monitor figures for each engine, like Chrome DevTools' Performance monitor: CPU usage, JS heap, DOM nodes, event listeners, documents, frames, layouts and style recalculations per second, paint timings, and the page's network figures. Chromium reports everything (rates measured over sample_ms); Firefox and WebKit expose only DOM size, frames, paint timings and network figures (the rest is n/a).",
        inputSchema: {
          type: 'object',
          properties: {
            engines: enginesParam,
            sample_ms: { type: 'number', description: 'How long to measure the rates for, 100–10000 ms (default 1000). Interact or wait during it to see load.' },
            format: { type: 'string', enum: ['text', 'json'], description: 'Default text.' },
          },
        },
        annotations: ro,
      },
      {
        name: 'site_info',
        description: "Each engine's view of the open site: connection and certificate, cookies, storage and permission states.",
        inputSchema: { type: 'object', properties: { clear_site_data: { type: 'boolean', description: "First clear this site's cookies and storage (localStorage, sessionStorage, IndexedDB) in every engine, including the saved data of engines that are off." } } },
      },
    ];
  }

  private async call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    try {
      await (this.started ??= this.host.ready.then(() => this.settle()));
      const content = await this.run(name, args);
      return { content: content.map((c) => (c.type === 'text' ? { ...c, text: truncate(c.text) } : c)) };
    } catch (err) {
      return { content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }], isError: true };
    }
  }

  private async run(name: string, args: Record<string, unknown>): Promise<Content[]> {
    const host = this.host;
    switch (name) {
      case 'status':
        return text(this.status());

      case 'navigate': {
        const url = normalizeUrl(str(args.url, 'url'));
        await host.run({ type: 'navigate', url });
        if (args.wait !== false) await this.settle();
        return text(this.status());
      }

      case 'history': {
        const action = str(args.action, 'action');
        if (action !== 'back' && action !== 'forward' && action !== 'reload') throw new ToolError('action must be back, forward or reload');
        await host.run({ type: 'history', action });
        await this.settle();
        return text(this.status());
      }

      case 'reload_engine': {
        const pane = this.pick([str(args.engine, 'engine')])[0];
        await host.run({ type: 'reloadPane', target: pane.id });
        return text(this.status());
      }

      case 'screenshot': {
        const type = args.format === 'png' ? 'png' : 'jpeg';
        const selector = typeof args.selector === 'string' && args.selector ? args.selector : null;
        const shots = await this.each(args.engines, async (page) => {
          const opts = { type, timeout: 15_000, ...(type === 'jpeg' ? { quality: 80 } : {}) } as const;
          return selector ? page.locator(selector).first().screenshot(opts) : page.screenshot({ ...opts, fullPage: args.full_page === true });
        });
        const out: Content[] = [];
        for (const s of shots) {
          if (!s.ok) out.push({ type: 'text', text: `${s.engine}: ${s.error}` });
          else out.push({ type: 'text', text: `${s.engine} (${s.pane.info.version}):` }, { type: 'image', data: s.value.toString('base64'), mimeType: `image/${type}` });
        }
        return out;
      }

      case 'click': {
        const selector = str(args.selector, 'selector');
        const r = await this.each(args.engines, (page) => page.locator(selector).first().click({ timeout: ACTION_TIMEOUT }));
        await this.settle(2_000);
        return text(report(r, () => 'clicked'), this.status());
      }

      case 'fill': {
        const selector = str(args.selector, 'selector');
        const value = typeof args.text === 'string' ? args.text : str(args.text, 'text');
        const r = await this.each(args.engines, (page) => page.locator(selector).first().fill(value, { timeout: ACTION_TIMEOUT }));
        return text(report(r, () => 'filled'));
      }

      case 'press_key': {
        const key = str(args.key, 'key');
        const selector = typeof args.selector === 'string' && args.selector ? args.selector : null;
        const r = await this.each(args.engines, (page) =>
          selector ? page.locator(selector).first().press(key, { timeout: ACTION_TIMEOUT }) : page.keyboard.press(key),
        );
        await this.settle(2_000);
        return text(report(r, () => 'pressed'), this.status());
      }

      case 'scroll': {
        const selector = typeof args.selector === 'string' && args.selector ? args.selector : null;
        const to = args.to === 'top' || args.to === 'bottom' ? args.to : null;
        const by = Number(args.by);
        if (!selector && !to && !Number.isFinite(by)) throw new ToolError('Give a selector, "to" (top or bottom), or "by" (pixels).');
        const r = await this.each(args.engines, async (page) => {
          if (selector) await page.locator(selector).first().scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT });
          else
            await page.evaluate(
              ({ to, by }) => {
                const el = document.scrollingElement ?? document.documentElement;
                if (to) window.scrollTo({ top: to === 'top' ? 0 : el.scrollHeight, behavior: 'instant' });
                else window.scrollBy({ top: by, behavior: 'instant' });
              },
              { to, by },
            );
          return page.evaluate(() => ({ y: Math.round(window.scrollY), height: (document.scrollingElement ?? document.documentElement).scrollHeight }));
        });
        return text(report(r, (v) => `scrollY ${v.y} of ${v.height}`));
      }

      case 'evaluate': {
        const expression = str(args.expression, 'expression');
        const r = await this.each(args.engines, (page) => page.evaluate(expression));
        return text(report(r, (v) => (v === undefined ? 'undefined' : JSON.stringify(v, null, 2))));
      }

      case 'compare_element':
        return text(await this.compare(str(args.selector, 'selector'), args.all_styles === true, args.include_prefixed === true));

      case 'console': {
        const level = args.level === 'error' ? ['error'] : args.level === 'warning' ? ['error', 'warning'] : null;
        const engine = typeof args.engine === 'string' ? args.engine : null;
        const after = Number.isFinite(Number(args.after_id)) ? Number(args.after_id) : 0;
        const limit = Math.max(1, Math.min(1000, Number(args.limit) || 100));
        const entries = host
          .log()
          .filter((e) => e.id > after && (!level || level.includes(e.level)) && (!engine || ENGINES[e.paneId] === engine))
          .slice(-limit);
        if (args.clear === true) await host.run({ type: 'clearLog' });
        if (!entries.length) return text('No matching log entries.');
        return text(
          entries
            .map((e) => {
              const where = e.url ? ` (${e.url}${e.line ? `:${e.line}` : ''})` : '';
              return `#${e.id} [${ENGINES[e.paneId]}] ${e.level} ${e.source}: ${e.text}${where}`;
            })
            .join('\n'),
        );
      }

      case 'visual_diff': {
        const reference = this.referenceEngine(args.reference);
        const r = await host.visualDiff({ reference, fullPage: args.full_page === true, threshold: typeof args.threshold === 'number' ? args.threshold : undefined });
        const out: Content[] = [];
        const lines = r.diffs.map(
          (d) => `${d.engine} vs ${d.against}: ${d.percent}% different (${d.pixels.toLocaleString('en')} of ${(d.width * d.height).toLocaleString('en')} px)${d.sizeMismatch ? ` — sizes differ, compared the shared ${d.width}×${d.height} area` : ''}`,
        );
        out.push({ type: 'text', text: `Reference: ${r.reference}${r.fullPage ? ' (full page)' : ' (viewport)'}, threshold ${r.threshold}\n${lines.join('\n')}` });
        if (args.images !== false) {
          for (const d of r.diffs) {
            out.push({ type: 'text', text: `${d.engine} vs ${d.against} (red/blue: differing pixels):` }, { type: 'image', data: d.image.split(',')[1], mimeType: 'image/png' });
          }
        }
        return out;
      }

      case 'aria_diff': {
        const reference = this.referenceEngine(args.reference);
        const r = await host.ariaDiff({ reference, selector: typeof args.selector === 'string' ? args.selector : undefined });
        const parts = [`Accessibility tree of ${r.selector === 'body' ? 'the page' : r.selector}, compared with ${r.reference}:`];
        for (const e of r.engines) {
          if (e.engine === r.reference) continue;
          if (e.error) parts.push(`\n${e.engine}: couldn't read the tree: ${e.error}`);
          else if (!e.added && !e.removed) parts.push(`\n${e.engine}: identical`);
          else parts.push(`\n${e.engine}: +${e.added} −${e.removed}\n${formatDiff(e.lines)}`);
        }
        if (args.full_tree === true) parts.push(`\n${r.reference} (full tree):\n${r.engines.find((e) => e.engine === r.reference)?.tree ?? ''}`);
        return text(parts.join('\n'));
      }

      case 'emulate': {
        const changes: string[] = [];
        const perEngine = Array.isArray(args.engines) && args.engines.length > 0;
        const chosen = perEngine ? this.pick(args.engines) : this.running();
        const s = host.settings;
        if (args.device !== undefined) {
          const device = args.device === 'none' || args.device === null ? null : str(args.device, 'device');
          if (device && !host.devices.some((d) => d.name === device)) throw new ToolError(`Unknown device. Choose one of: ${host.devices.map((d) => d.name).join(', ')}`);
          if (perEngine) {
            const base = s.sizePerEngine ? s.engineDevice : { chromium: s.device, firefox: s.device, webkit: s.device };
            const engineDevice = { ...base };
            for (const p of chosen) engineDevice[p.engine] = device;
            await host.run({ type: 'settings', settings: { sizePerEngine: true, engineDevice } });
          } else {
            await host.run({ type: 'settings', settings: { device, sizePerEngine: false } });
          }
          changes.push(`device: ${device ?? 'desktop'}${perEngine ? ` (${chosen.map((p) => p.engine).join(', ')})` : ''}`);
        }
        if (args.width !== undefined || args.height !== undefined) {
          const current = chosen[0]?.info.viewport ?? { width: 1280, height: 800 };
          const viewport = { width: Number(args.width ?? current.width), height: Number(args.height ?? current.height) };
          if (perEngine) {
            // A size means desktop for these engines; the others keep theirs.
            if (args.device === undefined) {
              const base = s.sizePerEngine ? s.engineDevice : { chromium: s.device, firefox: s.device, webkit: s.device };
              const engineDevice = { ...base };
              for (const p of chosen) engineDevice[p.engine] = null;
              await host.run({ type: 'settings', settings: { sizePerEngine: true, engineDevice } });
            }
            for (const p of chosen) await host.run({ type: 'viewport', target: p.id, viewport });
          } else {
            if (args.device === undefined && (s.device || s.sizePerEngine)) await host.run({ type: 'settings', settings: { device: null, sizePerEngine: false } });
            await host.run({ type: 'viewport', target: 'all', viewport });
          }
          changes.push(`viewport: ${viewport.width}×${viewport.height}${perEngine ? ` (${chosen.map((p) => p.engine).join(', ')})` : ''}`);
        }
        if (args.color_scheme === 'light' || args.color_scheme === 'dark') {
          await host.run({ type: 'settings', settings: { colorScheme: args.color_scheme } });
          changes.push(`color scheme: ${args.color_scheme}`);
        }
        if (!changes.length) throw new ToolError('Nothing to change: give width/height, device or color_scheme.');
        return text(`Changed ${changes.join(', ')}.`, this.status());
      }

      case 'performance': {
        const sampleMs = Math.max(100, Math.min(10_000, Number(args.sample_ms) || 1000));
        const r = await Promise.all(
          this.pick(args.engines).map(async (pane) => {
            try {
              return { ok: true as const, engine: pane.engine, stats: { ...(await pane.performance(sampleMs)), network: pane.info.metrics ?? null } };
            } catch (err) {
              return { ok: false as const, engine: pane.engine, error: firstLine(err) };
            }
          }),
        );
        if (args.format === 'json') return text(JSON.stringify(r.map((x) => (x.ok ? x.stats : { engine: x.engine, error: x.error })), null, 2));
        return text(
          r
            .map((x) => (x.ok ? `${formatPerformance(x.stats)}${x.stats.network ? `\n  Network: ${networkLine(x.stats.network)}` : ''}` : `${x.engine}: error: ${x.error}`))
            .join('\n\n'),
        );
      }

      case 'site_info': {
        const panes = this.running();
        const cleared = args.clear_site_data === true ? await host.forgetSite() : null;
        const infos = (await Promise.all(panes.map((p) => p.siteInfo()))).filter((i) => !!i);
        return text(`${cleared ? `${cleared}\n\n` : ''}${JSON.stringify(infos, null, 2)}`);
      }

      default:
        throw new ToolError(`Unknown tool: ${name}`);
    }
  }

  // ---- helpers ----------------------------------------------------------------------------------

  /** The engine to compare against: the one asked for, else the first running one. */
  private referenceEngine(asked: unknown): EngineName {
    const running = this.running();
    if (typeof asked === 'string' && asked) {
      if (!running.some((p) => p.engine === asked)) throw new ToolError(`${asked} isn't running.`);
      return asked as EngineName;
    }
    if (!running.length) throw new ToolError('No engine is running.');
    return running[0].engine;
  }

  private running(): PaneSession[] {
    return this.host.panes.filter((p) => p.ready && !p.info.disabled);
  }

  private pick(engines: unknown): PaneSession[] {
    const running = this.running();
    if (!running.length) throw new ToolError('No engine is running.');
    if (!Array.isArray(engines) || !engines.length) return running;
    const want = new Set(engines.map(String));
    const unknown = [...want].filter((e) => !ENGINES.includes(e as EngineName));
    if (unknown.length) throw new ToolError(`Unknown engine: ${unknown.join(', ')}. Use chromium, firefox or webkit.`);
    const panes = running.filter((p) => want.has(p.engine));
    if (!panes.length) throw new ToolError(`${[...want].join(', ')} ${want.size > 1 ? "aren't" : "isn't"} running.`);
    return panes;
  }

  /** Runs an action in each chosen engine in parallel; one engine failing doesn't stop the others. */
  private each<T>(engines: unknown, action: (page: Page) => Promise<T>) {
    return Promise.all(
      this.pick(engines).map(async (pane) => {
        try {
          return { ok: true as const, engine: pane.engine, pane, value: await pane.act(action) };
        } catch (err) {
          return { ok: false as const, engine: pane.engine, pane, error: firstLine(err) };
        }
      }),
    );
  }

  /** Waits for every engine to finish loading (navigations from a click may take a moment to start). */
  private async settle(timeout = LOAD_TIMEOUT): Promise<void> {
    await Bun.sleep(150);
    await Promise.all(this.running().map((p) => p.waitForLoad(timeout)));
    // Playwright's load state can be reached early (Firefox's placeholder document); the pane's
    // own loading flag clears on the real page's load. Then a moment for the title to be read.
    const end = Date.now() + timeout;
    while (this.running().some((p) => p.info.loading) && Date.now() < end) await Bun.sleep(50);
    await Bun.sleep(100);
  }

  private status(): string {
    const s = this.host.settings;
    const lines = this.host.panes.map((p) => {
      const i = p.info;
      if (i.disabled) return `${p.engine}: turned off in Settings → Engines`;
      if (i.failed) return `${p.engine}: failed to start: ${i.failed}`;
      return [
        `${p.engine} ${i.version}`,
        `  url: ${i.url}`,
        `  title: ${i.title}`,
        `  ${i.loading ? 'loading' : 'loaded'}, viewport ${i.viewport.width}×${i.viewport.height}${i.device ? ` (${i.device})` : ''}, console errors: ${i.errors}`,
        ...(i.metrics ? [`  network: ${networkLine(i.metrics)}`] : []),
      ].join('\n');
    });
    const on = (b: boolean) => (b ? 'on' : 'off');
    lines.push(`settings: sync input ${on(s.sync)}, sync scroll ${on(s.scrollSync)}, follow links ${on(s.linkFollow)}, color scheme ${s.colorScheme}`);
    return lines.join('\n');
  }

  private async compare(selector: string, allStyles: boolean, includePrefixed: boolean): Promise<string> {
    let hit: Awaited<ReturnType<PaneSession['refFor']>> = null;
    for (const p of this.running()) {
      try {
        hit = await p.refFor(selector);
      } catch (err) {
        throw new ToolError(`Bad selector: ${firstLine(err)}`);
      }
      if (hit) break;
    }
    if (!hit) throw new ToolError(`No element matches ${selector} in any engine.`);
    const result = await this.host.compare(hit.ref);
    const found = result.engines.filter((e) => e.found);
    const out: string[] = [`Element: ${hit.label}`];
    for (const e of result.engines) {
      if (!e.found || !e.box) {
        out.push(`${e.engine}: not found`);
        continue;
      }
      const b = e.box;
      out.push(`${e.engine}: ${e.label} at (${b.x}, ${b.y}) size ${b.width}×${b.height}, margin ${b.margin.join(' ')}, border ${b.border.join(' ')}, padding ${b.padding.join(' ')}`);
    }
    const props = new Set(found.flatMap((e) => Object.keys(e.styles ?? {})));
    const rows: string[] = [];
    for (const prop of [...props].sort()) {
      if (!includePrefixed && /^-(webkit|moz|ms|apple|epub)-/.test(prop)) continue;
      const values = found.map((e) => e.styles?.[prop]);
      const differs = values.some((v) => v !== values[0]);
      if (!allStyles && !differs) continue;
      rows.push(`  ${prop}: ${found.map((e, i) => `${e.engine}=${values[i] === undefined ? '(unsupported)' : JSON.stringify(values[i])}`).join(' | ')}`);
    }
    out.push(allStyles ? `Computed styles (${rows.length}):` : rows.length ? `Computed styles that differ (${rows.length}):` : 'No computed style differs between the engines.');
    out.push(...rows);
    return out.join('\n');
  }
}

class MethodNotFound extends Error {}

function text(...parts: string[]): Content[] {
  return [{ type: 'text', text: parts.join('\n\n') }];
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new ToolError(`"${name}" is required.`);
  return v;
}

function report<T>(results: ({ ok: true; engine: string; value: T } | { ok: false; engine: string; error: string })[], ok: (v: T) => string): string {
  return results.map((r) => `${r.engine}: ${r.ok ? ok(r.value) : `error: ${r.error}`}`).join('\n');
}

function firstLine(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).split('\n')[0];
}

function truncate(s: string): string {
  return s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n… (${s.length - MAX_TEXT} more characters)` : s;
}

// ---- transports ---------------------------------------------------------------------------------

/** Streamable HTTP, stateless: each POST carries one message (or a batch) and gets JSON back. */
export async function handleMcpHttp(mcp: McpServer, req: Request): Promise<Response> {
  // Browsers send an Origin; MCP clients don't. Refuse cross-site pages (DNS rebinding).
  const origin = req.headers.get('origin');
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin)) return new Response('Forbidden origin', { status: 403 });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { allow: 'POST' } });
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, { status: 400 });
  }
  const responses = (await Promise.all((Array.isArray(body) ? body : [body]).map((m) => mcp.handle(m)))).filter((r) => r !== null);
  if (!responses.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(body) ? responses : responses[0]);
}

/** Newline-delimited JSON-RPC on stdin/stdout. Resolves when stdin closes. */
export async function serveMcpStdio(mcp: McpServer, out: (line: string) => unknown = (l) => process.stdout.write(l)): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  const write = (msg: unknown) => out(`${JSON.stringify(msg)}\n`);
  const pending = new Set<Promise<void>>();
  for await (const chunk of Bun.stdin.stream()) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      // Requests run concurrently (a slow navigate shouldn't block a ping), answered as they finish.
      const p = mcp.handle(msg).then((r) => void (r && write(r)));
      pending.add(p);
      void p.finally(() => pending.delete(p));
    }
  }
  await Promise.all(pending);
}

/** One engine's network figures for the status tool. */
function networkLine(m: NetworkMetrics): string {
  const ms = (v: number | null) => (v === null ? 'n/a' : `${v} ms`);
  const kb = m.transferred < 1024 * 1024 ? `${Math.round(m.transferred / 1024)} kB` : `${(m.transferred / 1024 / 1024).toFixed(2)} MB`;
  return `load ${ms(m.load)}, DOMContentLoaded ${ms(m.domContentLoaded)}, first byte ${ms(m.ttfb)}, ${m.requests} requests (${m.failed} failed), ${kb} transferred`;
}
