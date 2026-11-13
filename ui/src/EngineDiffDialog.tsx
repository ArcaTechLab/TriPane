// Tools → Compare engines: the whole page across engines, against a reference engine.
//   Visual: screenshots compared pixel by pixel (pixelmatch), shown as a diff, a swipe or side by side.
//   Accessibility tree: each engine's ARIA snapshot, as a line diff.
// Everything is read through Playwright's public API on the server; nothing is injected.
import type { LucideIcon } from 'lucide-preact';
import { Accessibility, Camera, Columns2, Image as ImageIcon, LoaderCircle, Play, SplitSquareHorizontal, X } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { AriaDiffResult, DiffLine, EngineName, PaneInfo, VisualDiffResult } from '../../shared/protocol';
import type { EngineClient } from './engine';
import { btn, Check, cx, ENGINE_CLASS, EngineDot, ICON } from './ui';

const NAMES: Record<EngineName, string> = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' };
const THRESHOLDS = [
  { value: 0.05, label: 'Strict' },
  { value: 0.1, label: 'Normal' },
  { value: 0.2, label: 'Loose' },
];

interface Props {
  open: boolean;
  client: EngineClient;
  /** Running panes (the engines that can be compared). */
  panes: PaneInfo[];
  visual: VisualDiffResult | null;
  aria: AriaDiffResult | null;
  busy: 'visual' | 'aria' | null;
  error: string | null;
  onClose(): void;
}

type Tab = 'visual' | 'aria';

export function EngineDiffDialog(props: Props) {
  const { open, client, panes, onClose } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const [tab, setTab] = useState<Tab>('visual');
  const running = panes.filter((p) => !p.failed && !p.disabled);
  const [reference, setReference] = useState<EngineName>('chromium');
  useEffect(() => {
    if (running.length && !running.some((p) => p.engine === reference)) setReference(running[0].engine);
  }, [running.map((p) => p.engine).join()]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      class="m-auto flex h-[min(900px,calc(100vh-32px))] w-[min(1200px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-line bg-bg p-0 text-fg shadow-[0_24px_64px_var(--shadow)] backdrop:bg-black/60 [&:not([open])]:hidden"
      aria-labelledby="engine-diff-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <header class="flex flex-none flex-wrap items-center gap-x-4 gap-y-2 border-b border-line bg-chrome px-5 py-3">
        <h2 id="engine-diff-title" class="text-base font-bold">
          Compare engines
        </h2>
        <div role="tablist" class="flex gap-1">
          <TabButton icon={ImageIcon} on={tab === 'visual'} onClick={() => setTab('visual')}>
            Visual
          </TabButton>
          <TabButton icon={Accessibility} on={tab === 'aria'} onClick={() => setTab('aria')}>
            Accessibility tree
          </TabButton>
        </div>
        <button type="button" class={cx(btn('ghost', { icon: true }), 'ml-auto')} onClick={onClose} aria-label="Close" title="Close (Esc)">
          <X size={ICON} />
        </button>
      </header>

      {running.length < 2 ? (
        <p class="p-8 text-center text-muted">Comparing needs at least two running engines.</p>
      ) : tab === 'visual' ? (
        <VisualTab {...props} running={running} reference={reference} onReference={setReference} />
      ) : (
        <AriaTab {...props} running={running} reference={reference} onReference={setReference} />
      )}
    </dialog>
  );
}

function TabButton(props: { icon: LucideIcon; on: boolean; onClick(): void; children: ComponentChildren }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={props.on}
      class={cx('inline-flex h-8 items-center gap-1.5 rounded-md px-3', props.on ? 'bg-accent/15 font-semibold text-accent' : 'text-muted hover:bg-chrome-2 hover:text-fg')}
      onClick={props.onClick}
    >
      <props.icon size={15} /> <span class="trim-cap">{props.children}</span>
    </button>
  );
}

/** "Compare against: (Chromium) (Firefox) (WebKit)" */
function ReferencePicker(props: { running: PaneInfo[]; value: EngineName; onChange(e: EngineName): void }) {
  return (
    <div class="flex items-center gap-2">
      <span class="text-muted">Compare against</span>
      <div class="inline-flex rounded-lg border border-line bg-bg p-0.5" role="radiogroup" aria-label="Reference engine">
        {props.running.map((p) => (
          <button
            key={p.engine}
            type="button"
            role="radio"
            aria-checked={props.value === p.engine}
            class={cx(
              'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs',
              ENGINE_CLASS[p.engine],
              props.value === p.engine ? 'bg-chrome-2 font-semibold text-fg shadow-[inset_0_0_0_1px_var(--line)]' : 'text-muted hover:text-fg',
            )}
            onClick={() => props.onChange(p.engine)}
          >
            <EngineDot /> <span class="trim-cap">{NAMES[p.engine]}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const toolbar = 'flex flex-none flex-wrap items-center gap-x-5 gap-y-2 border-b border-line bg-chrome px-5 py-2.5 text-xs';

function RunButton(props: { busy: boolean; label: string; busyLabel: string; onClick(): void }) {
  return (
    <button type="button" class={cx(btn('primary'), 'ml-auto')} disabled={props.busy} onClick={props.onClick}>
      {props.busy ? <LoaderCircle size={14} class="animate-spin" /> : <Play size={14} />} <span class="trim-cap">{props.busy ? props.busyLabel : props.label}</span>
    </button>
  );
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? <p class="mx-5 mt-3 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">{error}</p> : null;
}

function Empty(props: { icon: LucideIcon; children: ComponentChildren }) {
  return (
    <div class="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center text-muted">
      <span class="grid size-12 place-items-center rounded-full bg-chrome">
        <props.icon size={22} />
      </span>
      <div class="max-w-[52ch]">{props.children}</div>
    </div>
  );
}

// ---- visual -------------------------------------------------------------------------------------

type ViewMode = 'diff' | 'swipe' | 'side';

function VisualTab(props: Props & { running: PaneInfo[]; reference: EngineName; onReference(e: EngineName): void }) {
  const { client, visual: r, busy, running, reference } = props;
  const [fullPage, setFullPage] = useState(false);
  const [threshold, setThreshold] = useState(0.1);
  const [shown, setShown] = useState<EngineName | null>(null);
  const [mode, setMode] = useState<ViewMode>('diff');
  const [swipe, setSwipe] = useState(50);

  const diff = r?.diffs.find((d) => d.engine === shown) ?? r?.diffs[0] ?? null;
  const shot = (engine: EngineName | undefined) => r?.engines.find((e) => e.engine === engine);

  return (
    <>
      <div class={toolbar}>
        <ReferencePicker running={running} value={reference} onChange={props.onReference} />
        <label class="inline-flex items-center gap-2">
          <span class="text-muted">Sensitivity</span>
          <select class="h-7 rounded-md border border-line bg-chrome-2 px-1.5" value={threshold} onChange={(e) => setThreshold(Number(e.currentTarget.value))}>
            {THRESHOLDS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <Check checked={fullPage} onChange={setFullPage}>
          Full page
        </Check>
        <RunButton
          busy={busy === 'visual'}
          label={r ? 'Compare again' : 'Capture and compare'}
          busyLabel="Capturing…"
          onClick={() => client.runDiff({ type: 'visualDiff', reference, fullPage, threshold })}
        />
      </div>
      <ErrorLine error={busy === null && props.error ? props.error : null} />

      {!r ? (
        <Empty icon={Camera}>
          Screenshots every engine and highlights the pixels that differ from the reference engine. Text anti-aliasing,
          which every engine does its own way, is ignored.
        </Empty>
      ) : (
        <div class="flex min-h-0 flex-1 flex-col">
          {/* One card per engine compared with the reference. */}
          <div class="flex flex-none flex-wrap gap-3 px-5 pt-4">
            {r.diffs.map((d) => {
              const on = d === diff;
              const tone = d.percent < 0.5 ? 'text-webkit' : d.percent < 5 ? 'text-warn-text' : 'text-danger';
              return (
                <button
                  key={d.engine}
                  type="button"
                  class={cx(
                    'flex min-w-56 flex-col gap-1 rounded-xl border bg-chrome px-4 py-3 text-left',
                    ENGINE_CLASS[d.engine],
                    on ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-muted',
                  )}
                  aria-pressed={on}
                  onClick={() => setShown(d.engine)}
                >
                  <span class="flex items-center gap-1.5 text-xs text-muted">
                    <EngineDot /> {NAMES[d.engine]} vs {NAMES[d.against]}
                  </span>
                  <span class={cx('text-2xl font-bold tabular-nums', tone)}>{d.percent}%</span>
                  <span class="text-xs text-muted">
                    {d.percent < 0.5 ? 'Nearly identical' : `${d.pixels.toLocaleString()} pixels differ`}
                    {d.sizeMismatch && ` · sizes differ, compared ${d.width}×${d.height}`}
                  </span>
                </button>
              );
            })}
          </div>

          {diff && (
            <>
              <div class="flex flex-none flex-wrap items-center gap-3 px-5 py-3 text-xs">
                <div class="inline-flex rounded-lg border border-line bg-chrome p-0.5" role="radiogroup" aria-label="View">
                  {(
                    [
                      ['diff', 'Diff', ImageIcon],
                      ['swipe', 'Swipe', SplitSquareHorizontal],
                      ['side', 'Side by side', Columns2],
                    ] as const
                  ).map(([value, label, Icon]) => (
                    <button
                      key={value}
                      type="button"
                      role="radio"
                      aria-checked={mode === value}
                      class={cx('inline-flex h-7 items-center gap-1.5 rounded-md px-2.5', mode === value ? 'bg-accent text-on-accent' : 'text-muted hover:text-fg')}
                      onClick={() => setMode(value)}
                    >
                      <Icon size={13} /> <span class="trim-cap">{label}</span>
                    </button>
                  ))}
                </div>
                {mode === 'diff' && (
                  <span class="flex items-center gap-3 text-muted">
                    <span class="inline-flex items-center gap-1.5">
                      <span class="size-2.5 rounded-sm bg-[rgb(230,30,60)]" /> darker in {NAMES[diff.against]}
                    </span>
                    <span class="inline-flex items-center gap-1.5">
                      <span class="size-2.5 rounded-sm bg-[rgb(30,120,255)]" /> darker in {NAMES[diff.engine]}
                    </span>
                  </span>
                )}
                {mode === 'swipe' && (
                  <label class="inline-flex items-center gap-2 text-muted">
                    {NAMES[diff.against]}
                    <input type="range" min={0} max={100} value={swipe} onInput={(e) => setSwipe(Number(e.currentTarget.value))} class="w-48 accent-accent" aria-label="Swipe position" />
                    {NAMES[diff.engine]}
                  </label>
                )}
                <span class="ml-auto text-muted">
                  {r.fullPage ? 'Full page' : 'Viewport'} · {new Date(r.at).toLocaleTimeString()}
                </span>
              </div>

              <div class="min-h-0 flex-1 overflow-auto px-5 pb-5">
                {mode === 'diff' && <img src={diff.image} alt={`Differences between ${NAMES[diff.engine]} and ${NAMES[diff.against]}`} class="mx-auto block max-w-full rounded-md border border-line bg-white" />}
                {mode === 'swipe' && (
                  <div class="relative mx-auto w-fit max-w-full overflow-hidden rounded-md border border-line bg-white">
                    <img src={shot(diff.against)?.image} alt={NAMES[diff.against]} class="block max-w-full" />
                    <img
                      src={shot(diff.engine)?.image}
                      alt={NAMES[diff.engine]}
                      class="absolute left-0 top-0 block max-w-full"
                      style={{ clipPath: `inset(0 0 0 ${swipe}%)` }}
                    />
                    <span class="pointer-events-none absolute inset-y-0 w-0.5 bg-accent" style={{ left: `${swipe}%` }} />
                  </div>
                )}
                {mode === 'side' && (
                  <div class="grid grid-cols-2 gap-3">
                    {[diff.against, diff.engine].map((e) => (
                      <figure key={e} class={cx('min-w-0', ENGINE_CLASS[e])}>
                        <figcaption class="mb-1.5 flex items-center gap-1.5 text-xs text-muted">
                          <EngineDot /> {NAMES[e]}
                        </figcaption>
                        <img src={shot(e)?.image} alt={NAMES[e]} class="block w-full rounded-md border border-line bg-white" />
                      </figure>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

// ---- accessibility tree -------------------------------------------------------------------------

function AriaTab(props: Props & { running: PaneInfo[]; reference: EngineName; onReference(e: EngineName): void }) {
  const { client, aria: r, busy, running, reference } = props;
  const [selector, setSelector] = useState('');
  const [shown, setShown] = useState<EngineName | null>(null);
  const [onlyChanges, setOnlyChanges] = useState(true);
  const others = r?.engines.filter((e) => e.engine !== r.reference) ?? [];
  const current = others.find((e) => e.engine === shown) ?? others[0] ?? null;
  const run = () => client.runDiff({ type: 'ariaDiff', reference, selector: selector.trim() || undefined });

  return (
    <>
      <div class={toolbar}>
        <ReferencePicker running={running} value={reference} onChange={props.onReference} />
        <label class="inline-flex min-w-64 flex-1 items-center gap-2">
          <span class="text-muted">Part of the page</span>
          <input
            class="h-7 min-w-0 flex-1 rounded-md border border-line bg-chrome-2 px-2 font-mono outline-none focus:border-accent"
            placeholder="whole page, or a selector: main, nav, #signup"
            value={selector}
            onInput={(e) => setSelector(e.currentTarget.value)}
            onKeyDown={(e) => e.key === 'Enter' && run()}
            aria-label="Selector"
          />
        </label>
        <RunButton busy={busy === 'aria'} label={r ? 'Compare again' : 'Compare trees'} busyLabel="Reading…" onClick={run} />
      </div>
      <ErrorLine error={busy === null && props.error ? props.error : null} />

      {!r ? (
        <Empty icon={Accessibility}>
          Reads each engine's accessibility tree (roles, names and states, as assistive technology gets them) and shows
          where it differs from the reference engine.
        </Empty>
      ) : (
        <div class="flex min-h-0 flex-1 flex-col">
          <div class="flex flex-none flex-wrap items-center gap-3 px-5 pt-4">
            {others.map((e) => {
              const on = e === current;
              const same = !e.error && !e.added && !e.removed;
              return (
                <button
                  key={e.engine}
                  type="button"
                  aria-pressed={on}
                  class={cx(
                    'flex min-w-56 flex-col gap-1 rounded-xl border bg-chrome px-4 py-3 text-left',
                    ENGINE_CLASS[e.engine],
                    on ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-muted',
                  )}
                  onClick={() => setShown(e.engine)}
                >
                  <span class="flex items-center gap-1.5 text-xs text-muted">
                    <EngineDot /> {NAMES[e.engine]} vs {NAMES[r.reference]}
                  </span>
                  {e.error ? (
                    <span class="text-sm font-semibold text-danger">Couldn't read</span>
                  ) : same ? (
                    <span class="text-lg font-bold text-webkit">Identical</span>
                  ) : (
                    <span class="text-lg font-bold tabular-nums">
                      <span class="text-webkit">+{e.added}</span> <span class="text-danger">−{e.removed}</span>
                    </span>
                  )}
                  <span class="text-xs text-muted">{e.error ?? `${e.tree.split('\n').length} lines`}</span>
                </button>
              );
            })}
            <span class="ml-auto self-end text-xs text-muted">
              {r.selector === 'body' ? 'Whole page' : r.selector} · {new Date(r.at).toLocaleTimeString()}
            </span>
          </div>

          {current && !current.error && (
            <>
              <div class="flex flex-none items-center gap-4 px-5 py-3 text-xs text-muted">
                <span class="inline-flex items-center gap-1.5">
                  <span class="rounded bg-danger/15 px-1 font-mono text-danger">−</span> only in {NAMES[r.reference]}
                </span>
                <span class="inline-flex items-center gap-1.5">
                  <span class="rounded bg-webkit/15 px-1 font-mono text-webkit">+</span> only in {NAMES[current.engine]}
                </span>
                <span class="ml-auto">
                  <Check checked={onlyChanges} onChange={setOnlyChanges}>
                    Only changes
                  </Check>
                </span>
              </div>
              <DiffView lines={current.lines} onlyChanges={onlyChanges} onExpand={() => setOnlyChanges(false)} />
            </>
          )}
        </div>
      )}
    </>
  );
}

const CONTEXT = 3;

function DiffView({ lines, onlyChanges, onExpand }: { lines: DiffLine[]; onlyChanges: boolean; onExpand(): void }) {
  const rows = useMemo(() => {
    if (!onlyChanges) return lines.map((l) => ({ line: l, skipped: 0 }));
    const keep = lines.map(() => false);
    lines.forEach((l, i) => {
      if (l.op !== 'same') for (let k = Math.max(0, i - CONTEXT); k <= Math.min(lines.length - 1, i + CONTEXT); k++) keep[k] = true;
    });
    const out: { line: DiffLine | null; skipped: number }[] = [];
    let skipped = 0;
    lines.forEach((l, i) => {
      if (!keep[i]) return void skipped++;
      if (skipped) out.push({ line: null, skipped });
      skipped = 0;
      out.push({ line: l, skipped: 0 });
    });
    if (skipped) out.push({ line: null, skipped });
    return out;
  }, [lines, onlyChanges]);

  if (onlyChanges && !lines.some((l) => l.op !== 'same')) {
    return <p class="px-5 py-6 text-center text-muted">No differences: both engines expose the same accessibility tree.</p>;
  }
  return (
    // The diff box itself scrolls (both ways) within the space left; long lines don't widen the view.
    <div class="flex min-h-0 min-w-0 flex-1 flex-col px-5 pb-5">
      <pre class="min-h-0 overflow-auto rounded-lg border border-line bg-chrome font-mono text-xs/5">
        {/* min-w-fit: rows (and their backgrounds) are as wide as the longest line. */}
        <div class="min-w-fit py-1">
        {rows.map((r, i) =>
          r.line === null ? (
            <button key={i} type="button" class="block w-full bg-chrome-2/60 px-3 text-left text-muted hover:text-fg" onClick={onExpand}>
              ⋯ {r.skipped} unchanged {r.skipped === 1 ? 'line' : 'lines'}
            </button>
          ) : (
            <div
              key={i}
              class={cx(
                'flex px-3',
                r.line.op === 'add' && 'bg-webkit/12 text-fg',
                r.line.op === 'del' && 'bg-danger/12 text-fg',
                r.line.op === 'same' && 'text-muted',
              )}
            >
              <span class={cx('w-4 flex-none select-none', r.line.op === 'add' ? 'text-webkit' : r.line.op === 'del' ? 'text-danger' : '')}>
                {r.line.op === 'add' ? '+' : r.line.op === 'del' ? '−' : ' '}
              </span>
              <span class="whitespace-pre">{r.line.text}</span>
            </div>
          ),
        )}
        </div>
      </pre>
    </div>
  );
}
