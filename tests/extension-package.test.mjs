/**
 * The extension parcel: what goes in, and what it looks like when it is opened again.
 *
 * The claim is two things at once — the zip contains every file in `extension/` and nothing from
 * outside it, and two builds of the same checkout are the same bytes. Both are read back out of
 * the archive here rather than trusted: the central directory is parsed, and every entry's bytes
 * are compared with the file on disk.
 */

import assert from 'node:assert/strict';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildExtensionZip } from '../scripts/package-extension.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const EXTENSION = join(ROOT, 'extension');

function walk(directory, base = directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  )) {
    const path = join(directory, entry.name);
    if (lstatSync(path).isDirectory()) files.push(...walk(path, base));
    else files.push(relative(base, path).split(sep).join('/'));
  }
  return files;
}

/** Read a stored zip back: every central entry, and the bytes its local header points at. */
function readZip(buffer) {
  const end = buffer.length - 22;
  assert.equal(buffer.readUInt32LE(end), 0x06054b50, 'the archive ends with a central directory record');

  const count = buffer.readUInt16LE(end + 10);
  const size = buffer.readUInt32LE(end + 12);
  const offset = buffer.readUInt32LE(end + 16);

  const entries = [];
  let cursor = offset;
  for (let index = 0; index < count; index += 1) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50, `central entry ${index} has its signature`);
    const method = buffer.readUInt16LE(cursor + 10);
    const crc = buffer.readUInt32LE(cursor + 16);
    const compressed = buffer.readUInt32LE(cursor + 20);
    const uncompressed = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8');

    assert.equal(buffer.readUInt32LE(localOffset), 0x04034b50, `${name} has its local header`);
    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const data = buffer.subarray(dataStart, dataStart + uncompressed);

    entries.push({ name, method, crc, compressed, uncompressed, data });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  assert.equal(cursor, offset + size, 'the central directory is exactly as long as it says');
  return entries;
}

test('the parcel is every file under extension/ and nothing else', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'bookmarks-parcel-'));
  const built = buildExtensionZip({ outDir });

  const manifest = JSON.parse(readFileSync(join(EXTENSION, 'manifest.json'), 'utf8'));
  assert.equal(built.file, join(outDir, `bookmarks-extension-${manifest.version}.zip`));
  assert.deepEqual(built.entries, walk(EXTENSION));

  const entries = readZip(built.bytes);
  assert.deepEqual(entries.map((entry) => entry.name), walk(EXTENSION));

  for (const entry of entries) {
    assert.ok(!entry.name.startsWith('/') && !entry.name.split('/').includes('..'), `${entry.name} is relative`);
    assert.equal(entry.method, 0, `${entry.name} is stored`);
    assert.equal(entry.compressed, entry.uncompressed, `${entry.name} is not compressed`);
    assert.equal(entry.uncompressed, entry.data.length, `${entry.name} has the length it declares`);
    assert.deepEqual(entry.data, readFileSync(join(EXTENSION, ...entry.name.split('/'))), `${entry.name} is the file on disk`);
  }

  /* The files the browser actually loads are in it, not merely some files. */
  for (const wanted of ['manifest.json', 'background.js', 'bridge.js', 'icons/16.png', 'icons/128.png']) {
    assert.ok(built.entries.includes(wanted), `${wanted} is in the parcel`);
  }
});

test('two builds of the same checkout are the same bytes', () => {
  const first = buildExtensionZip({ outDir: mkdtempSync(join(tmpdir(), 'bookmarks-parcel-a-')) });
  const second = buildExtensionZip({ outDir: mkdtempSync(join(tmpdir(), 'bookmarks-parcel-b-')) });
  assert.deepEqual(first.bytes, second.bytes);
});

test('a symlink is refused rather than followed out of the repository', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'bookmarks-parcel-fixture-'));
  writeFileSync(join(fixture, 'manifest.json'), JSON.stringify({ manifest_version: 3, version: '1.0.0' }));
  writeFileSync(join(fixture, 'outside.js'), '// in the fixture\n');
  const linked = join(fixture, 'linked.js');
  symlinkSync(join(fixture, 'outside.js'), linked);
  mkdirSync(join(fixture, 'icons'));

  assert.throws(() => buildExtensionZip({ extensionDir: fixture, outDir: join(fixture, 'dist') }), /symlink/);
});
