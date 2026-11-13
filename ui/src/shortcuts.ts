// TriPane's window is a Chromium app window, so Chromium's own shortcuts work in it: Ctrl+R
// reloads the UI, Ctrl+Shift+I opens DevTools on TriPane itself, Ctrl+U shows its source, Alt+Left
// navigates it away. None of that makes sense for an app. This cancels the browser's default
// action for those keys (and its context menu, which has Back, Reload and Inspect) while leaving
// the events themselves alone, so TriPane's own handlers (F12 → TriPane's DevTools, Ctrl+H →
// History) and the panes (which pass keys to the engines) still see them.
//
// Not covered: the shortcuts Chromium reserves and never lets a page cancel (Ctrl+N, Ctrl+T,
// Ctrl+W, Ctrl+Tab, Ctrl+Q). Zoom (Ctrl +/−/0) stays on: it scales TriPane's UI.

const mac = /Mac|iPhone|iPad/.test(navigator.platform);

/** Whether the event is a browser shortcut TriPane cancels. `inEditable`: focus is in a text field. */
export function isBrowserShortcut(e: KeyboardEvent, inEditable: boolean): boolean {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const mod = mac ? e.metaKey : e.ctrlKey; // the platform's command key
  if (key === 'F5' || key === 'F12' || key === 'F3' || key === 'F7' || key === 'BrowserBack' || key === 'BrowserForward' || key === 'BrowserRefresh') return true;
  if (key === 'F6' || key === 'F10') return true; // focus the (absent) toolbar / app menu
  // Back, forward, home page. (On macOS Option+arrow moves by word; back is Cmd+[ there.)
  if (!mac && e.altKey && !e.ctrlKey && (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home')) return true;
  if (!mod) return false;
  if (mac && !e.shiftKey && (key === '[' || key === ']')) return true; // back, forward
  if (mac && !inEditable && (key === 'ArrowLeft' || key === 'ArrowRight')) return true;
  if (e.shiftKey) {
    // reload without cache, DevTools (elements, console, inspect), bookmarks, clear data, task manager
    return ['r', 'i', 'j', 'c', 'b', 'o', 'd', 'Delete', 'Backspace', 'Escape'].includes(key);
  }
  if (mac && e.altKey) return ['i', 'j', 'c', 'u', 'b'].includes(key); // Cmd+Opt DevTools, source, bookmarks
  // reload, view source, save, print, open file, find, bookmark, downloads, history (Chrome's)
  return ['r', 'u', 's', 'p', 'o', 'f', 'g', 'd', 'j', 'e', 'k'].includes(key);
}

function editable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== 'function') return false;
  if (el.isContentEditable) return true;
  if (el instanceof el.ownerDocument.defaultView!.HTMLTextAreaElement) return true;
  if (el instanceof el.ownerDocument.defaultView!.HTMLInputElement) return !['button', 'checkbox', 'radio', 'range', 'color', 'submit', 'reset', 'file'].includes(el.type);
  return false;
}

const guarded = new WeakSet<Window>();

/**
 * Cancels browser shortcuts, the native context menu (except in text fields) and mouse
 * back/forward in `win`.
 *
 * `afterPage`: listen after the page's own handlers instead of before. For the Chrome DevTools
 * iframe, whose shortcuts (Ctrl+F search, Ctrl+R reload the inspected page, Ctrl+Shift+C pick an
 * element, its own context menus) should keep working; only what it leaves alone is cancelled.
 */
export function guardBrowserShortcuts(win: Window, { afterPage = false } = {}): void {
  if (guarded.has(win)) return;
  guarded.add(win);
  const capture = !afterPage;
  win.addEventListener(
    'keydown',
    (e) => {
      if (isBrowserShortcut(e, editable(e.target))) e.preventDefault();
    },
    capture,
  );
  // Text fields keep the native menu for cut, copy and paste.
  win.addEventListener(
    'contextmenu',
    (e) => {
      if (!editable(e.target)) e.preventDefault();
    },
    capture,
  );
  // The mouse's back and forward buttons would navigate the window.
  const noHistoryButtons = (e: MouseEvent) => {
    if (e.button === 3 || e.button === 4) e.preventDefault();
  };
  win.addEventListener('mouseup', noHistoryButtons, capture);
  win.addEventListener('auxclick', noHistoryButtons, capture);
}
