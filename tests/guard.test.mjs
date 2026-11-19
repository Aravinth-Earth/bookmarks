/**
 * The browser-bundle guard, tested against copies of the real tree.
 *
 * Each case runs `scripts/check.mjs` in its own copy of the repository with one violation planted,
 * so what is asserted is the guard's behaviour rather than a hand-written stub of it. The copy
 * leaves `.git` and `node_modules` behind: the guard reads files and parses them with `node
 * --check`, and needs neither.
 *
 * `index.html` is also a file the offline shell precaches, so planting a tag in it changes the
 * cache digest as well. Each case therefore asserts the line it is about rather than only the exit
 * status: a guard that lost the rule would still fail on the digest, and only the message shows
 * which rule answered.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const skipped = new Set(['.git', 'node_modules']);

function copyOfTree(t) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'));
  cpSync(root, dir, {
    recursive: true,
    filter: (path) => !skipped.has(relative(root, path).split(sep)[0])
  });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function guard(dir) {
  try {
    const stdout = execFileSync(process.execPath, ['scripts/check.mjs'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: 'pipe'
    });
    return { status: 0, output: stdout };
  } catch (error) {
    return { status: error.status, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

function plant(dir, file, before, added) {
  const path = join(dir, file);
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes(before), `${file} no longer contains ${before}, so this case cannot plant`);
  writeFileSync(path, text.replace(before, `${added}${before}`));
}

test('an inline script that builds a host from parts fails the guard', (t) => {
  const dir = copyOfTree(t);
  plant(
    dir,
    'public/index.html',
    '</body>',
    `<script>const h='cdn.exa'+'mple';fetch('https://'+h)</script>\n`
  );

  const result = guard(dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /inline <script>/);
});

test('a script the page does not allowlist fails the guard', (t) => {
  const dir = copyOfTree(t);
  plant(dir, 'public/index.html', '</body>', '<script src="/new.js"></script>\n');

  const result = guard(dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /not in the page's allowlist/);
});

test('markup a Worker returns is scanned like the page', (t) => {
  const dir = copyOfTree(t);
  const worker = join(dir, 'src/index.js');
  const text = readFileSync(worker, 'utf8');
  writeFileSync(
    worker,
    `${text}\nconst injected = '<script>fetch("https://cdn.example/x")</script>';\n`
  );

  const result = guard(dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /src\/index\.js: inline <script>/);
});

test('a deploy whose build step runs neither gate fails the guard', (t) => {
  const dir = copyOfTree(t);
  const path = join(dir, 'wrangler.toml');
  const text = readFileSync(path, 'utf8');
  const stripped = text.replace(/^\[build\][\s\S]*?(?=^\[)/m, '');
  assert.notEqual(
    stripped,
    text,
    'wrangler.toml declares no [build] block, so this case cannot plant'
  );
  writeFileSync(path, stripped);

  const result = guard(dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /deploy: wrangler\.toml has no \[build\] block/);
});

test('a deploy whose build step runs the guard but not the tests fails the guard', (t) => {
  const dir = copyOfTree(t);
  const path = join(dir, 'wrangler.toml');
  const text = readFileSync(path, 'utf8');
  const amended = text.replace(
    /^(\s*command\s*=\s*")[^"]*(")/m,
    '$1npm run check$2'
  );
  assert.notEqual(amended, text, 'wrangler.toml has no [build] command, so this case cannot plant');
  writeFileSync(path, amended);

  const result = guard(dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /deploy: the build command .* does not run `npm test`/);
});

test('an unmodified copy passes the guard', (t) => {
  const dir = copyOfTree(t);

  const result = guard(dir);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /check passed/);
});
