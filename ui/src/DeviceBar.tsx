// The device toolbar, modelled on Chrome DevTools' device mode: viewport size and device
// emulation, for all engines together or for each engine on its own.
//
//   [All engines | Per engine]   Dimensions: [Responsive ▾]  [1280] × [800]  DPR 1  ⟲
//   [All engines | Per engine]   ● Chromium [iPhone 15 ▾] 393×659 ⟲ │ ● Firefox [Responsive ▾] … │ …
import { ChevronDown, RotateCcwSquare } from 'lucide-preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { VIEWPORT_PRESETS, type DevicePreset, type EngineName, type PaneInfo, type Settings, type Target, type Viewport } from '../../shared/protocol';
import type { EngineClient } from './engine';
import { btn, cx, ENGINE_CLASS, EngineDot, ICON, Toggle } from './ui';

interface Props {
  client: EngineClient;
  /** The panes shown (engines that are turned off aren't included). */
  panes: PaneInfo[];
  settings: Settings | null;
  devices: DevicePreset[];
}

const ENGINE_NAMES: Record<EngineName, string> = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' };
const same = (a: Viewport, b: Viewport) => a.width === b.width && a.height === b.height;

export function DeviceBar({ client, panes, settings, devices }: Props) {
  const perEngine = settings?.sizePerEngine ?? false;
  const deviceNamed = (name: string | null | undefined) => devices.find((d) => d.name === name) ?? null;
  const setSettings = (patch: Partial<Settings>) => client.send({ type: 'settings', settings: patch });
  const setViewport = (target: Target, viewport: Viewport) => client.send({ type: 'viewport', target, viewport });

  return (
    <div class="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-line bg-chrome px-3 py-1 text-xs">
      <div class="inline-flex rounded-md border border-line bg-bg p-px" role="radiogroup" aria-label="Screen size applies to">
        {(
          [
            [false, 'All engines', 'One size or device for every engine'],
            [true, 'Per engine', 'Each engine gets its own size or device; synced clicks then go to the same element in each'],
          ] as const
        ).map(([value, label, title]) => (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={perEngine === value}
            title={title}
            class={cx(
              'h-[22px] rounded-[5px] px-2 focus-visible:outline-2 focus-visible:outline-accent',
              perEngine === value ? 'bg-accent text-on-accent' : 'text-muted hover:text-fg',
            )}
            onClick={() => perEngine !== value && setSettings({ sizePerEngine: value })}
          >
            <span class="trim-cap">{label}</span>
          </button>
        ))}
      </div>

      {!perEngine ? (
        <SizeControl
          label="Dimensions:"
          devices={devices}
          viewport={panes[0]?.viewport ?? { width: 1280, height: 800 }}
          mixed={panes.some((p) => !same(p.viewport, panes[0].viewport))}
          device={deviceNamed(settings?.device)}
          onDevice={(name) => setSettings({ device: name })}
          onViewport={(vp) => setViewport('all', vp)}
          showDpr
        />
      ) : (
        panes.map((p, i) => (
          <div key={p.id} class={cx('inline-flex items-center gap-1.5', ENGINE_CLASS[p.engine], i > 0 && 'border-l border-line pl-3')}>
            <EngineDot engine={p.engine} />
            <span class="trim-cap font-medium">{ENGINE_NAMES[p.engine]}</span>
            <SizeControl
              devices={devices}
              viewport={p.viewport}
              device={deviceNamed(settings?.engineDevice[p.engine])}
              onDevice={(name) => setSettings({ engineDevice: { [p.engine]: name } as Settings['engineDevice'] })}
              onViewport={(vp) => setViewport(p.id, vp)}
              engineName={ENGINE_NAMES[p.engine]}
              compact
            />
          </div>
        ))
      )}

      {/* Only meaningful while some engine emulates a device. */}
      {panes.some((p) => p.device) && (
        <Toggle
          label="Frame"
          checked={settings?.deviceFrames ?? true}
          title="Draw the device and its browser's bars around the page (an imitation; the page itself is unchanged)"
          onChange={(deviceFrames) => setSettings({ deviceFrames })}
        />
      )}
    </div>
  );
}

/** Dimensions menu, width × height fields, pixel ratio and rotate, for all engines or one. */
function SizeControl(props: {
  label?: string;
  devices: DevicePreset[];
  viewport: Viewport;
  /** The engines differ in size (only in "All engines", before a size is chosen). */
  mixed?: boolean;
  device: DevicePreset | null;
  onDevice(name: string | null): void;
  onViewport(vp: Viewport): void;
  /** For labels: which engine this controls (per-engine mode). */
  engineName?: string;
  showDpr?: boolean;
  compact?: boolean;
}) {
  const { device, viewport } = props;
  const sizeName = Object.entries(VIEWPORT_PRESETS).find(([, v]) => same(v, viewport))?.[0];
  const value = device ? `device:${device.name}` : sizeName && !props.mixed ? `size:${sizeName}` : 'responsive';
  const label = device ? device.name : sizeName && !props.mixed ? sizeName : 'Responsive';
  const rotated = device ? viewport.width !== device.viewport.width : false;
  const of = props.engineName ? ` (${props.engineName})` : '';

  // Choosing a size while a device is emulated first leaves device mode (which rebuilds the
  // engine's context and restores its desktop size); the size is applied once that's done.
  const pendingSize = useRef<Viewport | null>(null);
  useEffect(() => {
    if (!device && pendingSize.current) {
      props.onViewport(pendingSize.current);
      pendingSize.current = null;
    }
  }, [device]);

  const choose = (v: string) => {
    if (v.startsWith('device:')) return props.onDevice(v.slice('device:'.length));
    const size = v.startsWith('size:') ? VIEWPORT_PRESETS[v.slice('size:'.length)] : null;
    if (device) {
      pendingSize.current = size;
      props.onDevice(null);
    } else if (size) {
      props.onViewport(size);
    }
  };

  return (
    <span class={cx('inline-flex items-center', props.compact ? 'gap-1.5' : 'gap-3')}>
      {/* A native select (for its menu and keyboard support) laid invisibly over a label that lines up with the bar. */}
      <label class="relative inline-flex h-6 cursor-pointer items-center gap-1 rounded px-1.5 hover:bg-chrome-2">
        {props.label && <span class="trim-cap text-muted">{props.label}</span>}
        <span class={cx('font-medium', props.compact ? 'trim-cap-clip max-w-28 truncate' : 'trim-cap')}>{label}</span>
        <ChevronDown size={12} class="flex-none text-muted" />
        <select
          class="absolute inset-0 cursor-pointer opacity-0"
          aria-label={`Dimensions${of}`}
          title="Viewport size, or a phone or tablet to emulate (pixel ratio, touch, mobile mode and user agent; the page reloads)"
          value={value}
          onChange={(e) => choose(e.currentTarget.value)}
        >
          <option value="responsive">Responsive</option>
          <optgroup label="Sizes">
            {Object.entries(VIEWPORT_PRESETS).map(([name, v]) => (
              <option key={name} value={`size:${name}`}>{`${name} · ${v.width}×${v.height}`}</option>
            ))}
          </optgroup>
          <optgroup label="Devices">
            {props.devices.map((d) => (
              <option key={d.name} value={`device:${d.name}`}>{`${d.name} · ${d.viewport.width}×${d.viewport.height}`}</option>
            ))}
          </optgroup>
        </select>
      </label>

      <SizeFields viewport={viewport} locked={!!device} onApply={props.onViewport} of={of} compact={props.compact} />

      {(props.showDpr || device) && (
        <span class="trim-cap text-muted" title="Device pixel ratio">
          DPR <span class="text-fg">{device ? device.deviceScaleFactor : 1}</span>
        </span>
      )}

      <button
        type="button"
        class={btn('ghost', { icon: true, small: true, pressed: rotated })}
        title={`Rotate${of}`}
        aria-label={`Rotate${of}`}
        onClick={() => props.onViewport({ width: viewport.height, height: viewport.width })}
      >
        <RotateCcwSquare size={ICON - 1} />
      </button>
    </span>
  );
}

/** Width × height. Editable in Responsive mode (Enter or leaving the field applies); fixed for a device, as in Chrome. */
function SizeFields(props: { viewport: Viewport; locked: boolean; onApply(vp: Viewport): void; of: string; compact?: boolean }) {
  const [w, setW] = useState(String(props.viewport.width));
  const [h, setH] = useState(String(props.viewport.height));
  useEffect(() => setW(String(props.viewport.width)), [props.viewport.width]);
  useEffect(() => setH(String(props.viewport.height)), [props.viewport.height]);
  const apply = () => {
    const width = parseInt(w, 10);
    const height = parseInt(h, 10);
    if (width > 0 && height > 0 && (width !== props.viewport.width || height !== props.viewport.height)) props.onApply({ width, height });
    else {
      setW(String(props.viewport.width));
      setH(String(props.viewport.height));
    }
  };
  const field = cx(
    'h-6 rounded border border-line bg-chrome-2 text-center tabular-nums outline-none focus:border-accent',
    props.compact ? 'w-12' : 'w-14',
    props.locked && 'cursor-not-allowed text-muted',
  );
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
    if (e.key === 'Escape') {
      setW(String(props.viewport.width));
      setH(String(props.viewport.height));
      (e.currentTarget as HTMLInputElement).blur();
    }
  };
  return (
    <span class="inline-flex items-center gap-1">
      <input class={field} aria-label={`Viewport width${props.of}`} inputMode="numeric" readOnly={props.locked} value={w} onInput={(e) => setW(e.currentTarget.value)} onBlur={apply} onKeyDown={onKey} />
      <span class="trim-cap text-muted">×</span>
      <input class={field} aria-label={`Viewport height${props.of}`} inputMode="numeric" readOnly={props.locked} value={h} onInput={(e) => setH(e.currentTarget.value)} onBlur={apply} onKeyDown={onKey} />
    </span>
  );
}
