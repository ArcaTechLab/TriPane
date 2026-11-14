// Backspace must never navigate back. Playwright's WebKit still has "Backspace (Shift+Backspace)
// goes back (forward)" on Windows and macOS (Safari switches it off; Chrome and Firefox dropped
// it). It fires when the key reaches a page whose focus isn't in a text field, which happens when
// a synced click lands differently in one engine; Follow links then took all three panes back.
//
// Neither WebKit nor Playwright has a setting for it. So TriPane, which replays every key from the
// server anyway, checks where the focus is before it sends a Backspace to such an engine: in a
// text field it goes through as usual; anywhere else it isn't sent. Nothing is injected into the
// page; the check is a read-only evaluate (CLAUDE.md, option 3).
//
// The cost: in that engine a page's own Backspace shortcut on a non-editable element (a game, a
// custom widget) doesn't get the key. Text fields, contenteditable and every other key are
// unaffected.
import type { ElementHandle, Frame, Page } from 'playwright';
import type { EngineName } from '../shared/protocol';
import { quietly } from './quiet';

/** Engines whose Backspace navigates on this platform. Tests switch the others on to check the logic everywhere. */
export const BACKSPACE_NAVIGATES: Record<EngineName, boolean> = {
  chromium: false,
  // Firefox's own preference is set at launch as well (browser.backspace_action = 2, "do nothing").
  firefox: false,
  webkit: process.platform === 'darwin' || process.platform === 'win32',
};

/** Firefox's preference for it: 0 back, 1 scroll up, 2 nothing (the default today; set to be sure). */
export const FIREFOX_BACKSPACE_PREFS = { 'browser.backspace_action': 2 };

/** Keys held with Backspace that make it something else (a page or OS shortcut, never Back). */
const MODIFIERS = new Set(['Control', 'Meta', 'Alt']);

/** Read-only: the focused element of a document, through open shadow roots; an <iframe> if focus is inside one. */
function deepActiveElement(): Element | null {
  let el = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/** Read-only: whether an element takes text input (Backspace edits it). */
function isEditable(el: Element | null): boolean {
  if (!el) return false;
  if ((el as HTMLElement).isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'range', 'reset', 'submit'].includes(el.type);
  return false;
}

/** Whether the focus is in a text field, following it into iframes (cross-origin ones too, through Playwright). */
async function focusIsEditable(frame: Frame, depth = 0): Promise<boolean> {
  const handle = await frame.evaluateHandle(deepActiveElement);
  try {
    const el = handle.asElement() as ElementHandle<Element> | null;
    if (!el) return false;
    const child = depth < 8 ? await el.contentFrame() : null;
    if (child) return focusIsEditable(child, depth + 1);
    return el.evaluate(isEditable);
  } finally {
    void handle.dispose().catch(() => {});
  }
}

/**
 * Decides, for one engine, which Backspace key events to hold back. Keeps track of held
 * modifiers, and drops the key-up that goes with a dropped key-down.
 */
export class BackspaceGuard {
  private readonly held = new Set<string>();
  private droppedDown = false;

  constructor(private readonly engine: EngineName) {}

  /** True if this key event shouldn't be sent to the page. Call it in input order. */
  async drop(page: Page, ev: { action: 'down' | 'up'; key: string }): Promise<boolean> {
    if (ev.key !== 'Backspace') {
      if (ev.action === 'down') this.held.add(ev.key);
      else this.held.delete(ev.key);
      return false;
    }
    if (ev.action === 'up') {
      const drop = this.droppedDown;
      this.droppedDown = false;
      return drop;
    }
    if (!BACKSPACE_NAVIGATES[this.engine] || [...this.held].some((k) => MODIFIERS.has(k))) return false;
    // If the focus can't be read (the page is navigating), the key goes through as usual.
    const editable = await quietly(page, () => focusIsEditable(page.mainFrame())).catch(() => true);
    this.droppedDown = !editable;
    return this.droppedDown;
  }

  /** A new page: nothing is held any more. */
  reset(): void {
    this.held.clear();
    this.droppedDown = false;
  }
}
