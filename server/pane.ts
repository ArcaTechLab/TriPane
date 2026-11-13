import { join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import type { Browser, BrowserContext, BrowserContextOptions, BrowserType, CDPSession, LaunchOptions, Page } from 'playwright';
import type { ConsoleMessage } from 'playwright';
import { DEFAULT_FRAME_FORMAT, type SiteInfoEngine, type DevicePreset, type EngineName, type FrameFormat, type InputEvent, type LogEntry, type PaneId, type PaneInfo, type Settings, type Viewport } from '../shared/protocol';
import { formatConsoleArgs } from './console-format';
import { drawHighlight, pointFor, pointRef, refAtPoint, refForSelector, resolveElement, snapshotElement, type ElementRef, type ElementSnapshot } from './element-ref';
import type { NetworkOptions } from './proxy';
import { measurePerformance, type PerformanceStats } from './perf';
import { quietly } from './quiet';
import { cookieForHost, type StateFile } from './storage';

const SAVE_STATE_MS = 30_000;
/** Chromium's own DevTools highlight colours (margin, border, padding, content). */
const CHROMIUM_HIGHLIGHT = {
  showInfo: true,
  showAccessibilityInfo: false,
  contentColor: { r: 111, g: 168, b: 220, a: 0.66 },
  paddingColor: { r: 147, g: 196, b: 125, a: 0.55 },
  borderColor: { r: 255, g: 229, b: 153, a: 0.66 },
  marginColor: { r: 246, g: 178, b: 107, a: 0.66 },
};
/**
 * TriPane handles Ctrl+C itself (saving each engine's storage before closing it); Playwright's
 * own signal handlers would close the browsers first and lose that state.
 */
const LEAVE_SIGNALS_TO_TRIPANE = { handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false };

const BROWSER_TYPES: Record<EngineName, BrowserType> = { chromium, firefox, webkit };

/**
 * Turns off "Backspace (Shift+Backspace) goes back (forward)" in every engine. Playwright's
 * WebKit still does it on Windows and macOS (Safari switches it off; Chrome and Firefox dropped
 * it). It fires when the key reaches a page whose focus isn't in a text field, which happens when
 * a synced click lands differently in one engine; Follow links then took all three panes back.
 *
 * Only the browser's own default action is stopped, and only when the key isn't going to an
 * editable element and the page hasn't handled it: typing and page shortcuts are unaffected.
 * Listening on window in the bubble phase means page handlers run first.
 */
const NO_BACKSPACE_NAVIGATION = `(() => {
  const editable = (el) => {
    if (!el || !(el instanceof Element)) return false;
    if (el.isContentEditable) return true;
    if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
    if (el instanceof HTMLInputElement) return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(el.type);
    return false;
  };
  addEventListener('keydown', (e) => {
    if (e.key !== 'Backspace' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (editable(e.composedPath()[0])) return;
    e.preventDefault();
  });
})();`;

const JPEG_QUALITY = 70;

const ACTIVE_FRAME_MS = 66; // ~15 fps while something is happening
const IDLE_FRAME_MS = 250; // ~4 fps when the page looks static
const IDLE_AFTER_MS = 2000;

export interface PaneListener {
  info(pane: PaneInfo): void;
  frame(id: PaneId, jpeg: Buffer): void;
  /** A main-frame navigation the server did not start (link click, form post, JS redirect). */
  userNavigation(id: PaneId, url: string): void;
  /** Console output, errors and navigations for the unified log (the server assigns ids). */
  log(entry: Omit<LogEntry, 'id'>): void;
  /** The page was replaced (new device emulation): DevTools must re-attach to the new one. */
  pageReplaced(id: PaneId): void;
}

/**
 * One engine: a headless browser with a single page, streamed as JPEG frames.
 *
 * Chromium streams through the CDP screencast (frames are pushed when the page repaints).
 * Firefox and WebKit have no screencast API, so they poll page.screenshot(), faster while the
 * page is changing or being used and slower when it is idle.
 */
export class PaneSession {
  readonly info: PaneInfo;
  lastFrame: Buffer | null = null;

  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  private cdp?: CDPSession;
  private running = false;
  private programmaticNavs = 0;
  private lastActivity = Date.now();
  private wake?: () => void;
  private inputQueue: Promise<void> = Promise.resolve();
  private queuedInputs = 0;
  /** Log entries are formatted asynchronously; this chain keeps them in the order they happened. */
  private logChain: Promise<void> = Promise.resolve();
  private newDocumentPending = false;
  private stateFile?: StateFile;
  private saveTimer?: ReturnType<typeof setInterval>;
  /**
   * After "Clear saved data", storage from sites visited earlier this session is still in the
   * running browser; only sites visited since the clear are saved again.
   */
  private originsSinceClear?: Set<string>;
  /** Set while forgetSite opens its hidden helper page, so that page isn't adopted as a popup. */
  private openingHelperPage = false;
  private overlayReady = false;
  private colorScheme: Settings['colorScheme'] = 'light';
  private device: DevicePreset | null = null;
  /** The viewport before a device was chosen, restored when going back to desktop. */
  private desktopViewport?: Viewport;
  /**
   * A trace being recorded (Tools → Record trace): where it goes, and the files saved so far. A
   * trace belongs to a browser context, so replacing the context (device emulation, turning the
   * engine off) saves a part and the next context records the rest.
   */
  private trace?: { dir: string; title: string; parts: string[] };
  /** The context that is recording, if any. */
  private tracingContext?: BrowserContext;

  /**
   * Chromium only: the browser's remote-debugging port and this page's target id. Chrome DevTools
   * connects here directly, and the port also serves the DevTools frontend itself.
   */
  devtools?: { port: number; targetId: string };

  constructor(
    id: PaneId,
    readonly engine: EngineName,
    private readonly listener: PaneListener,
    private readonly network: NetworkOptions = {},
  ) {
    this.info = {
      id,
      engine,
      version: '',
      url: '',
      title: '',
      loading: true,
      viewport: { width: 1280, height: 800 },
      errors: 0,
      generation: 0,
      device: null,
    };
  }

  /** The size this pane goes back to when it leaves device emulation. */
  get desktopSize(): Viewport {
    return { ...(this.device ? (this.desktopViewport ?? this.info.viewport) : this.info.viewport) };
  }

  get id(): PaneId {
    return this.info.id;
  }

  get ready(): boolean {
    return !!this.page && this.running;
  }

  async start(
    viewport: Viewport,
    colorScheme: Settings['colorScheme'],
    stateFile?: StateFile,
    device: DevicePreset | null = null,
  ): Promise<void> {
    this.info.viewport = viewport;
    this.stateFile = stateFile;
    this.colorScheme = colorScheme;
    this.applyDevice(device);
    try {
      if (this.engine === 'chromium') {
        // The full Chromium build (not headless-shell) bundles the DevTools frontend.
        const port = await freePort();
        this.browser = await chromium.launch({
          ...LEAVE_SIGNALS_TO_TRIPANE,
          ...this.launchNetwork(),
          headless: true,
          channel: 'chromium',
          args: [`--remote-debugging-port=${port}`, '--remote-debugging-address=127.0.0.1'],
        });
        this.devtools = { port, targetId: '' };
      } else {
        this.browser = await BROWSER_TYPES[this.engine].launch({ ...LEAVE_SIGNALS_TO_TRIPANE, ...this.launchNetwork(), headless: true });
      }
      this.info.version = this.browser.version();
      const { context, page } = await this.createPage(await stateFile?.load());
      this.context = context;
      this.page = page;
    } catch (err) {
      this.info.failed = firstLines(err, 4);
      this.info.loading = false;
      this.emitInfo();
      await this.browser?.close().catch(() => {});
      this.browser = undefined;
      return;
    }
    this.running = true;
    if (stateFile) this.saveTimer = setInterval(() => void this.saveState(), SAVE_STATE_MS);
    this.wirePage(this.context, this.page);
    await this.traceContext();
    this.info.loading = false;
    const format = this.resolvedFormat();
    this.info.capture =
      this.engine === 'chromium'
        ? { method: 'screencast', format, quality: format === 'jpeg' ? JPEG_QUALITY : null, intervalMs: null }
        : { method: 'screenshot', format, quality: format === 'jpeg' ? JPEG_QUALITY : null, intervalMs: ACTIVE_FRAME_MS };
    this.emitInfo();

    if (this.engine === 'chromium') await this.startScreencast();
    else void this.pollFrames();
  }

  /** --proxy for this engine's launch. */
  private launchNetwork(): Pick<LaunchOptions, 'proxy' | 'firefoxUserPrefs'> {
    const proxy = this.network.proxy;
    if (!proxy) return {};
    if (!this.network.proxyLoopback) return { proxy };
    // Localhost through the proxy as well: Chromium skips the proxy for loopback unless told
    // otherwise, and Firefox needs a preference for it.
    if (this.engine === 'chromium') return { proxy: { ...proxy, bypass: [proxy.bypass, '<-loopback>'].filter(Boolean).join(',') } };
    if (this.engine === 'firefox') return { proxy, firefoxUserPrefs: { 'network.proxy.allow_hijacking_localhost': true } };
    return { proxy };
  }

  // ---- device emulation -----------------------------------------------------------------------

  /** Context options for the current device (or desktop). */
  private contextOptions(): BrowserContextOptions {
    const d = this.device;
    return {
      viewport: this.info.viewport,
      colorScheme: this.colorScheme,
      ...(this.network.ignoreCertErrors ? { ignoreHTTPSErrors: true } : {}),
      deviceScaleFactor: d?.deviceScaleFactor ?? 1,
      hasTouch: d?.hasTouch ?? false,
      // Firefox has no mobile mode; it still gets the device's size, pixel ratio, touch and UA.
      ...(d?.isMobile && this.engine !== 'firefox' ? { isMobile: true } : {}),
      ...(d ? { userAgent: d.userAgent } : {}),
    };
  }

  private applyDevice(device: DevicePreset | null): void {
    if (device && !this.device) this.desktopViewport = { ...this.info.viewport };
    if (device) this.info.viewport = { ...device.viewport };
    else if (this.device && this.desktopViewport) this.info.viewport = this.desktopViewport;
    this.device = device;
    this.info.device = device?.name ?? null;
  }

  private async createPage(storageState?: BrowserContextOptions['storageState']): Promise<{ context: BrowserContext; page: Page }> {
    const options = this.contextOptions();
    const context = storageState
      ? await this.browser!.newContext({ ...options, storageState }).catch(() => this.browser!.newContext(options))
      : await this.browser!.newContext(options);
    await context.addInitScript({ content: NO_BACKSPACE_NAVIGATION });
    return { context, page: await context.newPage() };
  }

  private wirePage(context: BrowserContext, page: Page): void {
    this.attachPageEvents(page);
    context.on('page', (popup) => {
      if (!this.openingHelperPage) void this.adoptPopup(popup);
    });
  }

  /**
   * Emulates a device (or, with null, goes back to desktop). Pixel ratio, touch, mobile mode and
   * user agent can only be set when a browser context is created, so this builds a new context
   * with the old one's cookies and storage, swaps the page in, and reloads the same URL.
   */
  async setDevice(device: DevicePreset | null): Promise<void> {
    if ((device?.name ?? null) === (this.device?.name ?? null)) return;
    this.applyDevice(device);
    if (!this.browser || !this.context || !this.page) {
      this.emitInfo();
      return;
    }
    const url = this.page.url();
    const old = this.context;
    const storageState = await quietly(old, () => old.storageState({ indexedDB: true })).catch(() => undefined);
    const { context, page } = await this.createPage(storageState);
    await this.saveTracePart(); // the old context's part of a trace being recorded

    // Swap: the frame loop and input pick up the new page on their next step.
    if (this.cdp) {
      await this.cdp.send('Page.stopScreencast').catch(() => {});
      await this.cdp.detach().catch(() => {});
      this.cdp = undefined;
      this.overlayReady = false;
    }
    this.context = context;
    this.page = page;
    this.lastFrame = null;
    this.inputQueue = Promise.resolve();
    this.wirePage(context, page);
    if (this.engine === 'chromium') await this.startScreencast();
    await this.traceContext(); // before the reload, so the trace has it
    await old.close().catch(() => {});

    // DevTools re-attaches before the reload so it sees the page load; the UI hears about the new
    // page (generation) once the reload has committed, never while it's still blank.
    this.listener.pageReplaced(this.id);
    if (url && url !== 'about:blank') await this.goto(url);
    this.info.generation++;
    this.emitInfo();
  }
  async close(): Promise<void> {
    this.running = false;
    this.wake?.();
    clearInterval(this.saveTimer);
    clearTimeout(this.metricsTimer);
    await this.saveState();
    await this.saveTracePart();
    await this.browser?.close().catch(() => {});
  }

  // ---- turning the engine off and on (Settings → Engines) ------------------------------------

  /** Marks the engine as off without launching it (it's off from the start). */
  markDisabled(): void {
    this.info.disabled = true;
    this.info.loading = false;
    this.emitInfo();
  }

  /**
   * Turns the engine off: saves its cookies and storage, closes its browser and forgets the page,
   * so everything the server asks of this pane becomes a no-op until it's enabled again.
   */
  async disable(): Promise<void> {
    if (this.info.disabled) return;
    await this.close();
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    this.cdp = undefined;
    this.devtools = undefined;
    this.overlayReady = false;
    this.lastFrame = null;
    this.info.disabled = true;
    this.info.loading = false;
    this.info.errors = 0;
    this.emitInfo();
  }

  /** Turns the engine back on with the current size, theme and device, at about:blank. */
  async enable(viewport: Viewport, colorScheme: Settings['colorScheme'], stateFile?: StateFile, device: DevicePreset | null = null): Promise<void> {
    if (!this.info.disabled) return;
    this.info.disabled = false;
    this.info.failed = undefined;
    this.info.loading = true;
    this.inputQueue = Promise.resolve();
    this.emitInfo();
    await this.start(viewport, colorScheme, stateFile, device);
    // A new page: DevTools reconnects (as after a device switch).
    this.info.generation++;
    this.listener.pageReplaced(this.id);
    this.emitInfo();
  }

  /** Writes cookies, localStorage and IndexedDB to this engine's state file (if persisting). */
  async saveState(): Promise<void> {
    if (!this.context || !this.stateFile) return;
    const since = this.originsSinceClear;
    const context = this.context;
    await quietly(context, () => this.stateFile!.save(context, since ? (origin) => since.has(origin) : undefined));
  }

  /**
   * Forgets saved data: deletes the state file, clears every cookie and the open site's
   * storage now, and reloads. Storage from other sites visited earlier this session is never
   * written back.
   */
  async clearStorage(): Promise<void> {
    this.originsSinceClear = new Set();
    await this.stateFile?.remove();
    if (!this.context || !this.page) return;
    const page = this.page;
    await quietly(page, () => this.context!.clearCookies());
    await quietly(page, () => page.evaluate(async () => {
        localStorage.clear();
        sessionStorage.clear();
        const dbs = (await indexedDB.databases?.()) ?? [];
        await Promise.all(
          dbs.map((db) => db.name && new Promise((done) => {
            const req = indexedDB.deleteDatabase(db.name!);
            req.onsuccess = req.onerror = req.onblocked = done;
          })),
        );
      })).catch(() => {});
    await this.history('reload');
  }

  // ---- navigation -------------------------------------------------------------------------

  goto(url: string): Promise<void> {
    return this.navigate(`Could not open ${url}`, (page) => page.goto(url, { waitUntil: 'commit', timeout: 30_000 }));
  }

  /** Resolves once the current page has loaded (or after the timeout). */
  async waitForLoad(timeout = 30_000): Promise<void> {
    const page = this.page;
    await quietly(page, async () => page?.waitForLoadState('load', { timeout })).catch(() => {});
  }

  history(action: 'back' | 'forward' | 'reload'): Promise<void> {
    return this.navigate(`${action} failed`, (page) => {
      const opts = { waitUntil: 'commit' as const, timeout: 30_000 };
      if (action === 'back') return page.goBack(opts);
      if (action === 'forward') return page.goForward(opts);
      return page.reload(opts);
    });
  }

  private async navigate(what: string, run: (page: Page) => Promise<unknown>): Promise<void> {
    const page = this.page;
    if (!page) return;
    this.touch();
    this.programmaticNavs++;
    try {
      await run(page);
    } catch (err) {
      if (this.running) this.tripaneError(`${what}: ${firstLines(err, 1)}`);
      this.setLoading(false);
    } finally {
      this.programmaticNavs--;
    }
  }

  // ---- input ------------------------------------------------------------------------------

  /** Replays input in order. Mouse moves are dropped while other input is still queued. */
  input(ev: InputEvent): Promise<void> {
    const page = this.page;
    if (!page) return Promise.resolve();
    if (ev.kind === 'mouse' && ev.action === 'move' && this.queuedInputs > 1) return Promise.resolve();
    this.touch();
    this.queuedInputs++;
    this.inputQueue = this.inputQueue
      .then(() => replayInput(page, ev, !!this.device?.hasTouch))
      .catch(() => {})
      .finally(() => {
        this.queuedInputs--;
        this.touch();
      });
    return this.inputQueue;
  }

  async getScroll(): Promise<{ x: number; y: number } | null> {
    if (!this.page) return null;
    const page = this.page;
    return quietly(page, () => page.evaluate(() => {
        const el = document.scrollingElement ?? document.documentElement;
        const maxY = el.scrollHeight - window.innerHeight;
        const maxX = el.scrollWidth - window.innerWidth;
        return { x: maxX > 0 ? window.scrollX / maxX : 0, y: maxY > 0 ? window.scrollY / maxY : 0 };
      })).catch(() => null);
  }

  async setScroll(frac: { x: number; y: number }): Promise<void> {
    if (!this.page) return;
    this.touch();
    const page = this.page;
    await quietly(page, () => page.evaluate((f) => {
        const el = document.scrollingElement ?? document.documentElement;
        window.scrollTo({
          left: f.x * (el.scrollWidth - window.innerWidth),
          top: f.y * (el.scrollHeight - window.innerHeight),
          behavior: 'instant',
        });
      }, frac)).catch(() => {});
  }

  // ---- emulation --------------------------------------------------------------------------

  async setViewport(viewport: Viewport): Promise<void> {
    this.info.viewport = viewport;
    if (this.page) {
      await this.page.setViewportSize(viewport).catch(() => {});
      if (this.cdp) await this.startScreencast();
      this.touch();
    }
    this.emitInfo();
  }

  async setColorScheme(colorScheme: Settings['colorScheme']): Promise<void> {
    await this.page?.emulateMedia({ colorScheme }).catch(() => {});
    this.touch();
  }

  async screenshot(path: string): Promise<boolean> {
    if (!this.page) return false;
    try {
      await this.page.screenshot({ path, fullPage: true, timeout: 30_000 });
      return true;
    } catch (err) {
      this.tripaneError(`Screenshot failed: ${firstLines(err, 1)}`);
      return false;
    }
  }

  // ---- element highlight & compare --------------------------------------------------------------

  /** The element under a viewport point, as a ref the other engines can resolve. */
  async refAt(x: number, y: number): Promise<{ ref: ElementRef; label: string } | null> {
    if (!this.page) return null;
    const page = this.page;
    return quietly(page, () => page.evaluate(refAtPoint, { x, y })).catch(() => null);
  }

  /**
   * Outlines the element (null removes the outline). Chromium uses its native DevTools highlight,
   * which leaves the page's DOM alone; Firefox and WebKit get an injected overlay.
   */
  highlight(ref: ElementRef | null): Promise<void> {
    return quietly(this.page, () => this.drawHighlight(ref));
  }

  private async drawHighlight(ref: ElementRef | null): Promise<void> {
    if (!this.page) return;
    this.touch();
    if (!this.cdp) {
      await this.page.evaluate(drawHighlight, ref).catch(() => {});
      return;
    }
    const cdp = this.cdp;
    try {
      if (!ref) {
        if (this.overlayReady) await cdp.send('Overlay.hideHighlight');
        return;
      }
      if (!this.overlayReady) {
        await cdp.send('DOM.enable');
        await cdp.send('Overlay.enable');
        this.overlayReady = true;
      }
      const { result } = await cdp.send('Runtime.evaluate', { expression: `(${resolveElement.toString()})(${JSON.stringify(ref)})` });
      if (!result.objectId) {
        await cdp.send('Overlay.hideHighlight');
        return;
      }
      await cdp.send('Overlay.highlightNode', { objectId: result.objectId, highlightConfig: CHROMIUM_HIGHLIGHT });
      void cdp.send('Runtime.releaseObject', { objectId: result.objectId }).catch(() => {});
    } catch {
      // mid-navigation; the next hover will try again
    }
  }

  /** Label, box model and computed styles of the element, for Compare. */
  async snapshot(ref: ElementRef): Promise<ElementSnapshot> {
    if (!this.page) return { found: false, label: '' };
    const page = this.page;
    return quietly(page, () => page.evaluate(snapshotElement, ref)).catch(() => ({ found: false, label: '' }));
  }

  // ---- site info (the button at the left of the address bar) ---------------------------------------

  private mainResponse?: {
    url: string;
    status: number;
    security: { protocol?: string; subjectName?: string; issuer?: string; validFrom?: number; validTo?: number } | null;
  };

  /** This engine's view of the open site: connection, cookies, storage and permissions. */
  siteInfo(): Promise<SiteInfoEngine | null> {
    return quietly(this.page, () => this.readSiteInfo());
  }

  private async readSiteInfo(): Promise<SiteInfoEngine | null> {
    const page = this.page;
    const context = this.context;
    if (!page || !context) return null;
    const url = page.url();
    let protocol = '';
    try {
      protocol = new URL(url).protocol;
    } catch {
      // about:blank
    }
    const response = this.mainResponse?.url === url ? this.mainResponse : undefined;
    const sec = response?.security;
    const cookies = /^https?:$/.test(protocol) ? await context.cookies(url).catch(() => []) : [];
    const inPage = await page
      .evaluate(async (names) => {
        const count = (s: () => Storage) => {
          try {
            return s().length;
          } catch {
            return 0;
          }
        };
        const permissions: Record<string, string> = {};
        for (const name of names) {
          try {
            permissions[name] = (await navigator.permissions.query({ name: name as PermissionName })).state;
          } catch {
            permissions[name] = 'unsupported';
          }
        }
        return { localStorage: count(() => localStorage), sessionStorage: count(() => sessionStorage), permissions };
      }, ['geolocation', 'notifications', 'camera', 'microphone', 'clipboard-read'])
      .catch(() => ({ localStorage: 0, sessionStorage: 0, permissions: {} as Record<string, string> }));
    return {
      paneId: this.id,
      engine: this.engine,
      url,
      secure: protocol === 'https:' || protocol === 'wss:',
      status: response?.status,
      certificate: sec
        ? { protocol: sec.protocol, subject: sec.subjectName, issuer: sec.issuer, validFrom: sec.validFrom, validTo: sec.validTo }
        : null,
      cookies: cookies.map((c) => ({
        name: c.name,
        domain: c.domain,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        session: c.expires === -1,
      })),
      ...inPage,
    };
  }

  /**
   * Clears one site's cookies and storage (localStorage, sessionStorage, IndexedDB) in this
   * running engine, wherever its page is; other sites are left alone. On the site, the page itself
   * clears it. Elsewhere, a hidden helper page opens the site's origin, answered with an empty
   * document so nothing reaches the network, clears it and closes. The saved state is rewritten.
   */
  forgetSite(origin: string): Promise<void> {
    return quietly(this.page, () => this.clearSite(origin));
  }

  private async clearSite(origin: string): Promise<void> {
    const page = this.page;
    const context = this.context;
    if (!page || !context) return;
    // The site's own cookies and its parent domains' (e.g. .example.com for www.example.com), any path.
    const host = new URL(origin).hostname;
    for (const c of (await context.cookies().catch(() => [])).filter((c) => cookieForHost(c.domain, host))) {
      await context.clearCookies({ name: c.name, domain: c.domain, path: c.path }).catch(() => {});
    }
    const clear = async () => {
      try {
        localStorage.clear();
        sessionStorage.clear();
      } catch {
        // storage blocked
      }
      try {
        const dbs = (await indexedDB.databases?.()) ?? [];
        await Promise.all(
          dbs.map(
            (db) =>
              new Promise<void>((done) => {
                if (!db.name) return done();
                const req = indexedDB.deleteDatabase(db.name);
                req.onsuccess = req.onerror = req.onblocked = () => done();
              }),
          ),
        );
      } catch {
        // not supported
      }
    };
    let onSite = false;
    try {
      onSite = new URL(page.url()).origin === origin;
    } catch {
      // about:blank
    }
    if (onSite) {
      await page.evaluate(clear).catch(() => {});
    } else {
      // Only needed when the engine holds storage for the site.
      const state = await context.storageState({ indexedDB: true }).catch(() => null);
      if (state?.origins.some((o) => o.origin === origin)) {
        let helper: Page | undefined;
        this.openingHelperPage = true;
        try {
          helper = await context.newPage();
        } catch {
          // the browser is closing
        } finally {
          this.openingHelperPage = false;
        }
        if (helper) {
          try {
            await helper.route('**/*', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html>' }));
            await helper.goto(origin, { timeout: 10_000 });
            await helper.evaluate(clear);
          } catch {
            // best effort
          } finally {
            await helper.close().catch(() => {});
          }
        }
      }
    }
    await this.saveState();
  }

  /**
   * Runs an action on the page for the MCP server (click, fill, evaluate…). The picture is kept
   * fresh while it runs, so the result shows up in the UI straight away.
   */
  async act<T>(run: (page: Page) => Promise<T>): Promise<T> {
    const page = this.page;
    if (!page) throw new Error(`${this.engine} isn't running`);
    this.touch();
    try {
      return await run(page);
    } finally {
      this.touch();
    }
  }

  /** Performance monitor figures (CPU, heap, DOM size, layouts…), measured over `sampleMs` where the engine allows. */
  async performance(sampleMs: number): Promise<PerformanceStats> {
    const page = this.page;
    if (!page) throw new Error(`${this.engine} isn't running`);
    return measurePerformance(this.engine, page, this.engine === 'chromium' ? this.cdp : undefined, sampleMs);
  }

  /** The element under a viewport point and where in it the point is (see pointRef). */
  async pointRef(x: number, y: number): Promise<{ ref: ElementRef; fx: number; fy: number } | null> {
    if (!this.page) return null;
    const page = this.page;
    return quietly(page, () => page.evaluate(pointRef, { x, y })).catch(() => null);
  }

  /** The same spot of the same element in this engine's layout (see pointFor). */
  async pointFor(at: { ref: ElementRef; fx: number; fy: number }): Promise<{ x: number; y: number } | null> {
    if (!this.page) return null;
    this.touch();
    const page = this.page;
    return quietly(page, () => page.evaluate(pointFor, at)).catch(() => null);
  }

  /** The element matching a CSS selector, as a ref every engine can resolve. */
  async refFor(selector: string): Promise<{ ref: ElementRef; label: string } | null> {
    if (!this.page) return null;
    const page = this.page;
    return quietly(page, () => page.evaluate(refForSelector, selector));
  }

  // ---- tracing (Tools → Record trace) -------------------------------------------------------------

  /**
   * Starts recording a Playwright trace (actions with DOM snapshots, screenshots, network and
   * console) into `dir`. An engine that's off starts recording when it's turned on.
   */
  startTrace(dir: string, title: string): Promise<void> {
    return this.traceStep(async () => {
      await this.saveTracePartNow();
      this.trace = { dir, title, parts: [] };
      await this.traceContextNow();
    });
  }

  /** Stops recording; returns the files saved (more than one when the context was replaced). */
  stopTrace(): Promise<string[]> {
    return this.traceStep(async () => {
      await this.saveTracePartNow();
      const parts = this.trace?.parts ?? [];
      this.trace = undefined;
      return parts;
    });
  }

  /** Starts tracing the current context, if a trace is being recorded and it isn't yet. */
  private traceContext(): Promise<void> {
    return this.traceStep(() => this.traceContextNow());
  }

  /** Saves what the recording context has so far as the next part of the trace. */
  private saveTracePart(): Promise<void> {
    return this.traceStep(() => this.saveTracePartNow());
  }

  private traceSteps: Promise<unknown> = Promise.resolve();

  /**
   * Trace steps run one at a time: starting and stopping take a while, and a device switch (which
   * saves one part and starts the next) can overlap with Record or Stop.
   */
  private traceStep<T>(step: () => Promise<T>): Promise<T> {
    const run = this.traceSteps.then(step, step);
    this.traceSteps = run.catch(() => {});
    return run;
  }

  private async traceContextNow(): Promise<void> {
    const context = this.context;
    if (!this.trace || !context || this.tracingContext === context) return;
    if (this.tracingContext) await this.saveTracePartNow(); // a context that has been replaced
    try {
      await context.tracing.start({ title: this.trace.title, screenshots: true, snapshots: true });
      this.tracingContext = context;
    } catch (err) {
      this.tripaneError(`Couldn't start the trace: ${firstLines(err, 1)}`);
    }
  }

  private async saveTracePartNow(): Promise<void> {
    const context = this.tracingContext;
    const trace = this.trace;
    this.tracingContext = undefined;
    if (!context || !trace) return;
    const n = trace.parts.length + 1;
    const file = join(trace.dir, n === 1 ? `${this.engine}.zip` : `${this.engine}-${n}.zip`);
    try {
      await context.tracing.stop({ path: file });
      trace.parts.push(file);
    } catch (err) {
      this.tripaneError(`Couldn't save the trace: ${firstLines(err, 1)}`);
    }
  }

  /** The page itself, for tests. */
  get playwrightPage(): Page | undefined {
    return this.page;
  }

  // ---- internals --------------------------------------------------------------------------

  private attachPageEvents(page: Page): void {
    page.on('request', (req) => {
      const main = req.isNavigationRequest() && req.frame() === page.mainFrame();
      if (main) {
        // Title and icon belong to the old page; they're read again once the new one loads
        // (history must not file the old page's under the new URL).
        this.info.title = '';
        this.info.icon = null;
        this.titleReads++; // and reads still in flight would see the next page's placeholder
        this.setLoading(true);
        this.newDocumentPending = true;
        // A redirect continues the same navigation; anything else starts new figures.
        if (!req.redirectedFrom()) {
          this.info.metrics = { startedAt: Date.now(), requests: 0, finished: 0, failed: 0, transferred: 0, ttfb: null, domContentLoaded: null, load: null };
        }
      }
      const m = this.info.metrics;
      if (m) {
        m.requests++;
        this.metricsChanged();
      }
    });
    page.on('requestfinished', (req) => {
      const m = this.info.metrics;
      if (!m) return;
      m.finished++;
      this.metricsChanged();
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) {
        const t = req.timing();
        if (t.responseStart >= 0) m.ttfb = Math.round(t.responseStart);
      }
      void quietly(page, () => req.sizes())
        .then((size) => {
          if (this.info.metrics !== m) return; // a new page started meanwhile
          m.transferred += Math.max(0, size.responseHeadersSize) + Math.max(0, size.responseBodySize);
          this.metricsChanged();
        })
        .catch(() => {});
    });
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame()) return;
      this.info.url = frame.url();
      // A new document (reload, navigation, link) starts with a clean error count, as in Chrome
      // DevTools. Same-document navigations (hash, pushState) keep it: the page is still running.
      if (this.newDocumentPending) this.info.errors = 0;
      this.emitInfo();
      if (this.originsSinceClear) {
        try {
          this.originsSinceClear.add(new URL(frame.url()).origin);
        } catch {
          // about:blank
        }
      }
      if (frame.url() === 'about:blank') {
        this.setLoading(false); // no load event is used for it (see below)
        this.info.metrics = null;
      }
      if (this.newDocumentPending) {
        this.newDocumentPending = false;
        this.emitLog(Date.now(), async () => ({ level: 'info', source: 'navigation', text: frame.url() }));
      }
      if (this.programmaticNavs === 0) this.listener.userNavigation(this.id, this.info.url);
    });
    // Firefox fires DOMContentLoaded and load for an about:blank placeholder ("Loading …") before
    // the first page commits, and those events aren't the page's. Nothing at about:blank has a
    // title or icon worth reading anyway (a real visit to it stops loading in framenavigated).
    const placeholder = () => this.newDocumentPending || page.url() === 'about:blank';
    const at = (key: 'domContentLoaded' | 'load') => {
      const m = this.info.metrics;
      if (m && m[key] === null) {
        m[key] = Date.now() - m.startedAt;
        this.metricsChanged();
      }
    };
    page.on('domcontentloaded', () => {
      if (placeholder()) return;
      at('domContentLoaded');
      void this.refreshTitle();
    });
    page.on('load', () => {
      if (placeholder()) return;
      at('load');
      this.setLoading(false);
      void this.refreshTitle();
    });
    page.on('console', (msg) => {
      const ts = Date.now();
      const level = consoleLevel(msg.type());
      if (level === 'error') this.countError();
      this.emitLog(ts, async () => {
        const loc = msg.location();
        return { level, source: 'console', text: await formatMessage(page, msg), url: loc.url || undefined, line: loc.url ? loc.lineNumber + 1 : undefined };
      });
    });
    page.on('pageerror', (err) => {
      this.countError();
      const frame = err.stack?.split('\n').map((l) => l.match(/(https?:\/\/[^\s)]+?):(\d+):\d+\)?$/)).find(Boolean);
      this.emitLog(Date.now(), async () => ({
        level: 'error',
        source: 'exception',
        text: `Uncaught ${err.name}: ${err.message}`,
        url: frame?.[1],
        line: frame ? Number(frame[2]) : undefined,
      }));
    });
    page.on('response', (res) => {
      // The main document's response and TLS details, for the site info panel.
      const req0 = res.request();
      if (req0.isNavigationRequest() && req0.frame() === page.mainFrame()) {
        const status = res.status();
        this.mainResponse = { url: res.url(), status, security: null };
        void quietly(page, () => res.securityDetails())
          .then((security) => {
            // Some engines report {} rather than null for a page that isn't over TLS.
            const real = security && Object.values(security).some((v) => v !== undefined && v !== '');
            if (this.mainResponse?.url === res.url()) this.mainResponse.security = real ? security : null;
          })
          .catch(() => {});
      }
      if (res.status() < 400) return;
      const req = res.request();
      this.emitLog(Date.now(), async () => ({
        level: 'error',
        source: 'network',
        text: `${req.method()} ${res.url()} ${res.status()} (${res.statusText() || 'error'})`,
        url: res.url(),
      }));
    });
    page.on('requestfailed', (req) => {
      const reason = req.failure()?.errorText ?? 'failed';
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) this.setLoading(false);
      // Aborted navigations happen on every quick re-navigation; they're noise.
      if (/abort|cancel/i.test(reason)) return;
      if (this.info.metrics) {
        this.info.metrics.failed++;
        this.metricsChanged();
      }
      this.countError();
      this.emitLog(Date.now(), async () => ({ level: 'error', source: 'network', text: `${req.method()} ${req.url()} ${reason}`, url: req.url() }));
    });
  }

  /** target=_blank links and window.open would open invisible tabs; load them in the pane instead. */
  private async adoptPopup(popup: Page): Promise<void> {
    if (popup === this.page) return;
    const url = await quietly(popup, () => popup.waitForURL((u) => u.href !== 'about:blank', { timeout: 10_000, waitUntil: 'commit' }))
      .then(() => popup.url())
      .catch(() => popup.url());
    await quietly(popup, () => popup.close()).catch(() => {});
    if (url && url !== 'about:blank') {
      await this.page?.goto(url, { waitUntil: 'commit' }).catch(() => {});
    }
  }

  // ---- frame format (Settings → Frame format) -------------------------------------------------

  /** Unset until Settings → Frame format is applied: then the engine's default. */
  private frameFormat?: FrameFormat;

  private resolvedFormat(): FrameFormat {
    return this.frameFormat ?? DEFAULT_FRAME_FORMAT[this.engine];
  }

  /**
   * Sets how frames are encoded. Polling picks it up on its next capture; Chromium's screencast is
   * restarted in the new format. Before the engine runs, this just sets the format it starts with.
   */
  async setFrameFormat(format: FrameFormat): Promise<void> {
    this.frameFormat = format;
    const capture = this.info.capture;
    if (!capture) return;
    const resolved = this.resolvedFormat();
    if (capture.format === resolved) return;
    capture.format = resolved;
    capture.quality = resolved === 'jpeg' ? JPEG_QUALITY : null;
    this.lastFrame = null;
    if (this.cdp) await this.startScreencast().catch(() => {});
    this.touch();
    this.emitInfo();
  }

  private startScreencast(): Promise<void> {
    return quietly(this.page, () => this.restartScreencast());
  }

  private async restartScreencast(): Promise<void> {
    const page = this.page;
    if (!page || !this.context) return;
    if (!this.cdp) {
      const cdp = await this.context.newCDPSession(page);
      this.cdp = cdp;
      cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
        if (this.cdp !== cdp) return; // a page that has been replaced
        this.emitFrame(Buffer.from(data, 'base64'));
        void quietly(cdp, () => cdp.send('Page.screencastFrameAck', { sessionId })).catch(() => {});
      });
      // Chrome DevTools connects to this page's target (it changes when the page is replaced).
      const { targetInfo } = await cdp.send('Target.getTargetInfo');
      if (this.devtools) this.devtools.targetId = targetInfo.targetId;
    } else {
      await this.cdp.send('Page.stopScreencast').catch(() => {});
    }
    const { width, height } = this.info.viewport;
    const format = this.resolvedFormat();
    await this.cdp.send('Page.startScreencast', {
      format,
      ...(format === 'jpeg' ? { quality: JPEG_QUALITY } : {}),
      maxWidth: width,
      maxHeight: height,
      everyNthFrame: 1,
    });
  }

  private async pollFrames(): Promise<void> {
    while (this.running && this.page) {
      const started = Date.now();
      let changed = false;
      try {
        const page = this.page;
        const jpeg = await quietly(page, () => page.screenshot({
          ...(this.info.capture?.format === 'png' ? { type: 'png' as const } : { type: 'jpeg' as const, quality: JPEG_QUALITY }),
          caret: 'initial',
          scale: 'css', // frames stay at CSS-pixel size even on high-DPR devices
          timeout: 5_000,
        }));
        if (!this.lastFrame || !jpeg.equals(this.lastFrame)) {
          changed = true;
          this.emitFrame(jpeg);
        }
      } catch {
        // Mid-navigation or the browser is closing; try again on the next tick.
      }
      if (changed) this.lastActivity = Date.now();
      const idle = Date.now() - this.lastActivity > IDLE_AFTER_MS;
      const interval = idle ? IDLE_FRAME_MS : ACTIVE_FRAME_MS;
      if (this.info.capture && this.info.capture.intervalMs !== interval) {
        this.info.capture.intervalMs = interval;
        this.emitInfo();
      }
      const delay = interval - (Date.now() - started);
      if (delay > 0) await this.sleep(delay);
    }
  }

  /** Sleeps, but wakes early when input arrives so the response shows up quickly. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
  }

  private touch(): void {
    this.lastActivity = Date.now();
    const wake = this.wake;
    this.wake = undefined;
    wake?.();
  }

  private emitFrame(jpeg: Buffer): void {
    this.lastFrame = jpeg;
    this.listener.frame(this.id, jpeg);
  }

  private setLoading(loading: boolean): void {
    if (this.info.loading === loading) return;
    this.info.loading = loading;
    this.emitInfo();
  }

  private titleReads = 0;

  private async refreshTitle(): Promise<void> {
    // Reads overlap (Firefox fires DOMContentLoaded and load for a "Loading …" placeholder, then
    // again for the page); only the latest read may write. The title is written as soon as it's
    // read: the icon lookup (a page script) can be slow right after a navigation.
    const read = ++this.titleReads;
    const url = this.page?.url();
    // Still the same page, and no navigation started since this read began.
    const current = () => read === this.titleReads && !this.newDocumentPending && this.page?.url() === url;
    const page = this.page;
    const title = await quietly(page, async () => page?.title()).catch(() => undefined);
    // Firefox's placeholder document, titled "Loading <url>", can fire its events before the
    // navigation request does, while the old page's URL is still shown: never the page's title.
    if (title !== undefined && this.engine === 'firefox' && /^Loading [a-z][a-z0-9+.-]*:\S*$/i.test(title)) return;
    if (current() && title !== undefined && title !== this.info.title) {
      this.info.title = title;
      this.emitInfo();
    }
    const icon = await quietly(page, async () => page?.evaluate(pageIcon)).catch(() => undefined);
    if (current() && icon !== undefined && icon !== this.info.icon) {
      this.info.icon = icon;
      this.emitInfo();
    }
  }

  private tripaneError(text: string): void {
    this.countError();
    this.emitLog(Date.now(), async () => ({ level: 'error', source: 'tripane', text }));
  }

  /** Counts errors for the pane badge. */
  private countError(): void {
    this.info.errors++;
    this.emitInfo();
  }

  /** Builds a log entry (possibly asking the page to format it) and emits it in order. */
  private emitLog(ts: number, build: () => Promise<Omit<LogEntry, 'id' | 'paneId' | 'ts'>>): void {
    this.logChain = this.logChain
      .then(async () => this.listener.log({ paneId: this.id, ts, ...(await build()) }))
      .catch(() => {});
  }

  private metricsTimer?: ReturnType<typeof setTimeout>;

  /** Network figures change with every request: they're sent at most five times a second. */
  private metricsChanged(): void {
    if (this.metricsTimer) return;
    this.metricsTimer = setTimeout(() => {
      this.metricsTimer = undefined;
      this.emitInfo();
    }, 200);
  }

  private emitInfo(): void {
    this.listener.info({
      ...this.info,
      viewport: { ...this.info.viewport },
      capture: this.info.capture && { ...this.info.capture },
      metrics: this.info.metrics && { ...this.info.metrics },
    });
  }
}

async function replayInput(page: Page, ev: InputEvent, touch: boolean): Promise<void> {
  const { mouse, keyboard } = page;
  switch (ev.kind) {
    case 'mouse':
      // On touch devices a click is a tap: touch events, then the emulated mouse events, like a phone.
      if (touch && ev.button === 'left' && ev.action !== 'move') {
        if (ev.action === 'up') await page.touchscreen.tap(ev.x, ev.y);
        return;
      }
      // Hover moves are frequent: a trace shows only the move that leads to a press.
      if (ev.action === 'down') await mouse.move(ev.x, ev.y);
      else await quietly(page, () => mouse.move(ev.x, ev.y));
      if (ev.action === 'down') await mouse.down({ button: ev.button, clickCount: ev.clickCount ?? 1 });
      if (ev.action === 'up') await mouse.up({ button: ev.button, clickCount: ev.clickCount ?? 1 });
      return;
    case 'wheel':
      await quietly(page, () => mouse.move(ev.x, ev.y));
      await mouse.wheel(ev.dx, ev.dy);
      return;
    case 'key':
      try {
        if (ev.action === 'down') await keyboard.down(ev.key);
        else await keyboard.up(ev.key);
      } catch {
        // Not on Playwright's US layout (e.g. "é"): type it as text instead.
        if (ev.action === 'down' && [...ev.key].length === 1) await keyboard.insertText(ev.key);
      }
      return;
    case 'text':
      await keyboard.insertText(ev.text);
      return;
  }
}

function firstLines(err: unknown, n: number): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg
    .split('\n')
    .map((l) => l.replace(/[║╔╗╚╝═]/g, '').trim())
    .filter(Boolean)
    .slice(0, n)
    .join(' ');
}

/** Asks the OS for a free localhost port. */
async function freePort(): Promise<number> {
  const listener = Bun.listen({ hostname: '127.0.0.1', port: 0, socket: { data() {} } });
  const { port } = listener;
  listener.stop(true);
  return port;
}

function consoleLevel(type: string): LogEntry['level'] {
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'warning') return 'warning';
  if (type === 'info') return 'info';
  if (type === 'debug') return 'debug';
  return 'log';
}

/** Formats the arguments inside the page so every engine prints them the same way. */
async function formatMessage(page: Page, msg: ConsoleMessage): Promise<string> {
  const args = msg.args();
  if (!args.length) return msg.text();
  try {
    return await quietly(page, () => page.evaluate(formatConsoleArgs, args));
  } catch {
    return msg.text(); // the page navigated away and the arguments are gone
  }
}

/**
 * The page's icon, run inside the page: the largest declared icon up to 64px (SVG first), else
 * /favicon.ico for web pages. null for pages without one (about:, data:, file:).
 */
function pageIcon(): string | null {
  const links = Array.from(document.querySelectorAll<HTMLLinkElement>('link[rel~="icon" i], link[rel="shortcut icon" i]')).filter((l) => l.href);
  const size = (l: HTMLLinkElement) => {
    if (/\.svg(\?|$)/i.test(l.href) || l.type === 'image/svg+xml' || l.sizes?.value === 'any') return 1000;
    const n = Math.max(0, ...Array.from(l.sizes ?? []).map((s) => parseInt(s, 10) || 0));
    return n === 0 ? 16 : n <= 64 ? n : 64 - n / 100; // prefer 32-64px over huge touch icons
  };
  links.sort((a, b) => size(b) - size(a));
  if (links[0]) return links[0].href;
  return /^https?:$/.test(location.protocol) ? `${location.origin}/favicon.ico` : null;
}
