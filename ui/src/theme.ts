import { useEffect } from 'preact/hooks';
import type { Settings } from '../../shared/protocol';

/**
 * Applies the interface theme to this document. Inside TriPane's window the server also sets
 * the window's prefers-color-scheme (which DevTools follows); data-theme makes TriPane's own UI
 * match even when it's opened in another browser.
 */
export function useUiTheme(theme: Settings['uiTheme'] | undefined): void {
  useEffect(() => {
    const root = document.documentElement;
    if (!theme || theme === 'system') delete root.dataset.theme;
    else root.dataset.theme = theme;
  }, [theme]);
}
