import { useEffect, useState } from 'preact/hooks';
import type {
  AriaDiffResult,
  VisualDiffResult,
  ClientMessage,
  CompareResult,
  DevicePreset,
  HistoryEntry,
  LogEntry,
  NetworkInfo,
  PaneId,
  UpdateStatus,
  PaneInfo,
  SiteInfo,
  ServerMessage,
  Settings,
  SavedTrace,
  TracingState,
} from '../../shared/protocol';

export interface EngineState {
  status: 'connecting' | 'open' | 'closed';
  panes: PaneInfo[];
  settings: Settings | null;
  screenshots: { dir: string; files: string[] } | null;
  /** Tools → Record trace: the recording in progress, and the last one saved. */
  tracing: TracingState | null;
  traces: { dir: string; traces: SavedTrace[] } | null;
  /** Unified log from all engines, oldest first. */
  log: LogEntry[];
  /** Where cookies and storage are saved between runs; null for a fresh session. */
  storageDir: string | null;
  notice: string | null;
  /** The latest element comparison (from any window). */
  compare: CompareResult | null;
  /** The latest site info (address bar's site button), or null before it's asked for. */
  siteInfo: SiteInfo | null;
  /** Device presets for the Device menu. */
  devices: DevicePreset[];
  /** The latest engine update check, and whether one is running. */
  updates: UpdateStatus | null;
  checkingUpdates: boolean;
  /** Browsing history, most recent first. */
  history: HistoryEntry[];
  /** The server's TriPane version ('dev' when run from source). */
  version: string;
  /** Proxy and certificate handling (--proxy, --ignore-cert-errors); null before hello. */
  network: NetworkInfo | null;
  /** When the current connection opened; when the next reconnect attempt is due while closed. */
  connectedAt: number | null;
  retryAt: number | null;
  /** Last measured round trip to the server, in ms (measured while the status panel is open). */
  latency: number | null;
  /** Tools → Compare engines: the latest results, and which comparison is running. */
  visualDiff: VisualDiffResult | null;
  ariaDiff: AriaDiffResult | null;
  diffBusy: 'visual' | 'aria' | null;
  error: string | null;
}

const MAX_LOG = 3000;

type FrameListener = (frame: ImageBitmap) => void;

/**
 * WebSocket client for the TriPane server. JSON state goes into a store the UI subscribes to;
 * frames bypass Preact and go straight to the pane's canvas through onFrame().
 */
export class EngineClient {
  private ws?: WebSocket;
  private state: EngineState = {
    status: 'connecting',
    panes: [],
    settings: null,
    screenshots: null,
    tracing: null,
    traces: null,
    log: [],
    storageDir: null,
    notice: null,
    compare: null,
    siteInfo: null,
    devices: [],
    updates: null,
    checkingUpdates: false,
    history: [],
    version: '',
    network: null,
    connectedAt: null,
    retryAt: null,
    latency: null,
    visualDiff: null,
    ariaDiff: null,
    diffBusy: null,
    error: null,
  };
  private retryTimer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<() => void>();
  private frameListeners = new Map<PaneId, Set<FrameListener>>();
  private latestFrame = new Map<PaneId, ImageBitmap>();
  private decoding = new Set<PaneId>();
  private pendingFrame = new Map<PaneId, Blob>();
  private retry = 0;
  private disposed = false;

  constructor(private readonly url: string) {}

  /** Connects (again). Safe to call after stop(). */
  start(): void {
    this.disposed = false;
    if (!this.ws || this.ws.readyState >= WebSocket.CLOSING) this.connect();
  }

  getState = (): EngineState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  onFrame(id: PaneId, fn: FrameListener): () => void {
    let set = this.frameListeners.get(id);
    if (!set) this.frameListeners.set(id, (set = new Set()));
    set.add(fn);
    const last = this.latestFrame.get(id);
    if (last) fn(last);
    return () => set.delete(fn);
  }

  checkUpdates(): void {
    this.send({ type: 'checkUpdates' });
  }

  clearStorage(): void {
    this.send({ type: 'clearStorage' });
  }

  dismissNotice(): void {
    this.set({ notice: null });
  }

  clearLog(): void {
    this.send({ type: 'clearLog' });
  }

  dismissTraces(): void {
    this.set({ traces: null });
  }

  dismissScreenshots(): void {
    this.set({ screenshots: null });
  }

  dismissError(): void {
    this.set({ error: null });
  }

  stop(): void {
    this.disposed = true;
    this.ws?.close();
    this.ws = undefined;
  }

  private set(patch: Partial<EngineState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  private connect(): void {
    const ws = new WebSocket(this.url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.retry = 0;
      this.set({ status: 'open', error: null, connectedAt: Date.now(), retryAt: null });
    };
    ws.onclose = () => {
      if (this.disposed || this.ws !== ws) return;
      const delay = Math.min(5000, 300 * 2 ** this.retry++);
      this.set({ status: 'closed', connectedAt: null, latency: null, retryAt: Date.now() + delay });
      this.retryTimer = setTimeout(() => !this.disposed && this.ws === ws && this.connect(), delay);
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      if (ev.data instanceof ArrayBuffer) this.onBinary(ev.data);
      else this.onJson(JSON.parse(ev.data as string) as ServerMessage);
    };
  }

  /** Runs a whole-page comparison (Tools → Compare engines); the result arrives in state. */
  runDiff(msg: Extract<ClientMessage, { type: 'visualDiff' | 'ariaDiff' }>): void {
    this.set({ diffBusy: msg.type === 'visualDiff' ? 'visual' : 'aria', error: null });
    this.send(msg);
  }

  /** Reconnects now instead of waiting for the next attempt. */
  reconnectNow(): void {
    if (this.disposed || this.state.status === 'open') return;
    clearTimeout(this.retryTimer);
    this.retry = 0;
    this.set({ status: 'connecting', retryAt: null });
    this.connect();
  }

  /** Measures the round trip to the server; the result lands in state.latency. */
  ping(): void {
    if (this.state.status === 'open') this.send({ type: 'ping', t: performance.now() });
  }

  private onJson(msg: ServerMessage): void {
    switch (msg.type) {
      case 'visualDiff':
        this.set({ visualDiff: msg.result, diffBusy: this.state.diffBusy === 'visual' ? null : this.state.diffBusy });
        break;
      case 'ariaDiff':
        this.set({ ariaDiff: msg.result, diffBusy: this.state.diffBusy === 'aria' ? null : this.state.diffBusy });
        break;
      case 'pong':
        this.set({ latency: Math.max(0, Math.round(performance.now() - msg.t)) });
        break;
      case 'hello':
        this.set({
          panes: msg.panes,
          settings: msg.settings,
          log: [...msg.log].sort((a, b) => a.ts - b.ts || a.id - b.id),
          storageDir: msg.storageDir,
          devices: msg.devices,
          updates: msg.updates,
          checkingUpdates: msg.checkingUpdates,
          history: msg.history,
          version: msg.version,
          network: msg.network,
          tracing: msg.tracing,
        });
        break;
      case 'historyEntry':
        this.set({ history: [msg.entry, ...this.state.history.filter((e) => e.url !== msg.entry.url)] });
        break;
      case 'historyRemoved': {
        const gone = msg.urls === 'all' ? null : new Set(msg.urls);
        this.set({ history: gone ? this.state.history.filter((e) => !gone.has(e.url)) : [] });
        break;
      }
      case 'updates':
        this.set({ updates: msg.status, checkingUpdates: msg.checking });
        break;
      case 'notice':
        this.set({ notice: msg.message });
        break;
      case 'siteInfo':
        this.set({ siteInfo: msg.info });
        break;
      case 'compare':
        this.set({ compare: msg.result });
        break;
      case 'log': {
        // Engines report independently, so insert by time rather than arrival.
        const log = this.state.log.slice(-(MAX_LOG - 1));
        let i = log.length;
        while (i > 0 && log[i - 1].ts > msg.entry.ts) i--;
        log.splice(i, 0, msg.entry);
        this.set({ log });
        break;
      }
      case 'logCleared':
        this.set({ log: [] });
        break;
      case 'pane': {
        const panes = this.state.panes.slice();
        panes[msg.pane.id] = msg.pane;
        this.set({ panes });
        break;
      }
      case 'settings':
        this.set({ settings: msg.settings });
        break;
      case 'screenshots':
        this.set({ screenshots: { dir: msg.dir, files: msg.files } });
        break;
      case 'tracing':
        this.set({ tracing: msg.tracing });
        break;
      case 'traces':
        this.set({ traces: { dir: msg.dir, traces: msg.traces } });
        break;
      case 'error':
        this.set({ error: msg.message, diffBusy: null });
        break;
    }
  }

  /** Decodes off the main thread; if frames arrive faster than they decode, only the newest is kept. */
  private onBinary(buf: ArrayBuffer): void {
    const id = new Uint8Array(buf, 0, 1)[0] as PaneId;
    const image = new Uint8Array(buf, 1);
    const blob = new Blob([image], { type: image[0] === 0x89 ? 'image/png' : 'image/jpeg' }); // PNG starts with 0x89 'P'
    if (this.decoding.has(id)) {
      this.pendingFrame.set(id, blob);
      return;
    }
    void this.decode(id, blob);
  }

  private async decode(id: PaneId, blob: Blob): Promise<void> {
    this.decoding.add(id);
    try {
      const bmp = await createImageBitmap(blob);
      this.latestFrame.get(id)?.close();
      this.latestFrame.set(id, bmp);
      for (const fn of this.frameListeners.get(id) ?? []) fn(bmp);
    } catch {
      // A corrupt frame is skipped; the next one replaces it.
    } finally {
      this.decoding.delete(id);
      const next = this.pendingFrame.get(id);
      if (next) {
        this.pendingFrame.delete(id);
        void this.decode(id, next);
      }
    }
  }
}

export function useEngine(): { client: EngineClient; state: EngineState } {
  const [client] = useState(() => {
    const token = new URLSearchParams(location.search).get('token') ?? '';
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return new EngineClient(`${proto}//${location.host}/ws?token=${encodeURIComponent(token)}`);
  });
  const [state, setState] = useState(client.getState);
  useEffect(() => {
    const unsubscribe = client.subscribe(() => setState(client.getState()));
    setState(client.getState());
    client.start();
    return () => {
      unsubscribe();
      client.stop();
    };
  }, [client]);
  return { client, state };
}
