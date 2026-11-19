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

test('an unmodified copy passes the guard', (t) => {
  const dir = copyOfTree(t);

  const result = guard(dir);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /check passed/);
});

/** Rewrite the alert rule in the copy, so a case can plant one drift in it. */
function editRule(dir, edit) {
  const path = join(dir, 'alerts/signin-failures.json');
  const rule = JSON.parse(readFileSync(path, 'utf8'));
  edit(rule);
  writeFileSync(path, `${JSON.stringify(rule, null, 2)}\n`);
}

test('an alert rule that would fire on a single failure fails the guard', (t) => {
  const dir = copyOfTree(t);
  editRule(dir, (rule) => {
    rule.threshold = 1;
  });

  const result = guard(dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /alerts: the rule fires at 1 failures/);
});

test('an alert rule that counts an event the Worker no longer writes fails the guard', (t) => {
  const dir = copyOfTree(t);
  editRule(dir, (rule) => {
    rule.events = rule.events.map((name) => (name === 'signin_locked' ? 'signin_lock' : name));
  });

  const result = guard(dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /alerts: the rule counts "signin_lock", which src\/ never writes/);
});

test('an alert rule grouped by the source instead of the account fails the guard', (t) => {
  const dir = copyOfTree(t);
  editRule(dir, (rule) => {
    rule.group_by = ['source'];
  });

  const result = guard(dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /alerts: the rule is not grouped by the account digest/);
});

test('a deployment with no alert rule fails the guard', (t) => {
  const dir = copyOfTree(t);
  rmSync(join(dir, 'alerts/signin-failures.json'));

  const result = guard(dir);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, /alerts: alerts\/signin-failures\.json is missing/);
});
