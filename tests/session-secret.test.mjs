/**
 * The secret the server recognises an account by does not sit in the page's own state.
 *
 * It is the one value worth stealing from a page that carries it: the HMAC key kept beside it
 * cannot be read out at all, and it signs the same proof (`crypto.test.mjs` pins that the two agree
 * byte for byte), so a session that held both held the secret for nothing. Before this rule the
 * value derived at an unlock stayed in `state.authSecret` until an account existed on the server —
 * on a vault with sync off, for the whole session — and every route that needed a credential could
 * have taken the key instead.
 *
 * The account is created from the phrase's signing key: `SyncClient.register` is handed
 * `{ proofKey, proofKeyText }` and its creation body carries `proofKey`, never a secret. The phrase
 * is asked for once when sync is turned on, when the page does not already have that material.
 *
 * `app.js` is one script that reads its own elements at load, so there is no DOM harness to drive
 * it from a test. The rule is therefore checked the way `sw.test.mjs` checks the service worker:
 * against the source, asserting the shape that would leak cannot come back.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const SOURCE = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

/** The page state, from its one literal to the closing brace in the first column. */
function stateLiteral(source) {
  const start = source.indexOf('const state = {');
  assert.notEqual(start, -1, 'the page still declares its state in one literal');
  const end = source.indexOf('\n};', start);
  assert.notEqual(end, -1, 'the literal is closed at the left margin');
  return source.slice(start, end);
}

/** A top-level function, from its declaration to the next one. */
function functionBody(source, declaration) {
  const start = source.indexOf(declaration);
  assert.notEqual(start, -1, `${declaration} is still in the page`);
  const rest = source.slice(start + declaration.length);
  const next = /\n(?:async )?function /.exec(rest);
  return source.slice(start, next ? start + declaration.length + next.index : source.length);
}

test('the page state has no field for the secret', () => {
  const literal = stateLiteral(SOURCE);

  assert.equal(/\bauthSecret\b/.test(literal), false, 'no field, and no comment offering one');
  assert.match(literal, /\bauthKey\b/, 'the key that signs the same proof is what a session keeps');
});

test('nothing reads or writes that secret on the state', () => {
  assert.equal(/state\.authSecret/.test(SOURCE), false, 'no property access');
  assert.equal(/state\s*\[\s*['"`]authSecret/.test(SOURCE), false, 'and no computed access');
});

test('the entry that opens a vault does not take the secret from the caller', () => {
  const entry = functionBody(SOURCE, 'function enter({');

  assert.equal(/authSecret/.test(entry.slice(0, entry.indexOf('}) {'))), false, 'not a parameter');
  assert.equal(/state\.authSecret\s*=/.test(entry), false, 'and not assigned inside');
});

test('turning sync on asks for the phrase, and the answer is the material a creation needs', () => {
  const prompt = functionBody(SOURCE, 'function promptForSyncPhrase()');
  const answer = /resolve\(\{([^}]*)\}\)/.exec(prompt);

  assert.ok(answer, 'the prompt answers with the derived material');
  for (const field of ['serverId', 'proofKey', 'proofKeyText']) {
    assert.ok(answer[1].includes(field), `${field} is part of the answer`);
  }
  assert.equal(answer[1].includes('authSecret'), false, 'and the secret is not part of it');

  const settings = functionBody(SOURCE, 'function openSettings()');
  assert.match(settings, /promptForSyncPhrase\(\)/, 'the switch goes to the prompt');
});
