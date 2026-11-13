import { ArrowUp, LoaderCircle, Maximize2, Minimize2, RotateCw, TriangleAlert } from 'lucide-preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { CaptureInfo, DevicePreset, InputEvent, MouseButton, PaneId, PaneInfo } from '../../shared/protocol';
import { DeviceFrame, frameGeometry } from './DeviceFrame';
import type { EngineClient } from './engine';
import { btn, cx, ENGINE_CLASS, EngineDot } from './ui';

export const ENGINE_LABEL = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' } as const;
const BUTTONS: MouseButton[] = ['left', 'middle', 'right'];
const IGNORED_KEYS = new Set(['Dead', 'Unidentified', 'Process', 'Compose']);
const LINE_HEIGHT_PX = 40;

interface Props {
  client: EngineClient;
  info: PaneInfo;
  /** A newer build of this engine (from the update check), if any. */
  update?: { latest: string; playwright: string | null };
  /** This pane is the one DevTools is showing. */
  inspected: boolean;
  /** The pane last clicked (or picked in DevTools); its top border is shown at full strength. */
  selected: boolean;
  /** Show this pane in DevTools (opening it if needed). */
  onOpenDevTools(): void;
  /** The user interacted with this pane; DevTools follows if it's open. */
  onActivate(): void;
  focused: boolean;
  onToggleFocus(): void;
  onFocusUrlBar(): void;
  /**
   * Picking an element for Compare: moving only highlights (no page input) and a click picks
   * the element instead of clicking it.
   */
  picking: boolean;
  onPicked(): void;
  /** The synced hover highlight is on (leaving the pane then clears the outline). */
  highlight: boolean;
  /** Click marks to show in this pane (Show clicks). */
  clicks: ClickMark[];
  /** A mouse button went down on the page at these viewport coordinates. */
  onPress(x: number, y: number): void;
  /** The device this pane emulates, and whether to draw its frame (Device frames). */
  device: DevicePreset | null;
  frames: boolean;
  /** The page's color scheme, for the imitated browser bars. */
  darkPage: boolean;
}

/** A click to show: where it landed (viewport pixels) and in which panes. */
export interface ClickMark {
  id: number;
  source: PaneId;
  /** Shown in every pane (input sync was on), or only in the source pane. */
  all: boolean;
  x: number;
  y: number;
}
/** How long a click mark stays (matches the animate-click duration in styles.css). */
export const CLICK_MARK_MS = 800;

export function Pane({ client, info, update, inspected, selected, focused, onToggleFocus, onFocusUrlBar, onOpenDevTools, onActivate, picking, onPicked, highlight, clicks, onPress, device, frames, darkPage }: Props) {
  // Kept in refs so new values each render don't re-attach the canvas input listeners.
  const activate = useRef(onActivate);
  activate.current = onActivate;
  const press = useRef(onPress);
  press.current = onPress;
  const pick = useRef({ on: picking, done: onPicked, highlight });
  pick.current = { on: picking, done: onPicked, highlight };
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  const [hasFrame, setHasFrame] = useState(false);
  const { width: vw, height: vh } = info.viewport;
  // Device frames: the whole device is fitted into the pane, and the picture scales with it.
  const geo = frames && device ? frameGeometry(device, info.viewport) : null;
  const fitW = geo?.outer.width ?? vw;
  const fitH = geo?.outer.height ?? vh;

  // Draw frames straight onto the canvas, outside Preact.
  useEffect(
    () =>
      client.onFrame(info.id, (bmp) => {
        const canvas = canvasRef.current;
        const ctx = canvas?.getContext('2d');
        if (!canvas || !ctx) return;
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        setHasFrame(true);
      }),
    [client, info.id],
  );

  // Fit the viewport into the space available, never upscaling.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const fit = () => {
      const s = Math.min(1, (stage.clientWidth - 16) / fitW, (stage.clientHeight - 16) / fitH);
      setScale(Math.max(0.05, s));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(stage);
    return () => ro.disconnect();
  }, [fitW, fitH]);

  // Input: mouse, wheel and keyboard are mapped into viewport pixels and sent to the server.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const send = (event: InputEvent) => client.send({ type: 'input', source: info.id, event });
    const toViewport = (e: { clientX: number; clientY: number }) => {
      const r = canvas.getBoundingClientRect();
      return {
        x: Math.round(((e.clientX - r.left) * canvas.width) / r.width),
        y: Math.round(((e.clientY - r.top) * canvas.height) / r.height),
      };
    };

    let moveFrame = 0;
    let lastMove: PointerEvent | null = null;
    const held = new Set<string>();

    let swallowUp = false; // the button-up after a pick must not reach the page
    const onPointerDown = (e: PointerEvent) => {
      activate.current();
      e.preventDefault();
      if (pick.current.on) {
        client.send({ type: 'compare', source: info.id, ...toViewport(e) });
        swallowUp = true;
        pick.current.done();
        return;
      }
      canvas.focus();
      canvas.setPointerCapture(e.pointerId);
      const at = toViewport(e);
      press.current(at.x, at.y);
      send({ kind: 'mouse', action: 'down', ...at, button: BUTTONS[e.button] ?? 'left', clickCount: Math.max(1, e.detail) });
    };
    const onPointerUp = (e: PointerEvent) => {
      if (swallowUp) {
        swallowUp = false;
        return;
      }
      send({ kind: 'mouse', action: 'up', ...toViewport(e), button: BUTTONS[e.button] ?? 'left', clickCount: Math.max(1, e.detail) });
    };
    const onPointerMove = (e: PointerEvent) => {
      lastMove = e;
      if (moveFrame) return;
      moveFrame = requestAnimationFrame(() => {
        moveFrame = 0;
        if (!lastMove) return;
        if (pick.current.on) client.send({ type: 'probe', source: info.id, ...toViewport(lastMove) });
        else send({ kind: 'mouse', action: 'move', ...toViewport(lastMove), button: 'left' });
      });
    };
    // Leaving the pane removes the synced outline.
    const onPointerLeave = () => {
      if (pick.current.on || pick.current.highlight) client.send({ type: 'probeEnd' });
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? LINE_HEIGHT_PX : e.deltaMode === 2 ? canvas.height : 1;
      send({ kind: 'wheel', ...toViewport(e), dx: e.deltaX * k, dy: e.deltaY * k });
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        onFocusUrlBar();
        return;
      }
      // F12 / Ctrl+Shift+I (DevTools) and Ctrl+, (settings) belong to the app, not the page.
      if (e.key === 'F12' || ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'i')) return;
      if ((e.ctrlKey || e.metaKey) && e.key === ',') return;
      if (e.isComposing || IGNORED_KEYS.has(e.key)) return;
      // Leave the shortcuts for pasting to the paste event, which carries the clipboard text.
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') return;
      e.preventDefault();
      held.add(e.key);
      send({ kind: 'key', action: 'down', key: e.key });
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (!held.delete(e.key)) return;
      e.preventDefault();
      send({ kind: 'key', action: 'up', key: e.key });
    };
    const onBlur = () => {
      for (const key of held) send({ kind: 'key', action: 'up', key });
      held.clear();
    };
    const onPaste = (e: ClipboardEvent) => {
      const text = e.clipboardData?.getData('text/plain');
      if (text) send({ kind: 'text', text });
      e.preventDefault();
    };
    const onContextMenu = (e: Event) => e.preventDefault();

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerleave', onPointerLeave);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('keydown', onKeyDown);
    canvas.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('blur', onBlur);
    canvas.addEventListener('paste', onPaste);
    canvas.addEventListener('contextmenu', onContextMenu);
    return () => {
      cancelAnimationFrame(moveFrame);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('keydown', onKeyDown);
      canvas.removeEventListener('keyup', onKeyUp);
      canvas.removeEventListener('blur', onBlur);
      canvas.removeEventListener('paste', onPaste);
      canvas.removeEventListener('contextmenu', onContextMenu);
    };
  }, [client, info.id, onFocusUrlBar]);


  // The page picture: canvas, click marks, and the starting or failed state.
  const picture = (
          <div class={cx('relative bg-white', !geo && 'shadow-[0_0_0_1px_var(--line),0_6px_24px_var(--shadow)]')} style={{ width: `${vw * scale}px`, height: `${vh * scale}px` }}>
            <canvas
              ref={canvasRef}
              class={cx('block outline-none', picking ? 'cursor-crosshair' : 'cursor-default')}
              width={vw}
              height={vh}
              tabIndex={0}
              style={{ width: `${vw * scale}px`, height: `${vh * scale}px` }}
              aria-label={`${ENGINE_LABEL[info.engine]} page. Click to interact; keys go to the page.`}
            />
            {clicks.map((c) => (
              <span
                key={c.id}
                aria-hidden
                class="animate-click pointer-events-none absolute -ml-4 -mt-4 size-8 rounded-full border-[3px] border-engine bg-engine/35 shadow-[0_0_0_1.5px_#fffc,0_1px_6px_#0006]"
                style={{ left: `${c.x * scale}px`, top: `${c.y * scale}px` }}
              />
            ))}
            {info.failed ? (
              <div class="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-chrome p-4 text-center text-fg">
                <strong>{ENGINE_LABEL[info.engine]} could not start</strong>
                <p class="max-w-[40ch] wrap-anywhere text-muted">{info.failed}</p>
                <p class="text-muted">
                  Try <code>sudo bunx playwright install-deps</code>
                </p>
              </div>
            ) : (
              !hasFrame && (
                <div class="absolute inset-0 flex items-center justify-center gap-2 bg-chrome p-4 text-muted">
                  <LoaderCircle size={14} class="animate-spin text-engine" /> <span class="trim-cap">Starting {ENGINE_LABEL[info.engine]}…</span>
                </div>
              )
            )}
          </div>
  );

  return (
    <section class={cx('flex min-h-0 min-w-0 flex-col bg-bg', ENGINE_CLASS[info.engine])} aria-label={`${ENGINE_LABEL[info.engine]} pane`}>
      <header
        class={cx(
          'flex min-w-0 items-center gap-2 overflow-hidden border-t-2 bg-chrome px-2 py-[5px] transition-[border-color]',
          // The selected pane's top border is shown at full strength, the others dimmed.
          selected ? 'border-engine' : 'border-[color-mix(in_srgb,var(--engine)_28%,var(--chrome))]',
        )}
      >
        <EngineDot />
        <strong class="trim-cap flex-none">{ENGINE_LABEL[info.engine]}</strong>
        <span class="trim-cap-clip min-w-0 shrink truncate text-[11px] text-muted" title={info.version}>
          {info.version}
        </span>
        {update && (
          <span
            class="inline-grid size-4 flex-none cursor-help place-items-center rounded-full bg-accent text-on-accent"
            title={`${ENGINE_LABEL[info.engine]} ${update.latest} is available${update.playwright ? ` with Playwright ${update.playwright}` : ''}. See Settings → Engine updates.`}
          >
            <ArrowUp size={11} strokeWidth={3} />
          </span>
        )}
        {info.capture && <CaptureBadge capture={info.capture} />}
        {/* The device itself is shown once, in the device bar. Only Firefox's caveat is per engine. */}
        {info.device && info.engine === 'firefox' && (
          <span
            class="inline-flex flex-none cursor-help text-warn"
            role="img"
            aria-label="Firefox has no mobile mode"
            title={`Firefox has no mobile mode: it emulates ${info.device}'s size, pixel ratio, touch and user agent, but ignores the page's meta viewport, so mobile layouts can differ from Chromium and WebKit.`}
          >
            <TriangleAlert size={13} />
          </span>
        )}
        {/* No page title here: the panes show the same page and the address bar shows where it is.
            Only the loading state is per engine. */}
        {info.loading && (
          <span class="inline-flex flex-none" title={`Loading ${info.url}`}>
            <LoaderCircle size={13} class="animate-spin text-engine" aria-label="Loading" />
          </span>
        )}
        <span class="flex-1" />
        <button
          type="button"
          class={btn('ghost', { icon: true, small: true })}
          disabled={!!info.failed}
          onClick={() => client.send({ type: 'reloadPane', target: info.id })}
          aria-label={`Reload ${ENGINE_LABEL[info.engine]}`}
          title={`Reload ${ENGINE_LABEL[info.engine]} only, then sync it with the other engines (URL with Follow links on, scroll position with Sync scroll on)`}
        >
          <RotateCw size={13} />
        </button>
        <button
          type="button"
          class={cx(
            'inline-flex h-[22px] flex-none items-center rounded-full border px-2 text-[11px]',
            info.errors ? 'border-transparent bg-[color-mix(in_srgb,var(--danger)_70%,var(--chrome))] text-white' : 'border-line bg-chrome-2 text-muted',
            inspected && 'outline-2 outline-engine',
          )}
          onClick={onOpenDevTools}
          title={`Inspect ${ENGINE_LABEL[info.engine]} in DevTools (Console, Elements, Network)`}
        >
          <span class="trim-cap">{info.errors ? `${info.errors} error${info.errors === 1 ? '' : 's'}` : 'DevTools'}</span>
        </button>
        <button
          type="button"
          class={btn('ghost', { icon: true })}
          onClick={onToggleFocus}
          title={focused ? 'Show all panes' : 'Focus this pane'}
          aria-label={focused ? 'Show all panes' : 'Focus this pane'}
        >
          {focused ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
        </button>
      </header>

      <div class="bg-grid relative flex min-h-0 flex-1 items-center justify-center overflow-hidden" ref={stageRef}>
        <DeviceFrame geo={geo} viewport={info.viewport} scale={scale} url={info.url} dark={darkPage} onAddressClick={onFocusUrlBar}>
          {picture}
        </DeviceFrame>
        <div class="pointer-events-none absolute bottom-1.5 right-2 text-[11px] text-muted">
          {vw}×{vh} · {Math.round(scale * 100)}%
        </div>
      </div>
    </section>
  );
}

/**
 * How this pane's picture gets here: "live:jpeg" when the engine pushes frames (CDP screencast),
 * "66ms:jpeg" when the server polls screenshots at that interval (250ms while the page is idle).
 */
function CaptureBadge({ capture }: { capture: CaptureInfo }) {
  const live = capture.method === 'screencast';
  const cadence = live ? 'live' : `${capture.intervalMs}ms`;
  const how = live
    ? 'CDP screencast: the engine pushes a frame on every repaint'
    : `Screenshot polling every ${capture.intervalMs} ms (66 ms while active, 250 ms when idle)`;
  return (
    <span
      class={cx(
        'inline-flex h-[18px] flex-none cursor-help items-center gap-1 rounded border border-line bg-chrome-2 px-1.5 font-mono text-[10.5px]/none',
        live ? 'text-fg' : 'text-muted',
      )}
      title={`${how}. ${capture.quality === null ? 'Lossless PNG' : `JPEG at quality ${capture.quality}`}, sent to this window over WebSocket.`}
    >
      <span class={cx('size-1.5 rounded-full', live ? 'bg-live shadow-[0_0_0_2px_#3ddc8433]' : 'bg-warn')} aria-hidden />
      <span class="trim-cap">
        {cadence}:{capture.format}
      </span>
    </span>
  );
}