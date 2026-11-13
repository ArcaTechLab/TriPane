// Comparing whole pages across engines: pixels (visual diff) and accessibility trees.
// Both read through Playwright's public API (page.screenshot, locator.ariaSnapshot); nothing is
// injected into the page.
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { AriaDiffResult, DiffLine, EngineName, VisualDiffResult } from '../shared/protocol';
import type { PaneSession } from './pane';

const MAX_DIFF_LINES = 6000;

// ---- visual diff --------------------------------------------------------------------------------

export interface VisualDiffOptions {
  reference: EngineName;
  /** The whole scrollable page instead of the viewport. */
  fullPage?: boolean;
  /** pixelmatch's colour threshold, 0 (exact) to 1; default 0.1. */
  threshold?: number;
}

/**
 * Screenshots every running engine (in CSS pixels, so device pixel ratios don't matter) and
 * compares each with the reference engine. Anti-aliasing differences are ignored: every engine
 * smooths text and edges its own way, and that isn't what you're looking for.
 */
export async function visualDiff(panes: PaneSession[], opts: VisualDiffOptions): Promise<VisualDiffResult> {
  const running = panes.filter((p) => p.ready && !p.info.disabled);
  const ref = running.find((p) => p.engine === opts.reference);
  if (!ref) throw new Error(`${opts.reference} isn't running; choose another reference engine.`);
  if (running.length < 2) throw new Error('A visual diff needs at least two running engines.');
  const threshold = Math.min(1, Math.max(0, opts.threshold ?? 0.1));

  const shots = await Promise.all(
    running.map(async (p) => {
      const png = await p.act((page) => page.screenshot({ type: 'png', scale: 'css', fullPage: !!opts.fullPage, timeout: 30_000, animations: 'disabled' }));
      return { pane: p, png, image: PNG.sync.read(png) };
    }),
  );
  const base = shots.find((s) => s.pane === ref)!;

  const engines: VisualDiffResult['engines'] = shots.map((s) => ({
    engine: s.pane.engine,
    paneId: s.pane.id,
    width: s.image.width,
    height: s.image.height,
    image: `data:image/png;base64,${s.png.toString('base64')}`,
  }));

  const diffs: VisualDiffResult['diffs'] = [];
  for (const s of shots) {
    if (s === base) continue;
    // Different sizes (per-engine sizes, or a page of another height): compare the shared area.
    const width = Math.min(s.image.width, base.image.width);
    const height = Math.min(s.image.height, base.image.height);
    const a = crop(base.image, width, height);
    const b = crop(s.image, width, height);
    const out = new PNG({ width, height });
    const pixels = pixelmatch(a, b, out.data, width, height, { threshold, includeAA: false, alpha: 0.15, diffColor: [230, 30, 60], diffColorAlt: [30, 120, 255], aaColor: [215, 215, 215] });
    diffs.push({
      engine: s.pane.engine,
      against: base.pane.engine,
      width,
      height,
      sizeMismatch: s.image.width !== base.image.width || s.image.height !== base.image.height,
      pixels,
      percent: Math.round((pixels / (width * height)) * 10000) / 100,
      image: `data:image/png;base64,${PNG.sync.write(out).toString('base64')}`,
    });
  }
  return { reference: base.pane.engine, fullPage: !!opts.fullPage, threshold, at: Date.now(), engines, diffs };
}

function crop(img: PNG, width: number, height: number): Uint8Array {
  if (img.width === width && img.height === height) return img.data;
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) out.set(img.data.subarray(y * img.width * 4, y * img.width * 4 + width * 4), y * width * 4);
  return out;
}

// ---- accessibility tree diff --------------------------------------------------------------------

export interface AriaDiffOptions {
  reference: EngineName;
  /** What to snapshot (a CSS or Playwright selector); default the whole page. */
  selector?: string;
}

/** Each running engine's accessibility tree (Playwright's ARIA snapshot), compared line by line with the reference. */
export async function ariaDiff(panes: PaneSession[], opts: AriaDiffOptions): Promise<AriaDiffResult> {
  const running = panes.filter((p) => p.ready && !p.info.disabled);
  const ref = running.find((p) => p.engine === opts.reference);
  if (!ref) throw new Error(`${opts.reference} isn't running; choose another reference engine.`);
  const selector = opts.selector?.trim() || 'body';
  const trees = await Promise.all(
    running.map(async (p) => {
      try {
        return { pane: p, tree: await p.act((page) => page.locator(selector).first().ariaSnapshot({ timeout: 10_000 })) };
      } catch (err) {
        return { pane: p, tree: null, error: (err instanceof Error ? err.message : String(err)).split('\n')[0] };
      }
    }),
  );
  const base = trees.find((t) => t.pane === ref)!;
  if (base.tree === null) throw new Error(`Couldn't read ${ref.engine}'s accessibility tree: ${base.error}`);
  const baseLines = base.tree.split('\n');
  return {
    reference: ref.engine,
    selector,
    at: Date.now(),
    engines: trees.map((t) => {
      if (t.tree === null) return { engine: t.pane.engine, paneId: t.pane.id, tree: '', error: t.error, lines: [], added: 0, removed: 0 };
      const lines = t.pane === ref ? baseLines.map((text) => ({ op: 'same' as const, text })) : lineDiff(baseLines, t.tree.split('\n'));
      return {
        engine: t.pane.engine,
        paneId: t.pane.id,
        tree: t.tree,
        lines,
        added: lines.filter((l) => l.op === 'add').length,
        removed: lines.filter((l) => l.op === 'del').length,
      };
    }),
  };
}

/** A line diff (longest common subsequence): 'del' lines are only in a, 'add' lines only in b. */
export function lineDiff(a: string[], b: string[]): DiffLine[] {
  // Same start and end are common to both; diff only the middle.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const head = a.slice(0, start).map((text) => ({ op: 'same' as const, text }));
  const tail = a.slice(endA).map((text) => ({ op: 'same' as const, text }));
  const ma = a.slice(start, endA);
  const mb = b.slice(start, endB);
  if (ma.length * mb.length > MAX_DIFF_LINES * MAX_DIFF_LINES / 4) {
    // Too big for a full LCS: show it as replaced.
    return [...head, ...ma.map((text) => ({ op: 'del' as const, text })), ...mb.map((text) => ({ op: 'add' as const, text })), ...tail];
  }
  const n = ma.length;
  const m = mb.length;
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * (m + 1) + j] = ma[i] === mb[j] ? lcs[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
    }
  }
  const mid: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (ma[i] === mb[j]) {
      mid.push({ op: 'same', text: ma[i++] });
      j++;
    } else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) {
      mid.push({ op: 'del', text: ma[i++] });
    } else {
      mid.push({ op: 'add', text: mb[j++] });
    }
  }
  while (i < n) mid.push({ op: 'del', text: ma[i++] });
  while (j < m) mid.push({ op: 'add', text: mb[j++] });
  return [...head, ...mid, ...tail];
}

/** A diff as unified-diff text with a few lines of context around each change (for the MCP tool). */
export function formatDiff(lines: DiffLine[], context = 2): string {
  const keep = new Array(lines.length).fill(false);
  lines.forEach((l, i) => {
    if (l.op === 'same') return;
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++) keep[k] = true;
  });
  const out: string[] = [];
  let skipped = 0;
  lines.forEach((l, i) => {
    if (!keep[i]) return void skipped++;
    if (skipped) out.push(`  … ${skipped} unchanged line${skipped === 1 ? '' : 's'}`);
    skipped = 0;
    out.push(`${l.op === 'add' ? '+' : l.op === 'del' ? '-' : ' '} ${l.text}`);
  });
  if (skipped && out.length) out.push(`  … ${skipped} unchanged line${skipped === 1 ? '' : 's'}`);
  return out.join('\n');
}
