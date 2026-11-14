import type { LucideIcon } from 'lucide-preact';
import { guardBrowserShortcuts } from './shortcuts';
import { Crosshair, PanelBottom, PanelLeft, PanelRight, PictureInPicture2, X } from 'lucide-preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { CompareResult, LogEntry, PaneId, PaneInfo } from '../../shared/protocol';
import { ComparePanel } from './ComparePanel';
import { isEngineTab, type DockTab } from './devtoolsChannel';
import { ENGINE_LABEL } from './Pane';
import { btn, cx, ENGINE_CLASS, EngineDot, ICON } from './ui';
import { applyNavigations, UnifiedLog } from './UnifiedLog';

export type { DockTab } from './devtoolsChannel';

interface Props {
  panes: PaneInfo[];
  log: LogEntry[];
  selected: DockTab;
  onSelect(tab: DockTab): void;
  onClearLog(): void;
  onClose(): void;
  /** Element compare. */
  compare: CompareResult | null;
  picking: boolean;
  onPick(): void;
  onRefreshCompare(): void;
  /**
   * 'docked': in the main window (bottom, left or right), resizable, with dock-side buttons.
   * 'window': fills its own window, with a button to dock it back.
   */
  mode: 'docked' | 'window';
  /** Docked mode: which side, and the dock's height (bottom) or width (left, right) in CSS px. */
  side?: DockSide;
  size?: number;
  onResize?(size: number): void;
  onSide?(side: DockSide): void;
  onPopOut?(): void;
  /** Window mode. */
  onDock?(): void;
}

export type DockSide = 'bottom' | 'left' | 'right';

const MIN_HEIGHT = 120;
const MIN_WIDTH = 320;
/** Room always left for the panes. */
const KEEP_FOR_PANES = { height: 160, width: 320 };

/** Keeps a dock size within the window, leaving room for the panes. */
export function clampDockSize(side: DockSide, size: number): number {
  return side === 'bottom'
    ? Math.max(MIN_HEIGHT, Math.min(window.innerHeight - KEEP_FOR_PANES.height, size))
    : Math.max(MIN_WIDTH, Math.min(window.innerWidth - KEEP_FOR_PANES.width, size));
}

const SIDES: { side: DockSide; icon: LucideIcon; label: string }[] = [
  { side: 'left', icon: PanelLeft, label: 'Dock to left' },
  { side: 'bottom', icon: PanelBottom, label: 'Dock to bottom' },
  { side: 'right', icon: PanelRight, label: 'Dock to right' },
];

/** TriPane's own shortcuts: settings and the DevTools toggle. (Ctrl+L stays with DevTools: it clears the Console.) */
const isAppShortcut = (e: KeyboardEvent) =>
  e.key === 'F12' || ((e.ctrlKey || e.metaKey) && (e.key === ',' || (e.shiftKey && e.key.toLowerCase() === 'i')));

/**
 * While DevTools has keyboard focus, keystrokes go to its iframe, not the app. The frontend is
 * served from TriPane's own origin, so the app can listen inside it and pass its shortcuts on.
 */
function forwardAppShortcuts(frame: HTMLIFrameElement) {
  const win = frame.contentWindow;
  if (!win) return;
  guardBrowserShortcuts(win, { afterPage: true });
  win.addEventListener(
    'keydown',
    (e) => {
      if (!isAppShortcut(e)) return;
      e.preventDefault();
      e.stopPropagation();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey }));
    },
    true,
  );
}

/**
 * DevTools preferences TriPane sets for every engine's DevTools. The frontend is served from
 * TriPane's origin, where it keeps its preferences in localStorage (one key per setting, values as
 * JSON), so they're written there before a DevTools frame loads. That origin changes every start,
 * so they're written each time.
 *   chrome-theme-colors       "Match Chrome color scheme" off: DevTools uses its own colors, not a
 *                             tint taken from the Chromium pane's browser.
 *   disable-self-xss-warning  pasting works straight away in the Console and Sources, without
 *                             typing "allow pasting" first.
 */
const DEVTOOLS_PREFERENCES: Record<string, unknown> = {
  'chrome-theme-colors': false,
  'disable-self-xss-warning': true,
};

function presetDevToolsPreferences(): void {
  try {
    for (const [name, value] of Object.entries(DEVTOOLS_PREFERENCES)) localStorage.setItem(name, JSON.stringify(value));
  } catch {
    // storage blocked: DevTools keeps its defaults
  }
}

/** The real Chrome DevTools frontend, connected to the chosen engine's CDP endpoint. */
export function devtoolsUrl(id: PaneId): string {
  presetDevToolsPreferences();
  const token = new URLSearchParams(location.search).get('token') ?? '';
  // disableSelfXssWarnings: the Console's own switch for the paste warning, besides the setting.
  return `/devtools/devtools_app.html?ws=${location.host}/cdp/${encodeURIComponent(token)}/${id}&disableSelfXssWarnings=true`;
}

export function DevToolsDock(props: Props) {
  const { panes, log, selected, mode, size, onSelect, onClearLog, onResize, onSide, onClose, onPopOut, onDock } = props;
  const side: DockSide = props.side ?? 'bottom';
  const vertical = mode === 'docked' && side !== 'bottom'; // docked beside the panes
  // Each engine keeps its own DevTools (and its history) once opened; switching tabs only hides it.
  const [opened, setOpened] = useState<Set<PaneId>>(() => new Set(isEngineTab(selected) ? [selected] : []));
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    if (isEngineTab(selected)) setOpened((s) => (s.has(selected) ? s : new Set(s).add(selected)));
  }, [selected]);
  // Errors since each engine's last page load (a reload starts the count again, like the pane badges).
  const logErrors = useMemo(() => applyNavigations(log, false).filter((e) => e.level === 'error').length, [log]);

  const chromiumUp = panes[0] && !panes[0].failed && panes[0].version;

  /** Flat tabs, as in Chrome DevTools: the selected one is underlined in its engine's color. */
  const tab = (on: boolean, accent: 'engine' | 'accent') =>
    cx(
      'relative inline-flex flex-none items-center gap-1.5 whitespace-nowrap px-3 transition-colors',
      'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent',
      // The underline sits on the header's bottom border.
      'after:absolute after:inset-x-1.5 after:-bottom-px after:h-0.5 after:rounded-t-sm',
      on
        ? cx('text-fg', accent === 'engine' ? 'after:bg-engine' : 'after:bg-accent')
        : 'text-muted hover:bg-chrome-2 hover:text-fg',
    );
  const errorCount = (n: number) => <CountBadge n={n} />;
  const empty = 'h-full bg-chrome p-6 text-muted';

  return (
    <section
      class={cx(
        'relative flex flex-col bg-chrome',
        mode === 'window' && 'min-h-0 flex-1',
        mode === 'docked' && side === 'bottom' && 'min-h-[120px] flex-none border-t border-line',
        mode === 'docked' && side === 'left' && 'min-w-0 flex-none border-r border-line',
        mode === 'docked' && side === 'right' && 'min-w-0 flex-none border-l border-line',
      )}
      style={mode === 'docked' ? (vertical ? { width: `${size}px` } : { height: `${size}px` }) : undefined}
      aria-label="DevTools"
    >
      {mode === 'docked' && (
        // The resize handle sits on the edge that faces the panes.
        <div
          class={cx(
            'absolute z-10 touch-none hover:bg-accent/40 active:bg-accent/40',
            side === 'bottom' && 'inset-x-0 -top-1 h-2 cursor-ns-resize',
            side === 'left' && 'inset-y-0 -right-1 w-2 cursor-ew-resize',
            side === 'right' && 'inset-y-0 -left-1 w-2 cursor-ew-resize',
          )}
          role="separator"
          aria-orientation={vertical ? 'vertical' : 'horizontal'}
          aria-label="Resize DevTools"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setDragging(true);
          }}
          onPointerMove={(e) => {
            if (!dragging) return;
            const next = side === 'bottom' ? window.innerHeight - e.clientY : side === 'right' ? window.innerWidth - e.clientX : e.clientX;
            onResize?.(clampDockSize(side, next));
          }}
          onPointerUp={() => setDragging(false)}
        />
      )}
      <header class="flex h-9 min-w-0 flex-none items-stretch gap-2.5 border-b border-line pl-2 pr-1 [&>:not([role=tablist])]:self-center">
        {!vertical && <strong class="trim-cap flex-none">DevTools</strong>}
        {/* Beside the panes the dock is narrow: the tabs scroll sideways instead of overflowing. */}
        <div class={cx('flex items-stretch', vertical ? 'min-w-0 overflow-x-auto [scrollbar-width:none]' : 'flex-none')} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={selected === 'log'}
            class={tab(selected === 'log', 'accent')}
            onClick={() => onSelect('log')}
            title="Console messages from all three engines in one timeline"
          >
            <span class="inline-flex gap-0.5" aria-hidden>
              <EngineDot engine="chromium" class="size-1.5" />
              <EngineDot engine="firefox" class="size-1.5" />
              <EngineDot engine="webkit" class="size-1.5" />
            </span>
            <span class="trim-cap">All consoles</span>
            {logErrors > 0 && errorCount(logErrors)}
          </button>
          <span class="mx-1.5 h-[18px] w-px self-center bg-line" aria-hidden />
          {panes.filter((p) => !p.disabled).map((p) => (
            <button
              key={p.id}
              type="button"
              role="tab"
              aria-selected={p.id === selected}
              class={cx(tab(p.id === selected, 'engine'), ENGINE_CLASS[p.engine])}
              onClick={() => onSelect(p.id)}
            >
              <EngineDot />
              <span class="trim-cap">{ENGINE_LABEL[p.engine]}</span>
              {p.errors > 0 && errorCount(p.errors)}
            </button>
          ))}
          <span class="mx-1.5 h-[18px] w-px self-center bg-line" aria-hidden />
          <button
            type="button"
            role="tab"
            aria-selected={selected === 'compare'}
            class={tab(selected === 'compare', 'accent')}
            onClick={() => onSelect('compare')}
            title="Compare one element’s box model and computed styles across the three engines"
          >
            <Crosshair size={13} /> <span class="trim-cap">Compare</span>
          </button>
        </div>
        <span class={cx('trim-cap-clip min-w-0 flex-1 truncate text-[11.5px] text-muted', vertical && 'hidden')}>
          {selected === 'log'
            ? 'Every engine’s console, merged by time. Identical messages are grouped; the ones some engines didn’t log are flagged.'
            : selected === 'compare'
              ? 'One element in all three engines. Values that differ from the other engines are highlighted.'
              : panes[selected]?.engine === 'chromium'
                ? 'Direct connection: every panel works.'
                : 'Through TriPane’s adapter: Console, Elements, Network and Sources (read-only). Debugger and profilers are Chromium-only.'}
        </span>
        {vertical && <span class="flex-1" />}
        {mode === 'docked' ? (
          // Dock side, as in Chrome DevTools: left, bottom, right, or its own window.
          <div class="flex flex-none items-center gap-px" role="group" aria-label="Dock side">
            {SIDES.map(({ side: s, icon: Icon, label }) => (
              <button
                key={s}
                type="button"
                class={btn('ghost', { icon: true, small: true, pressed: s === side })}
                aria-pressed={s === side}
                aria-label={label}
                title={label}
                onClick={() => onSide?.(s)}
              >
                <Icon size={ICON - 1} />
              </button>
            ))}
            <button type="button" class={btn('ghost', { icon: true, small: true })} onClick={onPopOut} aria-label="Pop out DevTools" title="Open DevTools in a separate window">
              <PictureInPicture2 size={ICON - 1} />
            </button>
          </div>
        ) : (
          <button type="button" class={btn('ghost')} onClick={onDock} title="Put DevTools back in the TriPane window">
            <PanelBottom size={ICON} /> <span class="trim-cap">Dock</span>
          </button>
        )}
        <button
          type="button"
          class={btn('ghost', { icon: true })}
          onClick={onClose}
          aria-label="Close DevTools"
          title={mode === 'docked' ? 'Close (F12)' : 'Close this window'}
        >
          <X size={ICON} />
        </button>
      </header>
      <div class="relative min-h-0 flex-1 bg-bg">
        {selected === 'log' && <UnifiedLog entries={log} panes={panes} onClear={onClearLog} onOpenEngine={onSelect} />}
        {selected === 'compare' && (
          <ComparePanel result={props.compare} panes={panes} picking={props.picking} onPick={props.onPick} onRefresh={props.onRefreshCompare} />
        )}
        {!chromiumUp ? (
          isEngineTab(selected) && <div class={empty}>Chrome DevTools is served by the Chromium pane, which isn’t running.</div>
        ) : (
          panes.map((p) =>
            opened.has(p.id) ? (
              p.failed ? (
                <div key={p.id} class={empty} hidden={p.id !== selected}>
                  {ENGINE_LABEL[p.engine]} isn’t running.
                </div>
              ) : (
                <iframe
                  key={`${p.id}:${p.generation}`} // a new page (device switch) gets a fresh DevTools
                  class="absolute inset-0 size-full border-0"
                  title={`DevTools for ${ENGINE_LABEL[p.engine]}`}
                  src={devtoolsUrl(p.id)}
                  hidden={p.id !== selected}
                  onLoad={(e) => forwardAppShortcuts(e.currentTarget)}
                />
              )
            ) : null,
          )
        )}
        {/* While resizing, keep the iframe from swallowing pointer events. */}
        {dragging && <div class="absolute inset-0 cursor-ns-resize" />}
      </div>
    </section>
  );
}

/**
 * The red error count on a tab: a circle for one digit, a pill for more. The number is trimmed to
 * its digits (trim-cap) and centred with flexbox, so it sits in the middle of the circle rather
 * than where the font's line box would put it.
 */
function CountBadge({ n }: { n: number }) {
  return (
    <span class="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-danger px-1 text-[10px] font-semibold tabular-nums text-white">
      <span class="trim-cap">{n > 99 ? '99+' : n}</span>
    </span>
  );
}
