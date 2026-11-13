// Standalone builds: TriPane compiled into one executable (bun run dist).
//
// The build defines TRIPANE_STANDALONE and TRIPANE_VERSION. A standalone binary has no
// node_modules and no Playwright CLI next to it, so it installs the browsers itself, using
// Playwright's own CLI code, which is bundled into the binary.
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium, firefox, webkit } from 'playwright';

export const STANDALONE = process.env.TRIPANE_STANDALONE === '1';
export const VERSION = process.env.TRIPANE_VERSION ?? 'dev';

/** Where screenshots go when there is no project folder to put them in. */
export const STANDALONE_SCREENSHOT_DIR = join(homedir(), '.tripane', 'screenshots');
/** Where traces (Tools → Record trace) go, likewise. */
export const STANDALONE_TRACE_DIR = join(homedir(), '.tripane', 'traces');

export const ENGINES = ['chromium', 'firefox', 'webkit'] as const;

/**
 * Playwright downloads each browser in a forked child process: it forks process.execPath with
 * the path of its downloader script. In a standalone build process.execPath is this binary, so
 * the child arrives here, and must act as the downloader instead of starting TriPane.
 */
export function isPlaywrightDownloadChild(argv = process.argv): boolean {
  return argv.some((a) => a.endsWith('oopBrowserDownload.js'));
}

export async function runPlaywrightDownloadChild(): Promise<void> {
  // @ts-expect-error: Playwright's internal bundles ship without type declarations.
  const { registry } = await import('playwright-core/lib/coreBundle');
  registry.runOopDownloadBrowserMain();
}

/** Runs Playwright's CLI (as `playwright <args>`), e.g. ['install', 'chromium', 'firefox', 'webkit']. */
export async function runPlaywrightCli(args: string[]): Promise<void> {
  // @ts-expect-error: as above.
  await import('playwright-core/lib/bootstrap');
  // @ts-expect-error: as above.
  const { libCli } = await import('playwright-core/lib/coreBundle');
  // @ts-expect-error: as above.
  const { program } = await import('playwright-core/lib/utilsBundle');
  libCli.decorateProgram(program);
  program.name('tripane');
  await program.parseAsync(['tripane', 'tripane', ...args]);
}

/** The engines whose browser build isn't installed yet. */
export function missingEngines(): string[] {
  const exe = { chromium: chromium.executablePath(), firefox: firefox.executablePath(), webkit: webkit.executablePath() };
  return ENGINES.filter((e) => !exe[e] || !existsSync(exe[e]));
}
