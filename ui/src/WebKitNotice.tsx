// Shown once, on first start: the WebKit pane is Playwright's WebKit, not Safari on an iPhone,
// so it can't replace testing on real devices. Dismissing it is saved in the settings.
import { Smartphone, TriangleAlert } from 'lucide-preact';
import { useEffect, useRef } from 'preact/hooks';
import { btn, cx } from './ui';

const POINTS: { title: string; text: string }[] = [
  {
    title: 'Not Safari',
    text: "The WebKit pane runs Playwright's WebKit build. It shares Safari's engine, but not its version, fonts, media codecs, network stack or Apple-only features (Apple Pay, passkeys, system UI).",
  },
  {
    title: 'Not iOS',
    text: "Device emulation sets the screen size, pixel ratio, user agent and touch. It doesn't reproduce iOS itself: the collapsing toolbar and safe areas, viewport units, zoom on focused inputs, native form controls, scrolling physics, memory limits or Safari's privacy rules.",
  },
  {
    title: 'The same goes for the others',
    text: 'The Chromium and Firefox panes are close to desktop Chrome and Firefox, but not Chrome on Android or any particular release.',
  },
];

export function WebKitNotice({ open, onClose }: { open: boolean; onClose(): void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      class="m-auto w-[min(560px,calc(100vw-32px))] overflow-hidden rounded-xl border border-line bg-chrome p-0 text-fg shadow-[0_24px_64px_var(--shadow)] backdrop:bg-black/60"
      aria-labelledby="webkit-notice-title"
      aria-describedby="webkit-notice-body"
      onClose={onClose}
    >
      <header class="flex items-start gap-3 px-5 pb-2 pt-5">
        <span class="mt-0.5 flex h-8 w-8 flex-none items-center justify-center rounded-full bg-warn/15 text-warn">
          <TriangleAlert size={17} />
        </span>
        <div>
          <h2 id="webkit-notice-title" class="text-base font-bold">
            WebKit here isn't Safari on an iPhone
          </h2>
          <p class="mt-1 text-sm text-muted">TriPane is for catching cross-engine differences early. It doesn't replace real devices.</p>
        </div>
      </header>
      <div id="webkit-notice-body" class="px-5 py-3">
        <ul class="space-y-3 text-sm">
          {POINTS.map((p) => (
            <li key={p.title} class="pl-11">
              <strong class="block font-semibold">{p.title}</strong>
              <span class="text-muted">{p.text}</span>
            </li>
          ))}
        </ul>
        <p class="mt-4 flex gap-3 rounded-lg border border-line bg-bg/40 px-3 py-2.5 text-sm">
          <Smartphone size={17} class="mt-0.5 flex-none text-accent" />
          <span>
            Before you ship, test on real iPhones, iPads and Macs with Safari, or with Xcode's iOS Simulator or a device
            cloud service.
          </span>
        </p>
      </div>
      <footer class="flex justify-end border-t border-line px-5 py-3">
        <button type="button" class={cx(btn('primary'), 'px-3')} onClick={onClose} autofocus>
          Got it
        </button>
      </footer>
    </dialog>
  );
}
