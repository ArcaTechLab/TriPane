// The History page (Tools → History, or Ctrl+H): every visited page by day, with search, time
// ranges, "more from this site", selecting several pages to remove, and clearing everything.
//
// Keyboard: type to search, ↓ into the list, ↑/↓ between pages, Enter opens, Space selects,
// Delete removes, Esc closes.
import type { LucideIcon } from 'lucide-preact';
import { Check, Copy, ExternalLink, Filter, History as HistoryIcon, Search, SearchX, Trash2, X } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { HistoryEntry } from '../../shared/protocol';
import type { EngineClient } from './engine';
import { displayUrl } from './omnibox';
import { SiteIcon } from './SiteIcon';
import { btn, cx, ICON } from './ui';

interface Props {
  open: boolean;
  history: HistoryEntry[];
  client: EngineClient;
  /** Whether history is saved between runs (a profile folder is in use). */
  saved: boolean;
  onClose(): void;
}

type Range = 'all' | 'today' | 'week' | 'month';
const RANGES: { value: Range; label: string }[] = [
  { value: 'all', label: 'All time' },
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Last 7 days' },
  { value: 'month', label: 'Last 30 days' },
];
const PAGE = 200;
const DAY = 86_400_000;

const startOfDay = (t: number) => {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

function rangeStart(range: Range, now: number): number {
  if (range === 'today') return startOfDay(now);
  if (range === 'week') return startOfDay(now) - 6 * DAY;
  if (range === 'month') return startOfDay(now) - 29 * DAY;
  return 0;
}

function dayTitle(ts: number, now: number): { title: string; date: string } {
  const d = new Date(ts);
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY);
  const date = d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: d.getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
  return days === 0 ? { title: 'Today', date } : days === 1 ? { title: 'Yesterday', date } : { title: date, date: '' };
}

const timeOf = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
}

export function HistoryDialog({ open, history, client, saved, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState('');
  const [range, setRange] = useState<Range>('all');
  const [site, setSite] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirmClear, setConfirmClear] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      dialog.showModal();
      searchRef.current?.focus();
    }
    if (!open && dialog.open) dialog.close();
    if (!open) {
      setQuery('');
      setRange('all');
      setSite(null);
      setShown(PAGE);
      setSelected(new Set());
      setConfirmClear(false);
    }
  }, [open]);

  // Forget selections of pages that are gone (removed here, from the address bar, or cleared).
  useEffect(() => {
    if (!selected.size) return;
    const urls = new Set(history.map((e) => e.url));
    const kept = [...selected].filter((u) => urls.has(u));
    if (kept.length !== selected.size) setSelected(new Set(kept));
  }, [history]);

  const now = Date.now();
  const words = useMemo(() => query.trim().toLowerCase().split(/\s+/).filter(Boolean), [query]);
  const matches = useMemo(() => {
    const from = rangeStart(range, now);
    return history.filter(
      (e) =>
        e.lastVisit >= from &&
        (!site || hostOf(e.url) === site) &&
        words.every((w) => e.url.toLowerCase().includes(w) || e.title.toLowerCase().includes(w)),
    );
  }, [history, words, range, site]);

  const groups = useMemo(() => {
    const out: { key: number; entries: HistoryEntry[] }[] = [];
    for (const e of matches.slice(0, shown)) {
      const key = startOfDay(e.lastVisit);
      if (out.at(-1)?.key !== key) out.push({ key, entries: [] });
      out.at(-1)!.entries.push(e);
    }
    return out;
  }, [matches, shown]);

  const filtered = !!words.length || range !== 'all' || !!site;
  const selecting = selected.size > 0;

  const openPage = (url: string) => {
    client.send({ type: 'navigate', url });
    onClose();
  };
  const remove = (urls: string[]) => {
    if (urls.length) client.send({ type: 'removeHistory', urls });
  };
  const toggle = (urls: string[], on: boolean) => {
    const next = new Set(selected);
    for (const u of urls) {
      if (on) next.add(u);
      else next.delete(u);
    }
    setSelected(next);
  };
  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(url);
      setTimeout(() => setCopied((c) => (c === url ? null : c)), 1200);
    } catch {
      // clipboard not available (e.g. opened over plain http in another browser)
    }
  };

  // ---- keyboard: rows are the focusable elements marked data-row -------------------------------
  const rows = () => Array.from(listRef.current?.querySelectorAll<HTMLElement>('[data-row]') ?? []);
  const focusRow = (i: number) => {
    const all = rows();
    all[Math.max(0, Math.min(all.length - 1, i))]?.focus();
  };
  const onListKey = (e: KeyboardEvent) => {
    const all = rows();
    const i = all.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    const url = all[i].dataset.row!;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (e.key === 'ArrowUp' && i === 0) searchRef.current?.focus();
      else focusRow(i + (e.key === 'ArrowDown' ? 1 : -1));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      focusRow(e.key === 'Home' ? 0 : all.length - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openPage(url);
    } else if (e.key === ' ') {
      e.preventDefault();
      toggle([url], !selected.has(url));
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      remove([url]);
      // Keep focus in place: the next page moves up into this row's position.
      setTimeout(() => focusRow(i), 50);
    }
  };

  return (
    <dialog
      ref={ref}
      class="m-auto flex h-[min(780px,calc(100vh-32px))] w-[min(880px,calc(100vw-32px))] flex-col overflow-hidden rounded-xl border border-line bg-bg p-0 text-fg shadow-[0_24px_64px_var(--shadow)] backdrop:bg-black/60 [&:not([open])]:hidden"
      aria-labelledby="history-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* ---- header: title, search, filters ---- */}
      <header class="flex flex-none flex-col gap-3 border-b border-line bg-chrome px-5 pb-3 pt-4">
        <div class="flex items-center gap-3">
          <span class="grid size-8 flex-none place-items-center rounded-lg bg-accent/15 text-accent">
            <HistoryIcon size={17} />
          </span>
          <div class="min-w-0">
            <h2 id="history-title" class="text-base/tight font-bold">
              History
            </h2>
            <p class="text-xs text-muted">
              {history.length} {history.length === 1 ? 'page' : 'pages'} · {saved ? 'saved with your profile' : 'fresh session, forgotten when you quit'}
            </p>
          </div>
          <button type="button" class={cx(btn('ghost', { icon: true }), 'ml-auto')} onClick={onClose} aria-label="Close history" title="Close (Esc)">
            <X size={ICON} />
          </button>
        </div>

        <label class="relative block">
          <Search size={15} class="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted" />
          <input
            ref={searchRef}
            type="text"
            class="h-9 w-full rounded-lg border border-line bg-chrome-2 pl-9 pr-9 outline-none focus:border-accent focus:ring-3 focus:ring-accent/25"
            placeholder="Search by title or address"
            aria-label="Search history"
            value={query}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setShown(PAGE);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                focusRow(0);
              }
              if (e.key === 'Escape' && query) {
                e.preventDefault(); // the first Esc clears the search, the next closes
                setQuery('');
              }
            }}
          />
          {query && (
            <button
              type="button"
              class="absolute right-2 top-1/2 grid size-6 -translate-y-1/2 place-items-center rounded text-muted hover:bg-line/60 hover:text-fg"
              aria-label="Clear search"
              onClick={() => {
                setQuery('');
                searchRef.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          )}
        </label>

        {/* Filters, or the selection's actions while pages are selected. */}
        {selecting ? (
          <div class="flex min-h-7 flex-wrap items-center gap-2" role="toolbar" aria-label="Selected pages">
            <span class="font-semibold">{selected.size} selected</span>
            <button type="button" class={btn('ghost', { small: true })} onClick={() => setSelected(new Set())}>
              Cancel
            </button>
            <button
              type="button"
              class={cx(btn('ghost', { small: true }), 'ml-auto')}
              onClick={() => toggle(matches.map((e) => e.url), true)}
              disabled={matches.every((e) => selected.has(e.url))}
            >
              Select all {matches.length}
            </button>
            <button
              type="button"
              class={btn('danger', { small: true })}
              onClick={() => {
                remove([...selected]);
                setSelected(new Set());
              }}
            >
              <Trash2 size={13} /> <span class="trim-cap">Remove {selected.size}</span>
            </button>
          </div>
        ) : (
          <div class="flex min-h-7 flex-wrap items-center gap-2">
            <div class="inline-flex rounded-lg border border-line bg-bg p-0.5" role="radiogroup" aria-label="Time range">
              {RANGES.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  role="radio"
                  aria-checked={range === r.value}
                  class={cx(
                    'h-6 rounded-md px-2.5 text-xs focus-visible:outline-2 focus-visible:outline-accent',
                    range === r.value ? 'bg-accent text-on-accent' : 'text-muted hover:text-fg',
                  )}
                  onClick={() => {
                    setRange(r.value);
                    setShown(PAGE);
                  }}
                >
                  {r.label}
                </button>
              ))}
            </div>
            {site && (
              <span class="inline-flex h-7 items-center gap-1.5 rounded-full border border-accent/50 bg-accent/10 pl-2 pr-1 text-xs">
                <SiteIcon url={`https://${site}/`} icon={history.find((e) => hostOf(e.url) === site)?.icon} size={12} plate />
                <span class="trim-cap">{site}</span>
                <button
                  type="button"
                  class="grid size-5 place-items-center rounded-full text-muted hover:bg-accent/20 hover:text-fg"
                  aria-label={`Show every site, not just ${site}`}
                  onClick={() => setSite(null)}
                >
                  <X size={12} />
                </button>
              </span>
            )}
            {filtered && (
              <span class="ml-auto text-xs text-muted">
                {matches.length} of {history.length}
              </span>
            )}
          </div>
        )}
      </header>

      {/* ---- the list, one card per day ---- */}
      <div ref={listRef} class="min-h-0 flex-1 overflow-auto px-5 py-4" onKeyDown={onListKey}>
        {!history.length ? (
          <Empty icon={HistoryIcon} title="No history yet" text="Pages you open show up here." />
        ) : !matches.length ? (
          <Empty
            icon={SearchX}
            title="Nothing found"
            text={words.length ? `No pages match “${query.trim()}”${range !== 'all' || site ? ' with these filters' : ''}.` : 'No pages in this time range.'}
            action={
              <button
                type="button"
                class={btn('outline', { small: true })}
                onClick={() => {
                  setQuery('');
                  setRange('all');
                  setSite(null);
                }}
              >
                Clear filters
              </button>
            }
          />
        ) : (
          groups.map((g) => {
            const { title, date } = dayTitle(g.key, now);
            const urls = g.entries.map((e) => e.url);
            const all = urls.every((u) => selected.has(u));
            const some = !all && urls.some((u) => selected.has(u));
            return (
              <section key={g.key} class="group/day mb-4 rounded-xl border border-line bg-chrome" aria-label={title}>
                <h3 class="sticky -top-4 z-10 flex items-center gap-3 rounded-t-xl border-b border-line bg-chrome px-3 py-2">
                  <input
                    type="checkbox"
                    class={cx('size-3.5 accent-accent', !selecting && !some && 'opacity-0 focus-visible:opacity-100 group-hover/day:opacity-100')}
                    checked={all}
                    ref={(el) => {
                      if (el) el.indeterminate = some;
                    }}
                    onChange={(e) => toggle(urls, e.currentTarget.checked)}
                    aria-label={`Select every page from ${title}`}
                  />
                  <span class="text-[13px] font-semibold">{title}</span>
                  {date && <span class="text-xs text-muted">{date}</span>}
                  <span class="ml-auto text-xs text-muted">
                    {g.entries.length} {g.entries.length === 1 ? 'page' : 'pages'}
                  </span>
                </h3>
                <ul>
                  {g.entries.map((e) => (
                    <Row
                      key={e.url}
                      entry={e}
                      words={words}
                      selected={selected.has(e.url)}
                      selecting={selecting}
                      copied={copied === e.url}
                      siteFiltered={!!site}
                      onOpen={() => openPage(e.url)}
                      onSelect={(on) => toggle([e.url], on)}
                      onCopy={() => void copy(e.url)}
                      onSite={() => {
                        setSite(hostOf(e.url));
                        setShown(PAGE);
                      }}
                      onRemove={() => remove([e.url])}
                    />
                  ))}
                </ul>
              </section>
            );
          })
        )}
        {matches.length > shown && (
          <div class="pb-2 text-center">
            <button type="button" class={btn('outline', { small: true })} onClick={() => setShown((n) => n + PAGE)}>
              Show more ({matches.length - shown} left)
            </button>
          </div>
        )}
      </div>

      <footer class="flex flex-none flex-wrap items-center justify-between gap-2 border-t border-line bg-chrome px-5 py-2.5 text-xs text-muted">
        <span class="hidden items-center gap-1 sm:inline-flex">
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move · <Kbd>Enter</Kbd> open · <Kbd>Space</Kbd> select · <Kbd>Del</Kbd> remove
        </span>
        <button
          type="button"
          class={cx(btn(confirmClear ? 'danger' : 'outline', { small: true }), 'ml-auto')}
          disabled={!history.length}
          onClick={() => {
            if (!confirmClear) return setConfirmClear(true);
            client.send({ type: 'clearHistory' });
            setConfirmClear(false);
          }}
          onBlur={() => setConfirmClear(false)}
        >
          <Trash2 size={13} /> <span class="trim-cap">{confirmClear ? `Click again to remove all ${history.length} pages` : 'Clear history'}</span>
        </button>
      </footer>
    </dialog>
  );
}

function Row(props: {
  entry: HistoryEntry;
  words: string[];
  selected: boolean;
  selecting: boolean;
  copied: boolean;
  siteFiltered: boolean;
  onOpen(): void;
  onSelect(on: boolean): void;
  onCopy(): void;
  onSite(): void;
  onRemove(): void;
}) {
  const { entry: e, words } = props;
  const shownUrl = displayUrl(e.url);
  return (
    <li
      data-row={e.url}
      tabIndex={0}
      class={cx(
        'group/row flex cursor-pointer items-center gap-3 border-b border-hairline px-3 py-2 outline-none last:rounded-b-xl last:border-b-0',
        props.selected ? 'bg-accent/10' : 'hover:bg-chrome-2 focus-visible:bg-chrome-2',
        'focus-visible:shadow-[inset_2px_0_0_var(--accent)]',
      )}
      title={e.url}
      onClick={(ev) => {
        // While pages are selected (or with Ctrl/Cmd), a click selects instead of opening.
        if (props.selecting || ev.ctrlKey || ev.metaKey) props.onSelect(!props.selected);
        else props.onOpen();
      }}
    >
      <input
        type="checkbox"
        class={cx('size-3.5 flex-none accent-accent', !props.selecting && 'opacity-0 group-hover/row:opacity-100')}
        checked={props.selected}
        tabIndex={-1}
        onClick={(ev) => ev.stopPropagation()}
        onChange={(ev) => props.onSelect(ev.currentTarget.checked)}
        aria-label={`Select ${e.title || shownUrl}`}
      />
      <span class="grid size-8 flex-none place-items-center rounded-lg border border-hairline bg-bg">
        <SiteIcon url={e.url} icon={e.icon} size={16} plate />
      </span>
      <span class="flex min-w-0 flex-1 flex-col gap-1">
        <span class="truncate text-[13px]/tight">
          <Marked text={e.title || shownUrl} words={words} />
        </span>
        <span class="truncate text-xs/tight text-muted">
          <Marked text={shownUrl} words={words} />
        </span>
      </span>

      {/* Visits and time; hovering or focusing the row swaps in its actions. */}
      <span class="flex flex-none items-center gap-2 text-xs tabular-nums text-muted group-hover/row:hidden group-focus-visible/row:hidden">
        {e.visits > 1 && (
          <span class="rounded-full border border-line px-1.5 text-[11px]/4" title={`Visited ${e.visits} times`}>
            {e.visits}×
          </span>
        )}
        <time class="min-w-16 text-right">{timeOf(e.lastVisit)}</time>
      </span>
      <span class="hidden flex-none items-center gap-0.5 group-hover/row:flex group-focus-visible/row:flex">
        <Action icon={ExternalLink} label="Open in every engine" onClick={props.onOpen} />
        <Action icon={props.copied ? Check : Copy} label={props.copied ? 'Copied' : 'Copy link'} onClick={props.onCopy} />
        {!props.siteFiltered && <Action icon={Filter} label={`More from ${hostOf(e.url)}`} onClick={props.onSite} />}
        <Action icon={Trash2} label="Remove from history" onClick={props.onRemove} danger />
      </span>
    </li>
  );
}

function Action(props: { icon: LucideIcon; label: string; onClick(): void; danger?: boolean }) {
  return (
    <button
      type="button"
      tabIndex={-1}
      class={cx('grid size-7 place-items-center rounded-md text-muted hover:bg-line/60', props.danger ? 'hover:text-danger' : 'hover:text-fg')}
      title={props.label}
      aria-label={props.label}
      onClick={(ev) => {
        ev.stopPropagation();
        props.onClick();
      }}
    >
      <props.icon size={14} />
    </button>
  );
}

function Empty(props: { icon: LucideIcon; title: string; text: string; action?: ComponentChildren }) {
  return (
    <div class="flex flex-col items-center gap-2 px-4 py-16 text-center">
      <span class="mb-1 grid size-12 place-items-center rounded-full bg-chrome text-muted">
        <props.icon size={22} />
      </span>
      <p class="font-semibold">{props.title}</p>
      <p class="max-w-80 text-muted">{props.text}</p>
      {props.action && <div class="mt-2">{props.action}</div>}
    </div>
  );
}

function Kbd(props: { children: string }) {
  return <kbd class="rounded border border-line bg-chrome-2 px-1 font-sans text-[10.5px]/4">{props.children}</kbd>;
}

/** The text with every searched word highlighted. */
function Marked({ text, words }: { text: string; words: string[] }) {
  if (!words.length) return <>{text}</>;
  const lower = text.toLowerCase();
  const marks: [number, number][] = [];
  for (const w of words) {
    for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + w.length)) marks.push([i, i + w.length]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  const parts = [];
  let at = 0;
  for (const [s, e] of marks) {
    if (s < at) continue;
    if (s > at) parts.push(text.slice(at, s));
    parts.push(<mark class="rounded-[2px] bg-warn/30 text-inherit">{text.slice(s, e)}</mark>);
    at = e;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}
