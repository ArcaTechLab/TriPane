// Interface themes: every theme in the list has a complete palette in styles.css, and settings
// accept exactly the listed themes.
import { expect, test } from 'bun:test';
import { sanitizeSettings, themeScheme, UI_THEMES } from '../shared/protocol';

const css = await Bun.file(`${import.meta.dir}/../ui/src/styles.css`).text();
const VARS = ['bg', 'chrome', 'chrome-2', 'line', 'fg', 'muted', 'accent', 'on-accent', 'danger', 'warn', 'chromium', 'firefox', 'webkit', 'error-text', 'warn-text', 'grid-dot', 'hairline', 'shadow'];

/** The declarations of the rule whose selector list includes `[data-theme='<id>']`. */
function block(id: string): string {
  const m = css.match(new RegExp(`\\[data-theme='${id}'\\][^{]*\\{([^}]*)\\}`));
  return m?.[1] ?? '';
}

test('every theme defines the whole palette and its light/dark base', () => {
  for (const t of UI_THEMES) {
    if (t.id === 'system') continue;
    const body = block(t.id);
    for (const v of VARS) expect(body, `${t.id} --${v}`).toMatch(new RegExp(`--${v}:\\s*#[0-9a-f]+;`));
    expect(body, t.id).toContain(`color-scheme: ${t.scheme};`);
  }
});

test('settings accept the listed themes only', () => {
  for (const t of UI_THEMES) expect(sanitizeSettings({ uiTheme: t.id }).uiTheme).toBe(t.id);
  expect(sanitizeSettings({ uiTheme: 'solarized' }).uiTheme).toBeUndefined();
  expect(themeScheme('dracula')).toBe('dark');
  expect(themeScheme('github-light')).toBe('light');
  expect(themeScheme('system')).toBeNull();
});
