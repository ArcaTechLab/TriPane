// Builds the distribution: TriPane compiled into one self-contained executable per platform
// (server, UI, Tailwind CSS and Playwright inside; no Bun or node_modules needed to run it),
// packed into dist/ with a short README and SHA-256 checksums.
//
//   bun run dist                     this machine's platform
//   bun run dist --all               Linux, macOS and Windows (x64 and arm64 where available)
//   bun run dist --target linux-x64  one or more specific targets (repeatable)
//
// The browsers are not embedded (several hundred MB): the binary downloads Playwright's builds
// of Chromium, Firefox and WebKit on first start, or with `tripane install`.
import type { BunPlugin } from 'bun';
import tailwind from 'bun-plugin-tailwind';
import { createHash } from 'node:crypto';
import { chmod, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import pkg from '../package.json' with { type: 'json' };
import playwrightPkg from 'playwright-core/package.json' with { type: 'json' };
import { setWindowsResources } from './windows-resources';

/**
 * Playwright loads its package.json and browsers.json at runtime with
 * require(path.join(packageRoot, '…')), where packageRoot comes from __dirname. In a compiled
 * binary __dirname is the *build machine's* path and those files aren't embedded, so the binary
 * only works where it was built ("Cannot find module …\node_modules\playwright-core\package.json").
 * This rewrites those requires into static ones, which Bun bundles into the binary.
 */
const PLAYWRIGHT_JSON_REQUIRE = /require\(import_path\d*\.default\.join\(packageRoot, "(package|browsers)\.json"\)\)/g;
function embedPlaywrightFiles(): BunPlugin & { rewritten: Map<string, number> } {
  const rewritten = new Map<string, number>();
  return {
    name: 'embed-playwright-files',
    rewritten,
    setup(build) {
      build.onLoad({ filter: /playwright-core[\\/]lib[\\/][^\\/]+\.js$/ }, async ({ path }) => {
        const source = await Bun.file(path).text();
        let count = 0;
        const contents = source.replace(PLAYWRIGHT_JSON_REQUIRE, (_m, name: string) => {
          count++;
          return `require("../${name}.json")`;
        });
        if (count) rewritten.set(path.split(/[\\/]/).pop()!, count);
        return { contents, loader: 'js' };
      });
    },
  };
}

/**
 * Playwright's Trace Viewer (Tools → Record trace) is a static web app in playwright-core. Its
 * files are embedded by replacing server/trace-viewer-files.ts with a module that imports each
 * one as a file (Bun keeps those inside the binary) and maps its path to where Bun put it.
 */
async function embedTraceViewer(): Promise<BunPlugin & { files: number }> {
  const root = join(dirname(Bun.resolveSync('playwright-core/package.json', import.meta.dir)), 'lib', 'vite', 'traceViewer');
  const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => relative(root, join(e.parentPath, e.name)).split('\\').join('/'));
  const source =
    files.map((f, i) => `import f${i} from ${JSON.stringify(join(root, f))} with { type: 'file' };`).join('\n') +
    `\nexport const TRACE_VIEWER_FILES: Record<string, string> | null = {\n${files.map((f, i) => `  ${JSON.stringify(f)}: f${i},`).join('\n')}\n};\n`;
  return {
    name: 'embed-trace-viewer',
    files: files.length,
    setup(build) {
      build.onLoad({ filter: /server[\\/]trace-viewer-files\.ts$/ }, () => ({ contents: source, loader: 'ts' }));
    },
  };
}

const ALL_TARGETS = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64', 'windows-x64'] as const;
type Target = (typeof ALL_TARGETS)[number];

const { values } = parseArgs({
  options: {
    all: { type: 'boolean', default: false },
    target: { type: 'string', multiple: true },
  },
});

const host = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}` as Target;
const targets: Target[] = values.all ? [...ALL_TARGETS] : ((values.target as Target[] | undefined) ?? [host]);
for (const t of targets) if (!ALL_TARGETS.includes(t)) throw new Error(`Unknown target ${t}. Known: ${ALL_TARGETS.join(', ')}`);

const ROOT = resolve(import.meta.dir, '..');
const DIST = join(ROOT, 'dist');
// Generated from assets/icon.svg by `bun run icons`.
const ICON_ICO = join(ROOT, 'assets/icon.ico');
const ICON_PNG = join(ROOT, 'assets/icon.png');
for (const f of [ICON_ICO, ICON_PNG]) if (!(await Bun.file(f).exists())) throw new Error(`${f} is missing; run \`bun run icons\`.`);

/** A launcher for Linux desktops: install it and icon.png as the comment in it says. */
const desktopEntry = `[Desktop Entry]
# To add TriPane to your applications menu, copy this file to ~/.local/share/applications/,
# icon.png to ~/.local/share/icons/tripane.png, and set Exec to where you keep the tripane binary.
Type=Application
Name=TriPane
GenericName=Cross-engine browser
Comment=One page in Chromium, Firefox and WebKit, side by side
Exec=tripane
Icon=tripane
Terminal=false
Categories=Development;WebDevelopment;
`;
process.chdir(ROOT); // Tailwind scans the UI sources relative to here
await mkdir(DIST, { recursive: true });

const readme = (target: Target, exe: string) => `TriPane ${pkg.version} (${target})
${'='.repeat(`TriPane ${pkg.version} (${target})`.length)}

One URL in Chromium, Firefox and WebKit, side by side, with synced input, DevTools for every
engine, element compare and device emulation.

Run it:

    ${target.startsWith('windows') ? exe : `./${exe}`}

On first start it downloads the browser builds it uses (Playwright ${playwrightPkg.version}:
Chromium, Firefox and WebKit, about 500 MB) into the shared Playwright cache, then opens its
window. Run \`${exe} --help\` for the options.

${
  target.startsWith('linux')
    ? `Linux: Firefox and WebKit need some system libraries. If an engine reports that it could not
start, install them once with:

    sudo ./${exe} install-deps

`
    : target.startsWith('darwin')
      ? `macOS: the binary isn't signed. If macOS refuses to open it, run once:

    xattr -d com.apple.quarantine ./${exe}

`
      : ''
}Cookies and site storage are saved in ~/.tripane/storage (use --no-persist for a fresh
session); screenshots go to ~/.tripane/screenshots, traces to ~/.tripane/traces.
`;

async function run(cmd: string[], cwd: string) {
  const p = Bun.spawn(cmd, { cwd, stdout: 'inherit', stderr: 'inherit' });
  if ((await p.exited) !== 0) throw new Error(`${cmd.join(' ')} failed`);
}

const sums: string[] = [];
for (const target of targets) {
  const name = `tripane-${pkg.version}-${target}`;
  const dir = join(DIST, name);
  const exe = target.startsWith('windows') ? 'tripane.exe' : 'tripane';
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  console.log(`Building ${name}…`);
  const embed = embedPlaywrightFiles();
  const traceViewer = await embedTraceViewer();
  if (traceViewer.files < 5) throw new Error(`Playwright's Trace Viewer wasn't found (${traceViewer.files} files)`);
  const result = await Bun.build({
    entrypoints: [join(ROOT, 'server/main.ts')],
    compile: {
      target: `bun-${target}` as Bun.Build.CompileTarget,
      outfile: join(dir, exe),
    },
    plugins: [tailwind, embed, traceViewer],
    // Names are kept so stack traces stay readable without shipping source maps.
    minify: { whitespace: true, syntax: true, identifiers: false },
    sourcemap: 'none',
    define: {
      'process.env.TRIPANE_STANDALONE': '"1"',
      'process.env.TRIPANE_VERSION': JSON.stringify(pkg.version),
    },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`build failed for ${target}`);
  }
  // Both files must have been embedded from Playwright's main bundle; if a Playwright upgrade
  // changes that code, fail here rather than ship a binary that only runs on this machine.
  if ((embed.rewritten.get('coreBundle.js') ?? 0) < 2) {
    throw new Error(
      `Couldn't embed Playwright's package.json and browsers.json (rewrote: ${JSON.stringify([...embed.rewritten])}). ` +
        'Check PLAYWRIGHT_JSON_REQUIRE against node_modules/playwright-core/lib/coreBundle.js.',
    );
  }
  if (target.startsWith('windows')) {
    // The app icon and version details in Explorer, the taskbar and the file properties.
    // (Linux and macOS executables can't carry an icon; their archives get icon.png instead.)
    const exePath = join(dir, exe);
    await Bun.write(
      exePath,
      setWindowsResources(await Bun.file(exePath).bytes(), {
        icon: await Bun.file(ICON_ICO).bytes(),
        productName: 'TriPane',
        description: 'TriPane: one page in Chromium, Firefox and WebKit, side by side',
        version: pkg.version,
        exeName: exe,
      }),
    );
  } else {
    await chmod(join(dir, exe), 0o755);
  }
  await Bun.write(join(dir, 'README.txt'), readme(target, exe));
  await Bun.write(join(dir, 'icon.png'), Bun.file(ICON_PNG));
  if (target.startsWith('linux')) await Bun.write(join(dir, 'tripane.desktop'), desktopEntry);

  // Archive: .zip for Windows when the zip tool is available, .tar.gz otherwise (Windows 10 and
  // later can extract both with the built-in tar).
  const archive = target.startsWith('windows') && Bun.which('zip') ? `${name}.zip` : `${name}.tar.gz`;
  await rm(join(DIST, archive), { force: true });
  if (archive.endsWith('.zip')) await run(['zip', '-qr', archive, name], DIST);
  else await run(['tar', '-czf', archive, name], DIST);

  const binarySize = (await stat(join(dir, exe))).size;
  await rm(dir, { recursive: true, force: true }); // keep only the archive
  const bytes = await Bun.file(join(DIST, archive)).bytes();
  sums.push(`${createHash('sha256').update(bytes).digest('hex')}  ${archive}`);
  const mb = (n: number) => `${(n / 1024 / 1024).toFixed(0)} MB`;
  console.log(`  ${archive}  ${mb(bytes.length)} (binary ${mb(binarySize)})`);
}

const sumsFile = join(DIST, 'SHA256SUMS');
const previous = (await Bun.file(sumsFile).exists()) ? (await Bun.file(sumsFile).text()).trim().split('\n') : [];
const built = new Set(sums.map((l) => l.split('  ')[1]));
await Bun.write(sumsFile, [...previous.filter((l) => l && !built.has(l.split('  ')[1])), ...sums].sort((a, b) => a.split('  ')[1].localeCompare(b.split('  ')[1])).join('\n') + '\n');
console.log(`Done. Archives and SHA256SUMS are in ${DIST}`);
