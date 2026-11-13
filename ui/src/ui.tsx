// Shared Tailwind recipes and tiny components used across the UI.
import type { ComponentChildren } from 'preact';
import type { EngineName } from '../../shared/protocol';

/** Joins class names, skipping falsy ones. */
export const cx = (...classes: (string | false | null | undefined)[]): string => classes.filter(Boolean).join(' ');

export const ENGINE_CLASS: Record<EngineName, string> = {
  chromium: 'engine-chromium',
  firefox: 'engine-firefox',
  webkit: 'engine-webkit',
};

/** Lucide icon size used in toolbars and buttons. */
export const ICON = 15;

type ButtonKind = 'ghost' | 'outline' | 'primary' | 'danger';

/** Button classes: ghost (border on hover), outline, primary or danger; icon buttons are square. */
export function btn(kind: ButtonKind = 'ghost', opts: { icon?: boolean; pressed?: boolean; small?: boolean } = {}): string {
  return cx(
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-md border',
    'disabled:cursor-progress disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-accent',
    opts.small ? 'h-6 text-xs' : 'h-7',
    opts.icon ? (opts.small ? 'w-6' : 'w-7') : 'px-2',
    opts.pressed
      ? 'border-accent bg-chrome-2'
      : kind === 'primary'
        ? 'border-transparent bg-accent text-on-accent hover:bg-accent/85'
        : kind === 'danger'
          ? 'border-transparent bg-danger text-white'
          : kind === 'outline'
            ? 'border-line hover:bg-chrome-2'
            : 'border-transparent hover:border-line hover:bg-chrome-2',
  );
}

/** Inputs and selects in bars. */
export const field = 'h-7 rounded-md border border-line bg-chrome-2 px-1.5 outline-none focus:border-accent';

/**
 * A tool bar inside a DevTools tab (All consoles, Compare). When the dock is too narrow for one
 * line, it wraps onto more lines between groups (panelGroup), never inside one, so related
 * controls stay together. No horizontal scrolling.
 */
export const panelBar = 'flex flex-none flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line bg-chrome px-2 py-[5px]';
/** One group of controls in a panelBar: kept on one line, wrapped as a whole. */
export const panelGroup = 'inline-flex flex-none items-center gap-2 whitespace-nowrap';

/** A small search/filter box (it gives up width first in a narrow bar). */
export const filterField = 'h-6 w-44 rounded-[5px] border border-line bg-chrome-2 px-2 text-xs outline-none focus:border-accent';

/** The engine's color dot; the engine comes from the element's (or an ancestor's) engine-* class. */
export function EngineDot({ engine, off, class: extra }: { engine?: EngineName; off?: boolean; class?: string }) {
  return (
    <span
      aria-hidden
      class={cx('inline-block size-2 flex-none rounded-full', off ? 'bg-line' : 'bg-engine', engine && ENGINE_CLASS[engine], extra)}
    />
  );
}

/** An on/off switch with its label. */
export function Toggle(props: { label: string; checked: boolean; title: string; onChange(v: boolean): void }) {
  return (
    <label
      class="inline-flex cursor-pointer select-none items-center gap-1.5 text-muted has-checked:text-fg"
      title={props.title}
    >
      <input
        type="checkbox"
        class="peer sr-only"
        checked={props.checked}
        onChange={(e) => props.onChange(e.currentTarget.checked)}
      />
      <span
        aria-hidden
        class={cx(
          'relative h-[15px] w-[26px] rounded-full bg-line transition-colors peer-checked:bg-accent',
          'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-accent',
          'after:absolute after:left-0.5 after:top-0.5 after:size-[11px] after:rounded-full after:bg-white after:shadow',
          'after:transition-transform peer-checked:after:translate-x-[11px]',
        )}
      />
      <span class="trim-cap">{props.label}</span>
    </label>
  );
}

/** A checkbox with its label, as used in the log, compare and settings bars. */
export function Check(props: { checked: boolean; onChange(v: boolean): void; title?: string; children: ComponentChildren }) {
  return (
    <label class="inline-flex cursor-pointer items-center gap-1 text-xs text-muted" title={props.title}>
      <input type="checkbox" class="relative -top-px accent-accent" checked={props.checked} onChange={(e) => props.onChange(e.currentTarget.checked)} />
      <span class="trim-cap">{props.children}</span>
    </label>
  );
}
