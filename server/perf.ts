// Performance monitor figures for the MCP `performance` tool: what Chrome DevTools' Performance
// monitor shows, for every engine that can provide it.
//
//   Chromium         CDP Performance.getMetrics, sampled twice over a short window for the rates
//                    (CPU usage, layouts and style recalculations per second), plus heap, nodes,
//                    event listeners, documents and frames.
//   Firefox, WebKit  No equivalent that Playwright exposes. Frames come from Playwright; the DOM
//                    size and paint timings from a read-only evaluate (it counts and returns, and
//                    leaves nothing in the page). CPU, heap and the rates aren't available.
//
// Everything runs quietly (see quiet.ts), so it stays out of recorded traces.
import type { CDPSession, Page } from 'playwright';
import type { EngineName } from '../shared/protocol';
import { quietly } from './quiet';

export interface PerformanceStats {
  engine: EngineName;
  url: string;
  /** How long the rates were measured over (Chromium only; 0 otherwise). */
  sampledMs: number;
  /** % of one CPU core spent on the page's main thread while sampling. */
  cpuPercent: number | null;
  jsHeapUsed: number | null;
  jsHeapTotal: number | null;
  /** Chromium: every DOM node the renderer holds (detached ones too). */
  rendererNodes: number | null;
  jsEventListeners: number | null;
  /** Chromium: documents and frames the renderer holds, detached ones too (a growing number can mean a leak). */
  documents: number | null;
  rendererFrames: number | null;
  /** Frames in the page (the main one included), from Playwright: the same count in every engine. */
  frames: number;
  layoutsPerSec: number | null;
  styleRecalcsPerSec: number | null;
  /** Main-thread time per second spent in script, layout and style (Chromium), in ms. */
  scriptMsPerSec: number | null;
  layoutMsPerSec: number | null;
  styleMsPerSec: number | null;
  /** Nodes and elements in the page's documents (frames and open shadow roots included); the same count in every engine. */
  domNodes: number | null;
  domElements: number | null;
  firstPaint: number | null;
  firstContentfulPaint: number | null;
  /** Frames whose DOM couldn't be read (e.g. still loading). */
  unreadableFrames: number;
}

type Metrics = Record<string, number>;

async function readMetrics(cdp: CDPSession): Promise<Metrics> {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

/** Read-only: walks a document (and its open shadow roots) counting nodes, and reads paint timings. */
function countDom(): { nodes: number; elements: number; fp: number | null; fcp: number | null } {
  let nodes = 0;
  let elements = 0;
  const walk = (root: Node) => {
    const it = document.createTreeWalker(root, NodeFilter.SHOW_ALL);
    for (let n: Node | null = it.currentNode; n; n = it.nextNode()) {
      nodes++;
      if (n.nodeType === 1) {
        elements++;
        const shadow = (n as Element).shadowRoot;
        if (shadow) walk(shadow);
      }
    }
  };
  walk(document);
  const paint = (name: string) => {
    const e = performance.getEntriesByName(name, 'paint')[0];
    return e ? Math.round(e.startTime) : null;
  };
  return { nodes, elements, fp: paint('first-paint'), fcp: paint('first-contentful-paint') };
}

export async function measurePerformance(engine: EngineName, page: Page, cdp: CDPSession | undefined, sampleMs: number): Promise<PerformanceStats> {
  const frames = page.frames();
  const stats: PerformanceStats = {
    engine,
    url: page.url(),
    sampledMs: 0,
    cpuPercent: null,
    jsHeapUsed: null,
    jsHeapTotal: null,
    rendererNodes: null,
    jsEventListeners: null,
    documents: null,
    rendererFrames: null,
    frames: frames.length,
    layoutsPerSec: null,
    styleRecalcsPerSec: null,
    scriptMsPerSec: null,
    layoutMsPerSec: null,
    styleMsPerSec: null,
    domNodes: null,
    domElements: null,
    firstPaint: null,
    firstContentfulPaint: null,
    unreadableFrames: 0,
  };

  const dom = quietly(page, () =>
    Promise.all(
      frames.map((f) =>
        f.evaluate(countDom).catch(() => null),
      ),
    ),
  );

  if (cdp) {
    await quietly(cdp, async () => {
      await cdp.send('Performance.enable', { timeDomain: 'timeTicks' });
      try {
        const a = await readMetrics(cdp);
        await Bun.sleep(sampleMs);
        const b = await readMetrics(cdp);
        const secs = (b.Timestamp ?? 0) - (a.Timestamp ?? 0);
        const rate = (name: string, scale = 1) => (secs > 0 && name in a && name in b ? round(((b[name] - a[name]) * scale) / secs, 1) : null);
        stats.sampledMs = Math.round(secs * 1000);
        stats.cpuPercent = rate('TaskDuration', 100);
        stats.layoutsPerSec = rate('LayoutCount');
        stats.styleRecalcsPerSec = rate('RecalcStyleCount');
        stats.scriptMsPerSec = rate('ScriptDuration', 1000);
        stats.layoutMsPerSec = rate('LayoutDuration', 1000);
        stats.styleMsPerSec = rate('RecalcStyleDuration', 1000);
        stats.jsHeapUsed = b.JSHeapUsedSize ?? null;
        stats.jsHeapTotal = b.JSHeapTotalSize ?? null;
        stats.rendererNodes = b.Nodes ?? null;
        stats.jsEventListeners = b.JSEventListeners ?? null;
        stats.documents = b.Documents ?? null;
        stats.rendererFrames = b.Frames ?? null;
      } finally {
        await cdp.send('Performance.disable').catch(() => {});
      }
    });
  }

  const counts = await dom;
  const read = counts.filter((c) => c !== null);
  stats.unreadableFrames = counts.length - read.length;
  if (read.length) {
    stats.domNodes = read.reduce((s, c) => s + c.nodes, 0);
    stats.domElements = read.reduce((s, c) => s + c.elements, 0);
  }
  const main = counts[0];
  if (main) {
    stats.firstPaint = main.fp;
    stats.firstContentfulPaint = main.fcp;
  }
  return stats;
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;

/** The figures as readable lines (n/a where an engine can't tell). */
export function formatPerformance(s: PerformanceStats): string {
  const na = (v: number | null, f: (v: number) => string = String) => (v === null ? 'n/a' : f(v));
  const mb = (v: number) => `${(v / 1024 / 1024).toFixed(1)} MB`;
  const ms = (v: number) => `${v} ms`;
  const lines = [
    `${s.engine} — ${s.url}`,
    `  CPU usage: ${na(s.cpuPercent, (v) => `${v}%`)}${s.sampledMs ? ` (over ${s.sampledMs} ms)` : ''}`,
    `  JS heap: ${s.jsHeapUsed === null ? 'n/a' : `${mb(s.jsHeapUsed)} used of ${na(s.jsHeapTotal, mb)}`}`,
    `  DOM nodes: ${na(s.domNodes)} (${na(s.domElements)} elements)${s.rendererNodes !== null ? `; renderer total incl. detached: ${s.rendererNodes}` : ''}${s.unreadableFrames ? ` — ${s.unreadableFrames} frame(s) unreadable` : ''}`,
    `  JS event listeners: ${na(s.jsEventListeners)}`,
    `  Frames: ${s.frames}${s.documents !== null ? `; renderer holds ${s.documents} documents, ${na(s.rendererFrames)} frames` : ''}`,
    `  Layouts/sec: ${na(s.layoutsPerSec)}, style recalcs/sec: ${na(s.styleRecalcsPerSec)}`,
    `  Main thread per second: script ${na(s.scriptMsPerSec, ms)}, layout ${na(s.layoutMsPerSec, ms)}, style ${na(s.styleMsPerSec, ms)}`,
    `  First paint: ${na(s.firstPaint, ms)}, first contentful paint: ${na(s.firstContentfulPaint, ms)}`,
  ];
  return lines.join('\n');
}
