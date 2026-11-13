// --proxy, --proxy-bypass, --proxy-loopback and --ignore-cert-errors, in all three engines.
import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'bun';
import { networkInfo, parseProxy } from '../server/proxy';
import { startServer, type TriPaneServer } from '../server/server';

setDefaultTimeout(120_000);

// ---- parsing ------------------------------------------------------------------------------------

test('parseProxy: forms, credentials, bypass, and clear errors', () => {
  expect(parseProxy('127.0.0.1:8080')).toEqual({ server: 'http://127.0.0.1:8080', bypass: 'localhost,127.0.0.1,[::1]' });
  expect(parseProxy('http://alice:p%40ss@proxy.corp:3128', '*.corp, 10.0.0.0/8')).toEqual({
    server: 'http://proxy.corp:3128',
    bypass: '*.corp,10.0.0.0/8,localhost,127.0.0.1,[::1]',
    username: 'alice',
    password: 'p@ss',
  });
  expect(parseProxy('socks5://127.0.0.1', '', true)).toEqual({ server: 'socks5://127.0.0.1:1080' });
  expect(() => parseProxy('ftp://x:1')).toThrow(/unsupported scheme/);
  expect(() => parseProxy('socks5://u:p@h:1')).toThrow(/SOCKS/);
  expect(() => parseProxy('http://h:1/path')).toThrow(/just scheme/);
  expect(networkInfo({ proxy: parseProxy('http://alice:secret@h:1'), ignoreCertErrors: true })).toEqual({
    proxy: 'http://h:1 (as alice)',
    bypass: ['localhost', '127.0.0.1', '[::1]'],
    proxyLoopback: false,
    ignoreCertErrors: true,
  });
});

// ---- engines ------------------------------------------------------------------------------------

/** A forward proxy that wants a login, answers for tripane-proxy.test itself, and forwards the rest. */
let proxy: HttpServer;
let proxyPort = 0;
const seen: string[] = [];
let site: Server<undefined>;
let https: Server<undefined> | null = null;
let certDir = '';
let tripane: TriPaneServer | undefined;

beforeAll(async () => {
  proxy = createServer(async (req, res) => {
    const auth = req.headers['proxy-authorization'];
    if (auth !== `Basic ${Buffer.from('alice:secret').toString('base64')}`) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="test"' }).end();
      return;
    }
    seen.push(req.url ?? '');
    const target = new URL(req.url ?? '/');
    if (target.hostname === 'tripane-proxy.test') {
      res.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><title>via proxy</title><p>proxied');
      return;
    }
    const upstream = await fetch(target, { headers: { accept: String(req.headers.accept ?? '*/*') } }).catch(() => null);
    if (!upstream) return void res.writeHead(502).end();
    res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'text/plain' }).end(Buffer.from(await upstream.arrayBuffer()));
  });
  await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
  proxyPort = (proxy.address() as { port: number }).port;

  site = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('<!doctype html><title>local site</title>', { headers: { 'content-type': 'text/html' } }) });

  // A self-signed HTTPS server, for --ignore-cert-errors.
  certDir = await mkdtemp(join(tmpdir(), 'tripane-cert-'));
  const made = Bun.spawnSync(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem')], { stderr: 'ignore' });
  if (made.exitCode === 0) {
    https = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      tls: { key: Bun.file(join(certDir, 'key.pem')), cert: Bun.file(join(certDir, 'cert.pem')) },
      fetch: () => new Response('<!doctype html><title>self-signed</title>', { headers: { 'content-type': 'text/html' } }),
    });
  }
});

afterAll(async () => {
  await tripane?.close();
  proxy?.close();
  site?.stop(true);
  https?.stop(true);
  if (certDir) await rm(certDir, { recursive: true, force: true });
});

async function titles(t: TriPaneServer, url: string, want: string): Promise<string[]> {
  await Promise.all(t.panes.map((p) => p.goto(url)));
  const end = Date.now() + 20_000;
  while (Date.now() < end && !t.panes.every((p) => p.info.title === want)) await Bun.sleep(100);
  return t.panes.map((p) => p.info.title);
}

test('every engine goes through the proxy, with its login; localhost goes direct', async () => {
  tripane = await startServer({
    startUrl: 'about:blank',
    viewport: { width: 800, height: 600 },
    network: { proxy: parseProxy(`http://alice:secret@127.0.0.1:${proxyPort}`) },
  });
  await tripane.ready;
  expect(await titles(tripane, 'http://tripane-proxy.test/', 'via proxy')).toEqual(['via proxy', 'via proxy', 'via proxy']);

  seen.length = 0;
  const local = `http://127.0.0.1:${site.port}/`;
  expect(await titles(tripane, local, 'local site')).toEqual(['local site', 'local site', 'local site']);
  expect(seen.filter((u) => u.startsWith(local))).toEqual([]);
  await tripane.close();
  tripane = undefined;
});

test('--proxy-loopback sends localhost through the proxy too', async () => {
  tripane = await startServer({
    startUrl: 'about:blank',
    viewport: { width: 800, height: 600 },
    network: { proxy: parseProxy(`http://alice:secret@127.0.0.1:${proxyPort}`, '', true), proxyLoopback: true },
  });
  await tripane.ready;
  seen.length = 0;
  const local = `http://127.0.0.1:${site.port}/loop`;
  expect(await titles(tripane, local, 'local site')).toEqual(['local site', 'local site', 'local site']);
  expect(seen.filter((u) => u === local).length).toBeGreaterThanOrEqual(3); // one per engine
  await tripane.close();
  tripane = undefined;
});

test('--ignore-cert-errors opens a self-signed HTTPS site in every engine', async () => {
  if (!https) return console.warn('openssl not available; skipped');
  const url = `https://127.0.0.1:${https.port}/`;
  tripane = await startServer({ startUrl: 'about:blank', viewport: { width: 800, height: 600 } });
  await tripane.ready;
  expect(await titles(tripane, url, 'self-signed')).not.toContain('self-signed'); // refused without the flag
  await tripane.close();

  tripane = await startServer({ startUrl: 'about:blank', viewport: { width: 800, height: 600 }, network: { ignoreCertErrors: true } });
  await tripane.ready;
  expect(await titles(tripane, url, 'self-signed')).toEqual(['self-signed', 'self-signed', 'self-signed']);
});
