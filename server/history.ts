// Browsing history: pages the panes visited, for the address bar's suggestions and the History
// page. Saved as history.json next to the engines' storage (not saved in a fresh session).
//
// The three engines load the same page, so a visit counts once: the same URL again within a few
// seconds (another engine, a redirect settling) only refreshes the entry.
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { HistoryEntry } from '../shared/protocol';

const MAX_ENTRIES = 5000;
const SAME_VISIT_MS = 5000;
const SAVE_DELAY_MS = 1000;

export class BrowsingHistory {
  /** Most recent first. */
  private entries: HistoryEntry[] = [];
  private saveTimer?: ReturnType<typeof setTimeout>;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string | null) {}

  async load(): Promise<void> {
    if (!this.dir) return;
    try {
      const data = await Bun.file(join(this.dir, 'history.json')).json();
      if (!Array.isArray(data)) return;
      this.entries = data
        .filter((e) => e && typeof e.url === 'string' && typeof e.lastVisit === 'number')
        .map((e) => ({
          url: e.url,
          title: typeof e.title === 'string' ? e.title : '',
          visits: Math.max(1, Number(e.visits) || 1),
          lastVisit: e.lastVisit,
          ...(typeof e.icon === 'string' ? { icon: e.icon } : {}),
        }))
        .sort((a, b) => b.lastVisit - a.lastVisit)
        .slice(0, MAX_ENTRIES);
    } catch {
      // no history yet, or unreadable: start empty
    }
  }

  all(): HistoryEntry[] {
    return this.entries;
  }

  /** Records a visit; returns the updated entry, or null for pages that aren't kept. */
  visit(url: string, now = Date.now()): HistoryEntry | null {
    if (!worthKeeping(url)) return null;
    const i = this.entries.findIndex((e) => e.url === url);
    const existing = i >= 0 ? this.entries[i] : null;
    const entry: HistoryEntry = existing
      ? { ...existing, visits: existing.visits + (now - existing.lastVisit < SAME_VISIT_MS ? 0 : 1), lastVisit: now }
      : { url, title: '', visits: 1, lastVisit: now };
    if (i >= 0) this.entries.splice(i, 1);
    this.entries.unshift(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.length = MAX_ENTRIES;
    this.scheduleSave();
    return entry;
  }

  /** Sets a page's title once it's known; returns the entry if it changed. */
  setTitle(url: string, title: string): HistoryEntry | null {
    const i = this.entries.findIndex((e) => e.url === url);
    if (i < 0 || !title || this.entries[i].title === title) return null;
    this.entries[i] = { ...this.entries[i], title };
    this.scheduleSave();
    return this.entries[i];
  }

  /** Sets a page's icon; returns the entry if it changed. */
  setIcon(url: string, icon: string): HistoryEntry | null {
    const i = this.entries.findIndex((e) => e.url === url);
    if (i < 0 || this.entries[i].icon === icon || icon.length > 2048) return null;
    this.entries[i] = { ...this.entries[i], icon };
    this.scheduleSave();
    return this.entries[i];
  }

  /** Removes pages; returns the URLs that were in history. */
  remove(urls: string[]): string[] {
    const gone = new Set(urls);
    const removed = this.entries.filter((e) => gone.has(e.url)).map((e) => e.url);
    if (!removed.length) return [];
    this.entries = this.entries.filter((e) => !gone.has(e.url));
    this.scheduleSave();
    return removed;
  }

  async clear(): Promise<void> {
    this.entries = [];
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    await this.writing;
    if (this.dir) await rm(join(this.dir, 'history.json'), { force: true });
  }

  /** Writes pending changes now (at shutdown). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = undefined;
      this.save();
    }
    await this.writing;
  }

  private scheduleSave(): void {
    if (!this.dir || this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, SAVE_DELAY_MS);
  }

  private save(): void {
    const dir = this.dir;
    if (!dir) return;
    const text = JSON.stringify(this.entries);
    this.writing = this.writing
      .then(async () => {
        const path = join(dir, 'history.json');
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const tmp = `${path}.${process.pid}.tmp`;
        await Bun.write(tmp, text);
        await chmod(tmp, 0o600);
        await rename(tmp, path);
      })
      .catch(() => {});
  }
}

/** Web pages and local files; not about:blank, data: URLs or TriPane's own pages (excluded by the caller). */
function worthKeeping(url: string): boolean {
  return /^(https?|file):/i.test(url);
}

const ICON_MAX_BYTES = 256 * 1024;
const ICON_CACHE_SIZE = 500;

/**
 * Site icons for the History page and address bar, fetched by the server (the UI can't load
 * other origins' images under its own address, and pages' icons may need the server's network).
 * Kept in memory; a failed fetch is remembered too, so a missing icon isn't asked for again.
 */
export class FaviconCache {
  private cache = new Map<string, Promise<{ body: Uint8Array<ArrayBuffer>; type: string } | null>>();

  async get(url: string): Promise<Response> {
    let icon: { body: Uint8Array<ArrayBuffer>; type: string } | null = null;
    if (url.startsWith('data:image/')) {
      const r = await fetch(url).catch(() => null);
      if (r?.ok) icon = { body: new Uint8Array(await r.arrayBuffer()), type: r.headers.get('content-type') ?? 'image/png' };
    } else if (/^https?:\/\//i.test(url)) {
      let pending = this.cache.get(url);
      if (!pending) {
        pending = fetchIcon(url);
        this.cache.set(url, pending);
        if (this.cache.size > ICON_CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!);
      }
      icon = await pending;
    }
    if (!icon) return new Response('No icon', { status: 404, headers: { 'cache-control': 'max-age=3600' } });
    return new Response(icon.body, {
      headers: {
        'content-type': icon.type,
        'cache-control': 'max-age=86400',
        // An SVG icon must not run script in TriPane's origin.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
        'x-content-type-options': 'nosniff',
      },
    });
  }
}

async function fetchIcon(url: string): Promise<{ body: Uint8Array<ArrayBuffer>; type: string } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { accept: 'image/*' } });
    if (!res.ok) return null;
    const body = new Uint8Array(await res.arrayBuffer());
    if (!body.length || body.length > ICON_MAX_BYTES) return null;
    const type = sniffImage(body) ?? (res.headers.get('content-type') ?? '').split(';')[0].trim();
    return type.startsWith('image/') ? { body, type } : null;
  } catch {
    return null;
  }
}

/** The image type from its first bytes (servers often send .ico as text/plain or octet-stream). */
function sniffImage(b: Uint8Array): string | null {
  const head = (n: number) => Array.from(b.subarray(0, n));
  const is = (...bytes: number[]) => bytes.every((x, i) => b[i] === x);
  if (is(0x89, 0x50, 0x4e, 0x47)) return 'image/png';
  if (is(0xff, 0xd8, 0xff)) return 'image/jpeg';
  if (is(0x47, 0x49, 0x46)) return 'image/gif';
  if (is(0x00, 0x00, 0x01, 0x00)) return 'image/x-icon';
  if (is(0x52, 0x49, 0x46, 0x46) && String.fromCharCode(...head(12).slice(8)) === 'WEBP') return 'image/webp';
  const text = new TextDecoder().decode(b.subarray(0, 512)).trimStart().toLowerCase();
  if (text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'))) return 'image/svg+xml';
  return null;
}
