// Device frames: a generic phone or tablet body around a pane that emulates a device, with
// imitation browser bars (status bar, Safari or Chrome toolbar, home indicator) in the space the
// real browser's bars take. Drawn in TriPane's UI, beside the page picture: nothing goes into the
// page, and the engines render exactly what they did before. Generic shapes, not product art.
//
// Geometry is in device CSS pixels and scaled with the picture.
import { BookOpen, ChevronLeft, ChevronRight, Copy, EllipsisVertical, Lock, PanelLeft, Plus, RotateCw, Share } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import type { DevicePreset, Viewport } from '../../shared/protocol';

type Style = 'island' | 'classic' | 'android' | 'tablet-ios' | 'tablet-android';

export interface FrameGeometry {
  style: Style;
  landscape: boolean;
  /** The whole device, body and all. */
  outer: Viewport;
  bezel: { top: number; right: number; bottom: number; left: number };
  bodyRadius: number;
  screenRadius: number;
  /** Bars inside the screen, around the viewport. */
  bars: { top: number; bottom: number; left: number; right: number };
}

function styleOf(d: DevicePreset): Style {
  const ios = /iPhone|iPad/.test(d.name) || /iPhone|iPad/.test(d.userAgent);
  const short = Math.min(d.viewport.width, d.viewport.height);
  if (short >= 600) return ios ? 'tablet-ios' : 'tablet-android';
  if (!ios) return 'android';
  return /SE\b/.test(d.name) ? 'classic' : 'island';
}

/** Typical bar heights (portrait), for presets where Playwright doesn't give the screen size. */
const DEFAULT_BARS: Record<Style, { top: number; bottom: number }> = {
  island: { top: 54, bottom: 84 },
  classic: { top: 20, bottom: 44 },
  android: { top: 80, bottom: 16 },
  'tablet-ios': { top: 74, bottom: 0 },
  'tablet-android': { top: 80, bottom: 0 },
};

const BODY: Record<Style, { bezel: number; top?: number; bottom?: number; radius: number; screenRadius: number }> = {
  island: { bezel: 12, radius: 58, screenRadius: 47 },
  classic: { bezel: 16, top: 76, bottom: 76, radius: 52, screenRadius: 2 },
  android: { bezel: 10, radius: 38, screenRadius: 30 },
  'tablet-ios': { bezel: 22, radius: 34, screenRadius: 16 },
  'tablet-android': { bezel: 20, radius: 30, screenRadius: 14 },
};

/** The frame for this device at this viewport (a rotated device has width > height). */
export function frameGeometry(device: DevicePreset, viewport: Viewport): FrameGeometry {
  const style = styleOf(device);
  const portraitVp = device.viewport;
  const landscape = viewport.width > viewport.height && portraitVp.width < portraitVp.height;
  // Bars: what Playwright's screen size leaves around the viewport, split the way the browser does.
  let { top, bottom } = DEFAULT_BARS[style];
  const screen = device.screen;
  if (screen && screen.height > portraitVp.height) {
    const gap = screen.height - portraitVp.height;
    if (style === 'island') [top, bottom] = [Math.min(54, gap), Math.max(0, gap - 54)];
    else if (style === 'classic') [top, bottom] = [Math.min(20, gap), Math.max(0, gap - 20)];
    else if (style === 'android') [top, bottom] = [Math.max(0, gap - 16), Math.min(16, gap)];
    else [top, bottom] = [gap, 0];
  }
  const b = BODY[style];
  const bezelTop = b.top ?? b.bezel;
  const bezelBottom = b.bottom ?? b.bezel;
  if (!landscape || style.startsWith('tablet')) {
    const bars = { top, bottom, left: 0, right: 0 };
    const bezel = landscape && style === 'classic' ? { top: b.bezel, bottom: b.bezel, left: bezelTop, right: bezelBottom } : { top: bezelTop, bottom: bezelBottom, left: b.bezel, right: b.bezel };
    return {
      style,
      landscape,
      bars,
      bezel,
      bodyRadius: b.radius,
      screenRadius: b.screenRadius,
      outer: { width: viewport.width + bezel.left + bezel.right, height: viewport.height + top + bottom + bezel.top + bezel.bottom },
    };
  }
  // A phone on its side: the bars move to the sides (the camera side on the left), the bezels rotate.
  const bars = { top: 0, bottom: 0, left: top, right: bottom };
  const bezel = { top: b.bezel, bottom: b.bezel, left: bezelTop, right: bezelBottom };
  return {
    style,
    landscape,
    bars,
    bezel,
    bodyRadius: b.radius,
    screenRadius: b.screenRadius,
    outer: { width: viewport.width + top + bottom + bezel.left + bezel.right, height: viewport.height + bezel.top + bezel.bottom },
  };
}

interface Props {
  /** null: no frame (the picture alone, same element structure). */
  geo: FrameGeometry | null;
  viewport: Viewport;
  scale: number;
  url: string;
  /** The page's color scheme: the imitated bars follow it, as the real ones do. */
  dark: boolean;
  onAddressClick(): void;
  /** The page picture (the canvas and its overlays), viewport-sized. */
  children: ComponentChildren;
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host || url;
  } catch {
    return url;
  }
}

export function DeviceFrame({ geo: frame, viewport, scale: s, url, dark, onAddressClick, children }: Props) {
  const px = (n: number) => `${n * s}px`;
  // Without a frame the same elements are rendered, undecorated: the page picture keeps its place
  // in the tree, so toggling the frame doesn't recreate the canvas (and its input listeners).
  const framed = !!frame;
  const geo: FrameGeometry = frame ?? {
    style: 'island',
    landscape: false,
    outer: viewport,
    bezel: { top: 0, right: 0, bottom: 0, left: 0 },
    bars: { top: 0, bottom: 0, left: 0, right: 0 },
    bodyRadius: 0,
    screenRadius: 0,
  };
  const { bezel, bars } = geo;
  const screenW = viewport.width + bars.left + bars.right;
  const screenH = viewport.height + bars.top + bars.bottom;
  const ink = dark ? '#f2f2f7' : '#111';
  const barBg = dark ? '#1c1c1e' : '#f2f2f7';
  const pill = dark ? '#2c2c2e' : '#e3e3e8';
  const host = hostOf(url);
  const icon = Math.max(6, Math.round(17 * s));
  const tablet = geo.style.startsWith('tablet');

  return (
    <div
      class="relative flex-none"
      style={{ width: px(geo.outer.width), height: px(geo.outer.height) }}
      aria-label={framed ? 'Device frame' : undefined}
    >
      {/* Body: dark, with a faint rim; side buttons on the edges. */}
      {framed && (
      <div
        class="absolute inset-0"
        style={{
          borderRadius: px(geo.bodyRadius),
          background: 'linear-gradient(145deg,#2a2a2e,#121214 55%,#1d1d20)',
          boxShadow: `0 0 0 ${Math.max(1, 1.5 * s)}px #3a3a3f, 0 ${px(10)} ${px(36)} var(--shadow)`,
        }}
      />
      )}
      {framed && !geo.landscape && !tablet && (
        <>
          <span class="absolute rounded-l-sm bg-[#2a2a2e]" style={{ left: px(-3), top: px(geo.outer.height * 0.18), width: px(3), height: px(30) }} />
          <span class="absolute rounded-l-sm bg-[#2a2a2e]" style={{ left: px(-3), top: px(geo.outer.height * 0.25), width: px(3), height: px(56) }} />
          <span class="absolute rounded-r-sm bg-[#2a2a2e]" style={{ right: px(-3), top: px(geo.outer.height * 0.22), width: px(3), height: px(80) }} />
        </>
      )}

      {/* Classic iPhone: earpiece and home button in the bezels. */}
      {framed && geo.style === 'classic' && !geo.landscape && (
        <>
          <span class="absolute left-1/2 -translate-x-1/2 rounded-full bg-[#3a3a3f]" style={{ top: px(36), width: px(46), height: px(5) }} />
          <span
            class="absolute left-1/2 -translate-x-1/2 rounded-full border-[#3a3a3f]"
            style={{ bottom: px(14), width: px(48), height: px(48), borderWidth: px(2) }}
          />
        </>
      )}

      {/* Screen */}
      <div
        class="absolute overflow-hidden"
        style={{ left: px(bezel.left), top: px(bezel.top), width: px(screenW), height: px(screenH), borderRadius: px(geo.screenRadius), background: framed ? barBg : undefined, color: ink }}
      >
        {/* Top bars (portrait, or tablets in either orientation) */}
        {bars.top > 0 && (
          <div class="absolute inset-x-0 top-0" style={{ height: px(bars.top), background: barBg }}>
            <StatusBar style={geo.style} s={s} ink={ink} height={geo.style === 'android' || tablet ? 24 : geo.style === 'classic' ? 20 : 54} />
            {(geo.style === 'android' || tablet) && bars.top > 30 && (
              <div class="absolute inset-x-0 flex items-center" style={{ top: px(24), height: px(bars.top - 24), gap: px(10), padding: `0 ${px(12)}` }}>
                {geo.style === 'tablet-ios' && (
                  <span class="flex items-center opacity-80" style={{ gap: px(14) }}>
                    <PanelLeft size={icon} />
                    <ChevronLeft size={icon} />
                    <ChevronRight size={icon} />
                  </span>
                )}
                <Address host={host} s={s} pill={pill} icon={icon} onClick={onAddressClick} center={geo.style === 'tablet-ios'} />
                {geo.style === 'tablet-ios' ? (
                  <span class="flex items-center opacity-80" style={{ gap: px(14) }}>
                    <Share size={icon} />
                    <Plus size={icon} />
                    <Copy size={icon} />
                  </span>
                ) : (
                  <span class="flex items-center opacity-80" style={{ gap: px(12) }}>
                    <span class="grid place-items-center rounded-[3px] font-semibold" style={{ width: px(17), height: px(17), border: `${Math.max(1, 1.6 * s)}px solid currentColor`, fontSize: px(10) }}>
                      1
                    </span>
                    <EllipsisVertical size={icon} />
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* Landscape phone: camera side on the left, empty margin on the right (as Safari does). */}
        {bars.left > 0 && (
          <div class="absolute inset-y-0 left-0" style={{ width: px(bars.left), background: barBg }}>
            {framed && geo.style === 'island' && <span class="absolute top-1/2 -translate-y-1/2 rounded-full bg-black" style={{ left: px(11), width: px(36), height: px(122) }} />}
          </div>
        )}
        {bars.right > 0 && <div class="absolute inset-y-0 right-0" style={{ width: px(bars.right), background: barBg }} />}

        {/* The page */}
        <div class="absolute" style={{ left: px(bars.left), top: px(bars.top), width: px(viewport.width), height: px(viewport.height) }}>
          {children}
        </div>

        {/* Bottom bars */}
        {bars.bottom > 0 && (
          <div class="absolute inset-x-0 bottom-0" style={{ height: px(bars.bottom), background: barBg }}>
            {(geo.style === 'island' || geo.style === 'classic') && (
              <div class="flex flex-col items-stretch" style={{ padding: `${px(8)} ${px(14)} 0`, gap: px(8) }}>
                <div class="flex items-center" style={{ gap: px(10) }}>
                  <span class="font-semibold opacity-80" style={{ fontSize: px(14) }}>
                    AA
                  </span>
                  <Address host={host} s={s} pill={pill} icon={icon} onClick={onAddressClick} center />
                  <RotateCw size={icon} class="opacity-80" />
                </div>
                {bars.bottom >= 100 && (
                  <div class="flex items-center justify-between opacity-80" style={{ padding: `0 ${px(8)}` }}>
                    <ChevronLeft size={icon + 2} />
                    <ChevronRight size={icon + 2} />
                    <Share size={icon} />
                    <BookOpen size={icon} />
                    <Copy size={icon} />
                  </div>
                )}
              </div>
            )}
          </div>
        )}
        {/* Home indicator / gesture bar, over the bottom edge as on the real devices. */}
        {framed && (geo.style === 'island' || geo.style === 'android' || geo.style === 'tablet-ios') && (
          <span
            class="absolute left-1/2 -translate-x-1/2 rounded-full"
            style={{ bottom: px(geo.style === 'android' ? 6 : 8), width: px(geo.style === 'android' ? 108 : 134), height: px(5), background: ink, opacity: 0.85 }}
          />
        )}
      </div>
    </div>
  );
}

function StatusBar({ style, s, ink, height }: { style: Style; s: number; ink: string; height: number }) {
  const px = (n: number) => `${n * s}px`;
  return (
    <div class="absolute inset-x-0 top-0 flex items-center justify-between font-semibold" style={{ height: px(height), padding: `0 ${px(style === 'island' ? 34 : 14)}`, fontSize: px(style === 'island' ? 16 : 13), color: ink }}>
      <span style={{ marginTop: style === 'island' ? px(4) : undefined }}>{style === 'tablet-ios' ? '9:41  Tue Nov 10' : '9:41'}</span>
      {style === 'island' && <span class="absolute left-1/2 -translate-x-1/2 rounded-full bg-black" style={{ top: px(11), width: px(122), height: px(36) }} />}
      {style === 'android' && <span class="absolute left-1/2 -translate-x-1/2 rounded-full bg-black" style={{ top: px(6), width: px(12), height: px(12) }} />}
      <span class="flex items-center" style={{ gap: px(5), marginTop: style === 'island' ? px(4) : undefined }}>
        <SignalBars s={s} ink={ink} />
        <WifiArc s={s} ink={ink} />
        <Battery s={s} ink={ink} />
      </span>
    </div>
  );
}

/** Imitation address field: shows the page's host; clicking it focuses TriPane's real address bar. */
function Address({ host, s, pill, icon, onClick, center }: { host: string; s: number; pill: string; icon: number; onClick(): void; center?: boolean }) {
  const px = (n: number) => `${n * s}px`;
  return (
    <button
      type="button"
      class="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap"
      style={{ height: px(36), borderRadius: px(12), background: pill, padding: `0 ${px(12)}`, gap: px(6), fontSize: px(15), justifyContent: center ? 'center' : 'flex-start', color: 'inherit' }}
      title="Edit the address"
      onClick={onClick}
    >
      <Lock size={Math.max(5, icon - 5)} class="flex-none opacity-70" />
      <span class="truncate">{host}</span>
    </button>
  );
}

function SignalBars({ s, ink }: { s: number; ink: string }) {
  const px = (n: number) => `${n * s}px`;
  return (
    <span class="flex items-end" style={{ gap: px(1.5), height: px(11) }}>
      {[4, 6, 8, 11].map((h) => (
        <span key={h} style={{ width: px(3), height: px(h), background: ink, borderRadius: px(1) }} />
      ))}
    </span>
  );
}

function WifiArc({ s, ink }: { s: number; ink: string }) {
  const w = 15 * s;
  return (
    <svg width={w} height={w * 0.73} viewBox="0 0 15 11" aria-hidden="true">
      <path d="M7.5 10.5 5.4 8.1a3 3 0 0 1 4.2 0Z M3.6 6.2a5.6 5.6 0 0 1 7.8 0L10.2 7.5a3.8 3.8 0 0 0-5.4 0Z M1.7 4.2a8.3 8.3 0 0 1 11.6 0L12.1 5.5a6.5 6.5 0 0 0-9.2 0Z" fill={ink} />
    </svg>
  );
}

function Battery({ s, ink }: { s: number; ink: string }) {
  const px = (n: number) => `${n * s}px`;
  return (
    <span class="flex items-center" style={{ gap: px(1) }}>
      <span style={{ width: px(24), height: px(11.5), border: `${Math.max(0.5, s)}px solid ${ink}`, borderRadius: px(3.5), padding: px(1.5), opacity: 0.9 }}>
        <span class="block h-full" style={{ width: '80%', background: ink, borderRadius: px(1.5) }} />
      </span>
      <span style={{ width: px(1.5), height: px(4), background: ink, borderRadius: px(1), opacity: 0.6 }} />
    </span>
  );
}
