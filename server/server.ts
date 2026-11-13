import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ServerWebSocket } from 'bun';
import {
  ENGINES,
  normalizeUrl,
  type ClientMessage,
  type CompareResult,
  type DevicePreset,
  type ElementRef,
  type InputEvent,
  type LogEntry,
  type PaneId,
  type PaneInfo,
  type ServerMessage,
  sanitizeSettings,
  type Settings,
  type UpdateStatus,
  type Viewport,
} from '../shared/protocol';
// Bun's HTML import: Bun.serve bundles the Preact UI (TSX + Tailwind CSS, via the plugin in bunfig.toml) itself, with HMR in development.
import ui from '../ui/index.html';
import { devices as playwrightDevices } from 'playwright';
import { DevToolsBridge, type DevToolsSocket } from './devtools';
import { ariaDiff, visualDiff } from './engine-diff';
import { BrowsingHistory, FaviconCache } from './history';
import { handleMcpHttp, McpServer } from './mcp';
import { networkInfo, type NetworkOptions } from './proxy';
import { PaneSession } from './pane';
import { STANDALONE, STANDALONE_SCREENSHOT_DIR, STANDALONE_TRACE_DIR, VERSION } from './standalone';
import { StateFile, loadSettings, saveSettings } from './storage';
import { checkForUpdates, DEFAULT_UPDATE_SOURCES, type UpdateSources } from './updates';
import { recordingStamp, TRACE_FILE_PATH, traceViewerResponse, traceViewerUrl } from './trace-viewer';
import { WELCOME_HTML } from './welcome';

const ROOT = resolve(import.meta.dir, '..');
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024; // skip frames for a client that can't keep up
/** The Device menu: a few common phones and tablets from Playwright's device list. */
const DEVICE_NAMES = ['iPhone 15', 'iPhone 15 Pro Max', 'iPhone SE', 'Pixel 7', 'Galaxy S24', 'iPad Mini', 'iPad Pro 11', 'Galaxy Tab S9'];
export const DEVICES: DevicePreset[] = DEVICE_NAMES.flatMap((name) => {
  const d = (playwrightDevices as Record<string, (typeof playwrightDevices)[string] | undefined>)[name];
  return d
    ? [{ name, viewport: d.viewport, deviceScaleFactor: d.deviceScaleFactor, hasTouch: d.hasTouch, isMobile: d.isMobile, userAgent: d.userAgent, ...((d as { screen?: Viewport }).screen ? { screen: (d as { screen?: Viewport }).screen } : {}) }]
    : [];
});
const deviceNamed = (name: string | null | undefined) => DEVICES.find((d) => d.name === name) ?? null;

const MAX_LOG = 3000;
const FIRST_UPDATE_CHECK_MS = 5_000;
const UPDATE_CHECK_EVERY_MS = 24 * 60 * 60 * 1000; // unified log entries kept for windows that connect later
const SCROLL_FOLLOW_MS = 1500; // longest time to follow one scroll gesture (covers smooth scrolling)
const SCROLL_SETTLE_MS = 250; // the position counts as settled after this long without change

export interface ServerOptions {
  port?: number;
  /** Hot-reload the UI (Bun's HMR) and serve unminified bundles with source maps. */
  dev?: boolean;
  token?: string;
  /** First page the panes open. Defaults to the built-in welcome page. */
  startUrl?: string;
  viewport?: Viewport;
  screenshotDir?: string;
  /** Where Tools → Record trace saves traces (one folder per recording). */
  traceDir?: string;
  /**
   * Folder where each engine's cookies, localStorage and IndexedDB are saved between runs.
   * Omit for a fresh session that saves nothing (the default, and what tests use).
   */
  profileDir?: string;
  /**
   * Check for engine updates automatically (shortly after start, then daily) when the
   * autoUpdateCheck setting is on. Off by default so tests never touch the network; the app
   * turns it on. "Check now" from the UI works either way.
   */
  autoCheckUpdates?: boolean;
  /** Where update checks look (tests point this at a local fake registry). */
  updateSources?: UpdateSources;
  /** Delay before the first automatic check (default 5 s). */
  firstUpdateCheckMs?: number;
  /** Proxy and certificate handling for every engine (--proxy, --ignore-cert-errors). */
  network?: NetworkOptions;
  /** Called whenever settings change (and once at start), e.g. to theme the app window. */
  onSettings?: (settings: Settings) => void;
}

export interface TriPaneServer {
  /** Address of the UI, including the access token. */
  appUrl: string;
  /** The MCP endpoint (Streamable HTTP), including the access token. */
  mcpUrl: string;
  /** The MCP server, for the stdio transport (`tripane mcp`). */
  mcp: McpServer;
  origin: string;
  token: string;
  panes: PaneSession[];
  /** Resolves once every engine has launched (or failed to). */
  ready: Promise<void>;
  /** Current settings (read-only; change them through the UI protocol). */
  readonly settings: Readonly<Settings>;
  close(): Promise<void>;
}

type SocketData = { kind: 'ui' } | DevToolsSocket;
type Client = ServerWebSocket<SocketData>;

export async function startServer(opts: ServerOptions = {}): Promise<TriPaneServer> {
  const token = opts.token ?? Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url');
  const screenshotDir = resolve(opts.screenshotDir ?? (STANDALONE ? STANDALONE_SCREENSHOT_DIR : join(ROOT, 'screenshots')));
  const traceDir = resolve(opts.traceDir ?? (STANDALONE ? STANDALONE_TRACE_DIR : join(ROOT, 'traces')));
  const storageDir = opts.profileDir ? resolve(opts.profileDir) : null;
  const settings: Settings = await loadSettings(storageDir);
  opts.onSettings?.({ ...settings });
  const clients = new Set<Client>();
  const history = new BrowsingHistory(storageDir);
  const favicons = new FaviconCache();
  await history.load();
  let log: LogEntry[] = [];
  let nextLogId = 1;
  /** The trace being recorded (Tools → Record trace). */
  let tracing: { startedAt: number; saving: boolean; stamp: string; dir: string } | null = null;

  // ---- HTTP + WebSocket: one Bun.serve ----------------------------------------------------

  // Chrome DevTools: its frontend is proxied from the Chromium pane, and each pane gets a CDP
  // endpoint (straight through for Chromium, translated for Firefox and WebKit).
  const devtools = new DevToolsBridge(() => panes);

  const server = Bun.serve<SocketData>({
    hostname: '127.0.0.1',
    port: opts.port ?? 0,
    development: opts.dev ? { hmr: true, console: true } : false,
    routes: {
      '/': ui,
      '/welcome': new Response(WELCOME_HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } }),
    },
    fetch(req, srv) {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/devtools/')) return devtools.frontend(url);
      // /cdp/<token>/<paneId>: the token is in the path because DevTools' ?ws= parameter can't carry a query.
      const cdp = url.pathname.match(/^\/cdp\/([^/]+)\/([012])$/);
      if (cdp) {
        if (!tokenMatches(cdp[1], token)) return new Response('Unauthorized', { status: 401 });
        if (srv.upgrade(req, { data: { kind: 'cdp', paneId: Number(cdp[2]) as PaneId } })) return undefined;
        return new Response('Expected a WebSocket upgrade', { status: 426 });
      }
      // Playwright's Trace Viewer (static files), and the traces it opens (these need the token).
      if (url.pathname === '/trace' || url.pathname.startsWith('/trace/')) return traceViewerResponse(url.pathname.slice('/trace'.length));
      const traceFile = url.pathname.match(TRACE_FILE_PATH);
      if (traceFile) {
        if (!tokenMatches(url.searchParams.get('token'), token)) return new Response('Unauthorized', { status: 401 });
        const file = Bun.file(join(traceDir, traceFile[1], traceFile[2]));
        return file.exists().then((ok) => (ok ? new Response(file, { headers: { 'content-type': 'application/zip' } }) : new Response('Not found', { status: 404 })));
      }
      if (url.pathname === '/favicon') {
        if (!tokenMatches(url.searchParams.get('token'), token)) return new Response('Unauthorized', { status: 401 });
        return favicons.get(url.searchParams.get('u') ?? '');
      }
      if (url.pathname === '/mcp') {
        const bearer = req.headers.get('authorization')?.match(/^Bearer\s+(.+)$/i)?.[1] ?? null;
        if (!tokenMatches(bearer ?? url.searchParams.get('token'), token)) return new Response('Unauthorized', { status: 401 });
        return handleMcpHttp(mcp, req);
      }
      if (url.pathname !== '/ws') return new Response('Not found', { status: 404 });
      if (!tokenMatches(url.searchParams.get('token'), token)) return new Response('Unauthorized', { status: 401 });
      if (srv.upgrade(req, { data: { kind: 'ui' } })) return undefined;
      return new Response('Expected a WebSocket upgrade', { status: 426 });
    },
    websocket: {
      maxPayloadLength: 16 * 1024 * 1024, // DevTools can send large messages (e.g. setOuterHTML)
      perMessageDeflate: false, // frames are JPEG already
      open(ws) {
        if (ws.data.kind === 'cdp') devtools.open(ws as ServerWebSocket<DevToolsSocket>);
        else onClient(ws);
      },
      close(ws) {
        if (ws.data.kind === 'cdp') devtools.close(ws as ServerWebSocket<DevToolsSocket>);
        else clients.delete(ws);
      },
      message(ws, data) {
        if (ws.data.kind === 'cdp') {
          devtools.message(ws as ServerWebSocket<DevToolsSocket>, data);
          return;
        }
        if (typeof data !== 'string') return;
        let msg: ClientMessage;
        try {
          msg = JSON.parse(data);
        } catch {
          return;
        }
        if (msg.type === 'ping') return send(ws, { type: 'pong', t: Number(msg.t) });
        handle(msg).catch((err) => send(ws, { type: 'error', message: String(err?.message ?? err) }));
      },
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;

  function send(ws: Client, msg: ServerMessage): void {
    ws.send(JSON.stringify(msg));
  }
  function broadcast(msg: ServerMessage): void {
    const text = JSON.stringify(msg);
    for (const ws of clients) ws.send(text);
  }
  function sendFrame(ws: Client, id: PaneId, jpeg: Buffer): void {
    if (ws.getBufferedAmount() > MAX_BUFFERED_BYTES) return;
    ws.send(Buffer.concat([Buffer.from([id]), jpeg]));
  }

  function onClient(ws: Client): void {
    clients.add(ws);
    send(ws, { type: 'hello', panes: panes.map((p) => ({ ...p.info })), settings, log, storageDir, devices: DEVICES, updates, checkingUpdates, history: history.all(), version: VERSION, network: networkInfo(opts.network), tracing: tracing && { startedAt: tracing.startedAt, saving: tracing.saving } });
    for (const p of panes) if (p.lastFrame) sendFrame(ws, p.id, p.lastFrame);
  }

  // ---- panes ---------------------------------------------------------------------------------

  const followTimers = new Map<PaneId, NodeJS.Timeout>();
  const panes: PaneSession[] = ENGINES.map(
    (engine, i) =>
      new PaneSession(i as PaneId, engine, {
        info: (pane) => {
          broadcast({ type: 'pane', pane });
          recordHistory(pane);
        },
        pageReplaced: (id) => devtools.retrack(panes[id]),
        log: (partial) => {
          const entry: LogEntry = { id: nextLogId++, ...partial };
          log.push(entry);
          if (log.length > MAX_LOG) log = log.slice(-MAX_LOG);
          broadcast({ type: 'log', entry });
        },
        frame: (id, jpeg) => {
          for (const ws of clients) sendFrame(ws, id, jpeg);
        },
        userNavigation: (id, url) => {
          // Link follow: once a pane settles on a page it reached by itself, bring the others along.
          // Debounced so the redirect chain and synced clicks in the other panes can finish first.
          if (!settings.linkFollow || url === 'about:blank') return;
          clearTimeout(followTimers.get(id));
          followTimers.set(
            id,
            setTimeout(() => {
              followTimers.delete(id);
              const leader = panes[id];
              if (leader.info.url !== url) return;
              for (const p of panes) if (p !== leader && p.ready && !sameDocument(p.info.url, url)) void p.goto(url);
            }, 600),
          );
        },
      }, opts.network),
  );

  // ---- browsing history ------------------------------------------------------------------------

  const lastUrl = new Map<PaneId, string>();
  /** Each URL a pane arrives at is a visit; its title is filled in once the page has loaded. */
  function recordHistory(pane: PaneInfo): void {
    if (pane.disabled || pane.failed || !pane.url || pane.url.startsWith(`${origin}/`)) return;
    if (lastUrl.get(pane.id) !== pane.url) {
      lastUrl.set(pane.id, pane.url);
      const entry = history.visit(pane.url);
      if (entry) broadcast({ type: 'historyEntry', entry });
    }
    // While loading, some engines report a placeholder title ("Loading …").
    if (!pane.loading && pane.title) {
      const entry = history.setTitle(pane.url, pane.title);
      if (entry) broadcast({ type: 'historyEntry', entry });
    }
    if (!pane.loading && pane.icon) {
      const entry = history.setIcon(pane.url, pane.icon);
      if (entry) broadcast({ type: 'historyEntry', entry });
    }
  }

  /** The device a pane emulates: its own in "Per engine" mode, else the shared one. */
  function deviceFor(p: PaneSession): string | null {
    return settings.sizePerEngine ? settings.engineDevice[p.engine] : settings.device;
  }

  /** True when another running pane has a different size or device than this one. */
  function sizesDiffer(source: PaneSession): boolean {
    const v = source.info.viewport;
    return panes.some((p) => p !== source && p.ready && (p.info.device !== source.info.device || p.info.viewport.width !== v.width || p.info.viewport.height !== v.height));
  }

  /**
   * Synced mouse input between panes of different sizes: the same x,y would land on different
   * things, so presses, releases and drags go to the same spot of the same element in each
   * engine. Plain hovering stays in the pane under the pointer.
   */
  const pressed = new Set<PaneId>();
  async function replayMapped(source: PaneSession, ev: Extract<InputEvent, { kind: 'mouse' }>): Promise<void> {
    if (ev.action === 'move' && !pressed.has(source.id)) return source.input(ev);
    if (ev.action === 'down') pressed.add(source.id);
    if (ev.action === 'up') pressed.delete(source.id);
    const others = panes.filter((p) => p !== source && p.ready && !p.info.disabled);
    const at = await source.pointRef(ev.x, ev.y);
    const points = at ? await Promise.all(others.map((p) => p.pointFor(at))) : others.map(() => null);
    await Promise.all([source.input(ev), ...others.map((p, i) => (points[i] ? p.input({ ...ev, x: points[i]!.x, y: points[i]!.y }) : undefined))]);
  }

  const startUrl = opts.startUrl ?? `${origin}/welcome`;
  const viewport = opts.viewport ?? { width: 1280, height: 800 };
  const stateFileFor = (p: PaneSession) => (storageDir ? new StateFile(join(storageDir, `${p.engine}.json`)) : undefined);
  const ready = Promise.all(
    panes.map(async (p) => {
      // Engines turned off in Settings → Engines aren't launched at all.
      if (!settings.engines[p.engine]) return p.markDisabled();
      await p.setFrameFormat(settings.frameFormat[p.engine]);
      await p.start(viewport, settings.colorScheme, stateFileFor(p), deviceNamed(deviceFor(p)));
      if (p.ready) devtools.track(p);
      if (p.ready) await p.goto(startUrl);
    }),
  ).then(() => {});

  /**
   * Applies Settings → Engines: turns engines off (saving their storage) or back on. An engine
   * that comes back opens the page the others show, at their scroll position.
   */
  async function applyEngines(): Promise<void> {
    await Promise.all(
      panes.map(async (p) => {
        const on = settings.engines[p.engine];
        if (!on && !p.info.disabled) {
          await p.disable();
          await clearHighlight();
          return;
        }
        if (on && p.info.disabled) {
          const reference = panes.find((o) => o !== p && o.ready);
          await p.setFrameFormat(settings.frameFormat[p.engine]);
          await p.enable(reference?.info.viewport ?? p.info.viewport, settings.colorScheme, stateFileFor(p), deviceNamed(deviceFor(p)));
          if (!p.ready) return;
          devtools.track(p);
          await p.goto(reference?.info.url || startUrl);
          await p.waitForLoad();
          const frac = settings.scrollSync ? await reference?.getScroll() : null;
          if (frac) await p.setScroll(frac);
        }
      }),
    );
  }

  let scrollSyncBusy = false;
  let scrollSyncAgain: PaneSession | null = null;
  async function syncScrollFrom(source: PaneSession): Promise<void> {
    if (scrollSyncBusy) {
      scrollSyncAgain = source;
      return;
    }
    scrollSyncBusy = true;
    try {
      let from: PaneSession | null = source;
      while (from) {
        scrollSyncAgain = null;
        // Chromium and WebKit apply wheel scrolling a frame or two after mouse.wheel() returns,
        // so follow the source until its position stops changing.
        const leader: PaneSession = from;
        const started = Date.now();
        let last = '';
        let stableSince = started;
        while (!scrollSyncAgain && Date.now() - started < SCROLL_FOLLOW_MS) {
          const frac = await leader.getScroll();
          const key = frac ? `${frac.x},${frac.y}` : '';
          if (frac && key !== last) {
            last = key;
            stableSince = Date.now();
            await Promise.all(panes.filter((p) => p !== leader).map((p) => p.setScroll(frac)));
          } else if (Date.now() - stableSince > SCROLL_SETTLE_MS) {
            break;
          }
          await new Promise((r) => setTimeout(r, 30));
        }
        from = scrollSyncAgain;
      }
    } finally {
      scrollSyncBusy = false;
    }
  }

  // ---- synced element highlight ---------------------------------------------------------------
  // The latest pointer position wins; while one lookup runs, newer moves just replace the target.

  let hoverWanted: { source: PaneSession; x: number; y: number; generation: number } | null = null;
  let hoverBusy = false;
  let hoverGeneration = 0;
  let shownRef = ''; // JSON of the ref currently outlined, '' for none
  let painting: Promise<unknown> = Promise.resolve();

  /** All outline drawing goes through one queue, so a later clear can't be overtaken by an earlier draw. */
  function paint(ref: ElementRef | null): Promise<unknown> {
    painting = painting.then(() => Promise.all(panes.map((p) => p.highlight(ref)))).catch(() => {});
    return painting;
  }

  /**
   * `generation` is taken when the message arrived. Messages are handled concurrently, so a
   * pointer-leave (which bumps the generation) can be processed before an earlier move gets
   * here; such a stale move must not bring the outline back.
   */
  /**
   * Reloads one engine and brings it back in step with the others, which aren't touched: with
   * Follow links on, it goes to the URL they show if it had drifted; with Sync scroll on, it
   * takes their scroll position once loaded. Both are programmatic navigations, so Follow links
   * doesn't send the other engines anywhere.
   */
  async function reloadAndResync(pane: PaneSession): Promise<void> {
    const reference = panes.find((p) => p !== pane && !p.info.failed && p.playwrightPage);
    const target = settings.linkFollow ? reference?.info.url : undefined;
    if (target && target !== pane.info.url) await pane.goto(target);
    else await pane.history('reload');
    await pane.waitForLoad();
    if (settings.scrollSync && reference) {
      // Twice: late layout (images, fonts) can still change the page height after load.
      for (const wait of [0, 400]) {
        await Bun.sleep(wait);
        const frac = await reference.getScroll();
        if (frac) await pane.setScroll(frac);
      }
    }
    if (settings.highlight) await refreshHighlight();
  }

  async function hoverAt(source: PaneSession, x: number, y: number, generation: number): Promise<void> {
    if (generation !== hoverGeneration) return;
    hoverWanted = { source, x, y, generation };
    if (hoverBusy) return;
    hoverBusy = true;
    try {
      while (hoverWanted) {
        const { source: from, x: hx, y: hy, generation } = hoverWanted;
        hoverWanted = null;
        if (generation !== hoverGeneration) continue;
        const hit = await from.refAt(hx, hy);
        const key = hit ? JSON.stringify(hit.ref) : '';
        if (key === shownRef || generation !== hoverGeneration) continue;
        shownRef = key;
        await paint(hit?.ref ?? null);
      }
    } finally {
      hoverBusy = false;
    }
  }

  async function clearHighlight(): Promise<void> {
    hoverGeneration++;
    hoverWanted = null;
    shownRef = '';
    await paint(null);
  }

  /** Redraws the current outline in every pane (after scrolling moved the element). */
  async function refreshHighlight(): Promise<void> {
    if (!shownRef) return;
    await paint(JSON.parse(shownRef) as ElementRef);
  }

  async function compare(ref: ElementRef, source: PaneId | null): Promise<CompareResult> {
    const engines = await Promise.all(
      panes.filter((p) => !p.info.disabled).map(async (p) => ({ paneId: p.id, engine: p.engine, ...(p.ready ? await p.snapshot(ref) : { found: false, label: '' }) })),
    );
    return { ref, source, at: Date.now(), engines };
  }

  /** Compare, shown in the UI's Compare tab, with the element kept outlined in every engine. */
  async function compareAndShow(ref: ElementRef, source: PaneId | null): Promise<CompareResult> {
    const result = await compare(ref, source);
    broadcast({ type: 'compare', result });
    hoverGeneration++;
    shownRef = JSON.stringify(ref);
    await paint(ref);
    return result;
  }

  // ---- engine update checks ------------------------------------------------------------------

  let updates: UpdateStatus | null = null;
  let checkingUpdates = false;
  let notifiedFor = ''; // the Playwright version we already told the user about

  async function runUpdateCheck(automatic: boolean): Promise<void> {
    if (checkingUpdates) return;
    checkingUpdates = true;
    broadcast({ type: 'updates', status: updates, checking: true });
    try {
      updates = await checkForUpdates(opts.updateSources ?? DEFAULT_UPDATE_SOURCES);
      const newer = updates.engines.filter((e) => e.update);
      if (automatic && newer.length && updates.playwright.latest !== notifiedFor) {
        notifiedFor = updates.playwright.latest ?? '';
        const label = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' } as const;
        broadcast({
          type: 'notice',
          message: `Engine updates available: ${newer.map((e) => `${label[e.engine]} ${e.latest}`).join(', ')}. See Settings → Engine updates.`,
        });
      }
    } finally {
      checkingUpdates = false;
      broadcast({ type: 'updates', status: updates, checking: false });
    }
  }

  const updateTimers: ReturnType<typeof setTimeout>[] = [];
  let closed = false;
  if (opts.autoCheckUpdates) {
    const auto = () => void (settings.autoUpdateCheck && runUpdateCheck(true));
    // Counted from when the engines are up, so the UI is connected to hear about it.
    void ready.then(() => {
      if (closed) return;
      updateTimers.push(setTimeout(auto, opts.firstUpdateCheckMs ?? FIRST_UPDATE_CHECK_MS), setInterval(auto, UPDATE_CHECK_EVERY_MS));
    });
  }

  function targets(target: 'all' | PaneId): PaneSession[] {
    return target === 'all' ? panes : panes.filter((p) => p.id === target);
  }

  async function handle(msg: ClientMessage): Promise<void> {
    const generation = hoverGeneration; // see hoverAt()
    switch (msg.type) {
      case 'navigate': {
        const url = normalizeUrl(String(msg.url));
        await Promise.all(panes.map((p) => p.goto(url)));
        return;
      }
      case 'history':
        if (!['back', 'forward', 'reload'].includes(msg.action)) return;
        await Promise.all(panes.map((p) => p.history(msg.action)));
        return;
      case 'reloadPane': {
        const pane = panes[msg.target];
        if (!pane || pane.info.failed) return;
        await reloadAndResync(pane);
        return;
      }
      case 'input': {
        const source = panes[msg.source];
        if (!source) return;
        const ev = msg.event;
        if (ev.kind === 'wheel' && settings.scrollSync) {
          await source.input(ev);
          await syncScrollFrom(source);
          if (settings.highlight) await refreshHighlight();
          return;
        }
        // While DevTools' element picker is on in this pane, the click is a pick, not page input.
        const syncInput = settings.sync && !devtools.inspecting.has(source.id);
        if (syncInput && ev.kind === 'mouse' && sizesDiffer(source)) {
          await replayMapped(source, ev);
          if (settings.highlight && ev.action === 'move') void hoverAt(source, ev.x, ev.y, generation);
          return;
        }
        await Promise.all((syncInput ? panes : [source]).map((p) => p.input(ev)));
        if (settings.highlight && ev.kind === 'mouse' && ev.action === 'move') void hoverAt(source, ev.x, ev.y, generation);
        if (settings.highlight && ev.kind === 'wheel') await refreshHighlight();
        return;
      }
      case 'probe': {
        const source = panes[msg.source];
        if (source) void hoverAt(source, Number(msg.x), Number(msg.y), generation);
        return;
      }
      case 'probeEnd':
        await clearHighlight();
        return;
      case 'compare': {
        let ref = msg.ref;
        let source: PaneId | null = null;
        if (!ref) {
          const pane = msg.source !== undefined ? panes[msg.source] : undefined;
          const hit = pane ? await pane.refAt(Number(msg.x), Number(msg.y)) : null;
          if (!hit) throw new Error('There is no element at that point to compare.');
          ref = hit.ref;
          source = pane!.id;
        }
        await compareAndShow(ref, source);
        return;
      }
      case 'viewport': {
        const { width, height } = msg.viewport;
        const vp = { width: clampInt(width, 200, 3840), height: clampInt(height, 200, 2400) };
        await Promise.all(targets(msg.target).map((p) => p.setViewport(vp)));
        return;
      }
      case 'settings': {
        const patch = sanitizeSettings(msg.settings);
        if (patch.device !== undefined && patch.device !== null && !deviceNamed(patch.device)) delete patch.device;
        if (patch.engineDevice) {
          const merged = { ...settings.engineDevice, ...patch.engineDevice };
          for (const e of ENGINES) if (!deviceNamed(merged[e])) merged[e] = null;
          patch.engineDevice = merged;
        }
        if (patch.devtoolsDock) patch.devtoolsDock = { ...settings.devtoolsDock, ...patch.devtoolsDock };
        // Switching to "Per engine" starts every engine on the shared device; switching back, all
        // engines take the first running engine's device and size.
        const lead = panes.find((p) => p.ready && !p.info.disabled);
        let unifyTo: Viewport | null = null;
        if (patch.sizePerEngine === true && !settings.sizePerEngine && !patch.engineDevice) {
          patch.engineDevice = { chromium: settings.device, firefox: settings.device, webkit: settings.device };
        }
        if (patch.sizePerEngine === false && settings.sizePerEngine) {
          if (patch.device === undefined) patch.device = lead ? settings.engineDevice[lead.engine] : null;
          if (lead && !patch.device) unifyTo = lead.info.device ? lead.desktopSize : { ...lead.info.viewport };
        }
        const devicesBefore = panes.map(deviceFor);
        const enginesChanged = patch.engines !== undefined && ENGINES.some((e) => patch.engines![e] !== settings.engines[e]);
        const schemeChanged = patch.colorScheme !== undefined && patch.colorScheme !== settings.colorScheme;
        Object.assign(settings, patch);
        if (schemeChanged) await Promise.all(panes.map((p) => p.setColorScheme(settings.colorScheme)));
        if (patch.highlight === false) await clearHighlight();
        const devicesAfter = panes.map(deviceFor);
        const changed = panes.filter((p, i) => devicesAfter[i] !== devicesBefore[i]);
        if (changed.length) {
          await clearHighlight();
          await Promise.all(changed.map((p) => p.setDevice(deviceNamed(deviceFor(p)))));
        }
        if (unifyTo) {
          const vp = unifyTo;
          await Promise.all(panes.filter((p) => p.ready && (p.info.viewport.width !== vp.width || p.info.viewport.height !== vp.height)).map((p) => p.setViewport(vp)));
        }
        broadcast({ type: 'settings', settings });
        opts.onSettings?.({ ...settings });
        if (enginesChanged) await applyEngines();
        if (patch.frameFormat) await Promise.all(panes.map((p) => p.setFrameFormat(settings.frameFormat[p.engine])));
        await saveSettings(storageDir, settings).catch(() => {});
        return;
      }
      case 'clearStorage':
        await Promise.all(panes.map((p) => p.clearStorage()));
        broadcast({
          type: 'notice',
          message: storageDir
            ? `Cleared cookies and site storage for all three engines, and deleted the saved data in ${storageDir}.`
            : 'Cleared cookies and site storage for all three engines.',
        });
        return;
      case 'siteInfo':
      case 'clearSiteData': {
        if (msg.type === 'clearSiteData') broadcast({ type: 'notice', message: await forgetSite(msg.origin) });
        const on = panes.filter((p) => p.ready);
        const engines = (await Promise.all(on.map((p) => p.siteInfo()))).filter((e): e is NonNullable<typeof e> => !!e);
        let origin = '';
        try {
          origin = engines[0] ? new URL(engines[0].url).origin : '';
        } catch {
          // about:blank
        }
        broadcast({ type: 'siteInfo', info: { origin, engines } });
        return;
      }
      case 'checkUpdates':
        await runUpdateCheck(false);
        return;
      case 'ping':
        // Answered on the asking socket only; see the message handler.
        return;
      case 'visualDiff': {
        await clearHighlight(); // keep outlines out of the screenshots
        const result = await visualDiff(panes, { reference: msg.reference, fullPage: msg.fullPage, threshold: msg.threshold });
        broadcast({ type: 'visualDiff', result });
        return;
      }
      case 'ariaDiff':
        broadcast({ type: 'ariaDiff', result: await ariaDiff(panes, { reference: msg.reference, selector: msg.selector }) });
        return;
      case 'removeHistory': {
        const removed = history.remove(Array.isArray(msg.urls) ? msg.urls.map(String) : []);
        if (removed.length) broadcast({ type: 'historyRemoved', urls: removed });
        return;
      }
      case 'clearHistory':
        await history.clear();
        broadcast({ type: 'historyRemoved', urls: 'all' });
        return;
      case 'clearLog':
        log = [];
        broadcast({ type: 'logCleared' });
        return;
      case 'trace':
        if (msg.action === 'start') await startTrace();
        else await stopTrace();
        return;
      case 'screenshot': {
        await clearHighlight(); // keep outlines out of the screenshots
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const dir = join(screenshotDir, stamp);
        await mkdir(dir, { recursive: true });
        const results = await Promise.all(
          panes.map(async (p) => {
            const file = join(dir, `${p.engine}.png`);
            return (await p.screenshot(file)) ? file : null;
          }),
        );
        broadcast({ type: 'screenshots', dir, files: results.filter((f): f is string => !!f) });
        return;
      }
    }
  }

  // ---- tracing (Tools → Record trace) ---------------------------------------------------------

  const TRACE_TITLE = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' } as const;

  async function startTrace(): Promise<void> {
    if (tracing) return;
    let stamp = recordingStamp();
    // Two recordings within a second get their own folders.
    for (let n = 2; existsSync(join(traceDir, stamp)); n++) stamp = `${recordingStamp()}-${n}`;
    const dir = join(traceDir, stamp);
    await mkdir(dir, { recursive: true });
    tracing = { startedAt: Date.now(), saving: false, stamp, dir };
    broadcast({ type: 'tracing', tracing: { startedAt: tracing.startedAt, saving: false } });
    await Promise.all(panes.map((p) => p.startTrace(dir, `TriPane: ${TRACE_TITLE[p.engine]}`)));
  }

  /** Stops recording and tells the UI where the traces are, with a Trace Viewer link for each. */
  async function stopTrace(): Promise<void> {
    if (!tracing || tracing.saving) return;
    const t = tracing;
    t.saving = true;
    broadcast({ type: 'tracing', tracing: { startedAt: t.startedAt, saving: true } });
    const saved = await Promise.all(panes.map(async (p) => ({ engine: p.engine, files: await p.stopTrace() })));
    tracing = null;
    broadcast({ type: 'tracing', tracing: null });
    broadcast({
      type: 'traces',
      dir: t.dir,
      traces: saved
        .filter((s) => s.files.length)
        .map((s) => {
          const names = s.files.map((f) => f.split(/[\\/]/).pop()!);
          return { engine: s.engine, files: s.files, viewer: traceViewerUrl(origin, token, t.stamp, names) };
        }),
    });
  }

  // MCP: an AI agent drives the engines through the same paths as the UI.
  /**
   * Clears one site's cookies and storage in every engine: live in the running ones (wherever
   * their page is), and from the saved data of engines that are off. `origin` defaults to the
   * site the first running engine shows. Returns a sentence saying what was done.
   */
  async function forgetSite(origin?: string): Promise<string> {
    let site = '';
    try {
      const u = new URL(origin || panes.find((p) => p.ready && !p.info.disabled)?.info.url || '');
      if (u.protocol === 'http:' || u.protocol === 'https:') site = u.origin;
    } catch {
      // not a URL
    }
    if (!site) return 'There is no web site open to clear data for.';
    const live: string[] = [];
    const saved: string[] = [];
    await Promise.all(
      panes.map(async (p) => {
        if (p.ready && !p.info.disabled) {
          await p.forgetSite(site);
          live.push(p.engine);
        } else if ((await stateFileFor(p)?.forgetSite(site).catch(() => false)) === true) {
          saved.push(p.engine);
        }
      }),
    );
    const names = (list: string[]) => {
      const labels = ENGINES.filter((e) => list.includes(e)).map((e) => ({ chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' })[e]);
      return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} and ${labels.at(-1)}` : (labels[0] ?? '');
    };
    const host = new URL(site).host;
    const parts = [live.length && `in ${names(live)}`, saved.length && `from the saved data of ${names(saved)} (off)`].filter(Boolean);
    return parts.length ? `Cleared ${host}'s cookies and site data ${parts.join(', and ')}.` : `No engine is running, and none had saved data for ${host}.`;
  }

  const mcp = new McpServer({
    panes,
    settings,
    devices: DEVICES,
    run: handle,
    log: () => log,
    compare: (ref) => compareAndShow(ref, null),
    visualDiff: async (o) => {
      await clearHighlight();
      return visualDiff(panes, o);
    },
    ariaDiff: (o) => ariaDiff(panes, o),
    forgetSite,
    version: VERSION,
    ready,
  });

  return {
    appUrl: `${origin}/?token=${token}`,
    mcpUrl: `${origin}/mcp?token=${token}`,
    mcp,
    settings,
    origin,
    token,
    panes,
    ready,
    async close() {
      if (closed) return;
      closed = true;
      for (const t of followTimers.values()) clearTimeout(t);
      for (const t of updateTimers) clearTimeout(t);
      devtools.closeAll();
      await Promise.all(panes.map((p) => p.close()));
      await history.flush();
      await server.stop(true);
    },
  };
}

function tokenMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function clampInt(n: unknown, min: number, max: number): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : min;
}

/** True when two URLs differ only by hash, so following would not load anything new. */
function sameDocument(a: string, b: string): boolean {
  return a.split('#')[0] === b.split('#')[0];
}
