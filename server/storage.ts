// Saved browser state (cookies, localStorage, IndexedDB) for one engine, in Playwright's
// storageState format. The files hold login cookies, so they are readable by the owner only.

import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BrowserContext } from 'playwright';
import { DEFAULT_SETTINGS, sanitizeSettings, type Settings } from '../shared/protocol';

export const DEFAULT_PROFILE_DIR = join(homedir(), '.tripane', 'storage');

type StorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

/** Whether a cookie for `domain` belongs to the site `host`: its own, or a parent domain's (.example.com for www.example.com). Any path. */
export function cookieForHost(domain: string, host: string): boolean {
  const d = domain.replace(/^\./, '');
  return d === host || host.endsWith(`.${d}`);
}

export class StateFile {
  private lastSaved = '';
  private writing: Promise<void> = Promise.resolve();

  constructor(readonly path: string) {}

  /** The saved state, or undefined if there is none or it can't be read. */
  async load(): Promise<StorageState | undefined> {
    const file = Bun.file(this.path);
    if (!(await file.exists())) return undefined;
    try {
      const text = await file.text();
      const state = JSON.parse(text) as StorageState;
      if (!Array.isArray(state.cookies) || !Array.isArray(state.origins)) return undefined;
      this.lastSaved = text;
      return state;
    } catch {
      return undefined; // corrupt file: start fresh rather than fail to launch
    }
  }

  /**
   * Saves the context's state if it changed since the last save. `keepOrigin` filters the
   * per-origin storage (localStorage, IndexedDB) that gets written.
   */
  save(context: BrowserContext, keepOrigin: (origin: string) => boolean = () => true): Promise<void> {
    this.writing = this.writing.then(async () => {
      let state: StorageState;
      try {
        state = await context.storageState({ indexedDB: true });
      } catch {
        return; // the browser is already gone
      }
      state = { ...state, origins: state.origins.filter((o) => keepOrigin(o.origin)) };
      const text = JSON.stringify(state);
      if (text === this.lastSaved) return;
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${process.pid}.tmp`;
      await Bun.write(tmp, text);
      await chmod(tmp, 0o600);
      await rename(tmp, this.path);
      this.lastSaved = text;
    }).catch(() => {});
    return this.writing;
  }

  /**
   * Removes one site from the saved state (for an engine that isn't running): its origin's
   * storage, and the cookies that would be sent to it (its host's and its parent domains').
   * Returns whether anything was removed.
   */
  async forgetSite(origin: string): Promise<boolean> {
    await this.writing;
    const state = await this.load();
    if (!state) return false;
    const host = new URL(origin).hostname;
    const next = { ...state, cookies: state.cookies.filter((c) => !cookieForHost(c.domain, host)), origins: state.origins.filter((o) => o.origin !== origin) };
    if (next.cookies.length === state.cookies.length && next.origins.length === state.origins.length) return false;
    const text = JSON.stringify(next);
    const tmp = `${this.path}.${process.pid}.tmp`;
    await Bun.write(tmp, text);
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
    this.lastSaved = text;
    return true;
  }

  async remove(): Promise<void> {
    await this.writing;
    this.lastSaved = '';
    await rm(this.path, { force: true });
  }
}

/** TriPane's own settings (themes, layout, sync toggles), saved next to the engines' data. */
export async function loadSettings(dir: string | null): Promise<Settings> {
  if (!dir) return { ...DEFAULT_SETTINGS };
  try {
    const saved = sanitizeSettings(await Bun.file(join(dir, 'settings.json')).json());
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      engineDevice: { ...DEFAULT_SETTINGS.engineDevice, ...saved.engineDevice },
      devtoolsDock: { ...DEFAULT_SETTINGS.devtoolsDock, ...saved.devtoolsDock },
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveSettings(dir: string | null, settings: Settings): Promise<void> {
  if (!dir) return;
  const path = join(dir, 'settings.json');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  await Bun.write(tmp, JSON.stringify(settings, null, 2));
  await rename(tmp, path);
}
