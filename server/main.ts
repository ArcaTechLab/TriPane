import { parseArgs } from 'node:util';
import { normalizeUrl } from '../shared/protocol';
import { serveMcpStdio } from './mcp';
import { networkInfo, parseProxy, type NetworkOptions } from './proxy';
import { startServer } from './server';
import {
  ENGINES,
  isPlaywrightDownloadChild,
  missingEngines,
  runPlaywrightCli,
  runPlaywrightDownloadChild,
  STANDALONE,
  VERSION,
} from './standalone';
import { DEFAULT_PROFILE_DIR } from './storage';
import { openAppWindow, type AppWindow } from './window';

// In a standalone build, Playwright's browser downloads re-run this binary as a child process.
if (isPlaywrightDownloadChild()) {
  await runPlaywrightDownloadChild();
  await new Promise(() => {}); // the downloader exits the process when it's done
}

const USAGE = STANDALONE ? 'tripane [options]' : 'bun server/main.ts [options]   (or: bun start)';
const HELP = `TriPane ${VERSION}: one URL in Chromium, Firefox and WebKit, side by side.

Usage: ${USAGE}
       ${STANDALONE ? 'tripane' : 'bun server/main.ts'} install        download the browser builds TriPane uses
       ${STANDALONE ? 'tripane' : 'bun server/main.ts'} install-deps   install the system libraries they need (Linux, uses sudo)
       ${STANDALONE ? 'tripane' : 'bun server/main.ts'} mcp            run as an MCP server on stdin/stdout, for AI agents
                                    (opens the window too, so you can watch; add --no-window to hide it)

  --url <url>      page to open first (default: the built-in welcome page)
  --port <n>       port for the UI server (default: random)
  --profile <dir>  where cookies and site storage are saved between runs
                   (default: ~/.tripane/storage)
  --no-persist     fresh session: don't load or save cookies and storage
  --no-window      don't open the app window; just print the URL
  --proxy <url>    send every engine's traffic through a proxy: host:port,
                   http://[user:pass@]host:port, https://… or socks5://host:port
  --proxy-bypass <hosts>  comma-separated hosts that skip the proxy (e.g. "*.corp,10.0.0.0/8");
                   localhost always goes direct unless --proxy-loopback
  --proxy-loopback send localhost traffic through the proxy too
  --ignore-cert-errors  accept any HTTPS certificate in every engine (for proxies that
                   re-sign traffic, like mitmproxy, when their CA isn't trusted)
  --dev            hot-reload the UI (Bun HMR)
  -v, --version    print the version
  -h, --help       show this help`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string' },
    port: { type: 'string' },
    profile: { type: 'string' },
    'no-persist': { type: 'boolean', default: false },
    'no-window': { type: 'boolean', default: false },
    proxy: { type: 'string' },
    'proxy-bypass': { type: 'string' },
    'proxy-loopback': { type: 'boolean', default: false },
    'ignore-cert-errors': { type: 'boolean', default: false },
    dev: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false },
  },
});

if (values.help) {
  console.log(HELP);
  process.exit(0);
}
if (values.version) {
  console.log(`TriPane ${VERSION}`);
  process.exit(0);
}

const [command, ...rest] = positionals;
if (command === 'install' || command === 'install-deps') {
  await runPlaywrightCli([command, ...(rest.length ? rest : ENGINES)]);
  process.exit(process.exitCode ?? 0);
}
const mcpMode = command === 'mcp';
// In MCP mode stdout carries the protocol; everything else (our messages, Playwright's
// download progress) goes to stderr.
const protocolOut = process.stdout.write.bind(process.stdout);
if (mcpMode) {
  process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;
  console.log = console.error;
  console.info = console.error;
} else if (command) {
  console.error(`Unknown command: ${command}\n\n${HELP}`);
  process.exit(2);
}

// First run of a standalone build: fetch the browser builds before starting.
const missing = missingEngines();
if (missing.length) {
  console.log(`Downloading the browser builds TriPane needs (${missing.join(', ')}). This happens once.`);
  await runPlaywrightCli(['install', ...ENGINES]);
  if (process.exitCode) {
    console.error(`Couldn't install the browsers. Try again with: ${STANDALONE ? 'tripane' : 'bun server/main.ts'} install`);
    process.exit(process.exitCode);
  }
}

let network: NetworkOptions | undefined;
try {
  if (values.proxy) network = { proxy: parseProxy(values.proxy, values['proxy-bypass'], values['proxy-loopback']), proxyLoopback: values['proxy-loopback'] };
  else if (values['proxy-bypass'] || values['proxy-loopback']) throw new Error('--proxy-bypass and --proxy-loopback need --proxy.');
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
}
if (values['ignore-cert-errors']) network = { ...network, ignoreCertErrors: true };

let appWindow: AppWindow | undefined;

const server = await startServer({
  port: values.port ? Number(values.port) : undefined,
  dev: values.dev,
  startUrl: values.url ? normalizeUrl(values.url) : undefined,
  profileDir: values['no-persist'] ? undefined : (values.profile ?? DEFAULT_PROFILE_DIR),
  onSettings: (s) => void appWindow?.setTheme(s.uiTheme),
  autoCheckUpdates: true,
  network,
});
console.log(`TriPane is running at ${server.appUrl}`);
if (!mcpMode) console.log(`MCP endpoint for AI agents: ${server.mcpUrl}`);
const net = networkInfo(network);
if (net.proxy) console.log(`Proxy: ${net.proxy}${net.proxyLoopback ? ' (localhost too)' : ''}${net.bypass.length ? `, except ${net.bypass.join(', ')}` : ''}`);
if (net.ignoreCertErrors) console.log('Certificate errors are ignored in every engine (--ignore-cert-errors).');
console.log(values['no-persist'] ? 'Fresh session: cookies and storage are not saved.' : `Cookies and storage are saved in ${values.profile ?? DEFAULT_PROFILE_DIR}`);

// Answer the MCP client right away; tools wait until the engines are up. The client closing
// stdin ends the session.
if (mcpMode) void serveMcpStdio(server.mcp, (line) => protocolOut(line)).then(() => shutdown());

let stopping = false;

async function shutdown(code = 0): Promise<never> {
  if (!stopping) {
    stopping = true;
    console.log('Shutting down…');
    await appWindow?.close();
    await server.close();
  }
  process.exit(code);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.on('SIGHUP', () => void shutdown()); // the terminal was closed

if (!values['no-window']) {
  try {
    appWindow = await openAppWindow(server.appUrl, server.settings.uiTheme);
    appWindow.context.on('close', () => void shutdown());
    // Closing the main window quits, even if a popped-out DevTools window is still open.
    appWindow.page.on('close', () => void shutdown());
  } catch (err) {
    const reason = err instanceof Error ? err.message.split('\n')[0] : String(err);
    console.log(`Could not open the app window (${reason}).`);
    console.log('Open the URL above in any browser instead. Press Ctrl+C to quit.');
  }
}

await server.ready;
for (const p of server.panes) {
  console.log(`  ${p.engine.padEnd(9)} ${p.info.failed ? `FAILED: ${p.info.failed}` : p.info.version}`);
}
