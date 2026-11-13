// Builds shared/css-compat.json: which CSS properties (and keyword values) each engine supports,
// and their Baseline status, from MDN's browser-compat-data and web-features. Compare uses it to
// explain why engines compute different styles.
//
// Run after updating either package:  bun run compat
// Only this compact table ships with TriPane (the source datasets are ~25 MB).
import bcd from '@mdn/browser-compat-data' with { type: 'json' };
import { features } from 'web-features';
import { join } from 'node:path';

type Version = string | false | null;
/** c/f/s: the Chrome, Firefox and Safari version that added it (false: not supported, null: unknown). */
interface Entry {
  c: Version;
  f: Version;
  s: Version;
  /** Only with a vendor prefix, per engine (c/f/s). */
  px?: string;
  /** Partly implemented, per engine (c/f/s). */
  pt?: string;
  /** Baseline: 'high' (widely available), 'low' (newly available), false (limited). Missing: not in web-features. */
  b?: 'high' | 'low' | false;
  /** The web-features id, for the MDN/Baseline link. */
  id?: string;
}

const baseline = new Map<string, { b: 'high' | 'low' | false; id: string }>();
for (const [id, f] of Object.entries(features)) {
  if (f.kind !== 'feature') continue;
  const byKey = (f.status as { by_compat_key?: Record<string, { baseline: 'high' | 'low' | false }> }).by_compat_key ?? {};
  for (const key of f.compat_features ?? []) baseline.set(key, { b: byKey[key]?.baseline ?? f.status.baseline, id });
}

type Statement = { version_added: string | boolean | null; version_removed?: string | boolean; prefix?: string; alternative_name?: string; flags?: unknown[]; partial_implementation?: boolean };

/** The version that added it unprefixed and unflagged; else whether it exists only prefixed. */
function support(raw: Statement | Statement[] | undefined): { v: Version; prefixed: boolean; partial: boolean } {
  const all = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  if (!all.length) return { v: null, prefixed: false, partial: false };
  const usable = all.filter((s) => !s.flags && !s.version_removed);
  const plain = usable.find((s) => !s.prefix && !s.alternative_name && s.version_added !== false);
  // Prefixed support counts when there's no released unprefixed version (user-select in Safari).
  const prefixed = (!plain || plain.version_added === 'preview') && usable.some((s) => (s.prefix || s.alternative_name) && s.version_added && s.version_added !== 'preview');
  const s = plain ?? null;
  const v: Version = !s ? (all.every((x) => x.version_added === null) ? null : false) : s.version_added === true ? '1' : (s.version_added as string | null);
  return { v, prefixed, partial: !!s?.partial_implementation };
}

function entry(compat: { support: Record<string, Statement | Statement[]> }, key: string): Entry {
  const c = support(compat.support.chrome);
  const f = support(compat.support.firefox);
  const s = support(compat.support.safari);
  const out: Entry = { c: c.v, f: f.v, s: s.v };
  const px = [c.prefixed && 'c', f.prefixed && 'f', s.prefixed && 's'].filter(Boolean).join('');
  const pt = [c.partial && 'c', f.partial && 'f', s.partial && 's'].filter(Boolean).join('');
  if (px) out.px = px;
  if (pt) out.pt = pt;
  const bl = baseline.get(key);
  if (bl) {
    out.b = bl.b;
    out.id = bl.id;
  }
  return out;
}

const properties: Record<string, Entry & { values?: Record<string, Entry> }> = {};
type Compat = { support: Record<string, Statement | Statement[]> };
// A property's own __compat, plus one { __compat } per value or note under it.
for (const [name, data] of Object.entries(bcd.css.properties as unknown as Record<string, { __compat?: Compat } & Record<string, { __compat?: Compat }>>)) {
  const compat = data.__compat as Compat | undefined;
  if (!compat) continue;
  const e: Entry & { values?: Record<string, Entry> } = entry(compat, `css.properties.${name}`);
  for (const [sub, subData] of Object.entries(data) as [string, { __compat?: Compat }][]) {
    // Keyword values only (display: grid); skip notes like is_animatable or multi-keyword_values.
    if (sub === '__compat' || !/^[a-z][a-z0-9-]*$/.test(sub) || !subData.__compat) continue;
    (e.values ??= {})[sub] = entry(subData.__compat!, `css.properties.${name}.${sub}`);
  }
  properties[name] = e;
}

const out = {
  source: {
    bcd: (bcd as { __meta: { version: string } }).__meta.version,
    webFeatures: ((await Bun.file(join(import.meta.dir, '..', 'node_modules', 'web-features', 'package.json')).json()) as { version: string }).version,
  },
  properties,
};
const file = join(import.meta.dir, '..', 'shared', 'css-compat.json');
await Bun.write(file, JSON.stringify(out));
console.log(`Wrote ${file}: ${Object.keys(properties).length} properties, ${(JSON.stringify(out).length / 1024).toFixed(0)} KB`);
