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
 * Every module the page can reach from its entry, following the relative imports each one makes.
 * A shell built from the entry's direct imports only leaves the second hop out: the page boots
 * online because the missing file is fetched, and then fails offline where it cannot say why.
 */
export function reachableModules(entry, read) {
  const seen = new Set();
  const queue = [entry];

  while (queue.length > 0) {
    const name = queue.pop();
    if (seen.has(name)) continue;
    seen.add(name);

    const source = read(name);
    if (source === null) continue;
    for (const next of importedModules(source.toString('utf8'))) queue.push(next);
  }

  return seen;
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

  /* The list has to cover the whole graph, not only what the entry imports directly. A module
     reached through another module is fetched on the first visit and missing on the next offline
     one, which is the failure this list exists to prevent. */
  const cachedModules = new Set(
    entries.map((path) => path.replace(/^\//, '')).filter((name) => name.endsWith('.js'))
  );
  for (const name of reachableModules('app.js', read)) {
    if (!cachedModules.has(name)) {
      problems.push(`sw.js does not cache ${name}, which the page reaches from app.js`);
    }
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
