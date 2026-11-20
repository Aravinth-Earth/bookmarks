/**
 * The way out of an open vault is a control on the page, not a route a person has to know.
 *
 * The toolbar's lock button is that way out: it drops the key and the open document, ends the
 * server session and takes the remembered key off the device. It has been inert before — drawn,
 * named and bound to nothing — and the browser suite is the only place that noticed, so a build
 * with a removed handler could pass `npm test` while the page had no working way out. These
 * cases hold the control, its binding and the order inside the lock itself, using the page's own
 * markup and modules rather than a copy.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const HTML = readFileSync(new URL('public/index.html', ROOT), 'utf8');
const APP = readFileSync(new URL('public/app.js', ROOT), 'utf8');
const SYNC = readFileSync(new URL('public/sync.js', ROOT), 'utf8');
const VAULT = readFileSync(new URL('src/vault.js', ROOT), 'utf8');

const count = (haystack, needle) => haystack.split(needle).length - 1;

/** The open vault's header row: the toolbar a person sees once the vault is unlocked. */
function toolbar() {
  const start = HTML.indexOf('<div class="toolbar">');
  assert.ok(start > -1, 'public/index.html has no toolbar');
  const end = HTML.indexOf('</div>', start);
  assert.ok(end > start, 'the toolbar is never closed');
  return HTML.slice(start, end);
}

function button(id) {
  const pattern = new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>([\\s\\S]*?)</button>`);
  const match = HTML.match(pattern);
  assert.ok(match, `public/index.html has no <button id="${id}">`);
  return { tag: match[0].slice(0, match[0].indexOf('>')), inner: match[1] };
}

/** The body of a top-level `async function name(...)`: only its closing brace starts at column 0. */
function topLevelFunction(name) {
  const match = APP.match(new RegExp(`^async function ${name}\\([\\s\\S]*?^\\}`, 'm'));
  assert.ok(match, `public/app.js has no top-level ${name}`);
  return match[0];
}

test('the open vault carries a visible sign-out control in its header row', () => {
  const appView = HTML.indexOf('<section id="app-view"');
  assert.ok(appView > -1, 'public/index.html has no app view');
  assert.ok(
    HTML.indexOf('<div class="toolbar">') > appView,
    'the sign-out control sits outside the open vault, where there is nothing to sign out of'
  );

  const row = toolbar();
  assert.match(row, /id="lock-button"/, 'the open vault has no sign-out control');

  /* One control, not one per view: a copy elsewhere is a second thing to keep bound. */
  assert.equal(count(HTML, 'id="lock-button"'), 1);

  const { tag, inner } = button('lock-button');
  assert.match(tag, /type="button"/);
  assert.match(tag, /aria-label="Lock the vault"/, 'the control carries no accessible name');
  assert.match(tag, /title="Lock the vault"/);
  assert.match(tag, /\bclass="[^"]*\bbutton\b/);
  /* Hidden until it is needed is still on the page; hidden always is not a way out. */
  assert.doesNotMatch(tag, /\bhidden\b/);

  /* Readable text beside the icon: a label a person cannot read is not a way out either. */
  const label = inner.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  assert.equal(label, 'Lock');
});

test('the control is bound once, to the one function that ends the session', () => {
  assert.equal(
    count(APP, "lockButton.addEventListener('click'"),
    1,
    'the toolbar control must be bound exactly once'
  );
  assert.match(
    APP,
    /lockButton\.addEventListener\('click',\s*\(\)\s*=>\s*void lockVault\(\)\)/,
    'public/app.js no longer binds the toolbar control to lockVault'
  );
});

test('the lock drops the key before it awaits, then ends the session and the device record', () => {
  const body = topLevelFunction('lockVault');

  const dropped = body.indexOf('state.key = null');
  assert.ok(dropped > -1, 'a lock must drop the key');
  const firstAwait = body.indexOf('await ');
  assert.ok(firstAwait > -1, 'a lock must end the session and the device record');
  /* A save already in flight checks `state.key`, so the key goes before the first suspension. */
  assert.ok(dropped < firstAwait, 'a lock must drop the key before its first await');

  assert.match(body, /await sync\.logout\(\)/, 'a lock must end the server session');
  assert.match(body, /await store\.forget\(\)/, 'a lock must take the remembered key off the device');
  assert.match(body, /lockSignal\.broadcast\(\)/, 'a lock must reach the other tabs');
});

test('signing out forgets the token here and deletes the session there', () => {
  const body = SYNC.match(/^  async logout\(\) \{[\s\S]*?^  \}/m);
  assert.ok(body, 'public/sync.js has no logout()');
  /* The token is off the client before the request goes out, so a failed call cannot leave it. */
  const dropped = body[0].indexOf('this.token = null');
  assert.ok(dropped > -1, 'logout must drop the token');
  assert.ok(
    dropped < body[0].indexOf('await this.request('),
    'logout must drop the token before it calls the server'
  );
  assert.match(body[0], /method: 'POST'/);
  assert.match(body[0], /\/a\/\$\{accountId\}\/logout/);

  const route = VAULT.match(/^  async logout\(request\) \{[\s\S]*?^  \}/m);
  assert.ok(route, 'src/vault.js has no logout handler');
  assert.match(route[0], /delete\(`session:\$\{auth\}`\)/, 'the server must delete the session it was given');
});
