/**
 * Signing out is a control on the page, not a route a person has to remember.
 *
 * The toolbar's lock button is the way out of an open vault: it drops the key, the open document
 * and the server session. It has been inert before — drawn, named and bound to nothing — so the
 * shape this file holds is that the control is on the page, is not hidden, carries an accessible
 * name, and is wired to the one function that ends the session. `npm run check` parses the module
 * and the browser suite clicks the button; this keeps the same promise inside `npm test`, where a
 * missing handler is a failing test rather than something only a browser run would notice.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const HTML = readFileSync(new URL('public/index.html', ROOT), 'utf8');
const APP = readFileSync(new URL('public/app.js', ROOT), 'utf8');

function button(id) {
  const pattern = new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</button>`);
  const match = HTML.match(pattern);
  assert.ok(match, `public/index.html has no <button id="${id}">`);
  return { attributes: match[0].slice(0, match[0].indexOf('>')), inner: match[1] };
}

test('the page carries a visible sign-out control', () => {
  const { attributes, inner } = button('lock-button');

  assert.match(attributes, /type="button"/);
  assert.match(attributes, /aria-label="Lock the vault"/);
  assert.match(attributes, /title="Lock the vault"/);
  /* Hidden until it is needed is still on the page; hidden always is not a way out. */
  assert.doesNotMatch(attributes, /\bhidden\b/);
  assert.match(attributes, /\bclass="[^"]*\bbutton\b/);

  /* A visible label, not an icon alone: a control a person cannot read is not a way out either. */
  const label = inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.equal(label, 'Lock');
});

test('the control is bound to the lock, and the lock ends the session', () => {
  assert.match(
    APP,
    /lockButton\.addEventListener\('click',\s*\(\)\s*=>\s*void lockVault\(\)\)/,
    'public/app.js no longer binds the toolbar lock control to lockVault'
  );

  /* Take the whole function: the closing brace of a top-level declaration is the only line that
     starts at column zero. An inner block is indented, so a non-greedy match stops at the end. */
  const match = APP.match(/^async function lockVault\([\s\S]*?^\}/m);
  assert.ok(match, 'public/app.js has no top-level lockVault');
  const body = match[0];

  assert.match(body, /state\.key = null/, 'a lock must drop the key before it awaits');
  assert.match(body, /await sync\.logout\(\)/, 'a lock must end the server session');
  assert.match(body, /await store\.forget\(\)/, 'a lock must take the remembered key off the device');
  assert.match(body, /lockSignal\.broadcast\(\)/, 'a lock must reach the other tabs');
});
