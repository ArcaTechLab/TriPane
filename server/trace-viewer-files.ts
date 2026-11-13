// Playwright's Trace Viewer files, embedded in standalone builds: scripts/build-dist.ts replaces
// this module with a map from each file's path (relative to playwright-core/lib/vite/traceViewer)
// to where the binary keeps it. When running from source it's null and the files are read from
// node_modules.
export const TRACE_VIEWER_FILES: Record<string, string> | null = null;
