// The address bar: site info button, URL field, and suggestions from the browsing history.
//
// Typing completes inline to a visited site ("git" → "github.com", the added part selected, so
// typing on replaces it) and lists matching pages below. ↑/↓ choose a suggestion, Enter opens it,
// Shift+Delete forgets the highlighted page, Esc closes the list and a second Esc restores the URL.
import { Globe, Search, X } from 'lucide-preact';
import type { Ref } from 'preact';
import { useMemo, useState } from 'preact/hooks';
import { normalizeUrl, type HistoryEntry, type NetworkInfo, type PaneInfo, type SiteInfo } from '../../shared/protocol';
import type { EngineClient } from './engine';
import { NetworkMetricsButton } from './NetworkMetrics';
import { displayUrl, inlineCompletion, suggest, visitedUrlFor } from './omnibox';
import { siteKind, SiteInfoButton } from './SiteInfo';
import { SiteIcon } from './SiteIcon';
import { cx, ICON } from './ui';

interface Props {
  client: EngineClient;
  /** The page shown (the first running engine's URL). */
  url: string;
  siteInfo: SiteInfo | null;
  network: NetworkInfo | null;
  history: HistoryEntry[];
  /** The running engines, for the network figures at the right end of the field. */
  panes: PaneInfo[];
  inputRef: Ref<HTMLInputElement>;
}

type Row = { kind: 'typed'; url: string; search: boolean } | { kind: 'history'; entry: HistoryEntry };

const LIST_ID = 'address-suggestions';
const SEARCH_PREFIX = normalizeUrl('two words').split('?')[0];

export function AddressBar({ client, url, siteInfo, network, history, panes, inputRef }: Props) {
  /** The field's text while editing; null shows the page's URL. */
  const [draft, setDraft] = useState<string | null>(null);
  /** What the user typed, without the inline completion. */
  const [typed, setTyped] = useState('');
  /** Typed text plus completion: what the field goes back to when the "typed" row is chosen. */
  const [completed, setCompleted] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  /** Highlighted row; -1 for none (the list opened with ↓ before typing). */
  const [active, setActive] = useState(-1);

  const resolve = (text: string) => visitedUrlFor(history, text) ?? normalizeUrl(text);

  const rows = useMemo<Row[]>(() => {
    if (!open) return [];
    const out: Row[] = [];
    const text = completed ?? '';
    const target = text.trim() ? resolve(text) : '';
    if (target) out.push({ kind: 'typed', url: target, search: target.startsWith(SEARCH_PREFIX) && !visitedUrlFor(history, text) });
    for (const entry of suggest(history, typed, 8)) if (entry.url !== target && out.length < 8) out.push({ kind: 'history', entry });
    return out;
  }, [open, history, typed, completed]);

  const close = () => {
    setOpen(false);
    setActive(-1);
  };
  const reset = () => {
    close();
    setDraft(null);
    setTyped('');
    setCompleted(null);
  };
  const go = (to: string) => {
    client.send({ type: 'navigate', url: to });
    reset();
    (inputRef as { current: HTMLInputElement | null }).current?.blur();
  };
  const highlight = (i: number) => {
    setActive(i);
    const row = rows[i];
    setDraft(row?.kind === 'history' ? row.entry.url : completed);
  };

  // The network chip shows while the field shows the page's URL, not while typing in it; the
  // field leaves room for it (about 60px per engine).
  const measured = panes.filter((p) => p.metrics && !p.failed && !p.disabled).length;
  const showMetrics = draft === null && !open && measured > 0;

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        setActive(-1);
        return;
      }
      if (!rows.length) return;
      const step = e.key === 'ArrowDown' ? 1 : -1;
      highlight(active < 0 && step < 0 ? rows.length - 1 : (active + step + rows.length) % rows.length);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      if (open && rows.length) {
        close();
        setDraft(completed);
      } else {
        reset();
        (e.currentTarget as HTMLInputElement).blur();
      }
    } else if (e.key === 'Delete' && e.shiftKey && open) {
      const row = rows[active];
      if (row?.kind !== 'history') return;
      e.preventDefault();
      client.send({ type: 'removeHistory', urls: [row.entry.url] });
      setDraft(completed);
      setActive(Math.min(active, rows.length - 2));
    }
  };

  return (
    <form
      class="relative min-w-[200px] flex-[1_1_320px]"
      onSubmit={(e) => {
        e.preventDefault();
        const row = rows[active];
        if (row) go(row.kind === 'history' ? row.entry.url : row.url);
        else if (draft?.trim()) go(resolve(draft));
        else reset();
      }}
    >
      <input
        ref={inputRef}
        class={cx(
          'h-8 w-full rounded-lg border border-line bg-chrome-2 pr-3 outline-none focus:border-accent focus:ring-3 focus:ring-accent/25',
          // Room for the site info button (wider with its "Not secure" label).
          siteKind(url) === 'insecure' ? 'pl-[6.75rem]' : 'pl-9',
        )}
        style={showMetrics ? { paddingRight: `${34 + 62 * measured}px` } : undefined}
        value={draft ?? url}
        onInput={(e) => {
          const el = e.currentTarget;
          const text = el.value;
          // Complete only while typing forward at the end, never after a deletion.
          const inserting = (e as InputEvent).inputType?.startsWith('insert') ?? false;
          const atEnd = el.selectionStart === text.length && el.selectionEnd === text.length;
          const rest = inserting && atEnd ? inlineCompletion(history, text) : '';
          const full = text + rest;
          if (rest) {
            el.value = full;
            el.setSelectionRange(text.length, full.length);
          }
          setTyped(text);
          setCompleted(full);
          setDraft(full);
          setOpen(true);
          setActive(text.trim() ? 0 : -1);
        }}
        onFocus={(e) => e.currentTarget.select()}
        onBlur={reset}
        onKeyDown={onKeyDown}
        placeholder="Search history or enter a URL to open it in every engine"
        spellcheck={false}
        autocomplete="off"
        role="combobox"
        aria-label="Address"
        aria-autocomplete="both"
        aria-expanded={open && rows.length > 0}
        aria-controls={LIST_ID}
        aria-activedescendant={open && active >= 0 ? `${LIST_ID}-${active}` : undefined}
      />
      <SiteInfoButton client={client} url={url} info={siteInfo} network={network} />
      {showMetrics && <NetworkMetricsButton panes={panes} />}

      {open && rows.length > 0 && (
        <ul
          id={LIST_ID}
          role="listbox"
          aria-label="Suggestions"
          class="absolute inset-x-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-line bg-chrome py-1 shadow-[0_12px_32px_var(--shadow)]"
          // Clicks in the list must not blur the field (which closes it) before they land.
          onMouseDown={(e) => e.preventDefault()}
        >
          {rows.map((row, i) => {
            const on = i === active;
            const rowUrl = row.kind === 'history' ? row.entry.url : row.url;
            return (
              <li
                key={`${row.kind}:${rowUrl}`}
                id={`${LIST_ID}-${i}`}
                role="option"
                aria-selected={on}
                class={cx('group flex h-8 cursor-pointer items-center gap-2.5 px-3', on ? 'bg-accent/15' : 'hover:bg-chrome-2')}
                onMouseMove={() => active !== i && setActive(i)}
                onClick={() => go(rowUrl)}
              >
                {row.kind === 'typed' ? (
                  row.search ? <Search size={ICON} class="flex-none text-muted" /> : <Globe size={ICON} class="flex-none text-muted" />
                ) : (
                  <SiteIcon url={row.entry.url} icon={row.entry.icon} size={ICON - 2} plate />
                )}
                {row.kind === 'typed' ? (
                  <span class="trim-cap-clip min-w-0 flex-1 truncate">
                    {row.search ? (
                      <>
                        {typed.trim()} <span class="text-muted">— Search DuckDuckGo</span>
                      </>
                    ) : (
                      <Marked text={displayUrl(row.url)} query={typed} />
                    )}
                  </span>
                ) : (
                  <span class="trim-cap-clip flex min-w-0 flex-1 items-baseline gap-2">
                    <span class="truncate">
                      <Marked text={row.entry.title || displayUrl(row.entry.url)} query={typed} />
                    </span>
                    {row.entry.title && (
                      <span class="min-w-0 shrink-[2] truncate text-xs text-muted">
                        <Marked text={displayUrl(row.entry.url)} query={typed} />
                      </span>
                    )}
                  </span>
                )}
                {row.kind === 'history' && (
                  <button
                    type="button"
                    class={cx('-mr-1.5 grid size-6 flex-none place-items-center rounded text-muted hover:bg-chrome-2 hover:text-fg', on ? 'visible' : 'invisible group-hover:visible')}
                    title="Remove from history (Shift+Delete)"
                    aria-label={`Remove ${displayUrl(row.entry.url)} from history`}
                    onClick={(e) => {
                      e.stopPropagation();
                      client.send({ type: 'removeHistory', urls: [row.entry.url] });
                    }}
                  >
                    <X size={13} />
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </form>
  );
}

/** The text with the first occurrence of each typed word in bold. */
function Marked({ text, query }: { text: string; query: string }) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return <>{text}</>;
  const lower = text.toLowerCase();
  const marks: [number, number][] = [];
  for (const w of words) {
    const i = lower.indexOf(displayUrl(w));
    if (i >= 0) marks.push([i, i + displayUrl(w).length]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  const parts = [];
  let at = 0;
  for (const [s, e] of marks) {
    if (s < at) continue;
    if (s > at) parts.push(text.slice(at, s));
    parts.push(<b class="font-semibold">{text.slice(s, e)}</b>);
    at = e;
  }
  parts.push(text.slice(at));
  return <>{parts}</>;
}
