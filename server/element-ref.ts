// Finding "the same element" in all three engines, highlighting it, and reading its styles.
//
// An element is identified by its path of child-element indices from the nearest ancestor with
// a unique id (or from <html>). Pages are usually built the same way in every engine, so the
// path from one engine finds the matching element in the others.
//
// Every function here is passed to page.evaluate() and runs inside the page: self-contained.

/* eslint-disable @typescript-eslint/no-explicit-any */
import type { ElementRef } from '../shared/protocol';

export type { ElementRef };

export interface BoxModel {
  x: number;
  y: number;
  width: number;
  height: number;
  /** top, right, bottom, left */
  margin: number[];
  border: number[];
  padding: number[];
}

export interface ElementSnapshot {
  found: boolean;
  /** e.g. button#count.primary */
  label: string;
  box?: BoxModel;
  styles?: Record<string, string>;
}

/** The element at a viewport point, as a ref plus a short label. */
export function refAtPoint(point: { x: number; y: number }): { ref: ElementRef; label: string } | null {
  let el = document.elementFromPoint(point.x, point.y);
  if (!el || el.localName === 'tripane-overlay') return null;
  const label = `${el.localName}${el.id ? '#' + el.id : ''}${Array.from(el.classList).slice(0, 3).map((c) => '.' + c).join('')}`;
  const path: number[] = [];
  let anchorId: string | null = null;
  while (el && el !== document.documentElement) {
    if (el.id) {
      try {
        if (document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
          anchorId = el.id;
          break;
        }
      } catch {
        // unusual id; fall back to the path
      }
    }
    const parent: Element | null = el.parentElement;
    if (!parent) break;
    path.unshift(Array.prototype.indexOf.call(parent.children, el));
    el = parent;
  }
  return { ref: { anchorId, path }, label };
}

/** Draws (or with null, removes) the highlight on the element a ref points to. */
export function drawHighlight(ref: ElementRef | null): boolean {
  const w = window as any;
  let ui = w.__tripaneHover as { host: HTMLElement; root: ShadowRoot } | undefined;
  if (!ref) {
    ui?.root.replaceChildren();
    return true;
  }
  let el: Element | null = ref.anchorId ? document.getElementById(ref.anchorId) : document.documentElement;
  for (const i of ref.path) el = el?.children[i] ?? null;
  if (!ui || !ui.host.isConnected) {
    const host = document.createElement('tripane-overlay');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    const root = host.attachShadow({ mode: 'closed' });
    document.documentElement.appendChild(host);
    ui = { host, root };
    Object.defineProperty(w, '__tripaneHover', { value: ui, configurable: true, enumerable: false });
  }
  ui.root.replaceChildren();
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const px = (v: string) => parseFloat(v) || 0;
  const m = [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)];
  const b = [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)];
  const p = [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)];
  const ring = (x: number, y: number, wd: number, ht: number, widths: number[], color: string, fill = 'transparent') => {
    const d = document.createElement('div');
    d.style.cssText =
      `position:fixed;box-sizing:border-box;left:${x}px;top:${y}px;width:${Math.max(0, wd)}px;height:${Math.max(0, ht)}px;` +
      `border-style:solid;border-color:${color};border-width:${widths.map((v) => v + 'px').join(' ')};background:${fill};`;
    ui!.root.appendChild(d);
  };
  ring(r.left - m[3], r.top - m[0], r.width + m[1] + m[3], r.height + m[0] + m[2], m, 'rgba(246,178,107,0.6)');
  ring(r.left, r.top, r.width, r.height, b, 'rgba(255,229,153,0.6)');
  ring(r.left + b[3], r.top + b[0], r.width - b[1] - b[3], r.height - b[0] - b[2], p, 'rgba(147,196,125,0.5)', 'rgba(111,168,220,0.55)');
  const label = document.createElement('div');
  const cls = Array.from(el.classList).slice(0, 3).map((c) => '.' + c).join('');
  label.textContent = `${el.localName}${el.id ? '#' + el.id : ''}${cls}  ${Math.round(r.width)} × ${Math.round(r.height)}`;
  const below = r.bottom + 30 < innerHeight;
  label.style.cssText =
    `position:fixed;left:${Math.max(4, Math.min(r.left, innerWidth - 260))}px;top:${below ? r.bottom + 6 : Math.max(4, r.top - 28)}px;` +
    'font:12px/1.4 system-ui,sans-serif;color:#222;background:#fff;padding:3px 8px;border-radius:4px;' +
    'box-shadow:0 2px 6px rgba(0,0,0,.35);white-space:nowrap;max-width:256px;overflow:hidden;text-overflow:ellipsis;';
  ui.root.appendChild(label);
  return true;
}

/** The first element matching a CSS selector, as a ref (the MCP server's compare_element). Throws on a bad selector. */
export function refForSelector(selector: string): { ref: ElementRef; label: string } | null {
  let el = document.querySelector(selector);
  if (!el) return null;
  const label = `${el.localName}${el.id ? '#' + el.id : ''}${Array.from(el.classList).slice(0, 3).map((c) => '.' + c).join('')}`;
  const path: number[] = [];
  let anchorId: string | null = null;
  while (el && el !== document.documentElement) {
    if (el.id) {
      try {
        if (document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
          anchorId = el.id;
          break;
        }
      } catch {
        // unusual id; fall back to the path
      }
    }
    const parent: Element | null = el.parentElement;
    if (!parent) break;
    path.unshift(Array.prototype.indexOf.call(parent.children, el));
    el = parent;
  }
  return { ref: { anchorId, path }, label };
}

/** Everything Compare shows for one element: label, box model and all computed styles. */
export function snapshotElement(ref: ElementRef): ElementSnapshot {
  let el: Element | null = ref.anchorId ? document.getElementById(ref.anchorId) : document.documentElement;
  for (const i of ref.path) el = el?.children[i] ?? null;
  if (!el) return { found: false, label: '' };
  const label = `${el.localName}${el.id ? '#' + el.id : ''}${Array.from(el.classList).slice(0, 3).map((c) => '.' + c).join('')}`;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const px = (v: string) => Math.round((parseFloat(v) || 0) * 100) / 100;
  const styles: Record<string, string> = {};
  for (let i = 0; i < cs.length; i++) styles[cs[i]] = cs.getPropertyValue(cs[i]);
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    found: true,
    label,
    box: {
      x: round(r.left + scrollX),
      y: round(r.top + scrollY),
      width: round(r.width),
      height: round(r.height),
      margin: [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)],
      border: [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)],
      padding: [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)],
    },
    styles,
  };
}

/** Scrolls the element into view (Compare's "show me" action). */
export function revealElement(ref: ElementRef): boolean {
  let el: Element | null = ref.anchorId ? document.getElementById(ref.anchorId) : document.documentElement;
  for (const i of ref.path) el = el?.children[i] ?? null;
  el?.scrollIntoView({ block: 'center', inline: 'nearest' });
  return !!el;
}

/** Resolves a ref to the element (used as a CDP expression for Chromium's native highlight). */
export function resolveElement(ref: ElementRef): Element | null {
  let el: Element | null = ref.anchorId ? document.getElementById(ref.anchorId) : document.documentElement;
  for (const i of ref.path) el = el?.children[i] ?? null;
  return el;
}

/**
 * Where a point is within the element under it: the element's ref plus the point's position
 * inside it as fractions of its box (0..1). Used to replay a click in a pane of another size.
 */
export function pointRef(point: { x: number; y: number }): { ref: ElementRef; fx: number; fy: number } | null {
  let el = document.elementFromPoint(point.x, point.y);
  if (!el || el.localName === 'tripane-overlay') return null;
  const r = el.getBoundingClientRect();
  const fx = r.width ? (point.x - r.left) / r.width : 0.5;
  const fy = r.height ? (point.y - r.top) / r.height : 0.5;
  const path: number[] = [];
  let anchorId: string | null = null;
  while (el && el !== document.documentElement) {
    if (el.id) {
      try {
        if (document.querySelectorAll('#' + CSS.escape(el.id)).length === 1) {
          anchorId = el.id;
          break;
        }
      } catch {
        // unusual id; fall back to the path
      }
    }
    const parent: Element | null = el.parentElement;
    if (!parent) break;
    path.unshift(Array.prototype.indexOf.call(parent.children, el));
    el = parent;
  }
  return { ref: { anchorId, path }, fx, fy };
}

/**
 * The viewport point at the same spot of the same element in this page, scrolling it into view
 * if needed (another layout may put it elsewhere). Null when the element isn't here or has no box.
 */
export function pointFor(at: { ref: ElementRef; fx: number; fy: number }): { x: number; y: number } | null {
  let el: Element | null = at.ref.anchorId ? document.getElementById(at.ref.anchorId) : document.documentElement;
  for (const i of at.ref.path) el = el?.children[i] ?? null;
  if (!el) return null;
  let r = el.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  const clamp = (v: number, max: number) => Math.min(max - 1, Math.max(0, v));
  const x0 = r.left + at.fx * r.width;
  const y0 = r.top + at.fy * r.height;
  if (x0 < 0 || y0 < 0 || x0 >= innerWidth || y0 >= innerHeight) {
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    r = el.getBoundingClientRect();
  }
  return { x: clamp(r.left + at.fx * r.width, innerWidth), y: clamp(r.top + at.fy * r.height, innerHeight) };
}
