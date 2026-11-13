// Messages exchanged between the TriPane server and the UI over the /ws WebSocket.
//
// JSON text messages carry commands and state. Binary messages carry frames:
//   byte 0      pane id (0 = chromium, 1 = firefox, 2 = webkit)
//   bytes 1..n  JPEG or PNG image of that pane's viewport (see PaneInfo.capture.format)

export const ENGINES = ['chromium', 'firefox', 'webkit'] as const;
export type EngineName = (typeof ENGINES)[number];
/** How an engine's picture is encoded for the UI (Settings → Frame format). */
export const FRAME_FORMATS = ['jpeg', 'png'] as const;
export type FrameFormat = (typeof FRAME_FORMATS)[number];
/**
 * Each engine's default frame format, the one that works best there. Chromium: JPEG screencast,
 * the smallest frames on the fastest path. Firefox: lossless PNG, pixel-exact text for about 10%
 * fewer frames than JPEG while scrolling. WebKit: JPEG, where PNG costs noticeably more.
 */
export const DEFAULT_FRAME_FORMAT: Record<EngineName, FrameFormat> = { chromium: 'jpeg', firefox: 'png', webkit: 'jpeg' };
export type PaneId = 0 | 1 | 2;
export type Target = 'all' | PaneId;

export interface Viewport {
  width: number;
  height: number;
}

/** How a pane's picture is captured from its engine. */
export interface CaptureInfo {
  /** 'screencast': the engine pushes a frame on every repaint (CDP). 'screenshot': the server polls. */
  method: 'screencast' | 'screenshot';
  format: 'jpeg' | 'png';
  /** JPEG quality (0-100); null for lossless PNG. */
  quality: number | null;
  /** Current polling interval for 'screenshot' (it slows down while the page is idle); null when pushed. */
  intervalMs: number | null;
}

export interface PaneInfo {
  id: PaneId;
  engine: EngineName;
  version: string;
  /** Unset until the engine has launched. */
  capture?: CaptureInfo;
  url: string;
  title: string;
  loading: boolean;
  viewport: Viewport;
  errors: number;
  /** Set when the engine failed to launch (e.g. missing system libraries). */
  failed?: string;
  /** Turned off in Settings → Engines: not running, and not shown. */
  disabled?: boolean;
  /**
   * Bumped when the engine's page is replaced (switching device emulation needs a new browser
   * context). DevTools reconnects when it changes.
   */
  generation: number;
  /** The emulated device's name, or null for desktop. */
  device: string | null;
  /** The page's icon (its <link rel=icon>, else /favicon.ico); null when unknown. */
  icon?: string | null;
  /** Network figures for the current page, since its navigation started; null before one. */
  metrics?: NetworkMetrics | null;
}

/**
 * One engine's network figures for its current page, from Playwright's network events (nothing
 * runs in the page). Times are milliseconds from the start of the navigation.
 */
export interface NetworkMetrics {
  /** Server clock when the main document's request started. */
  startedAt: number;
  /** Requests started since then (the document included). */
  requests: number;
  finished: number;
  /** Failed requests (aborted ones, e.g. by a quick re-navigation, aren't counted). */
  failed: number;
  /** Bytes received for finished requests: headers plus the (compressed) body. */
  transferred: number;
  /** The main document's first response byte, from its own timing. */
  ttfb: number | null;
  domContentLoaded: number | null;
  load: number | null;
}

/** A device preset (from Playwright's device list) as shown in the Device menu. */
export interface DevicePreset {
  name: string;
  viewport: Viewport;
  deviceScaleFactor: number;
  hasTouch: boolean;
  /** Mobile mode (meta viewport, overlay scrollbars). Not supported by Firefox. */
  isMobile: boolean;
  /** The whole screen in CSS pixels, when Playwright knows it (the viewport is what the browser's own bars leave). */
  screen?: Viewport;
  userAgent: string;
}

/**
 * Interface themes (Settings → Interface theme). `scheme` is the light/dark base each one sets on
 * the window, which Chrome DevTools and native controls follow; null follows the OS.
 */
export const UI_THEMES = [
  { id: 'system', label: 'System', scheme: null },
  { id: 'light', label: 'TriPane Light', scheme: 'light' },
  { id: 'dark', label: 'TriPane Dark', scheme: 'dark' },
  { id: 'github-light', label: 'GitHub Light', scheme: 'light' },
  { id: 'github-dark', label: 'GitHub Dark', scheme: 'dark' },
  { id: 'dracula', label: 'Dracula', scheme: 'dark' },
  { id: 'vscode-light', label: 'VS Code Light Modern', scheme: 'light' },
  { id: 'vscode-dark', label: 'VS Code Dark Modern', scheme: 'dark' },
] as const;
export type UiTheme = (typeof UI_THEMES)[number]['id'];

/** The light/dark base of an interface theme; null for 'system'. */
export function themeScheme(theme: UiTheme): 'light' | 'dark' | null {
  return UI_THEMES.find((t) => t.id === theme)?.scheme ?? null;
}

export interface Settings {
  /** Replay clicks, keys and hover in every pane. */
  sync: boolean;
  /** Wheel scrolls only the pane under the cursor; the others follow by scroll percentage. */
  scrollSync: boolean;
  /** When one pane navigates on its own (link click, redirect), the others go to the same URL. */
  linkFollow: boolean;
  /** Page theme: prefers-color-scheme emulated in the three engines. */
  colorScheme: 'light' | 'dark';
  /** Interface theme: TriPane's own UI and the DevTools panels. 'system' follows the OS. */
  uiTheme: UiTheme;
  layout: 'columns' | 'rows';
  /** Outline the hovered element in all three engines. */
  highlight: boolean;
  /** Emulated device (a DevicePreset name), or null for desktop. */
  device: string | null;
  /**
   * Each engine gets its own size or device (the device bar's "Per engine"). Its device is in
   * engineDevice; its size is the pane's viewport. Off: `device` and one size apply to all.
   */
  sizePerEngine: boolean;
  engineDevice: Record<EngineName, string | null>;
  /** Check npm for newer engine builds at startup and once a day. */
  autoUpdateCheck: boolean;
  /** Show a ripple where each click lands, in every pane it's replayed to. */
  showClicks: boolean;
  /** Draw a device body and imitation browser bars around panes that emulate a device. */
  deviceFrames: boolean;
  /** Which engines run (Settings → Engines). At least one is always on. */
  engines: Record<EngineName, boolean>;
  /** Frame format per engine (Settings → Frame format). */
  frameFormat: Record<EngineName, FrameFormat>;
  /** Where DevTools docks in the main window, and its size there (null: a share of the window). */
  devtoolsDock: DevtoolsDock;
  /** The first-start notice (WebKit here isn't Safari on iOS) was dismissed. */
  webkitNoticeSeen: boolean;
}

export type DockSide = 'bottom' | 'left' | 'right';
export interface DevtoolsDock {
  side: DockSide;
  /** Height when docked at the bottom, in CSS px. */
  height: number | null;
  /** Width when docked left or right, in CSS px. */
  width: number | null;
}

/** Result of an engine update check (engines update together with Playwright). */
export interface UpdateStatus {
  checkedAt: number;
  playwright: { installed: string; latest: string | null };
  engines: { engine: EngineName; installed: string; latest: string | null; update: boolean }[];
  /** How to update, when a newer Playwright exists. */
  command: string | null;
  /** A standalone build: updating the engines means getting a newer TriPane build. */
  standalone?: boolean;
  error?: string;
}

export const DEFAULT_SETTINGS: Settings = {
  sync: true,
  scrollSync: true,
  linkFollow: true,
  colorScheme: 'light',
  uiTheme: 'dark',
  layout: 'columns',
  highlight: true,
  device: null,
  sizePerEngine: false,
  engineDevice: { chromium: null, firefox: null, webkit: null },
  autoUpdateCheck: true,
  showClicks: true,
  deviceFrames: true,
  engines: { chromium: true, firefox: true, webkit: true },
  frameFormat: { ...DEFAULT_FRAME_FORMAT },
  devtoolsDock: { side: 'bottom', height: null, width: null },
  webkitNoticeSeen: false,
};

/** Keeps only valid values from untrusted input (a client message or a settings file). */
export function sanitizeSettings(input: unknown): Partial<Settings> {
  const s = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: Partial<Settings> = {};
  for (const key of ['sync', 'scrollSync', 'linkFollow', 'highlight', 'autoUpdateCheck', 'showClicks', 'sizePerEngine', 'deviceFrames', 'webkitNoticeSeen'] as const) if (typeof s[key] === 'boolean') out[key] = s[key];
  if (s.colorScheme === 'light' || s.colorScheme === 'dark') out.colorScheme = s.colorScheme;
  if (UI_THEMES.some((t) => t.id === s.uiTheme)) out.uiTheme = s.uiTheme as UiTheme;
  if (s.layout === 'columns' || s.layout === 'rows') out.layout = s.layout;
  if (s.device === null || (typeof s.device === 'string' && s.device.length <= 80)) out.device = s.device as string | null;
  if (s.engineDevice && typeof s.engineDevice === 'object') {
    // Only the engines mentioned (merged into the current ones by whoever applies it, so changes
    // to two engines in quick succession don't overwrite each other); a non-name means desktop.
    const d = s.engineDevice as Record<string, unknown>;
    out.engineDevice = Object.fromEntries(
      ENGINES.filter((e) => e in d).map((e) => [e, typeof d[e] === 'string' && (d[e] as string).length <= 80 ? d[e] : null]),
    ) as Record<EngineName, string | null>;
  }
  if (s.engines && typeof s.engines === 'object') {
    // A full record: an engine that isn't mentioned stays on. Turning all of them off isn't allowed.
    const e = s.engines as Record<string, unknown>;
    const engines = Object.fromEntries(ENGINES.map((name) => [name, e[name] !== false])) as Record<EngineName, boolean>;
    if (Object.values(engines).some(Boolean)) out.engines = engines;
  }
  if (s.frameFormat && typeof s.frameFormat === 'object') {
    // A full record: anything missing or unknown (such as an older 'auto') is the engine's default.
    const f = s.frameFormat as Record<string, unknown>;
    out.frameFormat = Object.fromEntries(
      ENGINES.map((name) => [name, (FRAME_FORMATS as readonly unknown[]).includes(f[name]) ? f[name] : DEFAULT_FRAME_FORMAT[name]]),
    ) as Record<EngineName, FrameFormat>;
  }
  if (s.devtoolsDock && typeof s.devtoolsDock === 'object') {
    // Only the fields mentioned (merged like engineDevice): moving the dock doesn't reset a size.
    const d = s.devtoolsDock as Record<string, unknown>;
    const size = (v: unknown) => (v === null ? null : typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(10_000, Math.max(80, v))) : undefined);
    const dock: Partial<DevtoolsDock> = {};
    if (d.side === 'bottom' || d.side === 'left' || d.side === 'right') dock.side = d.side;
    if (size(d.height) !== undefined) dock.height = size(d.height)!;
    if (size(d.width) !== undefined) dock.width = size(d.width)!;
    out.devtoolsDock = dock as DevtoolsDock;
  }
  return out;
}

export type MouseButton = 'left' | 'middle' | 'right';

export type InputEvent =
  | { kind: 'mouse'; action: 'move' | 'down' | 'up'; x: number; y: number; button: MouseButton; clickCount?: number }
  | { kind: 'wheel'; x: number; y: number; dx: number; dy: number }
  | { kind: 'key'; action: 'down' | 'up'; key: string }
  | { kind: 'text'; text: string };

export interface TracingState {
  startedAt: number;
  /** Stopped, and the engines are writing their trace files. */
  saving: boolean;
}

export interface SavedTrace {
  engine: EngineName;
  /** The trace files (more than one when the engine's context was replaced while recording). */
  files: string[];
  /** Playwright's Trace Viewer with this trace, on TriPane's server (a path with a query). */
  viewer: string;
}

export type ClientMessage =
  | { type: 'navigate'; url: string }
  | { type: 'history'; action: 'back' | 'forward' | 'reload' }
  /** Reload one engine only, then bring it back in step with the others (URL, scroll). */
  | { type: 'reloadPane'; target: PaneId }
  /** `source` is the pane the user interacted with; `sync` decides whether others receive it too. */
  | { type: 'input'; source: PaneId; event: InputEvent }
  | { type: 'viewport'; target: Target; viewport: Viewport }
  | { type: 'settings'; settings: Partial<Settings> }
  | { type: 'screenshot' }
  /** Tools → Record trace: start or stop recording a Playwright trace in every engine. */
  | { type: 'trace'; action: 'start' | 'stop' }
  /** Empties the unified log (for every connected window). */
  | { type: 'clearLog' }
  /** Forgets saved cookies and site storage for every engine. */
  | { type: 'clearStorage' }
  /** Site info (the button at the left of the address bar): ask for it, or clear the site's data. */
  | { type: 'siteInfo' }
  /** Clear a site's cookies and storage in every engine (default: the site the engines show). */
  | { type: 'clearSiteData'; origin?: string }
  /** Element picking (Compare): highlight what's under the pointer in all engines, without page input. */
  | { type: 'probe'; source: PaneId; x: number; y: number }
  /** The pointer left the pane, or picking ended: remove the highlights. */
  | { type: 'probeEnd' }
  /** Compare one element across engines: the element at a point in `source`, or a known ref. */
  | { type: 'compare'; source?: PaneId; x?: number; y?: number; ref?: ElementRef }
  /** Check for engine updates now. */
  | { type: 'checkUpdates' }
  /** Browsing history: forget one page, or all of it. */
  | { type: 'removeHistory'; urls: string[] }
  /** Compare engines: pixels against a reference engine, or accessibility trees (Tools → Compare engines). */
  | { type: 'visualDiff'; reference: EngineName; fullPage?: boolean; threshold?: number }
  | { type: 'ariaDiff'; reference: EngineName; selector?: string }
  /** Round-trip check (the status panel's latency); answered with pong carrying the same t. */
  | { type: 'ping'; t: number }
  | { type: 'clearHistory' };

/** The engines' network setup (--proxy, --ignore-cert-errors), shown in the UI; no credentials. */
export interface NetworkInfo {
  /** e.g. "http://127.0.0.1:8080 (as alice)"; null when connecting directly. */
  proxy: string | null;
  /** Hosts that skip the proxy. */
  bypass: string[];
  /** localhost goes through the proxy too. */
  proxyLoopback: boolean;
  /** Certificate errors are ignored in every engine. */
  ignoreCertErrors: boolean;
}

/** Screenshots of each engine compared with a reference engine (pixelmatch). Images are data: URLs. */
export interface VisualDiffResult {
  reference: EngineName;
  fullPage: boolean;
  threshold: number;
  at: number;
  /** Each engine's screenshot, in CSS pixels. */
  engines: { engine: EngineName; paneId: PaneId; width: number; height: number; image: string }[];
  /** Each other engine against the reference: differing pixels, drawn over a faded copy of the reference. */
  diffs: {
    engine: EngineName;
    against: EngineName;
    /** The compared area (the shared part when the screenshots differ in size). */
    width: number;
    height: number;
    sizeMismatch: boolean;
    pixels: number;
    percent: number;
    image: string;
  }[];
}

export interface DiffLine {
  op: 'same' | 'add' | 'del';
  text: string;
}

/** Each engine's accessibility tree (ARIA snapshot), compared line by line with a reference engine. */
export interface AriaDiffResult {
  reference: EngineName;
  selector: string;
  at: number;
  engines: {
    engine: EngineName;
    paneId: PaneId;
    tree: string;
    error?: string;
    /** Against the reference: 'del' lines are only in the reference, 'add' lines only in this engine. */
    lines: DiffLine[];
    added: number;
    removed: number;
  }[];
}

/** A page in the browsing history (the address bar's suggestions and the History page). */
export interface HistoryEntry {
  url: string;
  title: string;
  /** Times visited (the three engines loading it together count once). */
  visits: number;
  /** Epoch milliseconds. */
  lastVisit: number;
  /** The page's icon URL (shown through the server's /favicon proxy), when known. */
  icon?: string;
}

/** Identifies the same element in every engine: child-element indices from a unique id (or <html>). */
export interface ElementRef {
  anchorId: string | null;
  path: number[];
}

export interface CompareResult {
  ref: ElementRef;
  /** Where the element was picked (null when re-run from a saved ref). */
  source: PaneId | null;
  at: number;
  engines: {
    paneId: PaneId;
    engine: EngineName;
    found: boolean;
    label: string;
    box?: { x: number; y: number; width: number; height: number; margin: number[]; border: number[]; padding: number[] };
    styles?: Record<string, string>;
  }[];
}

/** One line in the unified log: console output, errors and navigations from any engine. */
export interface LogEntry {
  id: number;
  paneId: PaneId;
  /** Epoch milliseconds, taken when the engine reported it. */
  ts: number;
  level: 'log' | 'info' | 'warning' | 'error' | 'debug';
  /** 'tripane': reported by TriPane itself, e.g. a navigation that failed. */
  source: 'console' | 'exception' | 'network' | 'navigation' | 'tripane';
  text: string;
  url?: string;
  line?: number;
}

export type ServerMessage =
  /** `storageDir`: where each engine's cookies and storage are saved between runs; null if not saved. */
  | { type: 'hello'; panes: PaneInfo[]; settings: Settings; log: LogEntry[]; storageDir: string | null; devices: DevicePreset[]; updates: UpdateStatus | null; checkingUpdates: boolean; history: HistoryEntry[]; version: string; network: NetworkInfo; tracing: TracingState | null }
  | { type: 'pong'; t: number }
  | { type: 'visualDiff'; result: VisualDiffResult }
  | { type: 'ariaDiff'; result: AriaDiffResult }
  /** A page was visited or got its title: insert it, or move it to the top. */
  | { type: 'historyEntry'; entry: HistoryEntry }
  /** Pages removed from history; 'all' when it was cleared. */
  | { type: 'historyRemoved'; urls: string[] | 'all' }
  | { type: 'updates'; status: UpdateStatus | null; checking: boolean }
  | { type: 'notice'; message: string }
  | { type: 'compare'; result: CompareResult }
  | { type: 'siteInfo'; info: SiteInfo }
  | { type: 'log'; entry: LogEntry }
  | { type: 'logCleared' }
  | { type: 'pane'; pane: PaneInfo }
  | { type: 'settings'; settings: Settings }
  | { type: 'screenshots'; dir: string; files: string[] }
  /** A trace started (startedAt), is being saved, or isn't being recorded (null). */
  | { type: 'tracing'; tracing: TracingState | null }
  /** A recording was saved: one trace per engine. */
  | { type: 'traces'; dir: string; traces: SavedTrace[] }
  | { type: 'error'; message: string };

export const VIEWPORT_PRESETS: Record<string, Viewport> = {
  Mobile: { width: 375, height: 812 },
  Tablet: { width: 768, height: 1024 },
  Laptop: { width: 1280, height: 800 },
  Desktop: { width: 1920, height: 1080 },
};

/** Accepts "example.com", "localhost:3000" or full URLs; falls back to a search for plain words. */
export function normalizeUrl(input: string): string {
  const s = input.trim();
  if (!s) return 'about:blank';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  if (/^(localhost|127\.|\[::1\])/i.test(s)) return `http://${s}`;
  if (/^[^\s]+\.[^\s]{2,}/.test(s)) return `https://${s}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`;
}

/** One engine's view of the open site, for the site info panel. */
export interface SiteInfoEngine {
  paneId: PaneId;
  engine: EngineName;
  url: string;
  /** The main document came over HTTPS (or another secure transport). */
  secure: boolean;
  /** The main document's HTTP status, when known. */
  status?: number;
  /** TLS details of the main document, as this engine received them (null when not over TLS or not reported). */
  certificate: { protocol?: string; subject?: string; issuer?: string; validFrom?: number; validTo?: number } | null;
  cookies: { name: string; domain: string; secure: boolean; httpOnly: boolean; sameSite: string; session: boolean }[];
  localStorage: number;
  sessionStorage: number;
  /** navigator.permissions states ('granted', 'denied', 'prompt'), or 'unsupported'. */
  permissions: Record<string, string>;
}

export interface SiteInfo {
  /** The site's origin, from the first running engine. */
  origin: string;
  engines: SiteInfoEngine[];
}
