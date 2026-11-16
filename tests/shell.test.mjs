/**
 * The offline shell is only as good as the files it names.
 *
 * A service worker is the one part of the app that a returning visitor keeps after a deploy. If
 * its cache version does not follow the files, a security fix ships and never arrives; if its
 * list misses a module, the app opens online and then fails offline, where it cannot say why.
 * These tests hold the guard that refuses both, using the worker's own list rather than a copy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  cacheName,
  expectedCacheName,
  reachableModules,
  shellEntries,
  shellProblems
} from '../scripts/shell-guard.mjs';

const ROOT = new URL('../', import.meta.url);
const SW = readFileSync(new URL('public/sw.js', ROOT), 'utf8');

function readPublic(name) {
  try {
    return readFileSync(new URL(`public/${name}`, ROOT));
  } catch {
    return null;
  }
}

test('the cache name is the digest of the shell bytes', () => {
  assert.equal(cacheName(SW), expectedCacheName(shellEntries(SW), readPublic));
});

test('a changed shell file is refused until the cache name follows it', () => {
  const problems = shellProblems({
    swSource: SW,
    read: (name) => (name === 'app.js' ? Buffer.from('changed') : readPublic(name))
  });

  assert.match(problems.join('\n'), /CACHE_NAME/);
  assert.match(problems.join('\n'), /set CACHE_NAME/);
});

test('a shell entry with no file behind it is refused', () => {
  const problems = shellProblems({
    swSource: SW,
    read: (name) => (name === 'views.js' ? null : readPublic(name))
  });

  assert.match(problems.join('\n'), /\/views\.js/);
});

test('the module graph is followed through every import, not only the entry', () => {
  const files = new Map([
    ['app.js', "import { a } from './views.js';"],
    ['views.js', "import { b } from './tiles.js';"],
    ['tiles.js', 'export const b = 1;']
  ]);
  const source = "const CACHE_NAME = 'bookmarks-test';\nconst SHELL = [\n  '/app.js',\n  '/views.js'\n];";

  const reachable = reachableModules('app.js', (name) => files.get(name) ?? null);
  assert.deepEqual([...reachable].sort(), ['app.js', 'tiles.js', 'views.js']);

  const problems = shellProblems({ swSource: source, read: (name) => files.get(name) ?? null });
  assert.match(problems.join('\n'), /tiles\.js/);
});
