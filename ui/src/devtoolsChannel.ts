import type { PaneId } from '../../shared/protocol';

/** A DevTools tab: one engine's Chrome DevTools, the unified log, or element Compare. */
export type DockTab = PaneId | 'log' | 'compare';

export const isEngineTab = (tab: DockTab): tab is PaneId => typeof tab === 'number';

/** Messages between the main window and a popped-out DevTools window. */
export type ChannelMessage =
  /** Either side: the selected tab changed (the main window: a pane was clicked). */
  | { type: 'select'; tab: DockTab }
  /** DevTools window: put me back in the main window's dock, showing this tab. */
  | { type: 'dock'; tab: DockTab }
  /** DevTools window: I was closed. */
  | { type: 'closed' }
  /** Main window (after a reload): is a DevTools window open? */
  | { type: 'ping' }
  /** DevTools window: yes, showing this tab. */
  | { type: 'here'; tab: DockTab }
  /** DevTools window: start picking an element to compare (picking happens in the main window). */
  | { type: 'pick' };

/**
 * Both windows are served from TriPane's origin, so a BroadcastChannel connects them. It is
 * scoped by the session token so two TriPane instances never talk to each other.
 */
export function openDevtoolsChannel(onMessage: (msg: ChannelMessage) => void) {
  const token = new URLSearchParams(location.search).get('token') ?? '';
  const channel = new BroadcastChannel(`tripane-devtools:${token}`);
  channel.onmessage = (e) => onMessage(e.data as ChannelMessage);
  return {
    post: (msg: ChannelMessage) => channel.postMessage(msg),
    close: () => channel.close(),
  };
}

/** URL of the popped-out DevTools window: the same app, in DevTools-only mode. */
export function devtoolsWindowUrl(tab: DockTab): string {
  const params = new URLSearchParams(location.search);
  params.set('view', 'devtools');
  params.set('tab', String(tab));
  return `${location.pathname}?${params}`;
}
