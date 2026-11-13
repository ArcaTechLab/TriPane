// Engine update checks.
//
// Playwright pins an exact, patched build of Chromium, Firefox and WebKit to each release, so an
// engine is updated by updating Playwright. The check asks npm for the latest playwright-core,
// reads which browser builds that release ships (its browsers.json), and compares them with the
// installed ones, engine by engine.

import type { EngineName, UpdateStatus } from '../shared/protocol';
// Bundled at build time, so a standalone build (which has no node_modules) knows them too.
import installedBrowsers from '../node_modules/playwright-core/browsers.json' with { type: 'json' };
import installedPackage from 'playwright-core/package.json' with { type: 'json' };
import { STANDALONE } from './standalone';

export interface UpdateSources {
  /** npm registry, for the latest playwright-core version. */
  registry: string;
  /** A CDN serving files from npm packages, for that version's browsers.json. */
  cdn: string;
}

export const DEFAULT_UPDATE_SOURCES: UpdateSources = {
  registry: 'https://registry.npmjs.org',
  cdn: 'https://cdn.jsdelivr.net/npm',
};

const ENGINES: EngineName[] = ['chromium', 'firefox', 'webkit'];
const TIMEOUT_MS = 15_000;

interface BrowsersJson {
  browsers: { name: string; browserVersion?: string }[];
}

/** Compares dotted version numbers ("158.0.8127.18", "1.65.0"); prerelease suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return Math.sign(d);
  }
  return 0;
}

function engineVersions(json: BrowsersJson): Record<EngineName, string> {
  const out = {} as Record<EngineName, string>;
  for (const e of ENGINES) out[e] = json.browsers.find((b) => b.name === e)?.browserVersion ?? '';
  return out;
}

/** The installed playwright-core version and the browser builds it uses. */
export async function installedVersions(): Promise<{ playwright: string; engines: Record<EngineName, string> }> {
  return { playwright: installedPackage.version, engines: engineVersions(installedBrowsers as BrowsersJson) };
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return (await res.json()) as T;
}

export async function checkForUpdates(sources: UpdateSources = DEFAULT_UPDATE_SOURCES): Promise<UpdateStatus> {
  const installed = await installedVersions();
  const base: UpdateStatus = {
    checkedAt: Date.now(),
    playwright: { installed: installed.playwright, latest: null },
    engines: ENGINES.map((engine) => ({ engine, installed: installed.engines[engine], latest: null, update: false })),
    command: null,
  };
  try {
    const latest = (await getJson<{ version: string }>(`${sources.registry}/playwright-core/latest`)).version;
    base.playwright.latest = latest;
    if (compareVersions(latest, installed.playwright) <= 0) {
      for (const e of base.engines) e.latest = e.installed;
      return base;
    }
    const shipped = engineVersions(await getJson<BrowsersJson>(`${sources.cdn}/playwright-core@${latest}/browsers.json`));
    for (const e of base.engines) {
      e.latest = shipped[e.engine] || null;
      e.update = !!e.latest && compareVersions(e.latest, e.installed) > 0;
    }
    // A standalone build can't update its own Playwright: a newer TriPane build brings it.
    if (STANDALONE) base.standalone = true;
    else base.command = `bun add playwright@${latest} && bunx playwright install chromium firefox webkit`;
    return base;
  } catch (err) {
    return { ...base, error: `Couldn't check for updates: ${err instanceof Error ? err.message : String(err)}` };
  }
}
