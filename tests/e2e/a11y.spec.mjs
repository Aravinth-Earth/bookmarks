/**
 * Accessibility of the bookmark vault, asserted in a real Chromium against the roles and names a screen reader
 * actually receives.
 *
 * Two rules run through the file:
 *
 * - Every claim about a name, a state or a structure is read from the accessibility tree (Chrome's own, over CDP) or
 *   from a `getByRole` locator, never from a class name. A class is a drawing detail; the tree is what is announced.
 * - Focus is moved the way a keyboard moves it — `Tab` and `Shift+Tab` — because Chromium only paints and reports a
 *   `:focus-visible` ring for focus it considers keyboard-driven. A programmatic `.focus()` would let a missing ring
 *   pass for the wrong reason.
 *
 * The vault is created fresh in each test from the fixture profile, so a row that exists is a row the test put there.
 */

import {
  addBookmark,
  collectedRows,
  createVault,
  enableCollection,
  expect,
  lockVault,
  openSettings,
  settingsItem,
  test,
  visit
} from './fixtures.mjs';

/* ------------------------------------------------------------------ the tree */

/**
 * Chrome's accessibility tree for the current page: what a screen reader is handed, with the ignored nodes removed.
 *
 * `name` is the computed accessible name — label text, `aria-label`, `alt` and the text-transform that Chrome reports
 * included — so this is the same string a screen reader would speak.
 */
async function axTree(page) {
  const session = await page.context().newCDPSession(page);
  try {
    const { nodes } = await session.send('Accessibility.getFullAXTree');
    return nodes
      .filter((node) => !node.ignored)
      .map((node) => ({
        role: node.role?.value ?? '',
        name: (node.name?.value ?? '').trim(),
        props: Object.fromEntries((node.properties ?? []).map((p) => [p.name, p.value?.value ?? p.value]))
      }));
  } finally {
    await session.detach();
  }
}

/** The roles a person can operate: each one owes the user a name. */
const OPERABLE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'slider',
  'spinbutton',
  'tab',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'listbox',
  'option',
  'treeitem'
]);

/** Every operable control in the tree that would be announced with no name at all. */
async function unnamedControls(page) {
  const nodes = await axTree(page);
  return nodes.filter((node) => OPERABLE.has(node.role) && node.name === '').map((node) => node.role);
}

/** The names the tree carries, so a check can name a control without reading the DOM. */
async function namesOf(page, role) {
  const nodes = await axTree(page);
  return nodes.filter((node) => node.role === role).map((node) => node.name);
}

/* --------------------------------------------------------------- the keyboard */

/**
 * Whether the focused element, or something it sits inside, paints a focus ring.
 *
 * The pills view rings the whole pill through `.row:focus-within` while the anchor itself is told to draw nothing, so
 * looking only at `document.activeElement` would report a defect that is not there.
 */
async function focusRing(page) {
  return page.evaluate(() => {
    let node = document.activeElement;
    while (node && node !== document.body) {
      const style = getComputedStyle(node);
      if (style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0) {
        return { visible: true, at: node.className || node.tagName, style: `${style.outlineStyle} ${style.outlineWidth}` };
      }
      node = node.parentElement;
    }
    return { visible: false, at: document.activeElement?.className ?? '', style: 'none' };
  });
}

/** Press Tab `count` times and report what each stop was called and whether it showed a ring. */
async function walkTabStops(page, count) {
  const stops = [];
  for (let i = 0; i < count; i += 1) {
    await page.keyboard.press('Tab');
    stops.push(
      await page.evaluate(() => ({
        tag: document.activeElement.tagName,
        id: document.activeElement.id,
        name: document.activeElement.getAttribute('aria-label') ?? document.activeElement.textContent?.trim() ?? '',
        inMain: Boolean(document.activeElement.closest('#main'))
      }))
    );
    stops[stops.length - 1].ring = (await focusRing(page)).visible;
  }
  return stops;
}

/** The visible headings, in document order, with the level a screen reader announces. */
async function headingLevels(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')]
      .filter((heading) => heading.getClientRects().length > 0)
      .map((heading) => Number(heading.tagName[1]))
  );
}

/* ------------------------------------------------------------------- the lock */

test('the lock screen gives every control a name and starts with a way past the header', async ({ page }) => {
  /* A control with no name is announced as "button" and nothing else, which is unusable. */
  expect(await unnamedControls(page)).toEqual([]);

  await expect(page.getByRole('button', { name: 'Unlock' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New vault' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore a backup' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Stay unlocked on this device' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /13-word phrase/i })).toBeVisible();

  /* The skip link is the first stop in the document, hidden until it has focus, and it is named. */
  const firstFocusable = await page.evaluate(() => {
    const nodes = document.querySelectorAll('a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])');
    return nodes[0]?.className ?? '';
  });
  expect(firstFocusable).toBe('skip');

  const skip = page.getByRole('link', { name: 'Skip to content' });
  expect(await skip.evaluate((node) => node.getBoundingClientRect().x)).toBeLessThan(0);
  await skip.focus();
  await expect(skip).toBeInViewport();

  /* Enter on the skip link must leave the next Tab inside the content, not back at the top of the page. */
  await page.keyboard.press('Enter');
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => Boolean(document.activeElement.closest('#main')))).toBe(true);
});

/* Known defect: the hint sits inside the label, so the name swallows it and aria-describedby repeats it. */
test('the phrase field is named by its label, with the hint as a description only', async ({ page }) => {
  const field = page.getByRole('textbox', { name: /13-word phrase/i });

  /* The hint is already wired with aria-describedby; a name that also contains it is announced twice. */
  await expect.soft(field).toHaveAccessibleName(/^your 13-word phrase$/i);
  await expect.soft(field).toHaveAccessibleName(/^(?!.*never sent anywhere).*$/i);
  await expect(field).toHaveAccessibleDescription(/never sent anywhere/i);
});

test('the lock screen tolerates Tab, Shift+Tab, Escape and a refused phrase', async ({ page }) => {
  await page.locator('#phrase').focus();
  await page.keyboard.press('Tab');
  await expect(page.locator('#remember')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('#unlock-button')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator('#remember')).toBeFocused();

  /* Escape is not a lock-screen action: it must leave the form, the typed words and the view alone. */
  await page.locator('#phrase').fill('eleven words is not enough');
  await page.keyboard.press('Escape');
  await expect(page.locator('#lock-view')).toBeVisible();
  await expect(page.locator('#phrase')).toHaveValue('eleven words is not enough');

  await page.locator('#unlock-button').press('Enter');
  await expect(page.locator('#lock-error')).toBeVisible();
  await expect(page.locator('#lock-error')).toHaveAttribute('role', 'alert');
  await expect(page.locator('#lock-error')).not.toBeEmpty();
  await expect(page.locator('#app-view')).toBeHidden();
});

/* ----------------------------------------------------------------- the field */

test('the vault labels its form fields and the add button reports whether the form is open', async ({ page }) => {
  await createVault(page);

  await expect(page.getByRole('searchbox', { name: 'Search bookmarks' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Sort bookmarks' })).toBeVisible();

  const toggle = page.getByRole('button', { name: 'Add a bookmark' });
  await expect(toggle).toHaveAttribute('aria-controls', 'add-form');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');

  await expect(page.getByRole('textbox', { name: 'Address' })).toBeVisible();
  await expect(page.getByRole('textbox', { name: /^Name optional$/i })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
});

/* ------------------------------------------------------- names in both views */

test('every toolbar control and row action carries a name in both views', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://example.com/one', name: 'One' });

  for (const view of ['pills', 'list']) {
    if ((await page.locator('#list').getAttribute('data-view')) !== view) {
      await page.locator('#view-toggle').click();
      await expect(page.locator('#list')).toHaveAttribute('data-view', view);
    }

    expect(await unnamedControls(page), `unnamed controls in the ${view} view`).toEqual([]);

    const buttons = await namesOf(page, 'button');
    expect(buttons, `toolbar names in the ${view} view`).toEqual(
      expect.arrayContaining(['Add a bookmark', 'Lock the vault', 'Settings'])
    );
    expect(buttons.some((name) => /^Switch to (list|pills) view$/.test(name))).toBe(true);
  }

  /* The row actions exist only in the list view, and each one names the row it acts on: "Edit" twelve times over
     would tell a screen-reader user nothing about which row they are on. */
  const buttons = await namesOf(page, 'button');
  expect(buttons).toEqual(expect.arrayContaining(['Pin One', 'Edit One', 'Delete One']));
  expect(await namesOf(page, 'link')).toEqual(expect.arrayContaining(['One — example.com']));
});

test('a row is reachable by keyboard and named in both views', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://example.com/one', name: 'One' });
  await addBookmark(page, { url: 'https://example.com/two', name: 'Two' });

  for (const view of ['pills', 'list']) {
    if ((await page.locator('#list').getAttribute('data-view')) !== view) {
      await page.locator('#view-toggle').click();
      await expect(page.locator('#list')).toHaveAttribute('data-view', view);
    }

    await page.locator('#search').focus();
    const stops = await walkTabStops(page, 12);
    const names = stops.map((stop) => stop.name);

    expect(names, `row links reachable in the ${view} view`).toEqual(
      expect.arrayContaining(['One — example.com', 'Two — example.com'])
    );
  }
});

test('every keyboard stop in the vault paints a focus ring', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://example.com/one', name: 'One' });

  await page.locator('#search').focus();
  const stops = await walkTabStops(page, 10);

  /* A stop on BODY is the browser taking the focus away from the page, not a control that failed to draw. */
  const real = stops.filter((stop) => stop.tag !== 'BODY');
  expect(real.length).toBeGreaterThan(5);
  for (const stop of real) {
    expect(stop.ring, `${stop.tag}.${stop.id || stop.name} showed no focus ring`).toBe(true);
  }
});

test('focus moves into the add form, then back to the control that opened it', async ({ page }) => {
  await createVault(page);

  /* An empty vault opens the form for you; the field is where the typing goes. */
  await expect(page.locator('#add-url')).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(page.locator('#add-form')).toBeHidden();
  await expect(page.locator('#add-toggle')).toBeFocused();

  await page.locator('#add-toggle').click();
  await expect(page.locator('#add-url')).toBeFocused();

  await page.locator('#add-url').fill('https://example.com/one');
  await page.locator('#add-name').fill('One');
  await page.locator('#add-form').getByRole('button', { name: /^add$/i }).click();

  /* The row is not where focus belongs; the button that owns the form is. */
  await expect(page.locator('#add-toggle')).toBeFocused();
  await expect(page.locator('#add-toggle')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#list .row:not(.row-head)')).toHaveCount(1);
});

/* ------------------------------------------------------------------ structure */

/* Known defect: a drawn header row over <li>s, with no table and no column headers underneath it. */
test('the list view draws a table header that a screen reader can read as one', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://example.com/one', name: 'One' });
  await page.locator('#view-toggle').click();
  await expect(page.locator('#list')).toHaveAttribute('data-view', 'list');

  /* Name, Address, Uses and Last used are drawn as a header row over the values; the same four names must arrive as
     column headers inside a table, or the four columns are a stream of unlabelled text. */
  await expect.soft(page.getByRole('table', { name: 'Bookmarks' })).toHaveCount(1);
  await expect.soft(page.getByRole('columnheader')).toHaveText(['Name', 'Address', 'Uses', 'Last used']);
});

/* Known defect: aria-pressed is written only in the pressed position, and the name flips as well. */
test('the pin control reports its pressed state in both positions', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://example.com/one', name: 'One' });
  await page.locator('#view-toggle').click();

  /* A toggle button owes `aria-pressed` in both positions; naming the action is the alternative, not an addition. */
  const pin = page.getByRole('button', { name: 'Pin One' });
  await expect.soft(pin).toHaveAttribute('aria-pressed', 'false');

  await pin.click();
  await expect(page.getByRole('button', { name: 'Unpin One' })).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Unpin One' }).click();
  await expect.soft(page.getByRole('button', { name: 'Pin One' })).toHaveAttribute('aria-pressed', 'false');
});

test('headings run in order, in the vault and in the settings dialog', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://example.com/one', name: 'One' });
  await page.locator('#view-toggle').click();

  const assertOrder = async (where) => {
    const levels = await headingLevels(page);
    expect(levels[0], `first heading in ${where}`).toBe(1);
    expect(levels.filter((level) => level === 1).length, `one h1 in ${where}`).toBe(1);
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i] - levels[i - 1], `heading ${i} in ${where} jumps from h${levels[i - 1]} to h${levels[i]}`)
        .toBeLessThanOrEqual(1);
    }
  };

  await assertOrder('the vault');

  const modal = await openSettings(page);
  await expect(modal.getByRole('heading', { level: 2, name: 'Settings' })).toBeVisible();
  await assertOrder('the settings dialog');
});

/* --------------------------------------------------------------------- links */

test('a row link opens a new tab and says so to the browser', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://example.com/one', name: 'One' });
  await addBookmark(page, { url: 'https://example.com/two', name: 'Two' });

  for (const view of ['pills', 'list']) {
    if ((await page.locator('#list').getAttribute('data-view')) !== view) {
      await page.locator('#view-toggle').click();
      await expect(page.locator('#list')).toHaveAttribute('data-view', view);
    }

    const links = await page.locator('#list .row:not(.row-head) a').evaluateAll((nodes) =>
      nodes.map((node) => ({
        href: node.getAttribute('href'),
        target: node.getAttribute('target'),
        rel: (node.getAttribute('rel') ?? '').split(/\s+/).filter(Boolean)
      }))
    );

    expect(links.length, `links in the ${view} view`).toBe(2);
    for (const link of links) {
      expect(link.href).toMatch(/^https:\/\//);
      expect(link.target).toBe('_blank');
      expect(link.rel).toEqual(expect.arrayContaining(['noopener', 'noreferrer']));
    }
  }

  /* The way out of the page is a same-tab jump, not a new tab. */
  await expect(page.getByRole('link', { name: 'Skip to content' })).not.toHaveAttribute('target', /.*/);
});

/* ------------------------------------------------------------------- status */

test('status messages live in polite live regions and say what happened', async ({ page }) => {
  await createVault(page);

  /* The toast: role=status plus aria-live, so a change is announced without stealing focus. */
  const toast = page.locator('#status');
  await expect(toast).toHaveAttribute('role', 'status');
  await expect(toast).toHaveAttribute('aria-live', 'polite');

  /* The line under the form is the second one, and it reports the count. */
  const line = page.locator('#vault-status');
  await expect(line).toHaveAttribute('role', 'status');
  await expect(line).toHaveAttribute('aria-live', 'polite');
  await expect(line).toContainText(/bookmarks?/);

  await addBookmark(page, { url: 'https://example.com/one', name: 'One' });
  await expect(toast).toContainText(/added one/i);

  const statusNodes = (await axTree(page)).filter((node) => node.role === 'status');
  expect(statusNodes.length).toBeGreaterThanOrEqual(2);
  for (const node of statusNodes) expect(node.props.live).toBe('polite');
});

/* Known defect: the pill fades to opacity 0 and keeps a focusable Undo button inside it. */
test('a toast that has faded leaves nothing behind in the tab order', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://example.com/one', name: 'One' });
  await page.locator('#view-toggle').click();

  /* Deleting raises an Undo toast; while it is on screen the button is real and named. */
  await page.locator('#list .row [data-action=remove]').first().click();
  const undo = page.getByRole('button', { name: 'Undo' });
  await expect(undo).toBeVisible();

  /* Six seconds later the pill fades. What fades must also stop being reachable. */
  await expect(page.locator('#status')).not.toHaveClass(/\bvisible\b/, { timeout: 20_000 });
  const opacity = await page.locator('#status').evaluate((node) => getComputedStyle(node).opacity);
  expect.soft(opacity).toBe('0');

  await expect.soft(page.getByRole('button', { name: 'Undo' })).toHaveCount(0);

  await page.locator('#settings-button').focus();
  await page.keyboard.press('Tab');
  const landedInToast = await page.evaluate(() => Boolean(document.activeElement.closest('#status')));
  expect.soft(landedInToast, 'Tab reached the faded toast').toBe(false);
});

/* ----------------------------------------------------------------- collected */

/* Known defect: the same drawn-header-without-a-table as the vault list. */
test('the collected section draws a table header it also exposes as column headers', async ({ page, context }) => {
  await createVault(page);
  await enableCollection(page);
  await visit(context, '/a11y-collected');
  await page.waitForTimeout(6_000);

  const rows = await collectedRows(page);
  test.skip(
    rows.length === 0,
    'The extension did not fill the section, so there are no collected rows to read roles from. The section is ' +
      'drawn by the same row code as the vault list.'
  );

  await page.locator('#view-toggle').click();
  await expect(page.locator('#collected-list')).toHaveAttribute('data-view', 'list');

  await expect.soft(page.getByRole('table', { name: 'Collected links' })).toHaveCount(1);
  /* A selection column has no visible text, so the name it is announced by is what is compared. */
  const headers = await page
    .locator('#collected-list [role=columnheader]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label') ?? node.textContent.trim()));
  expect.soft(headers).toEqual(['Select', 'Name', 'Address', 'Visits', 'Last seen']);

  /* One checkbox per row plus the one that selects the lot, and every one of them names what it selects. */
  const boxes = await namesOf(page, 'checkbox');
  expect(boxes).toContain('Select every collected row');
  expect(boxes.length).toBe(rows.length + 1);
  for (const box of boxes) expect(box).not.toBe('');

  const links = await page.locator('#collected-list .row:not(.row-head) a').evaluateAll((nodes) =>
    nodes.map((node) => ({ target: node.getAttribute('target'), rel: node.getAttribute('rel') ?? '' }))
  );
  for (const link of links) {
    expect(link.target).toBe('_blank');
    expect(link.rel).toContain('noopener');
  }
});

/* --------------------------------------------------------------- the settings sheet */

test('the settings sheet names every control, including the collected-link ones', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://example.com/one', name: 'One' });
  await openSettings(page);

  /* The sheet is one long form of switches, selects and rows; none of it may be announced as an unnamed
     control, which is what a keyboard or screen-reader user meets first. */
  expect(await unnamedControls(page), 'unnamed controls in Settings').toEqual([]);

  const names = (await axTree(page)).map((node) => node.name);
  for (const wanted of [
    'Record each site as',
    'Group by domain',
    'Include private windows',
    'Keep collected links for',
    'Keep at most',
    'New addresses a day',
    'Show rows seen at least',
    'Add a site rule',
    'Exclude a site or a page'
  ]) {
    expect(
      names.some((name) => name.startsWith(wanted)),
      `Settings names "${wanted}" (saw: ${names.filter((name) => name !== '').slice(0, 20).join(' | ')})`
    ).toBe(true);
  }
});

test('the site-rule and exclusion dialogs name their field and their scope, and give focus back', async ({
  page
}) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://example.com/one', name: 'One' });

  const cases = [
    {
      item: /^Add a site rule/,
      title: 'Record a site differently',
      field: 'Site',
      scope: 'How to record this site'
    },
    {
      item: /^Exclude a site or a page/,
      title: 'Never collect this',
      field: 'Site, hostname or path',
      scope: 'What to exclude'
    }
  ];

  for (const { item, title, field, scope } of cases) {
    const modal = await openSettings(page);
    await (await settingsItem(modal, item)).click();

    const dialog = page.getByRole('dialog', { name: title });
    await expect(dialog, `${title} is a named dialog`).toBeVisible();
    await expect(page.getByRole('textbox', { name: field }), `${title} focuses its field`).toBeFocused();
    await expect(page.getByRole('combobox', { name: scope }), `${title} names its scope`).toBeVisible();
    expect(await unnamedControls(page), `unnamed controls in ${title}`).toEqual([]);

    /* Escape leaves the dialog and puts the keyboard back on the Settings button that started it. */
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('#settings-button'), `${title} gives focus back`).toBeFocused();
  }
});

/* --------------------------------------------------------------------- lock */

test('locking the vault returns the keyboard to the unlock field', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://example.com/one', name: 'One' });

  await lockVault(page);
  await expect(page.locator('#app-view')).toBeHidden();
  await expect(page.locator('#phrase')).toBeFocused();

  /* The locked page is still the lock screen, not a blank one, and its controls are still named. */
  expect(await unnamedControls(page)).toEqual([]);
});
