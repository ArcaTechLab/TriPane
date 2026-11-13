// Chrome DevTools for all three panes.
//
// The DevTools frontend itself is the one bundled in the Chromium pane's browser, proxied under
// /devtools/ so it shares the app's origin. Each pane has a CDP endpoint at /cdp/<token>/<paneId>:
//   Chromium         piped straight through to the browser's own DevTools socket (everything works)
//   Firefox, WebKit  answered by a PageInspector, which translates CDP into Playwright calls

import type { ServerWebSocket } from 'bun';
import type { PaneId } from '../shared/protocol';
import { PageInspector } from './cdp/inspector';
import type { PaneSession } from './pane';

export interface DevToolsSocket {
  kind: 'cdp';
  paneId: PaneId;
  upstream?: WebSocket;
  pending?: string[];
  detach?: () => void;
}
type Socket = ServerWebSocket<DevToolsSocket>;

export class DevToolsBridge {
  private readonly sockets = new Set<Socket>();
  private readonly inspectors = new Map<PaneId, PageInspector>();
  /** Panes whose element picker is on; clicks there must not be replayed in the other panes. */
  readonly inspecting = new Set<PaneId>();

  constructor(private readonly panes: () => PaneSession[]) {}

  /**
   * Starts recording console and network activity for a Firefox or WebKit pane, so DevTools can
   * show what happened before it was opened (as Chrome does).
   */
  track(pane: PaneSession): void {
    const page = pane.playwrightPage;
    if (!page || pane.devtools || this.inspectors.has(pane.id)) return;
    this.inspectors.set(pane.id, new PageInspector(page, (on) => this.setInspecting(pane.id, on)));
  }

  /**
   * The pane's page was replaced (device emulation): drop its DevTools connections and inspector,
   * and start a fresh inspector for the new page. The UI reconnects (it watches the generation).
   */
  retrack(pane: PaneSession): void {
    for (const ws of this.sockets) if (ws.data.paneId === pane.id) ws.close(1012, 'The page was replaced');
    this.inspectors.delete(pane.id);
    this.setInspecting(pane.id, false);
    this.track(pane);
  }

  async frontend(url: URL): Promise<Response> {
    const dt = this.panes()[0]?.devtools;
    if (!dt) return new Response('Chrome DevTools needs the Chromium pane, which is not running.', { status: 503 });
    const upstream = await fetch(`http://127.0.0.1:${dt.port}${url.pathname}${url.search}`).catch(() => null);
    if (!upstream) return new Response('The Chromium pane is not answering.', { status: 502 });
    const headers = new Headers(upstream.headers);
    headers.delete('content-encoding'); // fetch() already decompressed the body
    headers.delete('content-length');
    return new Response(upstream.body, { status: upstream.status, headers });
  }

  open(ws: Socket): void {
    this.sockets.add(ws);
    const pane = this.panes()[ws.data.paneId];
    if (!pane?.ready) {
      ws.close(1011, 'This engine is not running');
      return;
    }
    if (pane.devtools) {
      const upstream = new WebSocket(`ws://127.0.0.1:${pane.devtools.port}/devtools/page/${pane.devtools.targetId}`);
      upstream.binaryType = 'arraybuffer';
      ws.data.upstream = upstream;
      ws.data.pending = [];
      upstream.onopen = () => {
        for (const m of ws.data.pending ?? []) upstream.send(m);
        ws.data.pending = undefined;
      };
      upstream.onmessage = (e) => ws.send(e.data as string | ArrayBuffer);
      upstream.onclose = () => ws.close();
      upstream.onerror = () => ws.close(1011, 'Chromium DevTools connection failed');
      return;
    }
    const inspector = this.inspectors.get(pane.id);
    if (!inspector) {
      ws.close(1011, 'This engine is not ready yet');
      return;
    }
    ws.data.detach = inspector.connect((msg) => ws.send(msg));
  }

  message(ws: Socket, data: string | Buffer): void {
    const { upstream } = ws.data;
    if (upstream) {
      // Notice Chromium's element picker too, so synced clicks don't hit the other panes.
      const text = typeof data === 'string' ? data : data.toString(); // CDP is JSON text
      if (text.includes('"Overlay.setInspectMode"')) {
        try {
          this.setInspecting(ws.data.paneId, JSON.parse(text).params?.mode !== 'none');
        } catch {
          // not JSON; ignore
        }
      }
      if (ws.data.pending) ws.data.pending.push(text);
      else upstream.send(text);
      return;
    }
    this.inspectors.get(ws.data.paneId)?.handle(typeof data === 'string' ? data : data.toString());
  }

  close(ws: Socket): void {
    this.sockets.delete(ws);
    ws.data.upstream?.close();
    ws.data.detach?.();
    this.setInspecting(ws.data.paneId, false);
  }

  closeAll(): void {
    for (const ws of this.sockets) ws.close();
  }

  private setInspecting(id: PaneId, on: boolean): void {
    if (on) this.inspecting.add(id);
    else this.inspecting.delete(id);
  }
}
