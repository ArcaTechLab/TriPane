import type { LucideIcon } from 'lucide-preact';
import { ArrowUp, Check as CheckIcon, Columns3, Copy, Database, Download, Layers, LoaderCircle, Moon, Palette, RefreshCw, Rows3, Sun, Trash2, X } from 'lucide-preact';
import { Fragment, type ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ENGINES, UI_THEMES, type FrameFormat, type PaneInfo, type Settings, type UiTheme, type UpdateStatus } from '../../shared/protocol';
import { btn, Check, cx, EngineDot, ICON } from './ui';

const ENGINE_NAMES = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' } as const;

export type Layout = Settings['layout'];

interface Props {
  open: boolean;
  layout: Layout;
  uiTheme: Settings['uiTheme'];
  onUiTheme(theme: Settings['uiTheme']): void;
  colorScheme: Settings['colorScheme'];
  onLayout(layout: Layout): void;
  onColorScheme(scheme: Settings['colorScheme']): void;
  /** Where cookies and storage are saved between runs; null for a fresh session. */
  storageDir: string | null;
  onClearStorage(): void;
  updates: UpdateStatus | null;
  checkingUpdates: boolean;
  onCheckUpdates(): void;
  autoUpdateCheck: boolean;
  onAutoUpdateCheck(on: boolean): void;
  /** Settings → Engines: which engines run. */
  panes: PaneInfo[];
  engines: Settings['engines'];
  onEngines(engines: Settings['engines']): void;
  /** Settings → Frame format: how each engine's picture is encoded. */
  frameFormat: Settings['frameFormat'];
  onFrameFormat(frameFormat: Settings['frameFormat']): void;
  onClose(): void;
}

interface Choice<T extends string> {
  value: T;
  label: string;
  icon: LucideIcon;
}

const LAYOUTS: Choice<Layout>[] = [
  { value: 'columns', label: 'Columns', icon: Columns3 },
  { value: 'rows', label: 'Rows', icon: Rows3 },
];
const SCHEMES: Choice<Settings['colorScheme']>[] = [
  { value: 'light', label: 'Light', icon: Sun },
  { value: 'dark', label: 'Dark', icon: Moon },
];

/** One setting: a title and explanation on the left, its control on the right. */
function Row(props: { title: string; titleId?: string; children: ComponentChildren; control: ComponentChildren }) {
  return (
    <section class="flex flex-wrap items-center justify-between gap-x-8 gap-y-3 border-b border-line px-5 py-4">
      <div class="min-w-0 max-w-[60ch] flex-[1_1_280px]">
        <h3 id={props.titleId} class="mb-0.5 text-[13.5px] font-bold">
          {props.title}
        </h3>
        <div class="text-muted">{props.children}</div>
      </div>
      {props.control}
    </section>
  );
}

type SectionId = 'appearance' | 'engines' | 'data' | 'updates';
const SECTIONS: { id: SectionId; label: string; icon: LucideIcon }[] = [
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'engines', label: 'Engines', icon: Layers },
  { id: 'data', label: 'Saved data', icon: Database },
  { id: 'updates', label: 'Updates', icon: Download },
];

/**
 * The settings page: a modal over the app (Esc or the close button to close). Categories on the
 * left, the chosen one on the right; on narrow windows the categories become tabs along the top.
 */
export function SettingsDialog(props: Props) {
  const { open, layout, uiTheme, onUiTheme, colorScheme, onLayout, onColorScheme, storageDir, onClearStorage, onClose } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const [confirming, setConfirming] = useState(false);
  const [section, setSection] = useState<SectionId>('appearance');
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  useEffect(() => {
    if (!open) setConfirming(false);
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  // Arrow keys move between categories (both orientations), Home and End to the ends.
  const onTabKey = (e: KeyboardEvent) => {
    const i = SECTIONS.findIndex((s) => s.id === section);
    const next =
      e.key === 'ArrowDown' || e.key === 'ArrowRight'
        ? (i + 1) % SECTIONS.length
        : e.key === 'ArrowUp' || e.key === 'ArrowLeft'
          ? (i + SECTIONS.length - 1) % SECTIONS.length
          : e.key === 'Home'
            ? 0
            : e.key === 'End'
              ? SECTIONS.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    setSection(SECTIONS[next].id);
    tabs.current[next]?.focus();
  };

  return (
    <dialog
      ref={ref}
      class={cx(
        'm-auto h-[min(680px,calc(100vh-32px))] w-[min(960px,calc(100vw-32px))] overflow-hidden rounded-xl border border-line bg-chrome p-0 text-fg shadow-[0_24px_64px_var(--shadow)] backdrop:bg-black/60',
        '[&[open]]:flex [&[open]]:flex-col min-[720px]:[&[open]]:flex-row',
      )}
      aria-labelledby="settings-title"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose(); // click on the backdrop
      }}
    >
      <nav class="flex flex-none flex-col border-b border-line bg-bg/40 min-[720px]:w-52 min-[720px]:border-b-0 min-[720px]:border-r">
        <div class="flex items-center justify-between px-4 pb-2 pt-3.5 min-[720px]:pb-3">
          <h2 id="settings-title" class="text-base font-bold">
            Settings
          </h2>
          {/* On narrow windows the close button sits here, next to the title. */}
          <button type="button" class={cx(btn('ghost', { icon: true }), 'min-[720px]:hidden')} onClick={onClose} aria-label="Close settings">
            <X size={ICON} />
          </button>
        </div>
        <div
          role="tablist"
          aria-label="Settings categories"
          aria-orientation="vertical"
          class="flex gap-1 overflow-x-auto px-2 pb-2 min-[720px]:flex-col min-[720px]:overflow-visible"
          onKeyDown={onTabKey}
        >
          {SECTIONS.map(({ id, label, icon: Icon }, i) => {
            const on = section === id;
            return (
              <button
                key={id}
                ref={(el) => {
                  tabs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`settings-tab-${id}`}
                aria-selected={on}
                aria-controls={`settings-panel-${id}`}
                tabIndex={on ? 0 : -1}
                class={cx(
                  'inline-flex h-8 flex-none items-center gap-2 whitespace-nowrap rounded-md px-2.5 text-left focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent',
                  on ? 'bg-accent/15 font-medium text-fg' : 'text-muted hover:bg-line/50 hover:text-fg',
                )}
                onClick={() => setSection(id)}
              >
                <Icon size={15} class={on ? 'text-accent' : undefined} />
                <span class="trim-cap">{label}</span>
              </button>
            );
          })}
        </div>
        <p class="mt-auto hidden px-4 py-3 text-xs text-muted min-[720px]:block">Ctrl+, opens · Esc closes</p>
      </nav>

      <div class="flex min-h-0 min-w-0 flex-1 flex-col">
        <header class="hidden flex-none items-center justify-between border-b border-line px-5 pb-2.5 pt-3.5 min-[720px]:flex">
          <h2 class="text-[15px] font-bold">{SECTIONS.find((s) => s.id === section)!.label}</h2>
          <button type="button" class={btn('ghost', { icon: true })} onClick={onClose} aria-label="Close settings">
            <X size={ICON} />
          </button>
        </header>
        <div id={`settings-panel-${section}`} role="tabpanel" aria-labelledby={`settings-tab-${section}`} class="min-h-0 flex-1 overflow-auto">
          {section === 'appearance' && (
            <>
              <section class="flex flex-col gap-2.5 border-b border-line px-5 py-4">
                <div>
                  <h3 id="settings-ui-theme" class="mb-0.5 text-[13.5px] font-bold">
                    Interface theme
                  </h3>
                  <p class="text-muted">
                    TriPane's colors. Chrome DevTools follows the theme's light or dark base. System switches between TriPane
                    Light and Dark with your operating system.
                  </p>
                </div>
                <ThemePicker value={uiTheme} onChange={onUiTheme} />
              </section>
              <Row
                title="Page theme"
                titleId="settings-theme"
                control={<Segmented labelledBy="settings-theme" choices={SCHEMES} value={colorScheme} onChange={onColorScheme} />}
              >
                Sets <code>prefers-color-scheme</code> in Chromium, Firefox and WebKit. Pages with a dark mode switch to it.
              </Row>
              <Row title="Layout" titleId="settings-layout" control={<Segmented labelledBy="settings-layout" choices={LAYOUTS} value={layout} onChange={onLayout} />}>
                How the engine panes are arranged.
              </Row>
            </>
          )}

          {section === 'engines' && (
            <>
              <Row title="Engines" titleId="settings-engines" control={<EngineSwitches {...props} />}>
                Which engines run. One that's off isn't started at all (its saved logins are kept), and its pane and
                DevTools tab are hidden. At least one stays on.
              </Row>
              <Row title="Frame format" titleId="settings-frames" control={<FrameFormats {...props} />}>
                How each engine's picture is sent to this window. JPEG is smaller and faster; PNG is lossless, so text and
                fine lines are pixel-exact. Each engine starts on the format that works best there. The capture badge in each
                pane shows the result.
              </Row>
            </>
          )}

          {section === 'data' && (
            <Row
              title="Saved logins"
              control={
                <button
                  type="button"
                  class={btn(confirming ? 'danger' : 'outline')}
                  onClick={() => {
                    if (!confirming) {
                      setConfirming(true);
                      return;
                    }
                    setConfirming(false);
                    onClearStorage();
                    onClose();
                  }}
                  onBlur={() => setConfirming(false)}
                >
                  <Trash2 size={14} />
                  <span class="trim-cap">{confirming ? 'Click again to clear' : storageDir ? 'Clear saved data' : 'Clear cookies and storage'}</span>
                </button>
              }
            >
              {storageDir ? (
                <>
                  Each engine’s cookies, localStorage and IndexedDB are saved in <code>{storageDir}</code> and restored the next
                  time TriPane starts. Engines don’t share storage: log in to each one. This clears every site; to clear one
                  site, use the site information button at the left of the address bar.
                </>
              ) : (
                <>This is a fresh session (<code>--no-persist</code>): nothing is saved when TriPane closes.</>
              )}
            </Row>
          )}

          {section === 'updates' && <EngineUpdates {...props} />}
        </div>
      </div>
    </dialog>
  );
}

/** On/off pills for Chromium, Firefox and WebKit; the last one that's on can't be turned off. */
function EngineSwitches({ panes, engines, onEngines }: Props) {
  const onCount = ENGINES.filter((e) => engines[e]).length;
  return (
    <div class="inline-flex flex-wrap gap-1.5" role="group" aria-labelledby="settings-engines">
      {ENGINES.map((engine) => {
        const on = engines[engine];
        const last = on && onCount === 1;
        const version = panes.find((p) => p.engine === engine)?.version;
        return (
          <button
            key={engine}
            type="button"
            role="switch"
            aria-checked={on}
            disabled={last}
            title={last ? 'At least one engine stays on' : `${on ? 'Turn off' : 'Turn on'} ${ENGINE_NAMES[engine]}`}
            class={cx(
              'inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 disabled:cursor-not-allowed',
              'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
              on ? 'border-accent bg-accent/15 text-fg' : 'border-line text-muted hover:text-fg',
            )}
            onClick={() => onEngines({ ...engines, [engine]: !on })}
          >
            <EngineDot engine={engine} off={!on} />
            <span class="trim-cap">{ENGINE_NAMES[engine]}</span>
            {on && version && <span class="trim-cap text-[11px] text-muted">{version.split('.')[0]}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** One row per engine: Auto (and what it picks), JPEG or PNG. */
function FrameFormats({ frameFormat, onFrameFormat, engines }: Props) {
  return (
    <div class="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2" role="group" aria-labelledby="settings-frames">
      {ENGINES.map((engine) => {
        const choices: { value: FrameFormat; label: string }[] = [
          { value: 'jpeg', label: 'JPEG' },
          { value: 'png', label: 'PNG' },
        ];
        return (
          <Fragment key={engine}>
            <span id={`frames-${engine}`} class={cx('inline-flex items-center gap-1.5', !engines[engine] && 'text-muted')}>
              <EngineDot engine={engine} off={!engines[engine]} />
              <span class="trim-cap">{ENGINE_NAMES[engine]}</span>
              {!engines[engine] && <span class="trim-cap text-[11px]">(off)</span>}
            </span>
            <div
              class="inline-flex w-fit rounded-lg border border-line bg-bg p-0.5"
              role="radiogroup"
              aria-labelledby={`frames-${engine}`}
            >
              {choices.map((c) => {
                const on = frameFormat[engine] === c.value;
                return (
                  <button
                    key={c.value}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    class={cx(
                      'inline-flex h-6 items-center rounded-md px-2.5 text-xs focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                      on ? 'bg-accent text-on-accent' : 'text-muted hover:text-fg',
                    )}
                    onClick={() => onFrameFormat({ ...frameFormat, [engine]: c.value })}
                  >
                    <span class="trim-cap">{c.label}</span>
                  </button>
                );
              })}
            </div>
          </Fragment>
        );
      })}
    </div>
  );
}

/** Interface themes as cards, each showing a small preview in its own colors. */
function ThemePicker(props: { value: UiTheme; onChange(theme: UiTheme): void }) {
  return (
    <div role="radiogroup" aria-labelledby="settings-ui-theme" class="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {UI_THEMES.map((t) => {
        const on = props.value === t.id;
        return (
          <button
            key={t.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => props.onChange(t.id)}
            class={cx(
              'flex flex-col gap-1.5 rounded-lg border p-1.5 text-left focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
              on ? 'border-accent ring-1 ring-accent' : 'border-line hover:border-muted',
            )}
          >
            {t.id === 'system' ? (
              <div class="flex overflow-hidden rounded-md border border-line">
                <ThemePreview theme="light" half />
                <ThemePreview theme="dark" half />
              </div>
            ) : (
              <ThemePreview theme={t.id} />
            )}
            <span class={cx('px-0.5 text-xs leading-tight', on ? 'font-semibold text-fg' : 'text-muted')}>{t.label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** A miniature TriPane in one theme: toolbar with the engine colors and accent, then some text. */
function ThemePreview(props: { theme: UiTheme; half?: boolean }) {
  return (
    <div
      data-theme={props.theme}
      aria-hidden="true"
      class={cx('flex h-12 min-w-0 flex-col bg-bg', props.half ? 'flex-1' : 'overflow-hidden rounded-md border border-line')}
    >
      <div class="flex h-3.5 flex-none items-center gap-[3px] border-b border-line bg-chrome px-1.5">
        <span class="size-1.5 rounded-full bg-chromium" />
        <span class="size-1.5 rounded-full bg-firefox" />
        <span class="size-1.5 rounded-full bg-webkit" />
        <span class="ml-auto h-1.5 w-4 rounded-full bg-accent" />
      </div>
      <div class="flex flex-1 flex-col justify-center gap-1 px-1.5">
        <span class="h-1 w-3/4 rounded-full bg-fg/75" />
        <span class="h-1 w-1/2 rounded-full bg-muted/70" />
      </div>
    </div>
  );
}

function Segmented<T extends string>(props: { labelledBy: string; choices: Choice<T>[]; value: T; onChange(v: T): void }) {
  return (
    <div class="inline-flex rounded-lg border border-line bg-bg p-0.5" role="radiogroup" aria-labelledby={props.labelledBy}>
      {props.choices.map(({ value, label, icon: Icon }) => {
        const on = props.value === value;
        return (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={on}
            class={cx(
              'inline-flex h-7 items-center gap-1.5 rounded-md px-3 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
              on ? 'bg-accent text-on-accent' : 'text-muted hover:text-fg',
            )}
            onClick={() => props.onChange(value)}
          >
            <Icon size={14} /> <span class="trim-cap">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Engine updates: what's installed, what the latest Playwright ships, and how to update. */
function EngineUpdates({ updates, checkingUpdates, onCheckUpdates, autoUpdateCheck, onAutoUpdateCheck }: Props) {
  const [copied, setCopied] = useState(false);
  const available = updates?.engines.filter((e) => e.update) ?? [];
  const status = checkingUpdates
    ? 'Checking…'
    : !updates
      ? 'Not checked yet.'
      : updates.error
        ? updates.error
        : available.length
          ? `Updates available with Playwright ${updates.playwright.latest}.`
          : updates.command || updates.standalone
            ? `Playwright ${updates.playwright.latest} is available; it doesn’t change the engines.`
            : 'All engines are up to date.';
  const cell = 'border-b border-hairline px-2 py-1 text-left';

  return (
    <section class="flex flex-col gap-2.5 px-5 py-4">
      <div class="flex flex-wrap items-center justify-between gap-4">
        <div class="min-w-0 max-w-[60ch] flex-[1_1_280px]">
          <h3 class="mb-0.5 text-[13.5px] font-bold">Engine updates</h3>
          <p class="text-muted">
            Playwright ships a matching build of each engine, so the engines update together with Playwright (installed:{' '}
            {updates?.playwright.installed ?? '…'}).
          </p>
        </div>
        <button type="button" class={btn('outline')} onClick={onCheckUpdates} disabled={checkingUpdates}>
          {checkingUpdates ? <LoaderCircle size={14} class="animate-spin" /> : <RefreshCw size={14} />}
          <span class="trim-cap">{checkingUpdates ? 'Checking…' : 'Check now'}</span>
        </button>
      </div>

      {updates && (
        <table class="w-full max-w-xl border-collapse text-[12.5px]">
          <thead>
            <tr class="text-muted">
              <th scope="col" class={cx(cell, 'font-medium')}>Engine</th>
              <th scope="col" class={cx(cell, 'font-medium')}>Installed</th>
              <th scope="col" class={cx(cell, 'font-medium')}>Latest</th>
            </tr>
          </thead>
          <tbody>
            {updates.engines.map((e) => (
              <tr key={e.engine}>
                <th scope="row" class={cx(cell, 'whitespace-nowrap font-medium')}>
                  <span class="inline-flex items-center gap-1.5">
                    <EngineDot engine={e.engine} /> <span class="trim-cap">{ENGINE_NAMES[e.engine]}</span>
                  </span>
                </th>
                <td class={cell}>{e.installed}</td>
                <td class={cx(cell, e.update && 'font-semibold text-accent')}>
                  {e.latest ? (
                    e.update ? (
                      <span class="inline-flex items-center gap-1">
                        <ArrowUp size={12} strokeWidth={2.5} /> <span class="trim-cap">{e.latest}</span>
                      </span>
                    ) : (
                      e.latest
                    )
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <p class={cx(updates?.error ? 'text-danger' : available.length ? 'text-accent' : '')} role="status">
        {status}
        {updates && !checkingUpdates && <span class="text-muted"> · checked {new Date(updates.checkedAt).toLocaleString()}</span>}
      </p>

      {updates?.standalone && available.length > 0 && (
        <p class="text-muted">
          This is a standalone TriPane build: download a newer TriPane release to get these engines. Your saved logins and
          settings carry over.
        </p>
      )}

      {updates?.command && (
        <div>
          <p class="mb-1 text-muted">In the TriPane folder, run this, then restart TriPane:</p>
          <div class="flex items-center gap-2 rounded-md border border-line bg-bg px-2 py-1.5">
            <code class="min-w-0 flex-1 wrap-anywhere">{updates.command}</code>
            <button
              type="button"
              class={btn('ghost')}
              onClick={() => {
                void navigator.clipboard?.writeText(updates.command!).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <CheckIcon size={14} /> : <Copy size={14} />}
              <span class="trim-cap">{copied ? 'Copied' : 'Copy'}</span>
            </button>
          </div>
        </div>
      )}

      <Check checked={autoUpdateCheck} onChange={onAutoUpdateCheck}>
        Check automatically (at start and daily; asks registry.npmjs.org and cdn.jsdelivr.net)
      </Check>
    </section>
  );
}
