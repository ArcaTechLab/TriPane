// The site info button at the left of the address bar, as in Chrome: its icon shows the
// connection (secure, not secure, local), and it opens a panel with each engine's view of the
// site: connection and certificate, cookies and site data, and permissions.
import type { LucideIcon } from 'lucide-preact';
import { ChevronDown, ChevronRight, Cookie, Info, Lock, LockOpen, RefreshCw, ShieldCheck, SlidersHorizontal, Trash2, TriangleAlert, X } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import type { NetworkInfo, SiteInfo as SiteInfoData, SiteInfoEngine } from '../../shared/protocol';
import type { EngineClient } from './engine';
import { ENGINE_LABEL } from './Pane';
import { btn, cx, ENGINE_CLASS, EngineDot, ICON } from './ui';

type Kind = 'secure' | 'insecure' | 'local' | 'none';

/** What the address bar's URL is, for the icon: like Chrome, localhost isn't flagged "Not secure". */
export function siteKind(url: string): Kind {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'none';
  }
  if (u.protocol === 'https:') return 'secure';
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) || u.hostname.endsWith('.localhost');
  if (u.protocol === 'http:') return loopback ? 'local' : 'insecure';
  return 'local';
}

const PERMISSION_LABEL: Record<string, string> = {
  geolocation: 'Location',
  notifications: 'Notifications',
  camera: 'Camera',
  microphone: 'Microphone',
  'clipboard-read': 'Clipboard',
};

const date = (seconds?: number) => (seconds ? new Date(seconds * 1000).toLocaleDateString() : '—');

export function SiteInfoButton({ client, url, info, network }: { client: EngineClient; url: string; info: SiteInfoData | null; network?: NetworkInfo | null }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const kind = siteKind(url);

  // Fresh data each time the panel opens, and again when the page changes while it's open.
  useEffect(() => {
    if (open) client.send({ type: 'siteInfo' });
  }, [open, url]);
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

  const icon: { Icon: LucideIcon; label: string; cls: string } =
    kind === 'secure'
      ? { Icon: SlidersHorizontal, label: 'View site information', cls: 'text-fg' }
      : kind === 'insecure'
        ? { Icon: TriangleAlert, label: 'Not secure', cls: 'text-danger' }
        : { Icon: Info, label: 'View site information', cls: 'text-muted' };

  return (
    <div class="absolute inset-y-0 left-1 flex items-center" ref={root}>
      <button
        type="button"
        class={cx(
          'inline-flex h-6 items-center gap-1 rounded-full px-1.5 hover:bg-line/60 focus-visible:outline-2 focus-visible:outline-accent',
          open && 'bg-line/60',
          icon.cls,
        )}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={icon.label}
        title={icon.label}
        onClick={() => setOpen((o) => !o)}
      >
        <icon.Icon size={14} />
        {kind === 'insecure' && <span class="trim-cap text-xs font-medium">Not secure</span>}
      </button>

      {open && (
        <div
          ref={panel}
          role="dialog"
          aria-label="Site information"
          tabIndex={-1}
          class="absolute left-0 top-full z-50 mt-2 w-[min(420px,calc(100vw-32px))] rounded-xl border border-line bg-chrome text-fg shadow-[0_16px_40px_var(--shadow)] outline-none"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <Panel client={client} url={url} kind={kind} info={info} network={network ?? null} onClose={() => setOpen(false)} />
        </div>
      )}
    </div>
  );
}

function Panel({ client, url, kind, info, network, onClose }: { client: EngineClient; url: string; kind: Kind; info: SiteInfoData | null; network: NetworkInfo | null; onClose(): void }) {
  const [confirming, setConfirming] = useState(false);
  const [showCookies, setShowCookies] = useState(false);
  const [showCert, setShowCert] = useState(false);
  let host = url;
  try {
    host = new URL(url).host || url;
  } catch {
    // keep the raw text
  }
  // Only data about this page: until the answer for it arrives, show "Loading…" rather than the
  // previous site's.
  let origin = '';
  try {
    origin = new URL(url).origin;
  } catch {
    // not a URL
  }
  if (info && info.origin !== origin) info = null;
  // Engines can be on different pages (a navigation that failed or redirected in one of them).
  // Only the ones on this site count here; the others are listed so the difference is visible.
  const originOf = (u: string) => {
    try {
      return new URL(u).origin;
    } catch {
      return u;
    }
  };
  const engines = (info?.engines ?? []).filter((e) => originOf(e.url) === origin);
  const elsewhere = (info?.engines ?? []).filter((e) => originOf(e.url) !== origin);
  const row = 'flex items-start gap-3 px-4 py-3';
  const certs = engines.filter((e) => e.secure && e.certificate);

  return (
    <>
      <header class="flex items-center justify-between gap-2 border-b border-line px-4 py-3">
        <strong class="trim-cap-clip truncate text-sm" title={url}>
          {host}
        </strong>
        <div class="flex flex-none items-center">
          <button type="button" class={btn('ghost', { icon: true, small: true })} aria-label="Refresh" title="Refresh" onClick={() => client.send({ type: 'siteInfo' })}>
            <RefreshCw size={13} />
          </button>
          <button type="button" class={btn('ghost', { icon: true, small: true })} aria-label="Close" onClick={onClose}>
            <X size={ICON - 1} />
          </button>
        </div>
      </header>

      {elsewhere.length > 0 && (
        <div class="space-y-1 border-b border-line bg-warn/10 px-4 py-2 text-xs">
          {elsewhere.map((e) => (
            <p key={e.paneId} class={cx('flex items-start gap-1.5', ENGINE_CLASS[e.engine])}>
              <TriangleAlert size={12} class="mt-px flex-none text-warn" />
              <span class="min-w-0">
                <strong>{ENGINE_LABEL[e.engine]}</strong> is on another page: <span class="wrap-anywhere text-muted">{e.url}</span>. It isn’t included below.
              </span>
            </p>
          ))}
        </div>
      )}

      {/* Connection */}
      <section class={cx(row, 'border-b border-line')}>
        {kind === 'secure' ? (
          <Lock size={16} class="mt-px flex-none text-webkit" />
        ) : kind === 'insecure' ? (
          <LockOpen size={16} class="mt-px flex-none text-danger" />
        ) : (
          <Info size={16} class="mt-px flex-none text-muted" />
        )}
        <div class="min-w-0 flex-1 space-y-1.5">
          <p class="font-medium">
            {kind === 'secure' ? 'Connection is secure' : kind === 'insecure' ? 'Connection is not secure' : 'Local or internal page'}
          </p>
          <p class="text-xs text-muted">
            {kind === 'secure'
              ? 'Information you send to this site (passwords, card numbers) is private when it is sent.'
              : kind === 'insecure'
                ? 'Information sent to this site can be read or changed by others on the network. Avoid entering passwords or payment details.'
                : 'This page is served from this computer or by the browser itself.'}
          </p>
          {kind !== 'none' && <NetworkNote url={url} network={network} />}
          {certs.length > 0 && (
            <>
              <button type="button" class="inline-flex items-center gap-1 text-xs text-accent" onClick={() => setShowCert((s) => !s)} aria-expanded={showCert}>
                {showCert ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span class="trim-cap">Certificate {showCert ? '' : `· ${certs[0].certificate!.issuer ?? 'details'}`}</span>
              </button>
              {showCert && (
                <div class="space-y-2 pt-1">
                  {engines.map((e) => (
                    <EngineBlock key={e.paneId} e={e}>
                      {e.certificate ? (
                        <dl class="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
                          <dt class="text-muted">Issued to</dt>
                          <dd class="wrap-anywhere">{e.certificate.subject ?? '—'}</dd>
                          <dt class="text-muted">Issued by</dt>
                          <dd class="wrap-anywhere">{e.certificate.issuer ?? '—'}</dd>
                          <dt class="text-muted">Valid</dt>
                          <dd>
                            {date(e.certificate.validFrom)} – {date(e.certificate.validTo)}
                          </dd>
                          <dt class="text-muted">Protocol</dt>
                          <dd>{e.certificate.protocol ?? '—'}</dd>
                        </dl>
                      ) : (
                        <p class="text-xs text-muted">{e.secure ? 'This engine didn’t report certificate details.' : 'Not over HTTPS here.'}</p>
                      )}
                    </EngineBlock>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* Cookies and site data */}
      <section class={cx(row, 'border-b border-line')}>
        <Cookie size={16} class="mt-px flex-none text-muted" />
        <div class="min-w-0 flex-1 space-y-2">
          <p class="font-medium">Cookies and site data</p>
          {!info ? (
            <p class="text-xs text-muted">Loading…</p>
          ) : (
            engines.length > 0 && (
              <table class={TABLE}>
                <thead>
                  <tr>
                    <td />
                    <th scope="col" class={TH}>Cookies</th>
                    <th scope="col" class={TH}>Local</th>
                    <th scope="col" class={TH}>Session</th>
                  </tr>
                </thead>
                <tbody>
                  {engines.map((e) => (
                    <tr key={e.paneId}>
                      <th scope="row" class={TH_ROW}>
                        <EngineName e={e} />
                      </th>
                      <td class={TD}>{e.cookies.length}</td>
                      <td class={TD}>{e.localStorage}</td>
                      <td class={TD}>{e.sessionStorage}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          )}
          {/* One row of actions; the cookie list opens below it, so neither button moves. */}
          <div class="flex flex-wrap items-center justify-between gap-2 pt-1">
            {engines.some((e) => e.cookies.length) ? (
              <button type="button" class="inline-flex items-center gap-1 text-xs text-accent" onClick={() => setShowCookies((s) => !s)} aria-expanded={showCookies}>
                {showCookies ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                <span class="trim-cap">{showCookies ? 'Hide cookies' : 'Show cookies'}</span>
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              class={btn(confirming ? 'danger' : 'outline', { small: true })}
              disabled={!origin.startsWith('http')}
              onClick={() => {
                if (!confirming) return setConfirming(true);
                setConfirming(false);
                client.send({ type: 'clearSiteData', origin });
              }}
              onBlur={() => setConfirming(false)}
              title={`Delete ${host}'s cookies, localStorage, sessionStorage and IndexedDB in every engine, including the saved data of engines that are off`}
            >
              <Trash2 size={12} />
              <span class="trim-cap">{confirming ? 'Click again to clear in all engines' : 'Clear site data in all engines'}</span>
            </button>
          </div>
          {showCookies && engines.some((e) => e.cookies.length) && (
            <div class="max-h-48 space-y-2 overflow-auto pr-1">
              {engines.map((e) => (
                <EngineBlock key={e.paneId} e={e}>
                  {e.cookies.length === 0 ? (
                    <p class="text-xs text-muted">No cookies.</p>
                  ) : (
                    <table class={cx(TABLE, 'font-mono text-[11px]')}>
                      <tbody>
                        {e.cookies.map((c) => (
                          <tr key={`${c.domain}|${c.name}`}>
                            <td class="py-px pr-3 align-baseline text-fg">{c.name}</td>
                            <td class="py-px pr-3 align-baseline text-muted">{c.domain}</td>
                            <td class="py-px align-baseline font-sans text-[10px] text-muted">
                              {[c.secure && 'Secure', c.httpOnly && 'HttpOnly', c.sameSite, c.session && 'Session'].filter(Boolean).join(' · ')}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </EngineBlock>
              ))}
            </div>
          )}
        </div>
      </section>

      {/* Permissions */}
      <section class={row}>
        <ShieldCheck size={16} class="mt-px flex-none text-muted" />
        <div class="min-w-0 flex-1 space-y-2">
          <p class="font-medium">Permissions</p>
          {!info ? (
            <p class="text-xs text-muted">Loading…</p>
          ) : (
            <table class={TABLE}>
              <thead>
                <tr>
                  <td />
                  {engines.map((e) => (
                    <th key={e.paneId} scope="col" class={TH}>
                      <EngineName e={e} muted />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Object.keys(PERMISSION_LABEL).map((name) => (
                  <PermissionRow key={name} name={name} engines={engines} />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </>
  );
}

function EngineBlock({ e, children }: { e: SiteInfoEngine; children: ComponentChildren }) {
  return (
    <div class={ENGINE_CLASS[e.engine]}>
      <p class="mb-0.5 inline-flex items-center gap-1.5 text-xs font-medium">
        <EngineDot />
        <span class="trim-cap">{ENGINE_LABEL[e.engine]}</span>
      </p>
      {children}
    </div>
  );
}

/** Tables without borders: the columns line up, spacing does the rest. */
const TABLE = 'border-separate border-spacing-0 text-left text-xs';
const TH = 'pb-1 pr-4 align-bottom font-normal text-muted';
const TH_ROW = 'py-0.5 pr-4 text-left font-normal';
const TD = 'py-0.5 pr-4 tabular-nums';

function EngineName({ e, muted }: { e: SiteInfoEngine; muted?: boolean }) {
  return (
    <span class={cx('inline-flex items-center gap-1.5 whitespace-nowrap', muted && 'text-muted', ENGINE_CLASS[e.engine])}>
      <EngineDot />
      <span class="trim-cap">{ENGINE_LABEL[e.engine]}</span>
    </span>
  );
}

const STATE_CLASS: Record<string, string> = { granted: 'text-webkit', denied: 'text-danger', prompt: 'text-muted', unsupported: 'text-muted/60' };
const STATE_LABEL: Record<string, string> = { granted: 'Allowed', denied: 'Blocked', prompt: 'Ask', unsupported: '—' };

function PermissionRow({ name, engines }: { name: string; engines: SiteInfoEngine[] }) {
  const states = engines.map((e) => e.permissions[name] ?? 'unsupported');
  const differs = new Set(states).size > 1;
  return (
    <tr>
      <th scope="row" class={cx(TH_ROW, differs && 'font-medium')} title={differs ? 'The engines report different states' : undefined}>
        {PERMISSION_LABEL[name]}
      </th>
      {states.map((s, i) => (
        <td key={i} class={cx(TD, STATE_CLASS[s] ?? 'text-muted')} title={s === 'unsupported' ? 'Not supported by this engine' : s}>
          {STATE_LABEL[s] ?? s}
        </td>
      ))}
    </tr>
  );
}

/** When the engines go through --proxy or ignore certificate errors, "secure" means less: say so. */
function NetworkNote({ url, network }: { url: string; network: NetworkInfo | null }) {
  if (!network?.proxy && !network?.ignoreCertErrors) return null;
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // not a URL
  }
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host);
  const proxied = !!network.proxy && !(local && !network.proxyLoopback) && !network.bypass.some((b) => b === host || (b.startsWith('*.') && host.endsWith(b.slice(1))));
  if (!proxied && !network.ignoreCertErrors) return null;
  return (
    <div class="flex items-start gap-1.5 rounded-md border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs">
      <TriangleAlert size={12} class="mt-px flex-none text-warn" />
      <span class="min-w-0">
        {proxied && (
          <>
            Traffic goes through the proxy <span class="wrap-anywhere font-mono text-[11px]">{network.proxy}</span>. A proxy that
            inspects HTTPS presents its own certificate, which is what the engines report here.{' '}
          </>
        )}
        {network.ignoreCertErrors && <>Certificate errors are ignored (--ignore-cert-errors), so an invalid certificate isn’t flagged.</>}
      </span>
    </div>
  );
}
