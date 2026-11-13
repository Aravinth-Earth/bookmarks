/**
 * Build the installable zip for the optional extension.
 *
 * The parcel is the `extension/` directory and nothing else: every regular file under it is added
 * once, in path order, with a fixed timestamp and no compression (the payload is small and mostly
 * PNG, which is already compressed). That makes two runs from the same checkout byte-identical,
 * so a release can be rebuilt and compared instead of trusted.
 *
 * There is no dependency here on purpose. A zip is a container, and writing one for this handful
 * of files is smaller than the dependency graph a zip library would bring to a repository whose
 * one promise is "no third-party code".
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, lstatSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DEFAULT_EXTENSION_DIR = join(ROOT, 'extension');
const DEFAULT_OUT_DIR = join(ROOT, 'dist');

/* 1980-01-01 00:00 is the earliest moment a zip can name, and naming a fixed one is what keeps the
   bytes the same from run to run. The date bits are (year-1980)<<9 | month<<5 | day. */
const FIXED_TIME = 0;
const FIXED_DATE = 0x0021;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * Every regular file under the extension, as forward-slash paths in path order.
 *
 * A symlink is refused rather than followed: a link that points at the machine it was made on
 * would put a file outside the repository inside the parcel, which is exactly what this script
 * promises not to do.
 */
function collectFiles(directory, base = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )) {
    const path = join(directory, entry.name);
    if (lstatSync(path).isSymbolicLink()) {
      throw new Error(`extension parcel: ${path} is a symlink; only files from this checkout may ship`);
    }
    if (entry.isDirectory()) {
      files.push(...collectFiles(path, base));
    } else if (entry.isFile()) {
      files.push({ path, name: relative(base, path).split(sep).join('/') });
    } else {
      throw new Error(`extension parcel: ${path} is not a regular file`);
    }
  }
  return files;
}

function localHeader(nameBuffer, data, crc) {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4); // version needed: 2.0, which is all a stored entry needs
  header.writeUInt16LE(0x0800, 6); // names are UTF-8
  header.writeUInt16LE(0, 8); // method: stored
  header.writeUInt16LE(FIXED_TIME, 10);
  header.writeUInt16LE(FIXED_DATE, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return header;
}

function centralHeader(nameBuffer, data, crc, offset) {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4); // version made by
  header.writeUInt16LE(20, 6); // version needed
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10); // method: stored
  header.writeUInt16LE(FIXED_TIME, 12);
  header.writeUInt16LE(FIXED_DATE, 14);
  header.writeUInt32LE(crc, 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(nameBuffer.length, 28);
  header.writeUInt16LE(0, 30); // extra
  header.writeUInt16LE(0, 32); // comment
  header.writeUInt16LE(0, 34); // disk
  header.writeUInt16LE(0, 36); // internal attributes
  header.writeUInt32LE(0, 38); // external attributes
  header.writeUInt32LE(offset, 42);
  return header;
}

/**
 * Build the zip and return where it went, what went into it, and the bytes themselves.
 *
 * `extensionDir` and `outDir` exist so a test can build from a fixture or a copy; the command
 * line always uses the repository's own folder.
 */
export function buildExtensionZip({ extensionDir = DEFAULT_EXTENSION_DIR, outDir = DEFAULT_OUT_DIR } = {}) {
  const manifestPath = join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const version = String(manifest.version ?? '');
  if (!/^\d+(\.\d+){0,3}$/.test(version)) {
    throw new Error(`extension parcel: manifest version ${JSON.stringify(manifest.version)} is not a version`);
  }

  const entries = collectFiles(extensionDir).map(({ path, name }) => {
    const data = readFileSync(path);
    return { name, data, crc: crc32(data) };
  });
  if (entries.length === 0) throw new Error('extension parcel: nothing to package');

  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuffer = Buffer.from(entry.name, 'utf8');
    const header = localHeader(nameBuffer, entry.data, entry.crc);
    if (offset > 0xffffffff) throw new Error('extension parcel: too large for a zip without zip64');
    central.push({ ...entry, nameBuffer, header: centralHeader(nameBuffer, entry.data, entry.crc, offset) });
    chunks.push(header, nameBuffer, entry.data);
    offset += header.length + nameBuffer.length + entry.data.length;
  }

  const centralOffset = offset;
  for (const entry of central) {
    chunks.push(entry.header, entry.nameBuffer);
    offset += entry.header.length + entry.nameBuffer.length;
  }
  const centralSize = offset - centralOffset;

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk with central directory
  end.writeUInt16LE(central.length, 8);
  end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20); // no comment
  chunks.push(end);

  const bytes = Buffer.concat(chunks);
  mkdirSync(outDir, { recursive: true });
  const file = join(outDir, `bookmarks-extension-${version}.zip`);
  writeFileSync(file, bytes);

  return {
    file,
    version,
    bytes,
    entries: entries.map((entry) => entry.name)
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const built = buildExtensionZip();
  const digest = createHash('sha256').update(built.bytes).digest('hex');
  console.log(`${built.file}`);
  console.log(`${built.entries.length} files, ${built.bytes.length} bytes, sha256 ${digest}`);
}
