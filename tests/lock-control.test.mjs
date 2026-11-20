/**
 * The toolbar's Lock button is the one control a person presses to end a session, and it once
 * shipped drawn, named, and inert: the element was in the page, the constant that looked it up was
 * in the module, and nothing was ever bound to it, so the press left the key in page state.
 *
 * This guard reads the two halves that make the press work — the button in `index.html` and the
 * binding inside `bindEvents`, the function `boot()` runs on every load — and refuses either half
 * going missing. Each case plants a removal in a copy of the source, so a check that stopped
 * reading one of the files fails on the line it is about instead of passing on an empty reading.
 *
 * The page module cannot be imported here (it reads the document as it loads), so the binding is
 * read from the source rather than exercised; the end-to-end suite is where a press is something a
 * browser does.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ROOT = new URL('../', import.meta.url);
const PAGE = readFileSync(new URL('public/index.html', ROOT), 'utf8');
const APP = readFileSync(new URL('public/app.js', ROOT), 'utf8');

/* A top-level function's body. Every function in app.js closes with `}` in the first column, and
   `bindEvents` holds no template literal, so the first such line after the opening brace is its
   own. */
function body(source, name) {
  const head = source.match(new RegExp(`^function ${name}\\([^)]*\\) \\{`, 'm'));
  if (head === null) return null;
  const open = source.indexOf('{', head.index);
  const close = source.indexOf('\n}', open);
  return close === -1 ? null : source.slice(open + 1, close);
}

/* The arguments of the call whose opening paren follows `from`, read with balanced parens and with
   quoted bodies skipped, so a handler that closes over another call still ends where it says. */
function callArguments(source, from) {
  const open = source.indexOf('(', from);
  if (open === -1) return null;

  let depth = 0;
  let quote = '';
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (quote !== '') {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') quote = char;
    else if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }

  return null;
}

/** What is wrong with the two halves, said the way the reader would have to fix it. */
function wiringProblems({ page = PAGE, app = APP }) {
  const problems = [];

  const drawn = page.split('id="lock-button"').length - 1;
  if (drawn !== 1) {
    problems.push(`index.html names id="lock-button" ${drawn} times, so there is no single button to press`);
  } else {
    const tag = page.match(/<button\b[^>]*\bid="lock-button"[^>]*>/)?.[0] ?? '';
    if (tag === '') {
      problems.push('index.html has an element with id="lock-button" that is not a <button>');
    } else {
      if (!/\btype="button"/.test(tag)) {
        problems.push('the lock button is not type="button", so a form around it would read the press as a submit');
      }
      if (!/\baria-label="[^"]*lock/i.test(tag)) {
        problems.push('the lock button carries no accessible name that says what it does');
      }
    }
  }

  if (!/const lockButton = \$\('lock-button'\)/.test(app)) {
    problems.push('app.js never looks the lock button up by its id, so nothing can be bound to it');
  }
  if (!/^async function lockVault\(/m.test(app)) {
    problems.push('app.js has no lockVault(), so a press has no close path to run');
  }

  const bind = body(app, 'bindEvents');
  if (bind === null) {
    problems.push('app.js has no bindEvents(), so no control is bound at load');
    return problems;
  }

  const click = bind.indexOf("lockButton.addEventListener('click'");
  if (click === -1) {
    problems.push('bindEvents() binds no click to the toolbar lock button, so a press runs nothing');
  } else {
    const handler = callArguments(bind, click) ?? '';
    if (!/lockVault\s*\(/.test(handler)) {
      problems.push("the lock button's click handler does not call lockVault(), so the session stays open");
    }
  }

  const boot = body(app, 'boot');
  if (boot === null || !/\bbindEvents\(\)/.test(boot)) {
    problems.push('boot() does not call bindEvents(), so a binding in it would never run');
  }

  return problems;
}

test('the toolbar lock button is drawn as a button and bound to the vault lock on the boot path', () => {
  const problems = wiringProblems({});
  assert.equal(problems.length, 0, problems.join('\n'));

  /* The checks above pass on a binding that exists, so a guard reading nothing would be caught here. */
  assert.match(body(APP, 'bindEvents'), /lockButton\.addEventListener\('click'/);
});

test('a lock button with no click handler is refused', () => {
  const binding = "  lockButton.addEventListener('click', () => void lockVault());\n";
  assert.ok(APP.includes(binding), 'the binding this case removes is no longer in app.js');

  const problems = wiringProblems({ app: APP.replace(binding, '') });
  assert.match(problems.join('\n'), /binds no click to the toolbar lock button/);
});

test('a click handler that does not lock is refused', () => {
  const binding = "lockButton.addEventListener('click', () => void lockVault())";
  assert.ok(APP.includes(binding), 'the handler this case replaces is no longer in app.js');

  const problems = wiringProblems({
    app: APP.replace(binding, "lockButton.addEventListener('click', () => announce('still open'))")
  });
  assert.match(problems.join('\n'), /does not call lockVault\(\)/);
});

test('markup without the button is refused', () => {
  const button = PAGE.match(/<button\b[^>]*\bid="lock-button"[\s\S]*?<\/button>/)?.[0] ?? '';
  assert.notEqual(button, '', 'index.html no longer draws id="lock-button", so this case cannot plant');

  const problems = wiringProblems({ page: PAGE.replace(button, '') });
  assert.match(problems.join('\n'), /names id="lock-button" 0 times/);
});
