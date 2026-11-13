// The server status button at the right of the toolbar: a dot (green: connected and every engine
// up; amber: an engine failed; red: disconnected), with a label while not connected. Hover for a
// summary; click for details: connection, latency, engines, profile and the MCP endpoint.
import { Check, Copy, LoaderCircle, RefreshCw } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { PaneInfo } from '../../shared/protocol';
import type { EngineClient, EngineState } from './engine';
import { btn, cx, EngineDot } from './ui';

const ENGINE_NAMES = { chromium: 'Chromium', firefox: 'Firefox', webkit: 'WebKit' } as const;
const token = new URLSearchParams(location.search).get('token') ?? '';
const MCP_URL = `${location.origin}/mcp?token=${encodeURIComponent(token)}`;

type Health = 'ok' | 'degraded' | 'connecting' | 'down';

function healthOf(state: EngineState): Health {
  if (state.status === 'closed') return 'down';
  if (state.status === 'connecting') return 'connecting';
  return state.panes.some((p) => p.failed) ? 'degraded' : 'ok';
}

const DOT: Record<Health, string> = { ok: 'bg-live', degraded: 'bg-warn', connecting: 'bg-muted', down: 'bg-danger' };

function duration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

function summary(state: EngineState, health: Health, now: number): string {
  if (health === 'down') return `Disconnected from the TriPane server${state.retryAt ? `, retrying in ${Math.max(1, Math.ceil((state.retryAt - now) / 1000))}s` : ''}`;
  if (health === 'connecting') return 'Connecting to the TriPane server…';
  const running = state.panes.filter((p) => !p.disabled && !p.failed).length;
  const failed = state.panes.filter((p) => p.failed).length;
  return `Connected to the TriPane server · ${running} ${running === 1 ? 'engine' : 'engines'} running${failed ? ` · ${failed} failed to start` : ''}`;
}

export function StatusMenu({ client, state }: { client: EngineClient; state: EngineState }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const health = healthOf(state);

  // A clock for the countdown and "connected for": every second while the panel is open or the
  // button shows a countdown; latency is measured every couple of seconds while open.
  const ticking = open || health === 'down';
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    if (open) client.ping();
    let n = 0;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (open && ++n % 2 === 0) client.ping();
    }, 1000);
    return () => clearInterval(timer);
  }, [ticking, open, state.status]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [open]);
  useLayoutEffect(() => {
    if (open) panel.current?.focus();
  }, [open]);

  const label = health === 'down' ? (state.retryAt && state.retryAt > now ? `Reconnecting in ${Math.ceil((state.retryAt - now) / 1000)}s` : 'Reconnecting…') : health === 'connecting' ? 'Connecting…' : null;

  return (
    <div class="relative" ref={root}>
      <button
        type="button"
        class={cx(
          'inline-flex h-7 items-center gap-1.5 rounded-full px-2 hover:bg-line/60 focus-visible:outline-2 focus-visible:outline-accent',
          open && 'bg-line/60',
          label && 'border border-line',
          health === 'down' && 'border-danger/50 text-danger',
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Server status: ${summary(state, health, now)}`}
        title={summary(state, health, now)}
        onClick={() => setOpen((o) => !o)}
      >
        <StatusDot health={health} />
        {label && <span class="trim-cap whitespace-nowrap text-xs font-medium">{label}</span>}
      </button>

      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Server status"
          tabIndex={-1}
          class="absolute right-0 top-full z-50 mt-2 w-[min(360px,calc(100vw-24px))] overflow-hidden rounded-xl border border-line bg-chrome text-fg shadow-[0_16px_40px_var(--shadow)] outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <Panel client={client} state={state} health={health} now={now} />
        </div>
      )}
    </div>
  );
}

/** The dot; a soft pulse while (re)connecting. */
function StatusDot({ health, large }: { health: Health; large?: boolean }) {
  const size = large ? 'size-2.5' : 'size-2';
  return (
    <span class={cx('relative inline-flex flex-none', size)}>
      {(health === 'connecting' || health === 'down') && <span class={cx('absolute inset-0 animate-ping rounded-full opacity-60', DOT[health])} />}
      <span class={cx('relative inline-flex rounded-full', size, DOT[health], health === 'ok' && 'ring-3 ring-live/20')} />
    </span>
  );
}

function Panel({ client, state, health, now }: { client: EngineClient; state: EngineState; health: Health; now: number }) {
  const [copied, setCopied] = useState(false);
  const title = { ok: 'Connected', degraded: 'Connected, with problems', connecting: 'Connecting…', down: 'Disconnected' }[health];
  const latency = state.latency;

  return (
    <>
      <header class="flex items-start gap-3 border-b border-line px-4 py-3">
        <span class="mt-1.5">
          <StatusDot health={health} large />
        </span>
        <div class="min-w-0 flex-1">
          <h3 class="font-semibold">{title}</h3>
          <p class="truncate text-xs text-muted">TriPane server at {location.host}</p>
        </div>
        {state.version && (
          <span class="flex-none rounded-full border border-line px-2 py-0.5 text-[11px] text-muted" title="TriPane version">
            {state.version === 'dev' ? 'dev build' : `v${state.version}`}
          </span>
        )}
      </header>

      <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 border-b border-line px-4 py-3 text-xs">
        {state.status === 'open' ? (
          <>
            <dt class="text-muted">Connected for</dt>
            <dd class="tabular-nums">{state.connectedAt ? duration(now - state.connectedAt) : '—'}</dd>
            <dt class="text-muted">Latency</dt>
            <dd class="flex items-center gap-1.5 tabular-nums">
              {latency === null ? (
                <span class="text-muted">measuring…</span>
              ) : (
                <>
                  <span class={cx('size-1.5 rounded-full', latency < 50 ? 'bg-live' : latency < 200 ? 'bg-warn' : 'bg-danger')} />
                  {latency} ms
                </>
              )}
            </dd>
          </>
        ) : (
          <>
            <dt class="text-muted">Status</dt>
            <dd>
              {state.status === 'connecting'
                ? 'Trying to connect…'
                : state.retryAt && state.retryAt > now
                  ? `Next attempt in ${Math.ceil((state.retryAt - now) / 1000)}s`
                  : 'Trying again…'}
            </dd>
          </>
        )}
        <dt class="text-muted">Proxy</dt>
        <dd class="min-w-0">
          {state.network?.proxy ? (
            <>
              <span class="block truncate font-mono text-[11px]" title={state.network.proxy}>
                {state.network.proxy}
              </span>
              <span class="block truncate text-muted" title={state.network.bypass.join(', ')}>
                {state.network.proxyLoopback ? 'localhost too' : 'localhost goes direct'}
                {state.network.bypass.filter((b) => !['localhost', '127.0.0.1', '[::1]'].includes(b)).length
                  ? ` · skips ${state.network.bypass.filter((b) => !['localhost', '127.0.0.1', '[::1]'].includes(b)).join(', ')}`
                  : ''}
              </span>
            </>
          ) : (
            'None (direct)'
          )}
        </dd>
        {state.network?.ignoreCertErrors && (
          <>
            <dt class="text-muted">Certificates</dt>
            <dd class="text-warn-text">Errors ignored</dd>
          </>
        )}
        <dt class="text-muted">Profile</dt>
        <dd class="min-w-0 truncate" title={state.storageDir ?? undefined}>
          {state.storageDir ?? 'Fresh session (nothing is saved)'}
        </dd>
      </dl>

      {health === 'down' && (
        <div class="border-b border-line px-4 py-3 text-xs">
          <p class="mb-2 text-muted">
            The page lost its connection to the server. If you closed TriPane in the terminal, start it again; this window
            reconnects by itself.
          </p>
          <button type="button" class={btn('outline', { small: true })} onClick={() => client.reconnectNow()}>
            <RefreshCw size={13} /> <span class="trim-cap">Reconnect now</span>
          </button>
        </div>
      )}

      <Section title={state.status === 'open' ? 'Engines' : 'Engines (last known)'}>
        <ul class="flex flex-col gap-1.5">
          {state.panes.map((p) => (
            <EngineRow key={p.id} pane={p} stale={state.status !== 'open'} />
          ))}
          {!state.panes.length && <li class="text-xs text-muted">Not reported yet.</li>}
        </ul>
      </Section>

      <Section title="MCP endpoint for AI agents">
        <div class="flex items-center gap-1.5">
          <code class="min-w-0 flex-1 truncate rounded-md border border-line bg-chrome-2 px-2 py-1 font-mono text-[11px]" title="Includes this session's access token">
            {location.origin}/mcp?token=••••••
          </code>
          <button
            type="button"
            class={btn('outline', { small: true })}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(MCP_URL);
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              } catch {
                // clipboard not available
              }
            }}
          >
            {copied ? <Check size={13} /> : <Copy size={13} />} <span class="trim-cap">{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
        <p class="mt-1.5 text-[11px] text-muted">The address changes each run unless TriPane is started with --port.</p>
      </Section>
    </>
  );
}

function Section(props: { title: string; children: ComponentChildren }) {
  return (
    <section class="border-b border-line px-4 py-3 last:border-b-0">
      <h4 class="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted">{props.title}</h4>
      {props.children}
    </section>
  );
}

function EngineRow({ pane, stale }: { pane: PaneInfo; stale: boolean }) {
  const chip = pane.disabled
    ? { text: 'Off', cls: 'text-muted border-line' }
    : pane.failed
      ? { text: 'Failed', cls: 'text-danger border-danger/40 bg-danger/10' }
      : !pane.version
        ? { text: 'Starting', cls: 'text-muted border-line' }
        : pane.loading
          ? { text: 'Loading', cls: 'text-accent border-accent/40' }
          : { text: 'Running', cls: 'text-fg border-line' };
  return (
    <li class={cx('flex flex-col gap-0.5', stale && 'opacity-60')}>
      <div class="flex items-center gap-2 text-xs">
        <EngineDot engine={pane.engine} />
        <span class="font-medium">{ENGINE_NAMES[pane.engine]}</span>
        {pane.version && <span class="text-muted">{pane.version}</span>}
        <span class={cx('ml-auto inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[11px]', chip.cls)}>
          {chip.text === 'Loading' || chip.text === 'Starting' ? <LoaderCircle size={10} class="animate-spin" /> : null}
          {chip.text}
        </span>
      </div>
      {pane.failed && <p class="line-clamp-2 pl-4 text-[11px] text-danger" title={pane.failed}>{pane.failed}</p>}
    </li>
  );
}
