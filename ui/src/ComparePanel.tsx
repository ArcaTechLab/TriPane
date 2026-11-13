import { Crosshair, RefreshCw } from 'lucide-preact';
import { useMemo, useState } from 'preact/hooks';
import type { CompareResult, PaneInfo } from '../../shared/protocol';
import { BASELINE_LABEL, COMPAT_SOURCE, compatFor, type CompatInfo } from './compat';
import { ENGINE_LABEL } from './Pane';
import { btn, Check, cx, ENGINE_CLASS, EngineDot, filterField, panelBar, panelGroup } from './ui';

interface Props {
  result: CompareResult | null;
  panes: PaneInfo[];
  picking: boolean;
  /** Start (or cancel) picking an element in the panes. */
  onPick(): void;
  /** Compare the same element again (after resizing, interacting, …). */
  onRefresh(): void;
}

const VENDOR = /^-(webkit|moz|apple|epub|ms)-/;
const FILTERS_KEY = 'tripane.compareFilters';

interface Filters {
  onlyDiff: boolean;
  hideVendor: boolean;
  /** Hide properties some engine doesn't have at all (support gaps rather than value differences). */
  hideUnsupported: boolean;
  text: string;
}
const DEFAULT_FILTERS: Filters = { onlyDiff: true, hideVendor: true, hideUnsupported: true, text: '' };

function loadFilters(): Filters {
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem(FILTERS_KEY) ?? '{}') };
  } catch {
    return DEFAULT_FILTERS;
  }
}

/** The value most engines agree on; cells that differ from it get highlighted. */
function majority(values: (string | undefined)[]): string | undefined {
  const counts = new Map<string | undefined, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: string | undefined;
  let bestCount = 0;
  for (const [v, c] of counts) if (c > bestCount) [best, bestCount] = [v, c];
  return bestCount > 1 ? best : undefined;
}

const sides = (v: number[]) => (v.every((x) => x === v[0]) ? `${v[0]}` : v.join(' '));

const cell = 'border-b border-hairline px-2.5 py-[3px] text-left align-top wrap-anywhere';
const nameCol = 'w-[22%] min-w-40';

export function ComparePanel({ result, panes, picking, onPick, onRefresh }: Props) {
  const [filters, setFilters] = useState<Filters>(loadFilters);
  const update = (patch: Partial<Filters>) =>
    setFilters((f) => {
      const next = { ...f, ...patch };
      try {
        localStorage.setItem(FILTERS_KEY, JSON.stringify({ ...next, text: '' }));
      } catch {
        // storage unavailable
      }
      return next;
    });

  const engines = result?.engines ?? [];
  const found = engines.filter((e) => e.found);

  const boxRows = useMemo(() => {
    if (!found.length) return [];
    const row = (name: string, get: (e: (typeof found)[number]) => string) => ({ name, values: engines.map((e) => (e.found && e.box ? get(e) : undefined)) });
    return [
      row('Size', (e) => `${e.box!.width} × ${e.box!.height}`),
      row('Position', (e) => `${e.box!.x}, ${e.box!.y}`),
      row('Margin', (e) => sides(e.box!.margin)),
      row('Border', (e) => sides(e.box!.border)),
      row('Padding', (e) => sides(e.box!.padding)),
    ];
  }, [result]);

  const { rows, totalDiff, total } = useMemo(() => {
    const names = new Set<string>();
    for (const e of found) for (const k of Object.keys(e.styles ?? {})) names.add(k);
    const all = [...names].sort().map((name) => ({ name, values: engines.map((e) => (e.found ? e.styles?.[name] : undefined)) }));
    const differs = (r: (typeof all)[number]) => {
      const present = r.values.filter((_, i) => engines[i].found);
      return present.some((v) => v !== present[0]);
    };
    const supportedEverywhere = (r: (typeof all)[number]) => r.values.every((v, i) => !engines[i].found || v !== undefined);
    const needle = filters.text.trim().toLowerCase();
    const visible = all.filter(
      (r) => (!filters.hideVendor || !VENDOR.test(r.name)) && (!filters.hideUnsupported || supportedEverywhere(r)),
    );
    const shown = visible.filter(
      (r) =>
        (!filters.onlyDiff || differs(r)) &&
        (!needle || r.name.includes(needle) || r.values.some((v) => v?.toLowerCase().includes(needle))),
    );
    return { rows: shown, totalDiff: visible.filter(differs).length, total: visible.length };
  }, [result, filters]);

  // MDN support data for each shown property: Baseline, and what an engine (at its version) lacks.
  const versions = engines.map((e) => ({ engine: e.engine, version: panes[e.paneId]?.version ?? '' }));
  const compat = useMemo(() => new Map(rows.map((r) => [r.name, compatFor(r.name, r.values, versions)])), [rows, panes]);
  const gaps = [...compat.values()].filter((c) => c?.engines.some(Boolean)).length;

  const section = cx(cell, 'bg-chrome-2 py-1.5 font-semibold text-fg');

  return (
    <div class="absolute inset-0 flex flex-col bg-bg text-fg">
      <div class={panelBar}>
        <div class={panelGroup}>
        <button
          type="button"
          class={btn('outline', { pressed: picking })}
          onClick={onPick}
          title="Click an element in any pane (Esc cancels)"
        >
          <Crosshair size={14} /> <span class="trim-cap">{picking ? 'Click an element… (Esc)' : 'Pick element'}</span>
        </button>
        {result && (
          <button type="button" class={btn('outline')} onClick={onRefresh} title="Compare the same element again">
            <RefreshCw size={14} /> <span class="trim-cap">Refresh</span>
          </button>
        )}
        </div>
        {result && (
          <span class={cx(panelGroup, 'gap-1.5')}>
            {engines.map((e) => (
              <span
                key={e.paneId}
                class={cx(
                  'inline-flex items-center gap-1.5 rounded bg-chrome-2 px-1.5 py-0.5 font-mono text-xs',
                  ENGINE_CLASS[e.engine],
                  !e.found && 'text-danger',
                )}
                title={e.found ? undefined : 'Not found in this engine: the page’s structure differs'}
              >
                <EngineDot />
                <span class="trim-cap">{e.found ? e.label : 'not found'}</span>
              </span>
            ))}
          </span>
        )}
        {result && (
          <>
            <div class={panelGroup}>
            <Check checked={filters.onlyDiff} onChange={(onlyDiff) => update({ onlyDiff })}>
              Only differences
            </Check>
            <Check checked={filters.hideVendor} onChange={(hideVendor) => update({ hideVendor })} title="-webkit-, -moz-, … properties exist only in some engines">
              Hide vendor prefixes
            </Check>
            <Check
              checked={filters.hideUnsupported}
              onChange={(hideUnsupported) => update({ hideUnsupported })}
              title="Hide properties that some engine doesn't support at all"
            >
              Hide unsupported
            </Check>
            </div>
            <input
              class={filterField}
              type="search"
              placeholder="Filter properties"
              aria-label="Filter properties"
              value={filters.text}
              onInput={(e) => update({ text: e.currentTarget.value })}
            />
          </>
        )}
      </div>

      {!result ? (
        <div class="max-w-[60ch] space-y-3 p-5 text-muted">
          <p>Compare one element across Chromium, Firefox and WebKit: its box model and every computed style, side by side.</p>
          <p class="inline-flex flex-wrap items-center gap-1">
            Click{' '}
            <strong class="inline-flex items-center gap-1 text-fg">
              <Crosshair size={13} /> <span class="trim-cap">Pick element</span>
            </strong>
            , then click an element in any pane.
          </p>
        </div>
      ) : (
        <div class="min-h-0 flex-1 overflow-auto">
          <table class="w-full border-collapse text-xs">
            <thead>
              <tr>
                <th scope="col" class={cx(cell, nameCol, 'sticky top-0 z-[1] whitespace-nowrap border-line bg-chrome')}>
                  Property
                </th>
                {engines.map((e) => (
                  <th key={e.paneId} scope="col" class={cx(cell, 'sticky top-0 z-[1] whitespace-nowrap border-line bg-chrome', ENGINE_CLASS[e.engine])}>
                    <span class="inline-flex items-center gap-1.5">
                      <EngineDot />
                      <span class="trim-cap">
                        {ENGINE_LABEL[e.engine]}
                        {panes[e.paneId]?.failed && ' (not running)'}
                      </span>
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th colSpan={engines.length + 1} scope="rowgroup" class={section}>
                  Box model
                </th>
              </tr>
              {boxRows.map((r) => (
                <Row key={r.name} name={r.name} values={r.values} found={engines.map((e) => e.found)} />
              ))}
              <tr>
                <th colSpan={engines.length + 1} scope="rowgroup" class={section}>
                  Computed styles{' '}
                  <span class="font-normal text-muted">
                    · {totalDiff} of {total} differ
                    {gaps > 0 && ` · ${gaps} explained by support gaps`}
                  </span>
                </th>
              </tr>
              {rows.map((r) => (
                <Row key={r.name} name={r.name} values={r.values} found={engines.map((e) => e.found)} compat={compat.get(r.name) ?? null} mono />
              ))}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={engines.length + 1} class={cx(cell, 'px-2.5 py-3 text-muted')}>
                    {filters.onlyDiff && !filters.text ? 'No differences: all engines compute the same styles for this element.' : 'No properties match the filter.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
          <p class="px-2.5 py-2 text-[11px] text-muted">
            Support data: MDN browser-compat-data {COMPAT_SOURCE.bcd} and web-features {COMPAT_SOURCE.webFeatures}. Chromium is compared with
            Chrome, Firefox with Firefox and WebKit with Safari versions.
          </p>
        </div>
      )}
    </div>
  );
}

const BASELINE_CLASS = { high: 'border-webkit/40 text-webkit', low: 'border-accent/40 text-accent', false: 'border-warn/50 text-warn-text' } as const;
const BASELINE_SHORT = { high: 'Baseline', low: 'Baseline new', false: 'Limited' } as const;

function Row({ name, values, found, mono, compat }: { name: string; values: (string | undefined)[]; found: boolean[]; mono?: boolean; compat?: CompatInfo | null }) {
  const common = majority(values.filter((_, i) => found[i]));
  const differs = values.filter((_, i) => found[i]).some((v) => v !== values.find((_, i) => found[i]));
  return (
    <tr>
      <th scope="row" class={cx(cell, nameCol, 'font-medium', differs ? 'text-fg' : 'text-muted', mono && 'font-mono')}>
        {name}
        {compat?.baseline && (
          <span
            class={cx('ml-1.5 inline-block whitespace-nowrap rounded-full border px-1.5 align-[1px] font-sans text-[10px]/[14px] font-normal', BASELINE_CLASS[String(compat.baseline.level) as 'high'])}
            title={`Baseline: ${BASELINE_LABEL[String(compat.baseline.level) as 'high']} (web feature “${compat.baseline.feature}”)`}
          >
            {BASELINE_SHORT[String(compat.baseline.level) as 'high']}
          </span>
        )}
      </th>
      {values.map((v, i) => (
        <td
          key={i}
          class={cx(cell, mono && 'font-mono', differs && found[i] && v !== common && 'bg-warn/18 font-semibold text-warn-text')}
        >
          {!found[i] ? (
            <span class="text-muted">—</span>
          ) : v === undefined ? (
            <span class="text-muted">(not supported)</span>
          ) : (
            v || <span class="text-muted">(empty)</span>
          )}
          {found[i] && compat?.engines[i] && (
            <span
              class={cx(
                'ml-1.5 inline-block whitespace-nowrap rounded border px-1 align-[1px] font-sans text-[10px]/[14px] font-normal',
                compat.engines[i]!.state === 'no' || compat.engines[i]!.state === 'later' ? 'border-danger/40 text-danger' : 'border-warn/50 text-warn-text',
              )}
              title={compat.engines[i]!.long}
            >
              {compat.engines[i]!.short}
            </span>
          )}
        </td>
      ))}
    </tr>
  );
}
