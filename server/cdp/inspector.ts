// Server half of the DevTools adapter: speaks the Chrome DevTools Protocol (CDP) to a real
// Chrome DevTools frontend and serves it from a Firefox or WebKit page through Playwright.
//
//   Console   Runtime.*: console messages, exceptions, evaluate, object inspection
//   Network   Network.*: from Playwright's request/response events, with bodies and timing
//   Elements  DOM.*, CSS.*, Overlay.*: through the in-page agent (./agent.ts)
//   Sources   Page.getResourceTree / getResourceContent: the page's loaded files, read-only
//
// The debugger, profilers and the other panels are Chromium-only.

/* eslint-disable @typescript-eslint/no-explicit-any */
import { quietly } from '../quiet';
import type { ConsoleMessage, JSHandle, Page, Request, Response } from 'playwright';
import { AGENT_SOURCE } from './agent';
import { describeValue, listProperties } from './remote-object';

const FRAME_ID = 'tripane-main-frame';
const MAX_REQUESTS = 1000;
const MAX_CONSOLE = 1000;

type Send = (message: string) => void;
type ConsoleRecord = { kind: 'console'; msg: ConsoleMessage; ts: number } | { kind: 'exception'; error: Error; ts: number };

interface NetRecord {
  id: string;
  req: Request;
  loaderId: string;
  sentAt: number;
  response?: Response;
  headers?: Record<string, string>;
  respondedAt?: number;
  finishedAt?: number;
  bodySize?: number;
  encodedSize?: number;
  failure?: string;
  /** How far DevTools has been told: 0 nothing, 1 sent, 2 response, 3 finished or failed. */
  shown: number;
}

class ProtocolError extends Error {}

const now = () => Date.now() / 1000;

export class PageInspector {
  private send?: Send;
  private events: Promise<void> = Promise.resolve();
  private commands: Promise<void> = Promise.resolve();

  private loaderSeq = 1;
  private loaderId = 'tripane-loader-1';
  private contextId = 1;
  private newDocumentPending = false;

  private consoleLog: ConsoleRecord[] = [];
  private consoleShown = new WeakSet<ConsoleRecord>();
  private records = new Map<Request, NetRecord>();
  private recordsById = new Map<string, NetRecord>();
  private nextRequest = 1;

  private objects = new Map<string, JSHandle>();
  private groups = new Map<string, Set<string>>();
  private nextObject = 1;

  private bindingInstalled = false;
  private agentLoader: string | null = null;
  private runtimeEnabled = false;
  private networkEnabled = false;

  constructor(
    private readonly page: Page,
    /** Told when the element picker turns on or off, so the server can stop syncing clicks. */
    private readonly onInspectMode: (on: boolean) => void,
  ) {
    page.on('console', (msg) => this.record({ kind: 'console', msg, ts: Date.now() }));
    page.on('pageerror', (error) => this.record({ kind: 'exception', error, ts: Date.now() }));
    page.on('request', (req) => this.onRequest(req));
    page.on('response', (res) => this.queueEvent(() => this.onResponse(res)));
    page.on('requestfinished', (req) => this.queueEvent(() => this.onFinished(req)));
    page.on('requestfailed', (req) => this.queueEvent(() => this.onFailed(req)));
    page.on('framenavigated', (frame) => {
      if (frame === page.mainFrame()) this.onNavigated();
    });
    page.on('domcontentloaded', () => this.queueEvent(async () => this.emit('Page.domContentEventFired', { timestamp: now() })));
    page.on('load', () => this.queueEvent(async () => this.emit('Page.loadEventFired', { timestamp: now() })));
  }

  // ---- connection ---------------------------------------------------------------------------

  /** Attaches a DevTools frontend; a newer one replaces an older one. Returns the detach function. */
  connect(send: Send): () => void {
    this.send = send;
    this.runtimeEnabled = false;
    this.networkEnabled = false;
    this.consoleShown = new WeakSet();
    for (const r of this.recordsById.values()) r.shown = 0;
    return () => {
      if (this.send !== send) return;
      this.send = undefined;
      this.onInspectMode(false);
      if (this.agentLoader === this.loaderId) void quietly(this.page, () => this.page.evaluate(() => (window as any).__tripaneAgent?.deactivate())).catch(() => {});
      this.agentLoader = null;
    };
  }

  handle(raw: string): void {
    let msg: { id: number; method: string; params?: any; sessionId?: string };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const send = this.send;
    // One command at a time, in order, like a real CDP backend.
    this.commands = this.commands.then(async () => {
      let reply: object;
      try {
        if (msg.sessionId) throw new ProtocolError('TriPane exposes no child targets');
        reply = { id: msg.id, result: (await quietly(this.page, () => this.dispatch(msg.method, msg.params ?? {}))) ?? {} };
      } catch (err) {
        const message = err instanceof Error ? cleanError(err.message) : String(err);
        reply = { id: msg.id, error: { code: err instanceof ProtocolError ? -32601 : -32000, message } };
        if (process.env.TRIPANE_CDP_DEBUG) console.error(`[cdp] ${msg.method} → ${message}`);
      }
      if (msg.sessionId) Object.assign(reply, { sessionId: msg.sessionId });
      if (send && this.send === send) send(JSON.stringify(reply));
    });
  }

  private emit(method: string, params: object): void {
    this.send?.(JSON.stringify({ method, params }));
  }

  private queueEvent(fn: () => Promise<void>): void {
    this.events = this.events.then(() => quietly(this.page, fn)).catch(() => {});
  }

  // ---- dispatch -----------------------------------------------------------------------------

  private async dispatch(method: string, p: any): Promise<object | void> {
    switch (method) {
      // Target / session plumbing
      case 'Target.getTargetInfo':
        return { targetInfo: await this.targetInfo() };
      case 'Target.getTargets':
        return { targetInfos: [await this.targetInfo()] };
      case 'Debugger.enable':
        return { debuggerId: 'tripane' };

      // Runtime / Console
      case 'Runtime.enable':
        await this.enableRuntime();
        return;
      case 'Runtime.disable':
        this.runtimeEnabled = false;
        return;
      case 'Runtime.evaluate':
        return this.evaluate(p);
      case 'Runtime.callFunctionOn':
        return this.callFunctionOn(p);
      case 'Runtime.getProperties':
        return this.getProperties(p);
      case 'Runtime.releaseObject':
        this.release(p.objectId);
        return;
      case 'Runtime.releaseObjectGroup':
        for (const id of this.groups.get(p.objectGroup) ?? []) this.release(id);
        this.groups.delete(p.objectGroup);
        return;
      case 'Runtime.globalLexicalScopeNames':
        return { names: [] };
      case 'Runtime.compileScript':
        return {};
      case 'Runtime.discardConsoleEntries':
        this.consoleLog = [];
        return;

      // Page / Sources
      case 'Page.getResourceTree':
        return { frameTree: { frame: this.frame(), resources: this.resources() } };
      case 'Page.getFrameTree':
        return { frameTree: { frame: this.frame() } };
      case 'Page.getResourceContent':
        return this.resourceContent(p.url);
      case 'Page.reload':
        void this.page.reload({ waitUntil: 'commit' }).catch(() => {});
        return;
      case 'Page.navigate':
        await this.page.goto(p.url, { waitUntil: 'commit' });
        return { frameId: FRAME_ID, loaderId: this.loaderId };
      case 'Page.getNavigationHistory':
        return {
          currentIndex: 0,
          entries: [{ id: 0, url: this.page.url(), userTypedURL: this.page.url(), title: await this.page.title(), transitionType: 'typed' }],
        };

      // Network
      case 'Network.enable':
        this.networkEnabled = true;
        for (const r of this.recordsById.values()) this.show(r);
        return;
      case 'Network.disable':
        this.networkEnabled = false;
        return;
      case 'Network.getResponseBody':
        return this.responseBody(p.requestId);
      case 'Network.getRequestPostData': {
        const postData = this.recordsById.get(p.requestId)?.req.postData();
        if (postData == null) throw new Error('No post data');
        return { postData };
      }

      // DOM / Elements
      case 'DOM.getDocument':
        return { root: await this.agent('getDocument', p.depth ?? 1) };
      case 'DOM.requestChildNodes': {
        const result = await this.agent<any>('requestChildNodes', p.nodeId, p.depth ?? 1);
        this.emit('DOM.setChildNodes', result);
        return;
      }
      case 'DOM.describeNode':
        return { node: await this.agent('describeNode', await this.nodeId(p), p.depth ?? 0) };
      case 'DOM.resolveNode': {
        await this.ensureAgent();
        const id = await this.nodeId(p);
        const handle = await this.page.evaluateHandle((n) => (window as any).__tripaneAgent.node(n), id);
        return { object: await this.remote(handle, p.objectGroup) };
      }
      case 'DOM.requestNode':
        return { nodeId: await this.nodeId({ objectId: p.objectId }) };
      case 'DOM.pushNodesByBackendIdsToFrontend': {
        for (const id of p.backendNodeIds as number[]) this.emitAll(await this.agent<unknown[]>('pushPath', id));
        return { nodeIds: p.backendNodeIds };
      }
      case 'DOM.setInspectedNode':
        await this.agent('setInspectedNode', p.nodeId);
        return;
      case 'DOM.getOuterHTML':
        return { outerHTML: await this.agent('outerHTML', await this.nodeId(p)) };
      case 'DOM.setOuterHTML':
        await this.agent('setOuterHTML', p.nodeId, p.outerHTML);
        return;
      case 'DOM.removeNode':
        await this.agent('removeNode', p.nodeId);
        return;
      case 'DOM.setAttributeValue':
        await this.agent('setAttributeValue', p.nodeId, p.name, p.value);
        return;
      case 'DOM.setAttributesAsText':
        await this.agent('setAttributesAsText', p.nodeId, p.text, p.name);
        return;
      case 'DOM.removeAttribute':
        await this.agent('removeAttribute', p.nodeId, p.name);
        return;
      case 'DOM.setNodeValue':
        await this.agent('setNodeValue', p.nodeId, p.value);
        return;
      case 'DOM.performSearch':
        return this.agent('performSearch', p.query);
      case 'DOM.getSearchResults': {
        const { nodeIds, events } = await this.agent<{ nodeIds: number[]; events: unknown[] }>(
          'getSearchResults', p.searchId, p.fromIndex, p.toIndex);
        this.emitAll(events);
        return { nodeIds };
      }
      case 'DOM.discardSearchResults':
        await this.agent('discardSearchResults', p.searchId);
        return;
      case 'DOM.getNodeForLocation': {
        const hit = await this.agent<{ id: number; events: unknown[] } | null>('nodeForLocation', p.x, p.y);
        if (!hit) throw new Error('No node at that location');
        this.emitAll(hit.events);
        return { backendNodeId: hit.id, nodeId: hit.id, frameId: FRAME_ID };
      }
      case 'DOM.getBoxModel':
        return { model: await this.agent('boxModel', await this.nodeId(p)) };
      case 'DOM.getContentQuads':
        return { quads: [((await this.agent('boxModel', await this.nodeId(p))) as any).border] };
      case 'DOM.scrollIntoViewIfNeeded':
        await this.agent('scrollIntoView', await this.nodeId(p));
        return;
      case 'DOM.focus':
        await this.agent('focus', await this.nodeId(p));
        return;
      case 'DOM.highlightNode':
      case 'Overlay.highlightNode':
        await this.agent('highlight', await this.nodeId(p), p.highlightConfig ?? {});
        return;
      case 'DOM.hideHighlight':
      case 'Overlay.hideHighlight':
        if (this.agentLoader === this.loaderId) await this.agent('hideHighlight');
        return;
      case 'Overlay.setInspectMode': {
        const on = p.mode !== 'none';
        await this.agent('setInspectMode', on, p.highlightConfig ?? {});
        this.onInspectMode(on);
        return;
      }

      // CSS / Styles
      case 'CSS.getMatchedStylesForNode':
        return this.agent('matchedStyles', p.nodeId);
      case 'CSS.getInlineStylesForNode':
        return this.agent('inlineStyles', p.nodeId);
      case 'CSS.getComputedStyleForNode':
        return { computedStyle: await this.agent('computedStyle', p.nodeId) };
      case 'CSS.setStyleTexts': {
        const styles = [];
        for (const edit of p.edits as { styleSheetId: string; text: string }[]) {
          styles.push(await this.agent('setStyleText', edit.styleSheetId, edit.text));
        }
        return { styles };
      }
      case 'CSS.getLonghandProperties':
        return { longhandProperties: await this.agent('longhands', p.shorthandName, p.value) };
      case 'CSS.getPlatformFontsForNode':
        return { fonts: [] };
      case 'CSS.getBackgroundColors':
        return { backgroundColors: await this.agent('backgroundColors', p.nodeId) };
      case 'CSS.takeComputedStyleUpdates':
        return { nodeIds: [] };
      case 'CSS.getEnvironmentVariables':
        return { environmentVariables: {} };
      case 'CSS.getMediaQueries':
        return { medias: [] };
      case 'CSS.forcePseudoState':
      case 'CSS.trackComputedStyleUpdates':
      case 'CSS.trackComputedStyleUpdatesForNode':
      case 'DOM.markUndoableState':
      case 'Runtime.runIfWaitingForDebugger':
      case 'Runtime.addBinding':
      case 'Network.overrideNetworkState':
        return;
      case 'Page.addScriptToEvaluateOnNewDocument':
        // Used by DevTools for optional features; acknowledging without running is safe.
        return { identifier: 'tripane-noop' };
      case 'Network.emulateNetworkConditionsByRule':
        return { ruleIds: [] };
    }
    // Turning domains on and off, and settings we can't honor, are harmless no-ops.
    const name = method.slice(method.indexOf('.') + 1);
    if (name === 'enable' || name === 'disable' || /^set[A-Z]/.test(name)) return;
    if (['Target', 'Debugger', 'Profiler', 'HeapProfiler', 'Emulation', 'Log', 'Inspector', 'Audits'].includes(method.split('.')[0])) {
      if (/^(run|stop|clear|start|attach|detach)/.test(name)) return;
    }
    throw new ProtocolError(`'${method}' isn't available for this engine in TriPane (Chromium-only)`);
  }

  // ---- Runtime ------------------------------------------------------------------------------

  private executionContext() {
    let origin = '';
    try {
      origin = new URL(this.page.url()).origin;
    } catch {
      // about:blank
    }
    return {
      id: this.contextId,
      origin,
      name: '',
      uniqueId: `tripane-context-${this.contextId}`,
      auxData: { isDefault: true, type: 'default', frameId: FRAME_ID },
    };
  }

  private async enableRuntime(): Promise<void> {
    this.runtimeEnabled = true;
    this.emit('Runtime.executionContextCreated', { context: this.executionContext() });
    for (const rec of this.consoleLog) await this.showConsole(rec);
  }

  private async showConsole(rec: ConsoleRecord): Promise<void> {
    if (this.consoleShown.has(rec)) return;
    this.consoleShown.add(rec);
    const event = await this.consoleEvent(rec);
    this.emit(event.method, event.params);
  }

  private record(rec: ConsoleRecord): void {
    this.consoleLog.push(rec);
    if (this.consoleLog.length > MAX_CONSOLE) this.consoleLog.shift();
    this.queueEvent(async () => {
      if (this.send && this.runtimeEnabled) await this.showConsole(rec);
    });
  }

  private async consoleEvent(rec: ConsoleRecord): Promise<{ method: string; params: object }> {
    if (rec.kind === 'exception') {
      const { error } = rec;
      return {
        method: 'Runtime.exceptionThrown',
        params: {
          timestamp: rec.ts,
          exceptionDetails: {
            exceptionId: rec.ts,
            text: 'Uncaught',
            lineNumber: 0,
            columnNumber: 0,
            executionContextId: this.contextId,
            exception: {
              type: 'object',
              subtype: 'error',
              className: error.name || 'Error',
              description: error.stack || `${error.name}: ${error.message}`,
            },
          },
        },
      };
    }
    const { msg } = rec;
    let args: any[] = [];
    try {
      args = await Promise.all(msg.args().map((h) => this.remote(h, 'console')));
    } catch {
      // handles from a page that has gone away
    }
    if (!args.length) args = [{ type: 'string', value: msg.text() }];
    const loc = msg.location();
    return {
      method: 'Runtime.consoleAPICalled',
      params: {
        type: msg.type(),
        args,
        executionContextId: this.contextId,
        timestamp: rec.ts,
        ...(loc.url
          ? { stackTrace: { callFrames: [{ functionName: '', scriptId: '0', url: loc.url, lineNumber: loc.lineNumber, columnNumber: loc.columnNumber }] } }
          : {}),
      },
    };
  }

  /** Wraps a handle as a RemoteObject; objects keep their handle so DevTools can expand them. */
  private async remote(handle: JSHandle, group?: string): Promise<any> {
    let d: any;
    try {
      d = await handle.evaluate(describeValue);
    } catch {
      return { type: 'undefined' };
    }
    if (!d.needsHandle) {
      void handle.dispose().catch(() => {});
      return d;
    }
    delete d.needsHandle;
    const objectId = `tripane-object-${this.nextObject++}`;
    this.objects.set(objectId, handle);
    if (group) {
      if (!this.groups.has(group)) this.groups.set(group, new Set());
      this.groups.get(group)!.add(objectId);
    }
    return { ...d, objectId };
  }

  private release(objectId: string): void {
    const h = this.objects.get(objectId);
    this.objects.delete(objectId);
    void h?.dispose().catch(() => {});
  }

  private async evaluate(p: any): Promise<object> {
    const expression: string = p.expression;
    // DevTools evaluates as you type to preview results; only run things that are plainly
    // side-effect free (names and property access), like Chrome's own side-effect check.
    if (p.throwOnSideEffect && !/^[\w$\s.[\]'"]*$/.test(expression)) {
      return exceptionResult('EvalError: Possible side-effect in debug-evaluate');
    }
    // Evaluate inside a try/catch in the page so a thrown value comes back as the real object
    // (Firefox's protocol drops the error's class name), and so a returned Promise is shown
    // as a Promise rather than awaited. In-page eval isn't subject to the page's CSP here.
    let outcome: JSHandle;
    try {
      outcome = await this.page.evaluateHandle((expr) => {
        try {
          // eslint-disable-next-line no-eval
          return { threw: false, value: (0, eval)(expr) };
        } catch (error) {
          return { threw: true, value: error };
        }
      }, expression);
    } catch (err) {
      return exceptionResult(cleanError(err instanceof Error ? err.message : String(err)));
    }
    const threw = await outcome.evaluate((o) => o.threw);
    const handle = await outcome.evaluateHandle((o) => o.value);
    void outcome.dispose().catch(() => {});
    if (threw) {
      const exception = await this.remote(handle, p.objectGroup);
      return {
        result: exception,
        exceptionDetails: { exceptionId: Date.now(), text: 'Uncaught', lineNumber: 0, columnNumber: 0, exception },
      };
    }
    if (p.returnByValue) {
      const value = await handle.jsonValue().catch(() => undefined);
      void handle.dispose().catch(() => {});
      return { result: byValue(value) };
    }
    return { result: await this.remote(handle, p.objectGroup) };
  }

  private async callFunctionOn(p: any): Promise<object> {
    const self = p.objectId ? this.objects.get(p.objectId) : undefined;
    if (p.objectId && !self) throw new Error('Could not find object with given id');
    const args = ((p.arguments ?? []) as any[]).map((a) =>
      a.objectId ? this.objects.get(a.objectId) : a.unserializableValue !== undefined ? undefined : a.value);
    try {
      const handle = await this.page.evaluateHandle(
        ([src, thisArg, argv]) => {
          // eslint-disable-next-line no-eval
          const fn = (0, eval)(`(${src})`);
          return fn.apply(thisArg, argv);
        },
        [p.functionDeclaration as string, self ?? null, args] as const,
      );
      if (p.returnByValue) {
        const value = await handle.jsonValue().catch(() => undefined);
        void handle.dispose().catch(() => {});
        return { result: byValue(value) };
      }
      return { result: await this.remote(handle, p.objectGroup) };
    } catch (err) {
      return exceptionResult(cleanError(err instanceof Error ? err.message : String(err)));
    }
  }

  private async getProperties(p: any): Promise<object> {
    if (p.accessorPropertiesOnly) return { result: [] };
    const handle = this.objects.get(p.objectId);
    if (!handle) throw new Error('Could not find object with given id');
    const list = await handle.evaluateHandle(listProperties);
    const { names, getters } = await list.evaluate((l) => ({ names: l.names, getters: l.getters }));
    const values = await list.evaluateHandle((l) => [...l.values, l.proto]);
    const byIndex = await values.getProperties();
    const group = [...this.groups].find(([, ids]) => ids.has(p.objectId))?.[0];
    const result = await Promise.all(
      names.map(async (name, i) =>
        getters[i]
          ? { name, get: { type: 'function', className: 'Function', description: 'get' }, configurable: true, enumerable: false, isOwn: true }
          : {
              name,
              value: await this.remote(byIndex.get(String(i))!, group),
              writable: true,
              configurable: true,
              enumerable: true,
              isOwn: true,
            },
      ),
    );
    const protoHandle = byIndex.get(String(names.length));
    const proto = protoHandle ? await this.remote(protoHandle, group) : null;
    void list.dispose().catch(() => {});
    void values.dispose().catch(() => {});
    return {
      result,
      internalProperties: proto && proto.subtype !== 'null' ? [{ name: '[[Prototype]]', value: proto }] : [],
    };
  }

  // ---- Page / navigation ----------------------------------------------------------------------

  private frame() {
    const url = this.page.url();
    let origin = '';
    try {
      origin = new URL(url).origin;
    } catch {
      // about:blank
    }
    const secure = /^(https:|about:|data:)/.test(url) || /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(url);
    return {
      id: FRAME_ID,
      loaderId: this.loaderId,
      url,
      domainAndRegistry: '',
      securityOrigin: origin,
      mimeType: 'text/html',
      secureContextType: secure ? 'Secure' : 'InsecureScheme',
      crossOriginIsolatedContextType: 'NotIsolated',
      gatedAPIFeatures: [],
      adFrameStatus: { adFrameType: 'none' },
    };
  }

  private async targetInfo() {
    return {
      targetId: FRAME_ID,
      type: 'page',
      title: await this.page.title().catch(() => ''),
      url: this.page.url(),
      attached: true,
      canAccessOpener: false,
    };
  }

  /**
   * Runs synchronously in the framenavigated handler: the new document's first console messages
   * can arrive right after it, and they must land in the fresh buffer, not be wiped by a late reset.
   */
  private onNavigated(): void {
    const url = this.page.url();
    if (!this.newDocumentPending) {
      this.queueEvent(async () => this.emit('Page.navigatedWithinDocument', { frameId: FRAME_ID, url }));
      return;
    }
    // A new document: fresh console, objects, execution context and DOM.
    this.newDocumentPending = false;
    this.loaderId = `tripane-loader-${++this.loaderSeq}`;
    this.contextId++;
    this.consoleLog = [];
    for (const id of [...this.objects.keys()]) this.release(id);
    this.groups.clear();
    this.agentLoader = null;
    const frame = this.frame();
    const context = this.executionContext();
    this.queueEvent(async () => {
      this.emit('Page.frameNavigated', { frame, type: 'Navigation' });
      this.emit('Runtime.executionContextsCleared', {});
      if (this.runtimeEnabled) this.emit('Runtime.executionContextCreated', { context });
      this.emit('DOM.documentUpdated', {});
    });
  }

  private resources() {
    const out: object[] = [];
    for (const r of this.recordsById.values()) {
      const type = cdpType(r.req.resourceType());
      if (!r.response || ['Document', 'XHR', 'Fetch', 'Other'].includes(type)) continue;
      out.push({ url: r.req.url(), type, mimeType: mimeOf(r.headers) });
    }
    return out;
  }

  private async resourceContent(url: string): Promise<object> {
    const rec = [...this.recordsById.values()].reverse().find((r) => r.req.url() === url && r.response);
    if (!rec && url === this.page.url()) return { content: await this.page.content(), base64Encoded: false };
    if (!rec) throw new Error(`No resource with URL ${url}`);
    return this.bodyOf(rec);
  }

  // ---- Network ------------------------------------------------------------------------------

  private onRequest(req: Request): void {
    if (req.isNavigationRequest() && req.frame() === this.page.mainFrame()) {
      this.newDocumentPending = true;
      this.records.clear();
      this.recordsById.clear();
    }
    const rec: NetRecord = { id: `tripane-req-${this.nextRequest++}`, req, loaderId: this.loaderId, sentAt: now(), shown: 0 };
    this.records.set(req, rec);
    this.recordsById.set(rec.id, rec);
    if (this.recordsById.size > MAX_REQUESTS) {
      const [oldest] = this.recordsById.values();
      this.recordsById.delete(oldest.id);
      this.records.delete(oldest.req);
    }
    this.queueEvent(async () => this.show(rec));
  }

  private async onResponse(res: Response): Promise<void> {
    const rec = this.records.get(res.request());
    if (!rec) return;
    rec.response = res;
    rec.respondedAt = now();
    rec.headers = await res.allHeaders().catch(() => res.headers());
    this.show(rec);
  }

  private async onFinished(req: Request): Promise<void> {
    const rec = this.records.get(req);
    if (!rec) return;
    const sizes = await req.sizes().catch(() => null);
    rec.bodySize = sizes?.responseBodySize ?? 0;
    rec.encodedSize = sizes ? sizes.responseBodySize + sizes.responseHeadersSize : 0;
    const t = req.timing();
    rec.finishedAt = t.responseEnd >= 0 ? (t.startTime + t.responseEnd) / 1000 : now();
    this.show(rec);
  }

  private async onFailed(req: Request): Promise<void> {
    const rec = this.records.get(req);
    if (!rec) return;
    rec.failure = req.failure()?.errorText ?? 'net::ERR_FAILED';
    rec.finishedAt = now();
    this.show(rec);
  }

  /** Tells DevTools whatever it hasn't heard about this request yet, in protocol order. */
  private show(rec: NetRecord): void {
    if (!this.send || !this.networkEnabled) return;
    if (rec.shown < 1) {
      rec.shown = 1;
      this.emit('Network.requestWillBeSent', this.willBeSent(rec));
    }
    if (rec.shown < 2 && rec.response && rec.headers) {
      rec.shown = 2;
      this.emit('Network.responseReceived', this.responseReceived(rec));
    }
    if (rec.shown < 3 && rec.finishedAt !== undefined) {
      rec.shown = 3;
      this.emitFinished(rec);
    }
  }

  private willBeSent(rec: NetRecord) {
    const { req } = rec;
    const postData = req.postData();
    return {
      requestId: rec.id,
      loaderId: rec.loaderId,
      documentURL: this.page.url(),
      request: {
        url: req.url(),
        method: req.method(),
        headers: req.headers(),
        ...(postData != null ? { postData, hasPostData: true } : {}),
        initialPriority: 'High',
        referrerPolicy: 'strict-origin-when-cross-origin',
        mixedContentType: 'none',
      },
      timestamp: rec.sentAt,
      wallTime: rec.sentAt,
      initiator: { type: req.isNavigationRequest() ? 'other' : 'script' },
      redirectHasExtraInfo: false,
      type: cdpType(req.resourceType()),
      frameId: FRAME_ID,
      hasUserGesture: false,
    };
  }

  private responseReceived(rec: NetRecord) {
    const res = rec.response!;
    const t = rec.req.timing();
    return {
      requestId: rec.id,
      loaderId: rec.loaderId,
      timestamp: rec.respondedAt,
      type: cdpType(rec.req.resourceType()),
      frameId: FRAME_ID,
      hasExtraInfo: false,
      response: {
        url: res.url(),
        status: res.status(),
        statusText: res.statusText(),
        headers: rec.headers,
        mimeType: mimeOf(rec.headers),
        charset: '',
        connectionReused: false,
        connectionId: 0,
        fromDiskCache: false,
        fromServiceWorker: res.fromServiceWorker(),
        fromPrefetchCache: false,
        encodedDataLength: 0,
        protocol: 'http/1.1',
        securityState: res.url().startsWith('https:') ? 'secure' : 'insecure',
        ...(t.startTime > 0 ? { timing: cdpTiming(t) } : {}),
      },
    };
  }

  private emitFinished(rec: NetRecord): void {
    if (rec.failure) {
      this.emit('Network.loadingFailed', {
        requestId: rec.id,
        timestamp: rec.finishedAt,
        type: cdpType(rec.req.resourceType()),
        errorText: rec.failure,
        canceled: /abort|cancel/i.test(rec.failure),
      });
      return;
    }
    this.emit('Network.dataReceived', {
      requestId: rec.id,
      timestamp: rec.finishedAt,
      dataLength: rec.bodySize ?? 0,
      encodedDataLength: rec.bodySize ?? 0,
    });
    this.emit('Network.loadingFinished', {
      requestId: rec.id,
      timestamp: rec.finishedAt,
      encodedDataLength: rec.encodedSize ?? 0,
    });
  }

  private async responseBody(requestId: string): Promise<object> {
    const rec = this.recordsById.get(requestId);
    if (!rec?.response) throw new Error('No resource with given identifier found');
    return this.bodyOf(rec);
  }

  private async bodyOf(rec: NetRecord): Promise<object> {
    const body = await rec.response!.body();
    const mime = mimeOf(rec.headers);
    const textual = /^text\/|json|javascript|ecmascript|xml|css|svg|html|x-www-form-urlencoded/.test(mime);
    return textual ? { body: body.toString('utf8'), content: body.toString('utf8'), base64Encoded: false }
      : { body: body.toString('base64'), content: body.toString('base64'), base64Encoded: true };
  }

  // ---- DOM agent ----------------------------------------------------------------------------

  private async ensureAgent(): Promise<void> {
    if (!this.bindingInstalled) {
      this.bindingInstalled = true;
      await this.page.exposeBinding('__tripaneDomEvent', (_source, json: string) => this.onAgentEvents(json));
      await this.page.addInitScript({ content: AGENT_SOURCE });
    }
    if (this.agentLoader !== this.loaderId) {
      await this.page.evaluate(AGENT_SOURCE);
      await this.page.evaluate(() => (window as any).__tripaneAgent.activate());
      this.agentLoader = this.loaderId;
    }
  }

  private async agent<T = unknown>(method: string, ...args: unknown[]): Promise<T> {
    await this.ensureAgent();
    return this.page.evaluate(([m, a]) => (window as any).__tripaneAgent[m](...a), [method, args] as const);
  }

  private onAgentEvents(json: string): void {
    let events: { method: string; params: object }[];
    try {
      events = JSON.parse(json);
    } catch {
      return;
    }
    this.emitAll(events);
  }

  private emitAll(events: unknown[]): void {
    for (const e of events as { method: string; params: object }[]) this.emit(e.method, e.params);
  }

  /** Resolves nodeId / backendNodeId / objectId to the agent's node id. */
  private async nodeId(p: { nodeId?: number; backendNodeId?: number; objectId?: string }): Promise<number> {
    if (p.nodeId) return p.nodeId;
    if (p.backendNodeId) return p.backendNodeId;
    if (p.objectId) {
      const handle = this.objects.get(p.objectId);
      if (!handle) throw new Error('Could not find object with given id');
      await this.ensureAgent();
      const { id, events } = await handle.evaluate((n) => (window as any).__tripaneAgent.idOf(n));
      this.emitAll(events);
      return id;
    }
    throw new Error('Either nodeId, backendNodeId or objectId must be specified');
  }
}

// ---- helpers ------------------------------------------------------------------------------------

function exceptionResult(text: string) {
  const name = text.match(/^(\w*Error)\b/)?.[1] ?? 'Error';
  const exception = { type: 'object', subtype: 'error', className: name, description: text };
  return {
    result: exception,
    exceptionDetails: { exceptionId: 1, text: 'Uncaught', lineNumber: 0, columnNumber: 0, exception },
  };
}

function byValue(value: unknown) {
  if (value === null) return { type: 'object', subtype: 'null', value: null };
  return { type: typeof value, value };
}

/** Playwright prefixes errors with the API name and appends its own call log; DevTools wants the JS error. */
function cleanError(message: string): string {
  return message
    .replace(/^(?:\w+\.)?(?:evaluate|evaluateHandle|jsonValue|getProperties|goto|reload|goBack|goForward)\w*: /, '')
    .split('\n')
    .filter((line) => line.trim() && !/^\s*(at |Call log:|- )/.test(line) && !/@.*:\d+:\d+$/.test(line))
    .join('\n');
}

const CDP_TYPES: Record<string, string> = {
  document: 'Document',
  stylesheet: 'Stylesheet',
  image: 'Image',
  media: 'Media',
  font: 'Font',
  script: 'Script',
  texttrack: 'TextTrack',
  xhr: 'XHR',
  fetch: 'Fetch',
  eventsource: 'EventSource',
  websocket: 'WebSocket',
  manifest: 'Manifest',
  ping: 'Ping',
  other: 'Other',
};
function cdpType(playwrightType: string): string {
  return CDP_TYPES[playwrightType] ?? 'Other';
}

function mimeOf(headers?: Record<string, string>): string {
  return (headers?.['content-type'] ?? '').split(';')[0].trim().toLowerCase();
}

function cdpTiming(t: ReturnType<Request['timing']>) {
  const rel = (v: number) => (v >= 0 ? v : -1);
  return {
    requestTime: t.startTime / 1000,
    proxyStart: -1,
    proxyEnd: -1,
    dnsStart: rel(t.domainLookupStart),
    dnsEnd: rel(t.domainLookupEnd),
    connectStart: rel(t.connectStart),
    connectEnd: rel(t.connectEnd),
    sslStart: rel(t.secureConnectionStart),
    sslEnd: t.secureConnectionStart >= 0 ? rel(t.connectEnd) : -1,
    workerStart: -1,
    workerReady: -1,
    workerFetchStart: -1,
    workerRespondWithSettled: -1,
    sendStart: rel(t.requestStart),
    sendEnd: rel(t.requestStart),
    pushStart: 0,
    pushEnd: 0,
    receiveHeadersStart: rel(t.responseStart),
    receiveHeadersEnd: rel(t.responseStart),
  };
}
