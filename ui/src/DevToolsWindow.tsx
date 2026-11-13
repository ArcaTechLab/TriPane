import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { DevToolsDock } from './DevToolsDock';
import { openDevtoolsChannel, type DockTab } from './devtoolsChannel';
import { useEngine } from './engine';
import { useUiTheme } from './theme';

function initialTab(): DockTab {
  const t = new URLSearchParams(location.search).get('tab');
  if (t === '0' || t === '1' || t === '2') return Number(t) as DockTab;
  return t === 'compare' ? 'compare' : 'log';
}

/**
 * DevTools popped out into its own window (opened by the main window with ?view=devtools).
 * It has its own connection to the engines and stays in step with the main window through a
 * BroadcastChannel: clicking a pane there switches the tab here, and the other way round.
 */
export function DevToolsWindow() {
  const { client, state } = useEngine();
  const [tab, setTab] = useState<DockTab>(initialTab);
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const channel = useRef<ReturnType<typeof openDevtoolsChannel> | null>(null);
  const docking = useRef(false);

  useUiTheme(state.settings?.uiTheme);
  useEffect(() => {
    document.title = 'TriPane DevTools';
  }, []);

  useEffect(() => {
    const ch = openDevtoolsChannel((msg) => {
      if (msg.type === 'select') setTab(msg.tab);
      if (msg.type === 'ping') ch.post({ type: 'here', tab: tabRef.current });
    });
    channel.current = ch;
    ch.post({ type: 'here', tab: tabRef.current });
    const onHide = () => {
      if (!docking.current) ch.post({ type: 'closed' });
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      ch.close();
    };
  }, []);

  const select = useCallback((t: DockTab) => {
    setTab(t);
    channel.current?.post({ type: 'select', tab: t });
  }, []);

  const dock = useCallback(() => {
    docking.current = true;
    channel.current?.post({ type: 'dock', tab: tabRef.current });
    window.close();
  }, []);

  // F12 / Ctrl+Shift+I (also when forwarded from inside DevTools) close this window, like closing the dock.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F12' || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'i')) {
        e.preventDefault();
        window.close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div class="flex h-full flex-col">
      {state.panes.length > 0 ? (
        <DevToolsDock
          mode="window"
          panes={state.panes}
          log={state.log}
          selected={tab}
          onSelect={select}
          onClearLog={() => client.clearLog()}
          onDock={dock}
          onClose={() => window.close()}
          compare={state.compare}
          picking={false}
          onPick={() => channel.current?.post({ type: 'pick' })}
          onRefreshCompare={() => state.compare && client.send({ type: 'compare', ref: state.compare.ref })}
        />
      ) : (
        <div class="h-full bg-chrome p-6 text-muted">{state.status === 'closed' ? 'Not connected to TriPane.' : 'Connecting…'}</div>
      )}
    </div>
  );
}
