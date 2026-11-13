// Formats console.* arguments into one line of text, identically in every engine.
//
// Playwright's ConsoleMessage.text() is engine-specific (Chromium writes "Object", Firefox and
// WebKit write "JSHandle@object"), so the unified log formats the arguments itself, inside the
// page. This function is serialized and run there: it must stay self-contained.

/* eslint-disable @typescript-eslint/no-explicit-any */
export function formatConsoleArgs(values: unknown[]): string {
  const MAX_ITEMS = 10;
  const label = (el: Element) =>
    `<${el.localName}${el.id ? '#' + el.id : ''}${Array.from(el.classList).slice(0, 3).map((c) => '.' + c).join('')}>`;

  const fmt = (v: unknown, depth: number): string => {
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    const t = typeof v;
    if (t === 'string') return depth > 0 ? `'${v}'` : (v as string);
    if (t === 'number' || t === 'boolean') return String(v);
    if (t === 'bigint') return `${v}n`;
    if (t === 'symbol') return String(v);
    if (t === 'function') return `ƒ ${(v as Function).name || 'anonymous'}()`;
    const o = v as any;
    try {
      if (o instanceof Error) return `${o.name}: ${o.message}`;
      if (typeof Element !== 'undefined' && o instanceof Element) return label(o);
      if (typeof Node !== 'undefined' && o instanceof Node) return o.nodeName;
      if (o instanceof Date) return isNaN(o.getTime()) ? 'Invalid Date' : o.toISOString();
      if (o instanceof RegExp) return String(o);
      if (o instanceof Promise) return 'Promise';
      if (Array.isArray(o) || ArrayBuffer.isView(o)) {
        const arr = Array.from(o as ArrayLike<unknown>);
        if (depth > 1) return `Array(${arr.length})`;
        const items = arr.slice(0, MAX_ITEMS).map((x) => fmt(x, depth + 1));
        if (arr.length > MAX_ITEMS) items.push('…');
        return `[${items.join(', ')}]`;
      }
      if (o instanceof Map) {
        if (depth > 1) return `Map(${o.size})`;
        const items = Array.from(o).slice(0, MAX_ITEMS).map(([k, x]) => `${fmt(k, depth + 1)} => ${fmt(x, depth + 1)}`);
        return `Map(${o.size}) {${items.join(', ')}${o.size > MAX_ITEMS ? ', …' : ''}}`;
      }
      if (o instanceof Set) {
        if (depth > 1) return `Set(${o.size})`;
        const items = Array.from(o).slice(0, MAX_ITEMS).map((x) => fmt(x, depth + 1));
        return `Set(${o.size}) {${items.join(', ')}${o.size > MAX_ITEMS ? ', …' : ''}}`;
      }
      const name = o.constructor?.name;
      const prefix = name && name !== 'Object' ? `${name} ` : '';
      if (depth > 1) return `${prefix}{…}`;
      const keys = Object.keys(o);
      const items = keys.slice(0, MAX_ITEMS).map((k) => `${k}: ${fmt(o[k], depth + 1)}`);
      if (keys.length > MAX_ITEMS) items.push('…');
      return `${prefix}{${items.join(', ')}}`;
    } catch {
      return '[object]';
    }
  };

  // printf-style substitutions, as console.log supports: %s %d %i %f %o %O %c %%
  let rest = values;
  const parts: string[] = [];
  if (typeof values[0] === 'string' && /%[sdifoOc%]/.test(values[0])) {
    rest = values.slice(1);
    parts.push(
      (values[0] as string).replace(/%([sdifoOc%])/g, (m, c: string) => {
        if (c === '%') return '%';
        if (!rest.length) return m;
        const v = rest[0];
        rest = rest.slice(1);
        if (c === 'c') return ''; // CSS styling; no styling in a text log
        if (c === 's') return typeof v === 'string' ? v : fmt(v, 1);
        if (c === 'd' || c === 'i') return String(parseInt(String(v), 10));
        if (c === 'f') return String(parseFloat(String(v)));
        return fmt(v, 1);
      }),
    );
  }
  for (const v of rest) parts.push(typeof v === 'string' ? v : fmt(v, 1));
  return parts.join(' ');
}
