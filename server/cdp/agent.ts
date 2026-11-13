// In-page half of the DevTools adapter for Firefox and WebKit.
//
// `tripaneAgent` is serialized with Function.prototype.toString() and runs inside the inspected
// page, so it must be self-contained: no imports, no references to anything outside its body.
// It gives DOM nodes stable ids, describes them in the shape of the Chrome DevTools Protocol
// (CDP), reports DOM mutations, computes matched and computed styles, and draws the highlight
// overlay and the inspect-element picker. Events go back to the server through the
// `__tripaneDomEvent` binding (page.exposeBinding) as JSON arrays of {method, params}.

/* eslint-disable @typescript-eslint/no-explicit-any */
export function tripaneAgent(): void {
  const w = window as any;
  if (w.__tripaneAgent) return;

  type Rgba = { r: number; g: number; b: number; a?: number };
  type HighlightConfig = {
    contentColor?: Rgba;
    paddingColor?: Rgba;
    borderColor?: Rgba;
    marginColor?: Rgba;
    showInfo?: boolean;
  };

  let nextId = 1;
  const ids = new WeakMap<Node, number>();
  const nodes = new Map<number, WeakRef<Node>>();
  let childrenSent = new WeakSet<Node>();
  const observedRoots = new WeakSet<Node>();
  let active = false;

  let host: HTMLElement | null = null;
  let overlay: ShadowRoot | null = null;

  const emit = (events: unknown[]) => {
    if (active && events.length && typeof w.__tripaneDomEvent === 'function') w.__tripaneDomEvent(JSON.stringify(events));
  };

  // ---- node ids -------------------------------------------------------------------------------

  function idOf(n: Node): number {
    let id = ids.get(n);
    if (!id) {
      id = nextId++;
      ids.set(n, id);
      nodes.set(id, new WeakRef(n));
    }
    return id;
  }
  function byId(id: number): Node | null {
    return nodes.get(id)?.deref() ?? null;
  }
  function need(id: number): Node {
    const n = byId(id);
    if (!n) throw new Error(`No node with id ${id}`);
    return n;
  }
  function element(id: number): Element {
    const n = need(id);
    if (n.nodeType !== 1) throw new Error(`Node ${id} is not an element`);
    return n as Element;
  }

  /** Chrome's DOM agent hides whitespace-only text; TriPane also hides its overlays (DevTools' and the synced hover highlight). */
  function ignorable(n: Node): boolean {
    return n === host || n.nodeName === 'TRIPANE-OVERLAY' || (n.nodeType === 3 && !/\S/.test(n.nodeValue ?? ''));
  }
  function kids(n: Node): Node[] {
    return Array.from(n.childNodes).filter((c) => !ignorable(c));
  }

  function describe(n: Node, depth: number): any {
    const node: any = {
      nodeId: idOf(n),
      backendNodeId: idOf(n),
      nodeType: n.nodeType,
      nodeName: n.nodeName,
      localName: (n as Element).localName ?? '',
      nodeValue: n.nodeType === 3 || n.nodeType === 4 || n.nodeType === 8 ? (n.nodeValue ?? '') : '',
    };
    const children = kids(n);
    node.childNodeCount = children.length;
    if (n.nodeType === 1) {
      const el = n as Element;
      node.attributes = Array.from(el.attributes).flatMap((a) => [a.name, a.value]);
      if (el.shadowRoot) node.shadowRoots = [describe(el.shadowRoot, depth === -1 ? -1 : Math.max(0, depth - 1))];
    } else if (n.nodeType === 9) {
      const doc = n as Document;
      node.documentURL = doc.URL;
      node.baseURL = doc.baseURI;
      node.xmlVersion = '';
      node.compatibilityMode = doc.compatMode === 'BackCompat' ? 'QuirksMode' : 'NoQuirksMode';
    } else if (n.nodeType === 10) {
      const dt = n as DocumentType;
      node.publicId = dt.publicId;
      node.systemId = dt.systemId;
    } else if (n.nodeType === 11 && (n as ShadowRoot).host) {
      node.shadowRootType = (n as ShadowRoot).mode;
      observe(n);
    }
    const inlineText = depth === 0 && children.length === 1 && children[0].nodeType === 3 && (children[0].nodeValue ?? '').length < 80;
    if (depth !== 0 || inlineText) {
      node.children = children.map((c) => describe(c, depth === -1 ? -1 : Math.max(0, depth - 1)));
      childrenSent.add(n);
    }
    return node;
  }

  /** Sends DOM.setChildNodes for every ancestor of `n` the frontend hasn't expanded yet. */
  function pushPath(n: Node): unknown[] {
    const chain: Node[] = [];
    let p: Node | null = n.parentNode ?? (n as ShadowRoot).host ?? null;
    while (p) {
      chain.unshift(p);
      p = p.parentNode ?? (p as ShadowRoot).host ?? null;
    }
    const events: unknown[] = [];
    for (const a of chain) {
      if (childrenSent.has(a)) continue;
      events.push({ method: 'DOM.setChildNodes', params: { parentId: idOf(a), nodes: kids(a).map((c) => describe(c, 0)) } });
      childrenSent.add(a);
    }
    return events;
  }

  // ---- mutations --------------------------------------------------------------------------------

  const observer = new MutationObserver((records) => {
    if (!active) return;
    const events: unknown[] = [];
    for (const r of records) {
      const t = r.target;
      if (r.type === 'attributes') {
        const id = ids.get(t);
        if (!id || !r.attributeName) continue;
        const value = (t as Element).getAttribute(r.attributeName);
        events.push(
          value === null
            ? { method: 'DOM.attributeRemoved', params: { nodeId: id, name: r.attributeName } }
            : { method: 'DOM.attributeModified', params: { nodeId: id, name: r.attributeName, value } },
        );
      } else if (r.type === 'characterData') {
        const id = ids.get(t);
        if (id) events.push({ method: 'DOM.characterDataModified', params: { nodeId: id, characterData: t.nodeValue ?? '' } });
      } else {
        const parentId = ids.get(t);
        if (!parentId) continue;
        if (!childrenSent.has(t)) {
          events.push({ method: 'DOM.childNodeCountUpdated', params: { nodeId: parentId, childNodeCount: kids(t).length } });
          continue;
        }
        for (const n of Array.from(r.removedNodes)) {
          const id = ids.get(n);
          if (id && !ignorable(n)) events.push({ method: 'DOM.childNodeRemoved', params: { parentNodeId: parentId, nodeId: id } });
        }
        for (const n of Array.from(r.addedNodes)) {
          if (ignorable(n) || n.parentNode !== t) continue;
          let prev = n.previousSibling;
          while (prev && ignorable(prev)) prev = prev.previousSibling;
          events.push({
            method: 'DOM.childNodeInserted',
            params: { parentNodeId: parentId, previousNodeId: prev ? idOf(prev) : 0, node: describe(n, 0) },
          });
        }
      }
    }
    emit(events);
  });
  function observe(root: Node) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    observer.observe(root, { subtree: true, childList: true, attributes: true, characterData: true });
  }
  observe(document);

  // ---- highlight overlay ------------------------------------------------------------------------

  function ensureOverlay(): ShadowRoot {
    if (host && overlay && host.isConnected) return overlay;
    host = document.createElement('tripane-overlay');
    host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
    overlay = host.attachShadow({ mode: 'closed' });
    document.documentElement.appendChild(host);
    return overlay;
  }
  const rgba = (c: Rgba | undefined, fallback: string) => (c ? `rgba(${c.r},${c.g},${c.b},${c.a ?? 1})` : fallback);

  function hideHighlight() {
    if (overlay) overlay.replaceChildren();
  }

  function highlight(n: Node | null, cfg: HighlightConfig = {}) {
    hideHighlight();
    if (!n) return;
    const root = ensureOverlay();
    let border: DOMRect;
    let cs: CSSStyleDeclaration | null = null;
    if (n.nodeType === 1) {
      border = (n as Element).getBoundingClientRect();
      cs = getComputedStyle(n as Element);
    } else if (n.nodeType === 3) {
      const range = document.createRange();
      range.selectNodeContents(n);
      border = range.getBoundingClientRect();
    } else {
      return;
    }
    const px = (v: string | undefined) => parseFloat(v ?? '0') || 0;
    const m = cs ? [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)] : [0, 0, 0, 0];
    const b = cs ? [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)] : [0, 0, 0, 0];
    const p = cs ? [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)] : [0, 0, 0, 0];
    const ring = (x: number, y: number, wd: number, ht: number, widths: number[], color: string, fill = 'transparent') => {
      const d = document.createElement('div');
      d.style.cssText =
        `position:fixed;box-sizing:border-box;left:${x}px;top:${y}px;width:${Math.max(0, wd)}px;height:${Math.max(0, ht)}px;` +
        `border-style:solid;border-color:${color};border-width:${widths.map((v) => v + 'px').join(' ')};background:${fill};`;
      root.appendChild(d);
    };
    const { left: x, top: y, width: wd, height: ht } = border;
    ring(x - m[3], y - m[0], wd + m[1] + m[3], ht + m[0] + m[2], m, rgba(cfg.marginColor, 'rgba(246,178,107,0.66)'));
    ring(x, y, wd, ht, b, rgba(cfg.borderColor, 'rgba(255,229,153,0.66)'));
    ring(x + b[3], y + b[0], wd - b[1] - b[3], ht - b[0] - b[2], p, rgba(cfg.paddingColor, 'rgba(147,196,125,0.55)'),
      rgba(cfg.contentColor, 'rgba(111,168,220,0.66)'));
    if (cfg.showInfo !== false && n.nodeType === 1) {
      const el = n as Element;
      const label = document.createElement('div');
      const cls = Array.from(el.classList).slice(0, 3).map((c) => '.' + c).join('');
      label.textContent = `${el.localName}${el.id ? '#' + el.id : ''}${cls}  ${Math.round(wd * 100) / 100} × ${Math.round(ht * 100) / 100}`;
      const below = y + ht + 30 < innerHeight;
      label.style.cssText =
        `position:fixed;left:${Math.max(4, Math.min(x, innerWidth - 260))}px;top:${below ? y + ht + 6 : Math.max(4, y - 28)}px;` +
        'font:12px/1.4 system-ui,sans-serif;color:#222;background:#fff;padding:3px 8px;border-radius:4px;' +
        'box-shadow:0 2px 6px rgba(0,0,0,.35);white-space:nowrap;max-width:256px;overflow:hidden;text-overflow:ellipsis;';
      root.appendChild(label);
    }
  }

  // ---- inspect-element picker -------------------------------------------------------------------

  let inspectCfg: HighlightConfig | null = null;
  const targetOf = (e: Event) => {
    const t = e.composedPath()[0] as Node | undefined;
    return t && t.nodeType === 1 ? t : null;
  };
  const onMove = (e: Event) => highlight(targetOf(e), inspectCfg ?? {});
  const swallow = (e: Event) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onPick = (e: Event) => {
    swallow(e);
    const t = targetOf(e);
    if (t) emit([{ method: 'Overlay.inspectNodeRequested', params: { backendNodeId: idOf(t) } }]);
  };
  const SWALLOWED = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu', 'auxclick'];
  function setInspectMode(on: boolean, cfg: HighlightConfig) {
    if (on === !!inspectCfg) {
      inspectCfg = on ? cfg : null;
      return;
    }
    inspectCfg = on ? cfg : null;
    const method = on ? 'addEventListener' : 'removeEventListener';
    window[method]('mousemove', onMove, true);
    window[method]('click', onPick, true);
    for (const t of SWALLOWED) window[method](t, swallow, true);
    if (!on) hideHighlight();
  }

  // ---- search -----------------------------------------------------------------------------------

  const searches = new Map<string, Node[]>();
  let nextSearch = 1;
  function performSearch(query: string): { searchId: string; resultCount: number } {
    const found = new Set<Node>();
    try {
      document.querySelectorAll(query).forEach((n) => found.add(n));
    } catch {
      // not a selector; text search only
    }
    const q = query.toLowerCase();
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n && found.size < 1000; n = walker.nextNode()) {
      if (n === host) continue;
      if (n.nodeType === 3) {
        if ((n.nodeValue ?? '').toLowerCase().includes(q)) found.add(n);
      } else {
        const el = n as Element;
        if (el.localName.includes(q) || Array.from(el.attributes).some((a) => a.name.includes(q) || a.value.toLowerCase().includes(q))) {
          found.add(el);
        }
      }
    }
    const searchId = String(nextSearch++);
    searches.set(searchId, Array.from(found));
    return { searchId, resultCount: found.size };
  }

  // ---- styles -----------------------------------------------------------------------------------

  let nextSheet = 1;
  const ruleIds = new WeakMap<CSSStyleRule, string>();
  const rulesById = new Map<string, WeakRef<CSSStyleRule>>();
  function ruleId(rule: CSSStyleRule): string {
    let id = ruleIds.get(rule);
    if (!id) {
      id = `tp-rule-${nextSheet++}`;
      ruleIds.set(rule, id);
      rulesById.set(id, new WeakRef(rule));
    }
    return id;
  }

  /** Splits declaration text into properties with exact ranges, as CDP's CSSStyle expects. */
  function parseDecls(text: string) {
    const out: any[] = [];
    let start = 0;
    let depth = 0;
    let quote: string | null = null;
    for (let i = 0; i <= text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === quote && text[i - 1] !== '\\') quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(') depth++;
      else if (ch === ')') depth--;
      else if ((ch === ';' && depth === 0) || i === text.length) {
        const raw = text.slice(start, i);
        const colon = raw.indexOf(':');
        if (colon > 0 && raw.trim()) {
          const s0 = start + (raw.length - raw.trimStart().length);
          const e0 = i < text.length ? i + 1 : start + raw.trimEnd().length;
          let value = raw.slice(colon + 1).trim();
          const important = /!\s*important$/i.test(value);
          value = value.replace(/\s*!\s*important$/i, '');
          out.push({
            name: raw.slice(0, colon).trim(),
            value,
            important,
            implicit: false,
            text: text.slice(s0, e0),
            parsedOk: true,
            disabled: false,
            range: { startLine: 0, startColumn: s0, endLine: 0, endColumn: e0 },
          });
        }
        start = i + 1;
      }
    }
    return out;
  }
  function styleOf(styleSheetId: string, cssText: string) {
    return {
      styleSheetId,
      cssProperties: parseDecls(cssText),
      shorthandEntries: [],
      cssText,
      range: { startLine: 0, startColumn: 0, endLine: 0, endColumn: cssText.length },
    };
  }

  function specificity(sel: string): number {
    const s = sel.replace(/:where\([^)]*\)/g, '').replace(/:(?:not|is|has)\(([^)]*)\)/g, ' $1');
    const a = (s.match(/#[\w-]+/g) ?? []).length;
    const b = (s.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+(?:\([^)]*\))?/g) ?? []).length;
    const rest = s.replace(/#[\w-]+|\.[\w-]+|\[[^\]]+\]|::?[\w-]+(?:\([^)]*\))?/g, ' ');
    const c = (rest.match(/(?:^|[\s>+~])[a-zA-Z][\w-]*/g) ?? []).length + (s.match(/::[\w-]+/g) ?? []).length;
    return a * 1e6 + b * 1e3 + c;
  }
  function splitSelectors(text: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === ',' && depth === 0) {
        out.push(text.slice(start, i).trim());
        start = i + 1;
      }
    }
    out.push(text.slice(start).trim());
    return out;
  }

  /** Every author style rule that applies (media and supports conditions checked), in sheet order. */
  function styleRules(): { rule: CSSStyleRule; media: any[] }[] {
    const out: { rule: CSSStyleRule; media: any[] }[] = [];
    const walk = (rules: CSSRuleList, media: any[]) => {
      for (const r of Array.from(rules)) {
        if (r instanceof CSSStyleRule) out.push({ rule: r, media });
        else if (r instanceof CSSMediaRule) {
          if (matchMedia(r.conditionText || r.media.mediaText).matches) {
            walk(r.cssRules, [...media, { text: r.conditionText || r.media.mediaText, source: 'mediaRule' }]);
          }
        } else if (typeof CSSSupportsRule !== 'undefined' && r instanceof CSSSupportsRule) {
          if (CSS.supports(r.conditionText)) walk(r.cssRules, media);
        } else if ('cssRules' in r && (r as any).cssRules) {
          walk((r as any).cssRules, media); // @layer, @container (unchecked), @scope …
        }
      }
    };
    const sheets = [...Array.from(document.styleSheets), ...((document as any).adoptedStyleSheets ?? [])];
    for (const sheet of sheets) {
      let rules: CSSRuleList;
      try {
        rules = sheet.cssRules; // throws for cross-origin sheets without CORS
      } catch {
        continue;
      }
      if (sheet.disabled) continue;
      walk(rules, sheet.media?.mediaText ? [{ text: sheet.media.mediaText, source: 'linkedSheet' }] : []);
    }
    return out;
  }

  function matchedRulesFor(el: Element, all: { rule: CSSStyleRule; media: any[] }[]) {
    const matched: { entry: any; spec: number; order: number }[] = [];
    all.forEach(({ rule, media }, order) => {
      const selectors = splitSelectors(rule.selectorText);
      const matching: number[] = [];
      let spec = 0;
      selectors.forEach((sel, i) => {
        try {
          if (el.matches(sel)) {
            matching.push(i);
            spec = Math.max(spec, specificity(sel));
          }
        } catch {
          // pseudo-elements and unsupported selectors can't be matched from script
        }
      });
      if (!matching.length) return;
      const id = ruleId(rule);
      const href = rule.parentStyleSheet?.href ?? '';
      matched.push({
        spec,
        order,
        entry: {
          rule: {
            styleSheetId: id,
            selectorList: { selectors: selectors.map((text) => ({ text })), text: rule.selectorText },
            origin: 'regular',
            style: styleOf(id, rule.style.cssText),
            media,
            ...(href ? { sourceURL: href } : {}),
          },
          matchingSelectors: matching,
        },
      });
    });
    matched.sort((a, b) => a.spec - b.spec || a.order - b.order);
    return matched.map((m) => m.entry);
  }

  const INHERITED = /^(--|color$|font|line-height|letter-spacing|word-spacing|text-(align|indent|transform|shadow|rendering)|white-space|visibility|cursor|direction|list-style|quotes|tab-size|hyphens|caret-color|writing-mode)/;

  function matchedStyles(id: number) {
    if (need(id).nodeType !== 1) return { matchedCSSRules: [], pseudoElements: [], inherited: [] };
    const el = element(id);
    const all = styleRules();
    const inherited: any[] = [];
    for (let p = el.parentElement; p; p = p.parentElement) {
      const rules = matchedRulesFor(p, all).filter((m: any) => m.rule.style.cssProperties.some((d: any) => INHERITED.test(d.name)));
      const inline = p.getAttribute('style');
      inherited.push({
        matchedCSSRules: rules,
        ...(inline ? { inlineStyle: styleOf(`tp-inline-${idOf(p)}`, inline) } : {}),
      });
    }
    return {
      inlineStyle: styleOf(`tp-inline-${id}`, el.getAttribute('style') ?? ''),
      matchedCSSRules: matchedRulesFor(el, all),
      pseudoElements: [],
      inherited,
      inheritedPseudoElements: [],
      cssKeyframesRules: [],
      cssPositionTryRules: [],
      cssPropertyRules: [],
      cssPropertyRegistrations: [],
      cssFunctionRules: [],
    };
  }

  function computedStyle(id: number) {
    const n = need(id);
    if (n.nodeType !== 1) return []; // DevTools also asks about text nodes and the doctype
    const el = n as Element;
    const cs = getComputedStyle(el);
    const out: { name: string; value: string }[] = [];
    for (let i = 0; i < cs.length; i++) out.push({ name: cs[i], value: cs.getPropertyValue(cs[i]) });
    return out;
  }

  function setStyleText(styleSheetId: string, text: string) {
    const inline = styleSheetId.match(/^tp-inline-(\d+)$/);
    if (inline) {
      element(Number(inline[1])).setAttribute('style', text);
      return styleOf(styleSheetId, text);
    }
    const rule = rulesById.get(styleSheetId)?.deref();
    if (!rule) throw new Error('This style rule is no longer available');
    rule.style.cssText = text;
    return styleOf(styleSheetId, rule.style.cssText);
  }

  // ---- geometry ---------------------------------------------------------------------------------

  function boxModel(id: number) {
    const el = element(id);
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const px = (v: string) => parseFloat(v) || 0;
    const quad = (x: number, y: number, wd: number, ht: number) => [x, y, x + wd, y, x + wd, y + ht, x, y + ht];
    const b = [px(cs.borderTopWidth), px(cs.borderRightWidth), px(cs.borderBottomWidth), px(cs.borderLeftWidth)];
    const p = [px(cs.paddingTop), px(cs.paddingRight), px(cs.paddingBottom), px(cs.paddingLeft)];
    const m = [px(cs.marginTop), px(cs.marginRight), px(cs.marginBottom), px(cs.marginLeft)];
    const px0 = r.left + b[3];
    const py0 = r.top + b[0];
    const pw = r.width - b[1] - b[3];
    const ph = r.height - b[0] - b[2];
    return {
      content: quad(px0 + p[3], py0 + p[0], pw - p[1] - p[3], ph - p[0] - p[2]),
      padding: quad(px0, py0, pw, ph),
      border: quad(r.left, r.top, r.width, r.height),
      margin: quad(r.left - m[3], r.top - m[0], r.width + m[1] + m[3], r.height + m[0] + m[2]),
      width: Math.round(r.width),
      height: Math.round(r.height),
    };
  }

  // ---- console command-line API -----------------------------------------------------------------

  const cli: Record<string, () => unknown> = {
    $0: () => inspected,
    $: () => (sel: string, root?: ParentNode) => (root ?? document).querySelector(sel),
    $$: () => (sel: string, root?: ParentNode) => Array.from((root ?? document).querySelectorAll(sel)),
    $x: () => (xpath: string, ctx?: Node) => {
      const res = document.evaluate(xpath, ctx ?? document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      return Array.from({ length: res.snapshotLength }, (_, i) => res.snapshotItem(i));
    },
  };
  let inspected: Node | null = null;
  for (const [name, get] of Object.entries(cli)) {
    if (name in w) continue; // e.g. a page's own jQuery `$`
    try {
      Object.defineProperty(w, name, { get, configurable: true, enumerable: false });
    } catch {
      // non-configurable global; skip
    }
  }

  // ---- API used by the server -------------------------------------------------------------------

  const api = {
    activate() {
      active = true;
      childrenSent = new WeakSet();
    },
    deactivate() {
      active = false;
      setInspectMode(false, {});
      hideHighlight();
    },
    getDocument(depth: number) {
      childrenSent = new WeakSet(); // the frontend is starting a new tree
      return describe(document, depth);
    },
    requestChildNodes(id: number, depth: number) {
      const n = need(id);
      childrenSent.add(n);
      return { parentId: id, nodes: kids(n).map((c) => describe(c, depth === -1 ? -1 : Math.max(0, depth - 1))) };
    },
    describeNode: (id: number, depth: number) => describe(need(id), depth),
    pushPath: (id: number) => pushPath(need(id)),
    node: (id: number) => need(id),
    idOf: (n: Node) => ({ id: idOf(n), events: pushPath(n) }),
    outerHTML(id: number) {
      const n = need(id);
      return n.nodeType === 1 ? (n as Element).outerHTML : n.nodeType === 9 ? (n as Document).documentElement.outerHTML : (n.textContent ?? '');
    },
    setOuterHTML(id: number, html: string) {
      (element(id) as Element).outerHTML = html;
    },
    removeNode: (id: number) => (need(id) as ChildNode).remove(),
    setAttributeValue: (id: number, name: string, value: string) => element(id).setAttribute(name, value),
    removeAttribute: (id: number, name: string) => element(id).removeAttribute(name),
    setAttributesAsText(id: number, text: string, name?: string) {
      const el = element(id);
      const tmp = document.createElement('template');
      tmp.innerHTML = `<div ${text}></div>`;
      const parsed = tmp.content.firstElementChild!;
      if (name) el.removeAttribute(name);
      for (const a of Array.from(parsed.attributes)) el.setAttribute(a.name, a.value);
    },
    setNodeValue: (id: number, value: string) => void (need(id).nodeValue = value),
    performSearch,
    getSearchResults(searchId: string, from: number, to: number) {
      const found = (searches.get(searchId) ?? []).slice(from, to);
      const events: unknown[] = [];
      const nodeIds = found.map((n) => {
        events.push(...pushPath(n));
        return idOf(n);
      });
      return { nodeIds, events };
    },
    discardSearchResults: (searchId: string) => void searches.delete(searchId),
    nodeForLocation(x: number, y: number) {
      const el = document.elementFromPoint(x, y);
      return el ? { id: idOf(el), events: pushPath(el) } : null;
    },
    setInspectedNode: (id: number) => void (inspected = byId(id)),
    highlight: (id: number, cfg: HighlightConfig) => highlight(byId(id), cfg),
    hideHighlight,
    setInspectMode,
    scrollIntoView: (id: number) => (element(id) as Element).scrollIntoView({ block: 'center', inline: 'nearest' }),
    focus: (id: number) => (element(id) as HTMLElement).focus(),
    boxModel,
    matchedStyles,
    inlineStyles: (id: number) => ({ inlineStyle: styleOf(`tp-inline-${id}`, element(id).getAttribute('style') ?? '') }),
    computedStyle,
    setStyleText,
    backgroundColors: (id: number) => [getComputedStyle(element(id)).backgroundColor],
    longhands(shorthand: string, value: string) {
      const probe = document.createElement('div').style;
      probe.setProperty(shorthand, value);
      return Array.from({ length: probe.length }, (_, i) => ({ name: probe[i], value: probe.getPropertyValue(probe[i]) }));
    },
  };
  Object.defineProperty(w, '__tripaneAgent', { value: api, configurable: false, enumerable: false });
}

export const AGENT_SOURCE = `(${tripaneAgent.toString()})()`;
