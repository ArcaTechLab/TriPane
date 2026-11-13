// Sets the icon and version details of a Windows executable built by `bun build --compile`, on
// any build machine.
//
// Bun can do this itself (compile.windows.icon, --windows-icon), but only when the build runs on
// Windows; cross-compiling, the Bun.build API drops those options without a word. resedit can
// edit PE resources anywhere, but its writer refuses files with a section after .rsrc, and Bun
// appends its own `.bun` section (the bundled app) there. So: resedit parses and regenerates the
// resource table, and we write it back over the old .rsrc in place, at the same address and no
// larger. Every other byte of the file stays as Bun wrote it; only the .rsrc contents, the
// resource directory size and the PE checksum change.
import * as ResEdit from 'resedit';

export interface WindowsResources {
  icon: Uint8Array; // .ico file
  productName: string;
  description: string;
  version: string; // a.b.c
  exeName: string;
}

const RESOURCE_DIRECTORY = 2; // IMAGE_DIRECTORY_ENTRY_RESOURCE
const EN_US = 1033;
const UNICODE = 1200;

export function setWindowsResources(file: Uint8Array, opts: WindowsResources): Buffer {
  const out = Buffer.from(file);
  const exe = ResEdit.NtExecutable.from(out, { ignoreCert: true });
  const section = exe.getSectionByEntry(RESOURCE_DIRECTORY);
  if (!section?.data) throw new Error('The executable has no resource section.');

  // NtExecutableResource.from() would refuse this file (see above); parse() is what it calls.
  const res = Object.create(ResEdit.NtExecutableResource.prototype) as unknown as {
    entries: Parameters<typeof ResEdit.Resource.IconGroupEntry.replaceIconsForResource>[0];
    parse(s: typeof section, ignoreUnparsable: boolean): void;
    generateResourceData(va: number, align: number, noGrow: boolean, allowShrink: boolean): { bin: ArrayBuffer; rawSize: number };
  };
  res.parse(section, false);

  // Icon: replace the executable's icon group (Bun's own icon) or add one.
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const ico = ResEdit.Data.IconFile.from(opts.icon);
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
    res.entries,
    groups[0]?.id ?? 1,
    groups[0]?.lang ?? EN_US,
    ico.icons.map((i) => i.data),
  );

  // Version details (file properties, Task Manager, "Open with").
  const [major, minor, patch] = opts.version.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const vi = ResEdit.Resource.VersionInfo.fromEntries(res.entries)[0] ?? ResEdit.Resource.VersionInfo.createEmpty();
  const langs = vi.getAllLanguagesForStringValues();
  for (const lang of langs.length ? langs : [{ lang: EN_US, codepage: UNICODE }]) {
    vi.setStringValues(lang, {
      ProductName: opts.productName,
      FileDescription: opts.description,
      InternalName: opts.exeName.replace(/\.exe$/i, ''),
      OriginalFilename: opts.exeName,
      CompanyName: '',
      LegalCopyright: '',
    });
    vi.setFileVersion(major, minor, patch, 0, lang.lang as number);
    vi.setProductVersion(major, minor, patch, 0, lang.lang as number);
  }
  vi.outputToResourceEntries(res.entries);

  // Regenerate at the same RVA; noGrow throws if it doesn't fit the old section.
  const { bin, rawSize } = res.generateResourceData(section.info.virtualAddress, exe.getFileAlignment(), true, false);
  if (bin.byteLength !== section.info.sizeOfRawData) throw new Error(`Resource data is ${bin.byteLength} bytes; expected ${section.info.sizeOfRawData}.`);
  out.set(new Uint8Array(bin), section.info.pointerToRawData);

  // The resource data directory's size. (The section header stays as it was: same address and
  // size; the rest of the section is padding.)
  const pe = out.readUInt32LE(0x3c);
  if (out.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error('Not a PE file.');
  const opt = pe + 24;
  const pe32plus = out.readUInt16LE(opt) === 0x20b;
  const dirs = opt + (pe32plus ? 112 : 96);
  if (out.readUInt32LE(dirs + RESOURCE_DIRECTORY * 8) !== section.info.virtualAddress) throw new Error('Unexpected resource directory address.');
  out.writeUInt32LE(rawSize, dirs + RESOURCE_DIRECTORY * 8 + 4);

  // PE checksum (Windows checks it only for drivers, but keep it right).
  const checksumAt = opt + 64;
  out.writeUInt32LE(0, checksumAt);
  out.writeUInt32LE(peChecksum(out), checksumAt);
  return out;
}

function peChecksum(buf: Buffer): number {
  let sum = 0;
  const words = buf.length >> 1;
  for (let i = 0; i < words; i++) {
    sum += buf[i * 2] | (buf[i * 2 + 1] << 8);
    sum = (sum & 0xffff) + (sum >>> 16);
  }
  if (buf.length & 1) sum = ((sum + buf[buf.length - 1]) & 0xffff) + ((sum + buf[buf.length - 1]) >>> 16);
  sum = (sum & 0xffff) + (sum >>> 16);
  return (sum + buf.length) >>> 0;
}
