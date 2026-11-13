// CSS support per engine, from MDN's browser-compat-data and web-features (shared/css-compat.json,
// built by `bun run compat`). Compare uses it to explain why engines compute different styles.
// Playwright's engines map to the browsers MDN tracks: Chromium → Chrome, Firefox → Firefox,
// WebKit → Safari (Playwright's WebKit reports a Safari-like version).
import data from '../../shared/css-compat.json';
import type { EngineName } from '../../shared/protocol';

type Version = string | false | null;
interface Entry {
  c: Version;
  f: Version;
  s: Version;
  px?: string;
  pt?: string;
  b?: 'high' | 'low' | false;
  id?: string;
  values?: Record<string, Entry>;
}

const PROPS = (data as { properties: Record<string, Entry> }).properties;
export const COMPAT_SOURCE = (data as { source: { bcd: string; webFeatures: string } }).source;
const KEY: Record<EngineName, 'c' | 'f' | 's'> = { chromium: 'c', firefox: 'f', webkit: 's' };
export const BROWSER: Record<EngineName, string> = { chromium: 'Chrome', firefox: 'Firefox', webkit: 'Safari' };

export type SupportState = 'yes' | 'partial' | 'prefixed' | 'preview' | 'later' | 'no' | 'unknown';
export interface Support {
  state: SupportState;
  /** Short text for a chip, e.g. "Firefox 160+", "-webkit- only". */
  short: string;
  /** Full sentence for the tooltip. */
  long: string;
}

const num = (v: string) => parseFloat(v.replace(/^[≤<]/, ''));

/** Whether this engine (at this version) supports the feature. */
function supportOf(entry: Entry, engine: EngineName, version: string, what: string): Support {
  const k = KEY[engine];
  const v = entry[k];
  const browser = BROWSER[engine];
  const prefixed = entry.px?.includes(k);
  const partial = entry.pt?.includes(k);
  if (v === null) return { state: 'unknown', short: '', long: `${browser} support for ${what} isn't recorded.` };
  if (v === false || v === 'preview') {
    if (prefixed) return { state: 'prefixed', short: 'prefixed only', long: `${browser} supports ${what} only with a vendor prefix.` };
    if (v === 'preview') return { state: 'preview', short: 'preview only', long: `${what} is only in ${browser}'s preview builds.` };
    return { state: 'no', short: `not in ${browser}`, long: `${browser} doesn't support ${what}.` };
  }
  const added = num(v);
  const have = num(version);
  if (Number.isFinite(added) && Number.isFinite(have) && have < added) {
    return { state: 'later', short: `${browser} ${v}+`, long: `${what} arrived in ${browser} ${v}; this engine is ${version}.` };
  }
  if (partial) return { state: 'partial', short: 'partial', long: `${browser} ${v}+ supports ${what} partly.` };
  return { state: 'yes', short: '', long: `${browser} ${v}+ supports ${what}.` };
}

export interface CompatInfo {
  /** Baseline status of the property (undefined: not in web-features). */
  baseline?: { level: 'high' | 'low' | false; feature: string };
  /** Per engine: problems with the property itself or with the keyword value it computed. */
  engines: (Support | null)[];
}

/**
 * Support for a property and, when the computed value is a single keyword MDN tracks (display:
 * grid-lanes), for that value, for each engine. Null entries: nothing to point out.
 */
export function compatFor(property: string, values: (string | undefined)[], engines: { engine: EngineName; version: string }[]): CompatInfo | null {
  const entry = PROPS[property];
  if (!entry) return null;
  const out: CompatInfo = { engines: [] };
  if (entry.b !== undefined && entry.id) out.baseline = { level: entry.b, feature: entry.id };
  engines.forEach(({ engine, version }, i) => {
    const prop = supportOf(entry, engine, version, property);
    if (prop.state !== 'yes' && prop.state !== 'unknown') return void (out.engines[i] = prop);
    const kw = values[i]?.trim();
    const valueEntry = kw && entry.values?.[kw];
    if (valueEntry) {
      const val = supportOf(valueEntry, engine, version, `${property}: ${kw}`);
      if (val.state !== 'yes' && val.state !== 'unknown') return void (out.engines[i] = { ...val, short: `${kw}: ${val.short}` });
    }
    out.engines[i] = null;
  });
  return out;
}

export const BASELINE_LABEL = { high: 'Widely available', low: 'Newly available', false: 'Limited availability' } as const;
