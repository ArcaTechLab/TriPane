// Renders assets/icon.svg (the three engine bars, also the UI's favicon) into the raster icons
// the distribution uses, so `bun run dist` doesn't need a browser or image tools:
//   assets/icon.png   512×512, shipped in every archive (Linux .desktop file, docs)
//   assets/icon.ico   16–256 px (bitmaps, PNG at 256), embedded into tripane.exe
// Run after changing icon.svg:  bun run icons
import { chromium } from 'playwright';
import { join, resolve } from 'node:path';
import { PNG } from 'pngjs';

const ASSETS = join(resolve(import.meta.dir, '..'), 'assets');
const svg = await Bun.file(join(ASSETS, 'icon.svg')).text();

const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const browser = await chromium.launch();
const page = await browser.newPage();
async function render(size: number): Promise<Buffer> {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  return page.screenshot({ omitBackground: true, type: 'png' });
}

await Bun.write(join(ASSETS, 'icon.png'), await render(512));
const images = [];
for (const size of ICO_SIZES) images.push({ size, png: await render(size) });
await browser.close();

/**
 * A 32-bit BMP icon image (DIB): BITMAPINFOHEADER, BGRA rows bottom-up, then the 1-bit AND mask
 * (1 = transparent) that older code paths still read. The height is doubled (image + mask).
 */
function dib(png: Buffer): Buffer {
  const { width, height, data } = PNG.sync.read(png);
  const maskRow = Math.ceil(width / 32) * 4;
  const out = Buffer.alloc(40 + width * height * 4 + maskRow * height);
  out.writeUInt32LE(40, 0); // header size
  out.writeInt32LE(width, 4);
  out.writeInt32LE(height * 2, 8);
  out.writeUInt16LE(1, 12); // planes
  out.writeUInt16LE(32, 14); // bits per pixel
  out.writeUInt32LE(width * height * 4 + maskRow * height, 20); // image size (no compression)
  const mask = 40 + width * height * 4;
  for (let y = 0; y < height; y++) {
    const row = height - 1 - y; // bottom-up
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = 40 + (row * width + x) * 4;
      out[d] = data[s + 2];
      out[d + 1] = data[s + 1];
      out[d + 2] = data[s];
      out[d + 3] = data[s + 3];
      if (data[s + 3] === 0) out[mask + row * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}

// ICO: a 6-byte header, a 16-byte directory entry per image, then the images. Windows expects
// classic bitmaps below 256 px (some icon code ignores small PNG frames, and Explorer's lists use
// those sizes); the 256 px image is PNG, as Windows itself does.
const frames = images.map(({ size, png }) => ({ size, data: size >= 256 ? png : dib(png) }));
const header = Buffer.alloc(6 + 16 * frames.length);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(frames.length, 4);
let offset = header.length;
frames.forEach(({ size, data }, i) => {
  const e = 6 + 16 * i;
  header.writeUInt8(size >= 256 ? 0 : size, e); // 0 means 256
  header.writeUInt8(size >= 256 ? 0 : size, e + 1);
  header.writeUInt8(0, e + 2); // palette colours
  header.writeUInt8(0, e + 3); // reserved
  header.writeUInt16LE(1, e + 4); // colour planes
  header.writeUInt16LE(32, e + 6); // bits per pixel
  header.writeUInt32LE(data.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += data.length;
});
await Bun.write(join(ASSETS, 'icon.ico'), Buffer.concat([header, ...frames.map((f) => f.data)]));
console.log(`Wrote icon.png (512 px) and icon.ico (${ICO_SIZES.join(', ')} px) to ${ASSETS}`);
