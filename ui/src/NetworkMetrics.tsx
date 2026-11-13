// Network figures in the address bar: each engine's load time at the right end of the field, and
// on click a table per engine (requests, transferred, failed, first byte, DOMContentLoaded, load).
// The server measures them from Playwright's network events; nothing runs in the page.
import { Activity } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { NetworkMetrics, PaneInfo } from '../../shared/protocol';
import { ENGINE_LABEL } from './Pane';
import { cx, ENGINE_CLASS, EngineDot } from './ui';

export function formatMs(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} kB`;
  return `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

type Measured = PaneInfo & { metrics: NetworkMetrics };

const ROWS: { label: string; title: string; value(m: NetworkMetrics, p: PaneInfo): string; time?: (m: NetworkMetrics) => number | null; less?: (m: NetworkMetrics) => number }[] = [
  {
    label: 'Load',
    title: 'Until the load event: the page and everything it needs (images, styles, scripts) arrived',
    value: (m, p) => (m.load === null && p.loading ? 'loading…' : formatMs(m.load)),
    time: (m) => m.load,
  },
  {
    label: 'DOMContentLoaded',
    title: 'Until the document was parsed and its deferred scripts ran',
    value: (m) => formatMs(m.domContentLoaded),
    time: (m) => m.domContentLoaded,
  },
  { label: 'First byte', title: "The main document's first response byte, after its request started", value: (m) => formatMs(m.ttfb), time: (m) => m.ttfb },
  {
    label: 'Requests',
    title: 'Requests started since the navigation, the document included',
    value: (m) => (m.requests > m.finished + m.failed ? `${m.requests} (${m.requests - m.finished - m.failed} pending)` : String(m.requests)),
  },
  {
    label: 'Transferred',
    title: 'Bytes received for finished requests: headers plus the compressed body. Responses from the cache count as 0',
    value: (m) => formatBytes(m.transferred),
    less: (m) => m.transferred,
  },
  { label: 'Failed', title: 'Requests that failed (aborted ones aren’t counted)', value: (m) => String(m.failed) },
];

/** The chip at the right end of the address bar, and its table. Hidden while there's nothing measured. */
export function NetworkMetricsButton({ panes }: { panes: PaneInfo[] }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const measured = panes.filter((p): p is Measured => !!p.metrics && !p.failed && !p.disabled);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  if (!measured.length) return null;
  const summary = measured.map((p) => `${ENGINE_LABEL[p.engine]} ${p.metrics.load === null ? (p.loading ? 'loading' : 'no load event') : formatMs(p.metrics.load)}`).join(', ');

  return (
    <div class="absolute inset-y-0 right-1 flex items-center" ref={root}>
      <button
        type="button"
        class={cx(
          'inline-flex h-6 items-center gap-2 rounded-full px-2 text-[11.5px] tabular-nums hover:bg-line/60 focus-visible:outline-2 focus-visible:outline-accent',
          open && 'bg-line/60',
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Network: load time ${summary}. Show details`}
        title={`Load time: ${summary}`}
        // Keep the click from focusing (and selecting) the address field underneath.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
      >
        <Activity size={12} class="flex-none text-muted" />
        {measured.map((p) => (
          <span key={p.id} class={cx('inline-flex items-center gap-1', ENGINE_CLASS[p.engine])}>
            <EngineDot />
            <span class={cx('trim-cap', p.metrics.load === null && 'text-muted')}>{p.metrics.load === null ? (p.loading ? '…' : '—') : formatMs(p.metrics.load)}</span>
          </span>
        ))}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Network"
          class="absolute right-0 top-full z-50 mt-2 w-[min(480px,calc(100vw-32px))] rounded-xl border border-line bg-chrome text-fg shadow-[0_16px_40px_var(--shadow)]"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <header class="border-b border-line px-4 py-3">
            <strong class="text-sm">Network</strong>
            <span class="ml-2 text-xs text-muted">this page, since its navigation started</span>
          </header>
          <div class="overflow-x-auto px-4 py-3">
            <table class="w-full border-separate border-spacing-0 text-left text-xs">
              <thead>
                <tr>
                  <td />
                  {measured.map((p) => (
                    <th key={p.id} scope="col" class={cx('pb-1.5 pl-4 text-right font-normal text-muted', ENGINE_CLASS[p.engine])}>
                      <span class="inline-flex items-center gap-1.5 whitespace-nowrap">
                        <EngineDot />
                        <span class="trim-cap">{ENGINE_LABEL[p.engine]}</span>
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ROWS.map((row) => {
                  // The best value in a row (fastest time, fewest bytes) stands out when the engines differ.
                  const score = row.time ?? row.less;
                  const values = score ? measured.map((p) => score(p.metrics)) : [];
                  const known = values.filter((v): v is number => v !== null);
                  const best = known.length > 1 && new Set(known).size > 1 ? Math.min(...known) : null;
                  return (
                    <tr key={row.label}>
                      <th scope="row" class="whitespace-nowrap py-1 pr-2 font-normal text-muted" title={row.title}>
                        {row.label}
                      </th>
                      {measured.map((p, i) => (
                        <td key={p.id} class={cx('whitespace-nowrap py-1 pl-4 text-right tabular-nums', best !== null && values[i] === best && 'font-semibold text-webkit')}>
                          {row.value(p.metrics, p)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p class="border-t border-line px-4 py-2.5 text-[11px]/4 text-muted">
            Measured by TriPane from each engine's network events; nothing runs in the page. Times include TriPane's own
            overhead, so compare the engines with each other rather than with other tools. Green: the best value.
          </p>
        </div>
      )}
    </div>
  );
}
