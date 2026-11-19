/**
 * One Node major for the gate and for the deploy.
 *
 * Workers Builds runs the deploy, and it takes the Node version from a file in the repository —
 * `.nvmrc` or `.node-version` — before falling back to whatever the build image ships as its
 * default. The CI workflow is a separate runner choosing for itself. Two pins that nobody compares
 * is how a change passes `npm test` on one major and then runs on another where it ships: a
 * `node:test` runner, a `node --check` parse, and wrangler's own bundling can all differ between
 * majors without either side failing.
 *
 * So the pin is read as a fact rather than assumed: `.nvmrc` must name exactly one major, and every
 * `node-version`/`node-version-file` a workflow sets must resolve to that same major. A workflow
 * that pins nothing fails the presence check, because a scan that reads no pin proves nothing.
 */

import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKFLOWS = join(ROOT, '.github', 'workflows');

/* The files Workers Builds reads, in the order its documentation lists them. `.nvmrc` is the one
   this repository uses; `.node-version` is read too, so its absence is part of the claim. */
const VERSION_FILES = ['.nvmrc', '.node-version'];

/** A single major, written as `24`, `24.22.1` or `v24`. A range names no version to pin. */
function major(text, where) {
  const trimmed = text.trim();
  const match = trimmed.match(/^v?(\d+)(?:\.\d+|\.x)*$/);
  assert.ok(match, `${where} is ${JSON.stringify(trimmed)}, which names no single Node version`);
  return Number(match[1]);
}

function pinFromFile(name) {
  return major(readFileSync(join(ROOT, name), 'utf8'), name);
}

/* Every `node-version` and `node-version-file` line in every workflow, resolved to a major. A value
   this reader cannot resolve is a failure rather than a skip: a matrix expression or a shell
   substitution is a pin nobody can compare, which is the same defect in a different shape. */
function workflowPins() {
  const pins = [];
  const files = readdirSync(WORKFLOWS).filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'));

  for (const name of files) {
    const text = readFileSync(join(WORKFLOWS, name), 'utf8');
    text.split('\n').forEach((line, index) => {
      const match = line.match(/^\s*-?\s*(node-version|node-version-file)\s*:\s*(.+?)\s*$/);
      if (!match) return;

      const where = `${name}:${index + 1} ${match[1]}`;
      const value = match[2].replace(/^['"]|['"]$/g, '');
      assert.doesNotMatch(value, /\$\{\{|\$\(|`/, `${where} is ${JSON.stringify(value)}, which no reader can resolve`);

      if (match[1] === 'node-version') {
        pins.push({ where, major: major(value, where), fromFile: false });
        return;
      }

      const file = join(ROOT, value);
      assert.ok(existsSync(file), `${where} names ${value}, which is not in the repository`);
      pins.push({ where, major: pinFromFile(value), fromFile: true });
    });
  }

  return pins;
}

test('the deploy reads its Node major from a version file', () => {
  assert.ok(
    existsSync(join(ROOT, '.nvmrc')),
    'no .nvmrc: Workers Builds would fall back to the build image default for the deploy'
  );
  assert.ok(pinFromFile('.nvmrc') >= 20, 'the pinned major is older than any major this Worker supports');
});

test('a second version file cannot disagree with the one the deploy reads', () => {
  if (!existsSync(join(ROOT, '.node-version'))) return;
  assert.equal(
    pinFromFile('.node-version'),
    pinFromFile('.nvmrc'),
    '.node-version and .nvmrc name different majors, and which one the build reads is not decided here'
  );
});

test('every workflow pins the major the deploy runs on', () => {
  const pinned = pinFromFile('.nvmrc');
  const pins = workflowPins();

  assert.ok(pins.length > 0, 'no workflow sets node-version or node-version-file, so nothing was compared');
  assert.ok(
    pins.some((pin) => pin.fromFile),
    'no workflow reads the version file, so the gate and the deploy are pinned independently'
  );

  for (const pin of pins) {
    assert.equal(
      pin.major,
      pinned,
      `${pin.where} pins Node ${pin.major}, and the deploy runs on Node ${pinned}`
    );
  }
});
