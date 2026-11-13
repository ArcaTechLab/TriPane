import type { LucideIcon } from 'lucide-preact';
import { Bug, CircleX, Dot, Info, Trash2, TriangleAlert } from 'lucide-preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { EngineName, LogEntry, PaneId, PaneInfo } from '../../shared/protocol';
import { ENGINE_LABEL } from './Pane';
import { btn, Check, cx, ENGINE_CLASS, EngineDot, filterField, panelBar, panelGroup } from './ui';

interface Props {
  entries: LogEntry[];
  panes: PaneInfo[];
  onClear(): void;
  /** Open this engine's own DevTools (from a row's engine chip). */
  onOpenEngine(id: PaneId): void;
}

type Level = 'error' | 'warning' | 'info' | 'debug';
interface Filters {
  engines: PaneId[];
  levels: Level[];
  text: string;
  group: boolean;
  preserve: boolean;
}

const DEFAULT_FILTERS: Filters = { engines: [0, 1, 2], levels: ['error', 'warning', 'info'], text: '', group: true, preserve: false };
const FILTERS_KEY = 'tripane.logFilters';
/** Identical messages from different engines this close together count as the same event. */
const GROUP_WINDOW_MS = 3000;
const LEVELS: { level: Level; label: string; icon: LucideIcon }[] = [
  { level: 'error', label: 'Errors', icon: CircleX },
  { level: 'warning', label: 'Warnings', icon: TriangleAlert },
  { level: 'info', label: 'Info', icon: Info },
  { level: 'debug', label: 'Verbose', icon: Bug },
];
const LEVEL_ICON: Record<LogEntry['level'], LucideIcon | null> = { error: CircleX, warning: TriangleAlert, info: Info, log: null, debug: Dot };
/** Row background and text color per level. */
const LEVEL_ROW: Record<LogEntry['level'], string> = {
  error: 'bg-danger/9 [&_.msg]:text-error-text',
  warning: 'bg-warn/7 [&_.msg]:text-warn-text',
  info: '',
  log: '',
  debug: '[&_.msg]:text-muted',
};

export interface LogRow {
  key: string;
  first: LogEntry;
  /** Engines that reported this row, in pane order. */
  panes: PaneId[];
}

/** Without "Preserve log", a navigation clears that engine's earlier messages, as in Chrome. */
export function applyNavigations(entries: LogEntry[], preserve: boolean): LogEntry[] {
  if (preserve) return entries;
  const cutoff = new Map<PaneId, number>();
  entries.forEach((e, i) => e.source === 'navigation' && cutoff.set(e.paneId, i));
  return entries.filter((e, i) => i >= (cutoff.get(e.paneId) ?? -1));
}

/** Merges identical messages (same level, source and text) from different engines. */
export function groupAcrossEngines(entries: LogEntry[], group: boolean): LogRow[] {
  if (!group) return entries.map((e) => ({ key: String(e.id), first: e, panes: [e.paneId] }));
  const rows: LogRow[] = [];
  const open = new Map<string, LogRow>();
  for (const e of entries) {
    // Whitespace is normalized: Firefox applies printf formatting itself and splits %c-styled
    // segments into separate arguments, so its spacing can differ from the other engines.
    const sig = `${e.level}|${e.source}|${e.text.replace(/\s+/g, ' ').trim()}`;
    const row = open.get(sig);
    if (row && !row.panes.includes(e.paneId) && e.ts - row.first.ts <= GROUP_WINDOW_MS) {
      row.panes.push(e.paneId);
      row.panes.sort();
      continue;
    }
    const fresh = { key: String(e.id), first: e, panes: [e.paneId] };
    rows.push(fresh);
    open.set(sig, fresh);
  }
  return rows;
}

function loadFilters(): Filters {
  try {
    return { ...DEFAULT_FILTERS, ...JSON.parse(localStorage.getItem(FILTERS_KEY) ?? '{}') };
  } catch {
    return DEFAULT_FILTERS;
  }
}

const levelOf = (e: LogEntry): Level => (e.level === 'log' ? 'info' : e.level);

function time(ts: number): string {
  const d = new Date(ts);
  return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function shortSource(url?: string, line?: number): string {
  if (!url) return '';
  try {
    const u = new URL(url);
    const file = u.pathname.split('/').filter(Boolean).pop() || u.host;
    return line ? `${file}:${line}` : file;
  } catch {
    return url;
  }
}

/** A small pill in the toolbar: on (pressed) or off. */
const chip = (on: boolean) =>
  cx(
    'inline-flex h-6 items-center gap-1.5 rounded-[5px] border px-2 text-xs',
    on ? 'bg-chrome-2 text-fg' : 'text-muted',
  );
const kindTag = 'mr-1.5 rounded-[3px] border border-line px-1 py-px font-sans text-[10px]/none uppercase tracking-wide text-muted';

export function UnifiedLog({ entries, panes, onClear, onOpenEngine }: Props) {
  const [filters, setFilters] = useState<Filters>(loadFilters);
  const listRef = useRef<HTMLOListElement>(null);
  const stick = useRef(true);

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

  const running = panes.filter((p) => !p.failed && !p.disabled && filters.engines.includes(p.id)).map((p) => p.id);
  const engineOf = (id: PaneId): EngineName => panes[id]?.engine ?? (['chromium', 'firefox', 'webkit'][id] as EngineName);
  const engineName = (id: PaneId) => ENGINE_LABEL[engineOf(id)];

  const { rows, counts } = useMemo(() => {
    const kept = applyNavigations(entries, filters.preserve);
    const needle = filters.text.trim().toLowerCase();
    const shown = kept.filter(
      (e) =>
        filters.engines.includes(e.paneId) &&
        (e.source === 'navigation' || filters.levels.includes(levelOf(e))) &&
        (!needle || e.text.toLowerCase().includes(needle) || (e.url ?? '').toLowerCase().includes(needle)),
    );
    // Per level, for the level buttons: every message from the chosen engines, whatever the
    // level and text filters hide (as in Chrome).
    const counts: Record<Level, number> = { error: 0, warning: 0, info: 0, debug: 0 };
    for (const e of kept) if (e.source !== 'navigation' && filters.engines.includes(e.paneId)) counts[levelOf(e)]++;
    return { rows: groupAcrossEngines(shown, filters.group), counts };
  }, [entries, filters]);

  useEffect(() => {
    const list = listRef.current;
    if (list && stick.current) list.scrollTop = list.scrollHeight;
  }, [rows]);

  return (
    <div class="absolute inset-0 flex flex-col bg-bg text-fg">
      <div class={panelBar}>
        <div class={cx(panelGroup, 'gap-0.5')} role="group" aria-label="Engines">
          {panes.filter((p) => !p.disabled).map((p) => {
            const on = filters.engines.includes(p.id);
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={on}
                class={cx(chip(on), 'border-line', ENGINE_CLASS[p.engine])}
                onClick={() => update({ engines: on ? filters.engines.filter((x) => x !== p.id) : [...filters.engines, p.id].sort() })}
              >
                <EngineDot off={!on} /> <span class="trim-cap">{ENGINE_LABEL[p.engine]}</span>
              </button>
            );
          })}
        </div>
        <input
          class={filterField}
          type="search"
          placeholder="Filter"
          aria-label="Filter messages"
          value={filters.text}
          onInput={(e) => update({ text: e.currentTarget.value })}
        />
        <div class={cx(panelGroup, 'gap-0.5')} role="group" aria-label="Levels">
          {/* Each level: show or hide it, with its icon and how many messages there are. */}
          {LEVELS.map(({ level, label, icon: Icon }) => {
            const on = filters.levels.includes(level);
            const n = counts[level];
            const tone = n > 0 && level === 'error' ? 'text-danger' : n > 0 && level === 'warning' ? 'text-warn' : '';
            return (
              <button
                key={level}
                type="button"
                aria-pressed={on}
                aria-label={`${label}: ${n} message${n === 1 ? '' : 's'}`}
                title={`${on ? 'Hide' : 'Show'} ${label.toLowerCase()} (${n})`}
                class={cx(chip(on), on ? 'border-[color-mix(in_srgb,var(--accent)_60%,var(--line))]' : 'border-line')}
                onClick={() => update({ levels: on ? filters.levels.filter((l) => l !== level) : [...filters.levels, level] })}
              >
                <Icon size={12} class={cx('flex-none', tone || 'text-muted', !on && 'opacity-60')} />
                <span class="trim-cap">{label}</span>
                {n > 0 && <span class={cx('trim-cap tabular-nums', tone || 'text-muted')}>{n > 999 ? '999+' : n}</span>}
              </button>
            );
          })}
        </div>
        <div class={panelGroup}>
          <Check checked={filters.group} onChange={(group) => update({ group })} title="Show identical messages from different engines as one row">
            Group engines
          </Check>
          <Check checked={filters.preserve} onChange={(preserve) => update({ preserve })} title="Keep messages when pages navigate">
            Preserve log
          </Check>
        </div>
        {/* Clear stays at the right end of whichever line it lands on. */}
        <div class={cx(panelGroup, 'ml-auto')}>
        <button type="button" class={btn('ghost', { small: true })} onClick={onClear} title="Clear the log for all engines">
          <Trash2 size={13} /> <span class="trim-cap">Clear</span>
        </button>
        </div>
      </div>

      <ol
        class="min-h-0 flex-1 overflow-auto font-mono text-xs/[1.45]"
        ref={listRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
        }}
      >
        {rows.length === 0 && (
          <li class="p-4 font-sans text-muted">
            {entries.length ? 'No messages match the filters.' : 'Console messages from Chromium, Firefox and WebKit appear here, side by side in one timeline.'}
          </li>
        )}
        {rows.map(({ key, first, panes: from }) => {
          const missing = filters.group && running.length > 1 ? running.filter((id) => !from.includes(id)) : [];
          const nav = first.source === 'navigation';
          const Icon = LEVEL_ICON[first.level];
          return (
            <li
              key={key}
              class={cx(
                'grid grid-cols-[92px_minmax(0,max-content)_minmax(0,1fr)_auto] items-baseline gap-2.5 border-b border-hairline px-2 py-[3px]',
                nav ? 'bg-accent/8 text-muted' : LEVEL_ROW[first.level],
              )}
            >
              <time class="text-muted">{time(first.ts)}</time>
              <span class="inline-flex flex-wrap gap-[3px]">
                {from.map((id) => (
                  <button
                    key={id}
                    type="button"
                    class={cx(
                      'rounded-[3px] px-[5px] py-0.5 font-sans text-[10.5px]/none text-white',
                      'bg-[color-mix(in_srgb,var(--engine)_75%,#000)] hover:bg-engine',
                      ENGINE_CLASS[engineOf(id)],
                    )}
                    title={`Open ${engineName(id)} DevTools`}
                    onClick={() => onOpenEngine(id)}
                  >
                    {engineName(id)}
                  </button>
                ))}
              </span>
              <span class="msg min-w-0 whitespace-pre-wrap wrap-anywhere">
                {nav ? (
                  <>
                    Navigated to{' '}
                    <a class="text-accent" href={first.text} onClick={(e) => e.preventDefault()}>
                      {first.text}
                    </a>
                  </>
                ) : (
                  <>
                    {Icon && <Icon size={12} class="mr-1 inline-block align-[-1px]" aria-label={first.level} />}
                    {first.source === 'tripane' && <span class={kindTag}>TriPane</span>}
                    {first.source === 'network' && <span class={kindTag}>Network</span>}
                    {first.text}
                  </>
                )}
                {missing.length > 0 && !nav && (
                  <span
                    class="ml-2 whitespace-nowrap rounded-full border border-warn/50 px-1.5 py-0.5 font-sans text-[10.5px]/none text-warn"
                    title="The other engines didn't report this message"
                  >
                    {from.length === 1 ? `only in ${engineName(from[0])}` : `not in ${missing.map(engineName).join(', ')}`}
                  </span>
                )}
              </span>
              <span class="max-w-[220px] truncate text-muted" title={first.url}>
                {shortSource(first.url, first.line)}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
