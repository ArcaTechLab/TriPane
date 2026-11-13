import { ArrowLeft, ArrowRight, Code, LoaderCircle, RotateCw, Settings as SettingsIcon, X } from 'lucide-preact';
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { DEFAULT_SETTINGS, type DevtoolsDock, type PaneId, type Settings } from '../../shared/protocol';
import { useEngine } from './engine';
import { DeviceBar } from './DeviceBar';
import { clampDockSize, DevToolsDock, type DockSide, type DockTab } from './DevToolsDock';
import { devtoolsWindowUrl, isEngineTab, openDevtoolsChannel } from './devtoolsChannel';
import { CLICK_MARK_MS, Pane, type ClickMark } from './Pane';
import { SettingsDialog } from './SettingsDialog';
import { AddressBar } from './AddressBar';
import { EngineDiffDialog } from './EngineDiffDialog';
import { HistoryDialog } from './HistoryDialog';
import { StatusMenu } from './StatusMenu';
import { ToolsMenu } from './ToolsMenu';
import { useUiTheme } from './theme';
import { WebKitNotice } from './WebKitNotice';
import { SavedTraces, TraceIndicator } from './Tracing';
import { btn, cx, ICON, Toggle } from './ui';

const DEVTOOLS_WINDOW = 'tripane-devtools';

// --panes is the number of engines shown (Settings → Engines can turn some off).
const LAYOUT_CLASS = {
  // Side by side, stacked on narrow windows.
  columns: 'grid-rows-[repeat(var(--panes),minmax(0,1fr))] min-[901px]:grid-cols-[repeat(var(--panes),minmax(0,1fr))] min-[901px]:grid-rows-1',
  rows: 'grid-rows-[repeat(var(--panes),minmax(0,1fr))]',
  focus: 'grid-cols-1',
} as const;

export function App() {
  const { client, state } = useEngine();
  const { settings, status } = state;
  // Every engine's info (indexed by pane id), and the ones that are on (Settings → Engines).
  const allPanes = state.panes;
  const panes = allPanes.filter((p) => !p.disabled);
  const urlRef = useRef<HTMLInputElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [diffOpen, setDiffOpen] = useState(false);
  const [focusedPane, setFocusedPane] = useState<PaneId | null>(null);
  const [shooting, setShooting] = useState(false);
  const [devtoolsOpen, setDevtoolsOpen] = useState(false);
  const [devtoolsPane, setDevtoolsPane] = useState<DockTab>(0);
  const [selectedPane, setSelectedPane] = useState<PaneId>(0);
  /** Choosing an engine tab in DevTools also selects that pane. */
  const selectDockTab = useCallback((tab: DockTab) => {
    setDevtoolsPane(tab);
    if (isEngineTab(tab)) setSelectedPane(tab);
  }, []);
  // Where DevTools is docked (bottom, left or right) and its size: the height at the bottom, the
  // width at a side, each remembered separately. They're saved in the server's settings, not
  // localStorage: this page's origin has a new port every start, so localStorage starts empty.
  const savedDock = settings?.devtoolsDock ?? DEFAULT_SETTINGS.devtoolsDock;
  const dockSide: DockSide = savedDock.side;
  // While dragging, the size is local; it's saved once the drag pauses.
  const [liveDockSize, setLiveDockSize] = useState<{ side: DockSide; size: number } | null>(null);
  const dockSaveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const dockSize = clampDockSize(
    dockSide,
    liveDockSize?.side === dockSide
      ? liveDockSize.size
      : dockSide === 'bottom'
        ? (savedDock.height ?? Math.round(window.innerHeight * 0.42))
        : (savedDock.width ?? Math.round(window.innerWidth * 0.4)),
  );
  const saveDock = useCallback(
    (dock: Partial<DevtoolsDock>) => client.send({ type: 'settings', settings: { devtoolsDock: dock as DevtoolsDock } }),
    [client],
  );
  const resizeDock = useCallback(
    (size: number) => {
      setLiveDockSize({ side: dockSide, size });
      clearTimeout(dockSaveTimer.current);
      dockSaveTimer.current = setTimeout(() => saveDock({ [dockSide === 'bottom' ? 'height' : 'width']: Math.round(size) }), 250);
    },
    [dockSide, saveDock],
  );
  const moveDock = useCallback((side: DockSide) => saveDock({ side }), [saveDock]);
  // ---- element compare: picking happens in this window's panes -------------------------------
  const [picking, setPicking] = useState(false);
  const pickingRef = useRef(false);
  pickingRef.current = picking;
  const stopPicking = useCallback(() => {
    if (!pickingRef.current) return;
    setPicking(false);
    client.send({ type: 'probeEnd' });
  }, [client]);

  // ---- popped-out DevTools window -----------------------------------------------------------
  const [poppedOut, setPoppedOut] = useState(false);
  const poppedRef = useRef(false);
  poppedRef.current = poppedOut;
  const popup = useRef<Window | null>(null);
  const channel = useRef<ReturnType<typeof openDevtoolsChannel> | null>(null);

  useEffect(() => {
    const ch = openDevtoolsChannel((msg) => {
      if (msg.type === 'here') {
        // A DevTools window is open (e.g. this window was reloaded): don't also show the dock.
        setPoppedOut(true);
        setDevtoolsOpen(false);
        setDevtoolsPane(msg.tab);
      } else if (msg.type === 'closed') {
        setPoppedOut(false);
        popup.current = null;
      } else if (msg.type === 'dock') {
        setPoppedOut(false);
        popup.current = null;
        setDevtoolsPane(msg.tab);
        if (isEngineTab(msg.tab)) setSelectedPane(msg.tab);
        setDevtoolsOpen(true);
      } else if (msg.type === 'pick') {
        setPicking((p) => !p);
      } else if (msg.type === 'select') {
        setDevtoolsPane(msg.tab);
        if (isEngineTab(msg.tab)) setSelectedPane(msg.tab);
      }
    });
    channel.current = ch;
    ch.post({ type: 'ping' });
    return () => ch.close();
  }, []);

  const focusPopup = useCallback(() => {
    // After a reload the reference is gone; window.open with the same name finds the window again.
    const w = popup.current ?? window.open('', DEVTOOLS_WINDOW);
    w?.focus();
  }, []);

  const popOut = useCallback(() => {
    const w = window.open(devtoolsWindowUrl(devtoolsPane), DEVTOOLS_WINDOW, 'popup,width=1280,height=760');
    if (!w) return; // blocked; the dock stays
    popup.current = w;
    setPoppedOut(true);
    setDevtoolsOpen(false);
  }, [devtoolsPane]);

  /** Shows DevTools for an engine (or the unified log): in the popped-out window if there is one. */
  const showDevTools = useCallback(
    (tab: DockTab) => {
      setDevtoolsPane(tab);
      if (isEngineTab(tab)) setSelectedPane(tab);
      if (poppedRef.current) {
        channel.current?.post({ type: 'select', tab });
        focusPopup();
      } else {
        setDevtoolsOpen(true);
      }
    },
    [focusPopup],
  );

  /** Compare: show the Compare tab and start (or cancel) picking an element. */
  const togglePick = useCallback(() => {
    if (pickingRef.current) {
      stopPicking();
      return;
    }
    setDevtoolsPane('compare');
    if (poppedRef.current) channel.current?.post({ type: 'select', tab: 'compare' });
    else setDevtoolsOpen(true);
    setPicking(true);
  }, [stopPicking]);

  const toggleDevTools = useCallback(() => {
    if (poppedRef.current) focusPopup();
    else setDevtoolsOpen((o) => !o);
  }, [focusPopup]);

  // An engine that's turned off can't stay selected, inspected or focused: move to one that's on.
  const shownIds = panes.map((p) => p.id).join();
  useEffect(() => {
    const first = panes[0]?.id;
    if (first === undefined) return;
    if (allPanes[selectedPane]?.disabled) setSelectedPane(first);
    if (isEngineTab(devtoolsPane) && allPanes[devtoolsPane]?.disabled) {
      setDevtoolsPane(first);
      if (poppedRef.current) channel.current?.post({ type: 'select', tab: first });
    }
    if (focusedPane !== null && allPanes[focusedPane]?.disabled) setFocusedPane(null);
  }, [shownIds]);

  // The address bar follows the first engine that is running.
  const lead = panes.find((p) => !p.failed);
  const anyLoading = panes.some((p) => p.loading);

  const focusUrlBar = useCallback(() => {
    urlRef.current?.focus();
    urlRef.current?.select();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        focusUrlBar();
      }
      // History: Ctrl+H (Cmd+Y on macOS, where Cmd+H hides the app).
      if ((e.ctrlKey && !e.metaKey && e.key.toLowerCase() === 'h') || (e.metaKey && e.key.toLowerCase() === 'y')) {
        e.preventDefault();
        setHistoryOpen(true);
      }
      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setSettingsOpen(true);
      }
      if (e.key === 'Escape' && pickingRef.current) {
        e.preventDefault();
        stopPicking();
      }
      if (e.key === 'F12' || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'i')) {
        e.preventDefault();
        toggleDevTools();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focusUrlBar, toggleDevTools, stopPicking]);

  useEffect(() => {
    if (state.screenshots) setShooting(false);
  }, [state.screenshots]);

  const updateSettings = (patch: Partial<Settings>) => client.send({ type: 'settings', settings: patch });
  // Layout and themes live in the server's settings, so they're saved with the profile.
  const layout = settings?.layout ?? 'columns';
  const uiTheme = settings?.uiTheme;

  useUiTheme(uiTheme);

  // ---- show clicks: a ripple where each click lands, in every pane it's replayed to -------------
  const [clicks, setClicks] = useState<ClickMark[]>([]);
  const clickSeq = useRef(0);
  const showClicksRef = useRef(true);
  showClicksRef.current = settings?.showClicks ?? true;
  // Click ripples show in every pane only when the click lands at the same point in each: with
  // different sizes, synced clicks are mapped to the element instead (and only the source shows one).
  const sizesDiffer = panes.some((p) => p.device !== panes[0]?.device || p.viewport.width !== panes[0]?.viewport.width || p.viewport.height !== panes[0]?.viewport.height);
  const syncRef = useRef(true);
  syncRef.current = (settings?.sync ?? true) && !sizesDiffer;
  const showClick = useCallback((source: PaneId, x: number, y: number) => {
    if (!showClicksRef.current) return;
    const mark: ClickMark = { id: ++clickSeq.current, source, all: syncRef.current, x, y };
    setClicks((c) => [...c, mark]);
    setTimeout(() => setClicks((c) => c.filter((k) => k.id !== mark.id)), CLICK_MARK_MS);
  }, []);

  const dock = devtoolsOpen && panes.length > 0 && (
    <DevToolsDock
      panes={allPanes}
      log={state.log}
      selected={devtoolsPane}
      onClearLog={() => client.clearLog()}
      side={dockSide}
      size={dockSize}
      onSelect={selectDockTab}
      onResize={resizeDock}
      onSide={moveDock}
      onClose={() => setDevtoolsOpen(false)}
      compare={state.compare}
      picking={picking}
      onPick={togglePick}
      onRefreshCompare={() => state.compare && client.send({ type: 'compare', ref: state.compare.ref })}
      mode="docked"
      onPopOut={popOut}
    />
  );

  return (
    <div class="flex h-full flex-col">
      <header class="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-chrome px-3 py-2">
        <div class="flex gap-0.5">
          <button type="button" class={btn('ghost', { icon: true })} title="Back" aria-label="Back" onClick={() => client.send({ type: 'history', action: 'back' })}>
            <ArrowLeft size={ICON + 1} />
          </button>
          <button type="button" class={btn('ghost', { icon: true })} title="Forward" aria-label="Forward" onClick={() => client.send({ type: 'history', action: 'forward' })}>
            <ArrowRight size={ICON + 1} />
          </button>
          <button type="button" class={btn('ghost', { icon: true })} title="Reload" aria-label="Reload" onClick={() => client.send({ type: 'history', action: 'reload' })}>
            {anyLoading ? <LoaderCircle size={ICON} class="animate-spin text-accent" /> : <RotateCw size={ICON} />}
          </button>
        </div>

        <AddressBar client={client} url={lead?.url ?? ''} siteInfo={state.siteInfo} network={state.network} history={state.history} panes={panes} inputRef={urlRef} />

        <div class="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
          <Toggle label="Sync input" checked={settings?.sync ?? true} onChange={(sync) => updateSettings({ sync })}
            title="Replay clicks, typing and hover in every pane" />
          <Toggle label="Sync scroll" checked={settings?.scrollSync ?? true} onChange={(scrollSync) => updateSettings({ scrollSync })}
            title="Keep every pane at the same scroll percentage" />
          <Toggle label="Follow links" checked={settings?.linkFollow ?? true} onChange={(linkFollow) => updateSettings({ linkFollow })}
            title="When one pane navigates, the others go to the same URL" />
          <Toggle label="Highlight" checked={settings?.highlight ?? true} onChange={(highlight) => updateSettings({ highlight })}
            title="Outline the hovered element in all three engines" />
          <Toggle label="Show clicks" checked={settings?.showClicks ?? true} onChange={(showClicks) => updateSettings({ showClicks })}
            title="Show a ripple where each click lands, in every pane it's replayed to" />

          <button
            type="button"
            class={btn('ghost', { pressed: devtoolsOpen || poppedOut })}
            aria-pressed={devtoolsOpen || poppedOut}
            title="Console, Elements and Network for the selected engine (F12)"
            onClick={toggleDevTools}
          >
            <Code size={ICON} /> <span class="trim-cap">DevTools</span>
          </button>
          {state.tracing && <TraceIndicator tracing={state.tracing} onStop={() => client.send({ type: 'trace', action: 'stop' })} />}
          <ToolsMenu
            picking={picking}
            onCompare={togglePick}
            onHistory={() => setHistoryOpen(true)}
            onEngineDiff={() => setDiffOpen(true)}
            shooting={shooting}
            onScreenshot={() => {
              setShooting(true);
              client.send({ type: 'screenshot' });
            }}
            tracing={state.tracing}
            onTrace={() => {
              client.dismissTraces();
              client.send({ type: 'trace', action: state.tracing ? 'stop' : 'start' });
            }}
          />
          <button
            type="button"
            class={btn('ghost', { icon: true })}
            title="Settings (Ctrl+,)"
            aria-label="Settings"
            aria-haspopup="dialog"
            onClick={() => setSettingsOpen(true)}
          >
            <SettingsIcon size={ICON + 1} />
          </button>
          <StatusMenu client={client} state={state} />
        </div>
      </header>

      <DeviceBar client={client} panes={panes} settings={settings} devices={state.devices} />

      {(state.screenshots || state.traces || state.error || state.notice) && (
        <div
          class={cx(
            'flex items-center gap-2 border-b border-line px-3 py-1.5',
            state.error ? 'bg-[color-mix(in_srgb,var(--danger)_18%,var(--chrome))]' : 'bg-[color-mix(in_srgb,var(--webkit)_15%,var(--chrome))]',
          )}
          role="status"
        >
          <span class="flex-1 wrap-anywhere">
            {state.error ? (
              state.error
            ) : state.notice ? (
              state.notice
            ) : state.traces ? (
              <SavedTraces dir={state.traces.dir} traces={state.traces.traces} />
            ) : (
              <>
                Saved {state.screenshots!.files.length} full-page screenshots to <code>{state.screenshots!.dir}</code>
              </>
            )}
          </span>
          <button
            type="button"
            class={btn('ghost', { icon: true })}
            aria-label="Dismiss"
            onClick={() => {
              client.dismissScreenshots();
              client.dismissTraces();
              client.dismissError();
              client.dismissNotice();
            }}
          >
            <X size={ICON} />
          </button>
        </div>
      )}

      {status === 'closed' && allPanes.length === 0 && (
        <div class="px-6 py-12 text-center">
          <h1 class="mb-3 text-xl font-bold">Can't reach the TriPane engine</h1>
          <p>
            Start it with <code>bun start</code> and open the URL it prints. That URL includes the access token.
          </p>
        </div>
      )}

      {/* The panes and the docked DevTools share the space below the bars: stacked when DevTools is
          at the bottom, side by side when it's docked left or right. */}
      <div class={cx('flex min-h-0 flex-1', dockSide === 'bottom' ? 'flex-col' : 'flex-row')}>
      {dockSide === 'left' && dock}
      <main
        class={cx('grid min-h-0 min-w-0 flex-1 gap-px bg-line', LAYOUT_CLASS[focusedPane === null ? layout : 'focus'])}
        style={{ '--panes': String(Math.max(1, panes.length)) }}
      >
        {panes.map((p) =>
          focusedPane !== null && focusedPane !== p.id ? null : (
            <Pane
              key={p.id}
              client={client}
              info={p}
              update={(() => {
                const u = state.updates?.engines.find((e) => e.engine === p.engine && e.update);
                return u?.latest ? { latest: u.latest, playwright: state.updates!.playwright.latest } : undefined;
              })()}
              inspected={(devtoolsOpen || poppedOut) && devtoolsPane === p.id}
              onOpenDevTools={() => showDevTools(p.id)}
              selected={selectedPane === p.id}
              onActivate={() => {
                setSelectedPane(p.id);
                if ((devtoolsOpen || poppedOut) && isEngineTab(devtoolsPane)) {
                  setDevtoolsPane(p.id);
                  if (poppedOut) channel.current?.post({ type: 'select', tab: p.id });
                }
              }}
              focused={focusedPane === p.id}
              onToggleFocus={() => setFocusedPane(focusedPane === p.id ? null : p.id)}
              onFocusUrlBar={focusUrlBar}
              device={state.devices.find((d) => d.name === p.device) ?? null}
              frames={settings?.deviceFrames ?? true}
              darkPage={settings?.colorScheme === 'dark'}
              picking={picking}
              onPicked={() => setPicking(false)}
              highlight={settings?.highlight ?? true}
              clicks={clicks.filter((c) => c.all || c.source === p.id)}
              onPress={(x, y) => showClick(p.id, x, y)}
            />
          ),
        )}
      </main>
      {dockSide !== 'left' && dock}
      </div>

      <EngineDiffDialog
        open={diffOpen}
        client={client}
        panes={panes}
        visual={state.visualDiff}
        aria={state.ariaDiff}
        busy={state.diffBusy}
        error={state.error}
        onClose={() => setDiffOpen(false)}
      />
      {/* First start only: once dismissed it's saved in the settings. */}
      <WebKitNotice open={!!settings && !settings.webkitNoticeSeen} onClose={() => updateSettings({ webkitNoticeSeen: true })} />
      <HistoryDialog open={historyOpen} history={state.history} client={client} saved={!!state.storageDir} onClose={() => setHistoryOpen(false)} />
      <SettingsDialog
        open={settingsOpen}
        layout={layout}
        uiTheme={uiTheme ?? 'dark'}
        onUiTheme={(next) => updateSettings({ uiTheme: next })}
        colorScheme={settings?.colorScheme ?? 'light'}
        onLayout={(next) => updateSettings({ layout: next })}
        onColorScheme={(colorScheme) => updateSettings({ colorScheme })}
        updates={state.updates}
        checkingUpdates={state.checkingUpdates}
        onCheckUpdates={() => client.checkUpdates()}
        autoUpdateCheck={settings?.autoUpdateCheck ?? true}
        onAutoUpdateCheck={(autoUpdateCheck) => updateSettings({ autoUpdateCheck })}
        storageDir={state.storageDir}
        onClearStorage={() => client.clearStorage()}
        panes={allPanes}
        engines={settings?.engines ?? { chromium: true, firefox: true, webkit: true }}
        onEngines={(engines) => updateSettings({ engines })}
        frameFormat={settings?.frameFormat ?? DEFAULT_SETTINGS.frameFormat}
        onFrameFormat={(frameFormat) => updateSettings({ frameFormat })}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
