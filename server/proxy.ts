// --proxy: send every engine's traffic through one proxy (mitmproxy, Charles, a corporate proxy…).
import type { LaunchOptions } from 'playwright';
import type { NetworkInfo } from '../shared/protocol';

export interface NetworkOptions {
  proxy?: NonNullable<LaunchOptions['proxy']>;
  /** Accept any certificate: needed for a proxy that re-signs HTTPS (mitmproxy) unless its CA is trusted. */
  ignoreCertErrors?: boolean;
  /** Send localhost traffic through the proxy too (--proxy-loopback). */
  proxyLoopback?: boolean;
}


const SCHEMES = ['http:', 'https:', 'socks4:', 'socks5:'];
/** Local addresses go direct, in every engine (Chromium does this by itself; the others don't). */
export const LOOPBACK = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Parses --proxy ("host:port", "http://user:pass@host:port", "socks5://host:port") and
 * --proxy-bypass ("*.internal.example, 10.0.0.0/8"). Throws with a message for the user.
 */
export function parseProxy(input: string, bypass = '', includeLoopback = false): NonNullable<LaunchOptions['proxy']> {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    throw new Error(`--proxy: "${input}" isn't a proxy address. Use host:port, http://host:port or socks5://host:port.`);
  }
  if (!SCHEMES.includes(url.protocol)) throw new Error(`--proxy: unsupported scheme "${url.protocol.slice(0, -1)}". Use http, https, socks4 or socks5.`);
  if (!url.hostname) throw new Error(`--proxy: "${input}" has no host.`);
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new Error(`--proxy: "${input}" should be just scheme://host:port.`);
  const username = decodeURIComponent(url.username);
  const password = decodeURIComponent(url.password);
  if (username && url.protocol.startsWith('socks')) throw new Error('--proxy: SOCKS proxies with a username and password aren’t supported by the engines.');
  const port = url.port || { 'http:': '80', 'https:': '443', 'socks4:': '1080', 'socks5:': '1080' }[url.protocol];
  const hosts = bypass
    .split(/[,\s]+/)
    .map((h) => h.trim())
    .filter(Boolean);
  if (!includeLoopback) for (const h of LOOPBACK) if (!hosts.includes(h)) hosts.push(h);
  return {
    server: `${url.protocol}//${url.hostname}:${port}`,
    ...(hosts.length ? { bypass: hosts.join(',') } : {}),
    ...(username ? { username, password } : {}),
  };
}

export function networkInfo(net: NetworkOptions | undefined): NetworkInfo {
  return {
    proxy: net?.proxy ? `${net.proxy.server}${net.proxy.username ? ` (as ${net.proxy.username})` : ''}` : null,
    bypass: net?.proxy?.bypass ? net.proxy.bypass.split(',') : [],
    proxyLoopback: !!net?.proxyLoopback,
    ignoreCertErrors: !!net?.ignoreCertErrors,
  };
}
