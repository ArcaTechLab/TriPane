import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type BrowserContext, type Page } from 'playwright';
import { themeScheme, type Settings } from '../shared/protocol';

export interface AppWindow {
  context: BrowserContext;
  page: Page;
  /**
   * Sets the window's prefers-color-scheme. TriPane's UI and the DevTools frontend (an iframe in
   * the window) both follow it, so this keeps their themes in sync, live.
   */
  setTheme(theme: Settings['uiTheme']): Promise<void>;
  close(): Promise<void>;
}

// The theme's light/dark base; null = no emulation: follow the operating system's preference.
const colorSchemeFor = (theme: Settings['uiTheme']) => themeScheme(theme);

/**
 * Opens the UI in a chromeless window: Playwright's own Chromium in --app mode with a
 * throwaway profile, so no system browser is needed.
 */
export async function openAppWindow(url: string, theme: Settings['uiTheme'] = 'system'): Promise<AppWindow> {
  const profileDir = await mkdtemp(join(tmpdir(), 'tripane-window-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: null,
    colorScheme: colorSchemeFor(theme),
    handleSIGINT: false, // TriPane's shutdown closes this window after saving the engines' storage
    handleSIGTERM: false,
    handleSIGHUP: false,
    args: [`--app=${url}`, '--window-size=1600,960'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
  context.on('close', () => void rm(profileDir, { recursive: true, force: true }).catch(() => {}));

  const isApp = (p: Page) => p.url().startsWith(url.split('?')[0]);
  let page =
    context.pages().find(isApp) ??
    (await context.waitForEvent('page', { predicate: isApp, timeout: 5000 }).catch(() => undefined));
  // Playwright also opens about:blank for a persistent context; close it once the app window exists.
  for (const p of context.pages()) if (p !== page && p.url() === 'about:blank') await p.close().catch(() => {});
  if (!page) {
    page = await context.newPage();
    await page.goto(url);
  }
  // The theme applies to every window TriPane opens, including a popped-out DevTools window.
  let current = theme;
  context.on('page', (p) => void p.emulateMedia({ colorScheme: colorSchemeFor(current) }).catch(() => {}));
  return {
    context,
    page,
    async setTheme(t) {
      current = t;
      await Promise.all(context.pages().map((p) => p.emulateMedia({ colorScheme: colorSchemeFor(t) }).catch(() => {})));
    },
    close: () => context.close().catch(() => {}),
  };
}
