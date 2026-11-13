// Address bar suggestions from the browsing history: ranking and inline completion, Chrome-style.
// Pure functions, shared by the address bar and its tests.
import type { HistoryEntry } from '../../shared/protocol';

/** A URL the way it's typed: no scheme, no "www.", no trailing slash on a bare host. */
export function displayUrl(url: string): string {
  return url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^www\./i, '').replace(/^([^/?#]+)\/$/, '$1');
}

const hostOf = (shown: string) => shown.split(/[/?#]/, 1)[0];

/** How often and how recently a page was visited: a week-scale decay times the visit count. */
function frecency(e: HistoryEntry, now: number): number {
  const days = Math.max(0, (now - e.lastVisit) / 86_400_000);
  return Math.log2(1 + e.visits) * (1 / (1 + days / 7));
}

/**
 * History entries matching what was typed, best first. URLs that start with the input (host
 * first) rank above pages that only contain every word in their URL or title. Empty input gives
 * the most recent pages.
 */
export function suggest(history: HistoryEntry[], input: string, limit = 8, now = Date.now()): HistoryEntry[] {
  const q = input.trim().toLowerCase();
  if (!q) return history.slice(0, limit);
  const qShown = displayUrl(q);
  const words = q.split(/\s+/);
  const scored: { e: HistoryEntry; score: number }[] = [];
  for (const e of history) {
    const shown = displayUrl(e.url).toLowerCase();
    const full = e.url.toLowerCase();
    const title = e.title.toLowerCase();
    let tier = 0;
    if (shown.startsWith(qShown) || full.startsWith(q)) tier = hostOf(shown).startsWith(qShown) ? 4 : 3;
    else if (hostOf(shown).split('.').some((part) => part.startsWith(qShown))) tier = 2; // "hub" → github.com
    else if (words.every((w) => full.includes(w) || title.includes(w))) tier = 1;
    if (!tier) continue;
    // Among prefix matches, the shorter URL (the site itself) wins over deep pages.
    const brevity = tier >= 3 ? 1 / (1 + shown.length / 40) : 0;
    scored.push({ e, score: tier * 10 + frecency(e, now) + brevity });
  }
  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.e);
}

/**
 * What to add after the caret when the input is the start of a visited URL: the rest of the host
 * while the host is still being typed ("git" → "hub.com"), then the rest of the URL. '' if none.
 */
export function inlineCompletion(history: HistoryEntry[], input: string): string {
  if (!input || /\s/.test(input)) return '';
  const typed = input.toLowerCase();
  const typedShown = displayUrl(typed);
  // "github.com/": displayUrl drops that slash, so completing would double it.
  if (/^(?:[a-z][a-z0-9+.-]*:\/\/)?[^/?#]+\/$/.test(typed)) return '';
  let best: { shown: string; score: number } | null = null;
  const now = Date.now();
  for (const e of history) {
    const shown = displayUrl(e.url);
    if (!shown.toLowerCase().startsWith(typedShown)) continue;
    const score = frecency(e, now);
    if (!best || score > best.score) best = { shown, score };
  }
  if (!best) return '';
  const host = hostOf(best.shown);
  const target = typedShown.length < host.length ? host : best.shown;
  return target.slice(typedShown.length);
}

/** The visited URL a typed address refers to (so "github.com" opens the https:// page visited), if any. */
export function visitedUrlFor(history: HistoryEntry[], typed: string): string | null {
  const t = typed.trim().toLowerCase();
  if (!t) return null;
  const hit = history.find((e) => displayUrl(e.url).toLowerCase() === displayUrl(t) || e.url.toLowerCase() === t);
  return hit?.url ?? null;
}
