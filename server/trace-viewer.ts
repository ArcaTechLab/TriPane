// Tools → Record trace: Playwright traces, opened in Playwright's own Trace Viewer, a static web
// app that TriPane serves under /trace/ (as `playwright show-trace` does from its own server).
// The viewer loads a trace from a URL: /traces/<recording>/<engine>.zip, which needs the token.
import { dirname, join } from 'node:path';
import { TRACE_VIEWER_FILES } from './trace-viewer-files';

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  ttf: 'font/ttf',
  webmanifest: 'application/manifest+json',
};

let viewerDir: string | null | undefined;
function viewerRoot(): string | null {
  if (viewerDir === undefined) {
    try {
      viewerDir = join(dirname(Bun.resolveSync('playwright-core/package.json', import.meta.dir)), 'lib', 'vite', 'traceViewer');
    } catch {
      viewerDir = null;
    }
  }
  return viewerDir;
}

/** A Trace Viewer file, for a path under /trace/ (e.g. "index.html", "assets/x.js"). */
export async function traceViewerResponse(path: string): Promise<Response> {
  if (path === '' || path === '/') path = 'index.html';
  path = path.replace(/^\/+/, '');
  if (!/^[\w.-]+(\/[\w.-]+)*$/.test(path) || path.split('/').includes('..')) return new Response('Not found', { status: 404 });
  const root = TRACE_VIEWER_FILES ? null : viewerRoot();
  const source = TRACE_VIEWER_FILES ? TRACE_VIEWER_FILES[path] : root && join(root, path);
  const file = source ? Bun.file(source) : null;
  if (!file || !(await file.exists())) return new Response('Not found', { status: 404 });
  const type = TYPES[path.split('.').pop()!] ?? 'application/octet-stream';
  return new Response(file, { headers: { 'content-type': type, 'cache-control': 'no-cache' } });
}

/** One recording's folder name: its start time, safe in paths and URLs. */
export function recordingStamp(date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

export const TRACE_FILE_PATH = /^\/traces\/(\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d(?:-\d+)?)\/((?:chromium|firefox|webkit)(?:-\d+)?\.zip)$/;

/**
 * The Trace Viewer for one engine's trace (several files when it was recorded in parts: the
 * viewer shows them as one timeline). Relative to the server's origin.
 */
export function traceViewerUrl(origin: string, token: string, stamp: string, files: string[]): string {
  const params = new URLSearchParams();
  for (const f of files) params.append('trace', `${origin}/traces/${stamp}/${f}?token=${encodeURIComponent(token)}`);
  return `/trace/index.html?${params}`;
}
