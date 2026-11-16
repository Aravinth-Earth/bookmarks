/**
 * The offline shell's manifest, shared by the guard and its tests.
 *
 * `public/sw.js` names the files a first visit stores for offline use and the cache version that
 * has to change whenever any of them changes. Both are read out of the worker itself so the guard
 * cannot drift from what it really ships, and the version is a digest of the bytes rather than a
 * number a person has to remember.
 */

import { createHash } from 'node:crypto';

const SHELL_START = 'const SHELL = [';
const SHELL_END = '];';
const CACHE_NAME = /\bconst CACHE_NAME = '([^']+)'/;
const IMPORT = /from '\.\/([\w-]+\.js)'/g;

/** The root-absolute paths the worker precaches, in the order it lists them. */
export function shellEntries(source) {
  const start = source.indexOf(SHELL_START);
  if (start === -1) return [];
  const end = source.indexOf(SHELL_END, start);
  if (end === -1) return [];

  return [...source.slice(start, end).matchAll(/'(\/[^']*)'/g)].map((match) => match[1]);
}

/** The cache version the worker declares, or null when the line cannot be read. */
export function cacheName(source) {
  return source.match(CACHE_NAME)?.[1] ?? null;
}

/** The module specifiers one file imports from its own directory. */
export function importedModules(source) {
  return [...source.matchAll(IMPORT)].map((match) => match[1]);
}

/**
 * The digest of the shell's bytes. The path is hashed with its contents, so renaming a file or
 * changing one byte changes the name. `read` returns a Buffer or null for a file that is missing.
 */
export function shellFingerprint(entries, read) {
  const hash = createHash('sha256');
  for (const path of [...entries].sort()) {
    const name = path === '/' ? 'index.html' : path.replace(/^\//, '');
    hash.update(path);
    hash.update('\0');
    hash.update(read(name) ?? Buffer.alloc(0));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 10);
}

/** The one cache name the current bytes allow. */
export function expectedCacheName(entries, read) {
  return `bookmarks-${shellFingerprint(entries, read)}`;
}

/**
 * Every disagreement between the worker and the files it ships.
 *
 * A shell that misses a module is an app that opens once and then refuses to boot offline; a
 * stale cache name is the same failure for a returning visitor, because the old worker keeps the
 * old files. Both are silent in production, so they are refused here instead.
 */
export function shellProblems({ swSource, read }) {
  const problems = [];
  const entries = shellEntries(swSource);
  if (entries.length === 0) {
    problems.push('sw.js declares no SHELL list');
    return problems;
  }

  for (const path of entries) {
    const name = path === '/' ? 'index.html' : path.replace(/^\//, '');
    if (read(name) === null) problems.push(`sw.js caches ${path}, which is not in public/`);
  }

  const declared = cacheName(swSource);
  const expected = expectedCacheName(entries, read);
  if (declared !== expected) {
    problems.push(
      `sw.js CACHE_NAME is ${declared ?? 'missing'}, but the shell files hash to ${expected}; ` +
        `set CACHE_NAME = '${expected}'`
    );
  }

  return problems;
}
