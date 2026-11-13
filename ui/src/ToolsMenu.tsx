// The Tools menu (wrench, next to Settings): Compare element, Screenshot all, Record trace,
// Compare engines and History.
import type { LucideIcon } from 'lucide-preact';
import { Camera, ChevronDown, CircleDot, CircleStop, Crosshair, Diff, History, LoaderCircle, Wrench } from 'lucide-preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { TracingState } from '../../shared/protocol';
import { btn, cx, ICON } from './ui';

interface Props {
  /** Picking an element for Compare is in progress. */
  picking: boolean;
  onCompare(): void;
  /** Screenshot all is capturing. */
  shooting: boolean;
  onScreenshot(): void;
  /** A trace being recorded (or saved), or null. */
  tracing: TracingState | null;
  /** Starts recording a trace, or stops and saves the one being recorded. */
  onTrace(): void;
  onHistory(): void;
  onEngineDiff(): void;
}

interface Item {
  icon: LucideIcon;
  label: string;
  hint: string;
  disabled?: boolean;
  busy?: boolean;
  /** Icon colour, e.g. the record dot. */
  tone?: string;
  run(): void;
}

export function ToolsMenu({ picking, onCompare, shooting, onScreenshot, tracing, onTrace, onHistory, onEngineDiff }: Props) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const items: Item[] = [
    {
      icon: Crosshair,
      label: picking ? 'Cancel compare' : 'Compare element',
      hint: picking ? 'Esc' : 'Pick in any pane',
      run: onCompare,
    },
    {
      icon: shooting ? LoaderCircle : Camera,
      label: shooting ? 'Capturing…' : 'Screenshot all',
      hint: 'Full page, 3 engines',
      disabled: shooting,
      busy: shooting,
      run: onScreenshot,
    },
    {
      icon: tracing?.saving ? LoaderCircle : tracing ? CircleStop : CircleDot,
      label: tracing?.saving ? 'Saving trace…' : tracing ? 'Stop trace' : 'Record trace',
      hint: tracing ? 'Save, open in Trace Viewer' : 'Playwright, 3 engines',
      disabled: !!tracing?.saving,
      busy: !!tracing?.saving,
      tone: tracing?.saving ? undefined : 'text-danger',
      run: onTrace,
    },
    {
      icon: Diff,
      label: 'Compare engines',
      hint: 'Pixels, accessibility tree',
      run: onEngineDiff,
    },
    {
      icon: History,
      label: 'History',
      hint: /Mac/.test(navigator.platform) ? '⌘Y' : 'Ctrl+H',
      run: onHistory,
    },
  ];

  // Close on a click outside or when focus leaves the menu; Escape closes and returns focus.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);

  // Focus the first enabled item as soon as the menu opens (before paint, so a quick second
  // arrow key already lands in the menu).
  const firstItem = () => itemRefs.current.find((b) => b && !b.disabled);
  useLayoutEffect(() => {
    if (open) firstItem()?.focus();
  }, [open]);

  const onMenuKey = (e: KeyboardEvent) => {
    const enabled = itemRefs.current.filter((b): b is HTMLButtonElement => !!b && !b.disabled);
    const i = enabled.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = (i + (e.key === 'ArrowDown' ? 1 : -1) + enabled.length) % enabled.length;
      enabled[next]?.focus();
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      enabled[e.key === 'Home' ? 0 : enabled.length - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // don't also cancel an element pick
      setOpen(false);
      button.current?.focus();
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div class="relative" ref={root}>
      <button
        ref={button}
        type="button"
        class={btn('ghost', { pressed: open || picking })}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Tools"
        title={picking ? 'Tools: picking an element to compare' : shooting ? 'Tools: capturing screenshots' : 'Tools'}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            if (open) firstItem()?.focus();
            else setOpen(true);
          }
        }}
      >
        {shooting ? <LoaderCircle size={ICON} class="animate-spin text-accent" /> : <Wrench size={ICON} class={picking ? 'text-accent' : undefined} />}
        <ChevronDown size={12} class="text-muted" />
      </button>

      {open && (
        <div
          role="menu"
          aria-label="Tools"
          class="absolute right-0 top-full z-50 mt-1 w-max min-w-56 rounded-lg border border-line bg-chrome p-1 shadow-[0_12px_32px_var(--shadow)]"
          onKeyDown={onMenuKey}
        >
          {items.map((item, i) => (
            <button
              key={item.label}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              class="flex w-full items-center gap-2.5 whitespace-nowrap rounded-md px-2.5 py-2 text-left outline-none hover:bg-chrome-2 focus-visible:bg-chrome-2 disabled:cursor-progress disabled:opacity-60"
              onClick={() => {
                setOpen(false);
                item.run();
              }}
            >
              <item.icon size={ICON} class={cx(item.tone ?? 'text-muted', item.busy && 'animate-spin')} />
              <span class="trim-cap flex-1">{item.label}</span>
              <span class="trim-cap pl-4 text-[11px] text-muted">{item.hint}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
