// Turning JavaScript values in the page into CDP RemoteObjects (what the Console renders).
// The functions passed to evaluate() run inside the page and must be self-contained.

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Describes one value as a CDP RemoteObject, without objectId (the server adds that). */
export function describeValue(v: unknown): any {
  const t = typeof v;
  if (v === null) return { type: 'object', subtype: 'null', value: null };
  if (t === 'undefined') return { type: 'undefined' };
  if (t === 'string' || t === 'boolean') return { type: t, value: v };
  if (t === 'number') {
    const n = v as number;
    return Number.isFinite(n) && !Object.is(n, -0)
      ? { type: 'number', value: n, description: String(n) }
      : { type: 'number', unserializableValue: Object.is(n, -0) ? '-0' : String(n), description: String(n) };
  }
  if (t === 'bigint') return { type: 'bigint', unserializableValue: `${v}n`, description: `${v}n` };
  if (t === 'symbol') return { type: 'symbol', description: String(v), needsHandle: true };

  const short = (x: unknown): { type: string; subtype?: string; value: string } => {
    if (x === null) return { type: 'object', subtype: 'null', value: 'null' };
    const tx = typeof x;
    if (tx === 'string') return { type: 'string', value: (x as string).length > 100 ? (x as string).slice(0, 100) + '…' : (x as string) };
    if (tx === 'function') return { type: 'function', value: '' };
    if (tx !== 'object') return { type: tx, value: String(x) };
    if (Array.isArray(x)) return { type: 'object', subtype: 'array', value: `Array(${x.length})` };
    if (typeof Node !== 'undefined' && x instanceof Node) return { type: 'object', subtype: 'node', value: nodeLabel(x) };
    return { type: 'object', value: (x as object).constructor?.name ?? 'Object' };
  };
  const nodeLabel = (n: Node): string => {
    if (n.nodeType !== 1) return n.nodeName;
    const el = n as Element;
    return el.localName + (el.id ? '#' + el.id : '') + Array.from(el.classList).slice(0, 3).map((c) => '.' + c).join('');
  };

  if (t === 'function') {
    const src = String(v);
    return {
      type: 'function',
      className: 'Function',
      description: src.length > 300 ? src.slice(0, 300) + '…' : src,
      needsHandle: true,
    };
  }

  const o = v as any;
  const className: string = o.constructor?.name ?? 'Object';
  let subtype: string | undefined;
  let description = className;
  let entries: [string, unknown][] = [];
  let overflow = false;

  if (Array.isArray(o)) {
    subtype = 'array';
    description = `${className}(${o.length})`;
    entries = o.slice(0, 100).map((x: unknown, i: number) => [String(i), x]);
    overflow = o.length > 100;
  } else if (typeof Node !== 'undefined' && o instanceof Node) {
    subtype = 'node';
    description = nodeLabel(o);
  } else if (o instanceof Error) {
    subtype = 'error';
    // V8 stacks start with "Name: message"; Firefox and WebKit stacks are frames only. Build the
    // V8 shape DevTools expects, minus frames from TriPane's own evaluation wrapper.
    const header = `${o.name}: ${o.message}`;
    const frames = String(o.stack ?? '')
      .split('\n')
      .filter((l) => l.trim() && l !== header && !/debugger eval code|^eval( code)?@|\[native code\]|^evaluate@|^@$/.test(l.trim()));
    description = [header, ...frames.map((l) => (/^\s*at /.test(l) ? l : `    at ${l}`))].join('\n');
  } else if (o instanceof RegExp) {
    subtype = 'regexp';
    description = String(o);
  } else if (o instanceof Date) {
    subtype = 'date';
    description = String(o);
  } else if (o instanceof Map) {
    subtype = 'map';
    description = `Map(${o.size})`;
  } else if (o instanceof Set) {
    subtype = 'set';
    description = `Set(${o.size})`;
  } else if (o instanceof Promise) {
    subtype = 'promise';
    description = 'Promise';
  } else if (ArrayBuffer.isView(o)) {
    subtype = 'typedarray';
    description = `${className}(${(o as any).length ?? o.byteLength})`;
  } else {
    try {
      const keys = Object.keys(o);
      overflow = keys.length > 5;
      entries = keys.slice(0, 5).map((k) => [k, o[k]]);
    } catch {
      // exotic object (e.g. cross-origin window)
    }
  }
  if (subtype === 'array' && entries.length > 5) {
    overflow = true;
    entries = entries.slice(0, 5);
  }

  const preview = {
    type: 'object',
    subtype,
    description,
    overflow,
    properties: entries.map(([name, x]) => ({ name, ...short(x) })),
  };
  return { type: 'object', subtype, className, description, preview, needsHandle: true };
}

/** Lists an object's own properties (plus [[Prototype]]) for Runtime.getProperties. */
export function listProperties(o: any): { names: string[]; values: unknown[]; getters: boolean[]; proto: unknown } {
  const names: string[] = [];
  const values: unknown[] = [];
  const getters: boolean[] = [];
  let ownNames: string[] = [];
  try {
    ownNames = Object.getOwnPropertyNames(o).slice(0, 500);
  } catch {
    // ignore
  }
  for (const name of ownNames) {
    const desc = Object.getOwnPropertyDescriptor(o, name);
    names.push(name);
    if (desc && 'value' in desc) {
      values.push(desc.value);
      getters.push(false);
    } else {
      values.push(undefined);
      getters.push(true);
    }
  }
  if (o instanceof Map) {
    let i = 0;
    for (const [k, v] of o) {
      if (i++ >= 100) break;
      names.push(`[[Entries]] ${String(k)}`);
      values.push(v);
      getters.push(false);
    }
  } else if (o instanceof Set) {
    let i = 0;
    for (const v of o) {
      names.push(`[[Entries]] ${i}`);
      values.push(v);
      getters.push(false);
      if (++i >= 100) break;
    }
  }
  return { names, values, getters, proto: Object.getPrototypeOf(o) };
}
