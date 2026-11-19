/**
 * The lock screen is the one moment the page says the vault is off the screen.
 *
 * The open dialog is not inside `#app-view`: the backdrop is appended to `#modal-root`, a sibling,
 * and it is fixed and stacked above the page. Hiding the app therefore left a bookmark's address
 * and name — or the recovery phrase — painted over the lock screen until the page was reloaded.
 * `showLock` is the only way onto that screen, so the dialog has to be closed inside it rather
 * than at each caller: a caller added later would otherwise reopen the same hole.
 *
 * `app.js` is a browser module with no exports, so the rule is read from its source: the function
 * bodies are taken whole, and the assertion is about the order of two statements in `showLock`,
 * not about how the file is written around them.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const APP = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

/**
 * The body of a top-level `function name(...)`, braces balanced.
 *
 * Strings, template literals and comments are stepped over: a `}` inside one of them would
 * otherwise end the body early, and the test would read a prefix of the function and pass.
 */
function bodyOf(source, name) {
  const head = new RegExp(`^function ${name}\\(`, 'm').exec(source);
  assert.ok(head, `public/app.js has no function ${name}`);

  /* The parameters are skipped first: `function openModal({ title })` opens with an object
     pattern, and its braces would otherwise be read as the body of the function. */
  const open = source.indexOf('{', closingParen(source, source.indexOf('(', head.index)));
  assert.notEqual(open, -1, `function ${name} has no body`);

  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];

    if (char === '/' && source[index + 1] === '/') {
      index = source.indexOf('\n', index);
      if (index === -1) break;
      continue;
    }
    if (char === '/' && source[index + 1] === '*') {
      index = source.indexOf('*/', index + 2) + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === '`') {
      index = endOfString(source, index);
      continue;
    }

    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, index + 1);
    }
  }

  assert.fail(`function ${name} is not closed`);
}

/** The index of the quote that closes the string starting at `start`. */
function endOfString(source, start) {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index += 1) {
    if (source[index] === '\\') index += 1;
    else if (source[index] === quote) return index;
  }
  return source.length - 1;
}

/** The index of the `)` matching the `(` at `start`, stepping over strings. */
function closingParen(source, start) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (char === "'" || char === '"' || char === '`') {
      index = endOfString(source, index);
      continue;
    }
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  assert.fail('a parameter list is not closed');
}

test('the lock screen closes the open dialog before it hides the app', () => {
  const body = bodyOf(APP, 'showLock');

  const closes = body.indexOf('closeModal(');
  const hides = body.indexOf('appView.hidden = true');

  assert.notEqual(hides, -1, 'showLock does not hide the app, so this test is reading the wrong body');
  assert.notEqual(
    closes,
    -1,
    'showLock hides the app without closing the active dialog, so a lock leaves it over the lock screen'
  );
  assert.ok(closes < hides, 'showLock hides the app before it closes the dialog, so the dialog outlives the lock');
});

test('the dialog that is closed is the backdrop added to #modal-root', () => {
  const body = bodyOf(APP, 'openModal');

  assert.match(body, /root\.append\(backdrop\)/, 'the dialog is not added to #modal-root, so this test reads the wrong body');
  assert.match(body, /backdrop\.remove\(\)/, 'closing a dialog leaves its backdrop in #modal-root');
});
