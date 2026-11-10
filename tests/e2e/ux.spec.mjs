/**
 * User journeys: the sentences a first-time visitor reads, and the small interactions around adding, finding,
 * sorting, locking, and the collected section — checked the way a person meets them (a message appears, a control is
 * disabled, focus lands somewhere useful) rather than by inspecting markup.
 *
 * Every test starts on a fresh browser profile with the extension loaded, so the vault and the extension's storage
 * are both empty and nothing depends on the order the tests run in.
 */

import {
  addBookmark,
  chooseSetting,
  closeSettings,
  collectedRows,
  createVault,
  enableCollection,
  expect,
  lockVault,
  openSettings,
  settingsItem,
  test,
  unlockVault,
  vaultRows,
  visit
} from './fixtures.mjs';

/* The toolbar toggle names the view it moves to, so its own words say which view is on screen now. */
async function showListView(page) {
  if (/switch to list view/i.test((await page.locator('#view-toggle').getAttribute('aria-label')) ?? '')) {
    await page.locator('#view-toggle').click();
  }
  await expect(page.locator('#list')).toHaveAttribute('data-view', 'list');
}

async function showPillsView(page) {
  if (/switch to pills view/i.test((await page.locator('#view-toggle').getAttribute('aria-label')) ?? '')) {
    await page.locator('#view-toggle').click();
  }
  await expect(page.locator('#list')).toHaveAttribute('data-view', 'pills');
}

const rows = (page) => page.locator('#list .row:not(.row-head)');

/**
 * Wait for the section to reach a size, and when it never does, say what the page heard back from the extension.
 * The section is optional and fills from a message, so "nothing appeared" is otherwise indistinguishable from
 * "no extension" — which is exactly what a person is left guessing at too.
 */
async function expectCollected(page, count) {
  const collected = page.locator('#collected-list .row:not(.row-head)');
  try {
    await expect(collected).toHaveCount(count, { timeout: 30_000 });
  } catch {
    const reply = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const id = 987654;
          const onMessage = (event) => {
            if (event.data?.source === 'bookmarks-collector' && event.data.id === id) {
              window.removeEventListener('message', onMessage);
              resolve(event.data.reply ?? null);
            }
          };
          window.addEventListener('message', onMessage);
          window.postMessage({ source: 'bookmarks-page', version: 1, id, type: 'hello' }, window.location.origin);
          setTimeout(() => resolve('no answer from any extension'), 2500);
        })
    );
    const origin = await page.evaluate(() => location.origin);
    throw new Error(
      `the collected section showed ${await collected.count()} row(s) instead of ${count}, and the page's own ` +
        `hello to the extension answered ${JSON.stringify(reply)} from origin ${origin}. ` +
        'The extension refuses the vault page on any origin that carries a port (see FINDINGS).'
    );
  }
}

/* ------------------------------------------------------------ 1. the first run */

test('a device that holds nothing explains itself, and a new vault lands on an empty list with the add form open', async ({
  page
}) => {
  /* What the lock screen says before anything has happened on this device. */
  await expect(page.locator('#lock-view')).toBeVisible();
  await expect(page.locator('.lede')).toContainText(/sealed in this browser/i);
  await expect(page.locator('.field-label').first()).toHaveText('Your 13-word phrase');
  await expect(page.locator('#phrase-hint')).toHaveText(
    'Thirteen words, separated by spaces. The phrase is never sent anywhere.'
  );
  await expect(page.locator('#remember')).not.toBeChecked();
  await expect(page.locator('#remember-hint')).toContainText(/stores this vault's key and a sign-in secret/i);
  await expect(page.locator('.lock-note')).toContainText(/There is no recovery/i);
  await expect(page.locator('#lock-device-note')).toHaveText(
    'No vault on this device yet. Enter your 13 words to load a synced one, or create a new vault.'
  );
  await expect(page.locator('#phrase')).toBeFocused();
  await expect(page.locator('#unlock-button')).toBeVisible();
  await expect(page.locator('#restore-button')).toBeVisible();

  /* Creating one: the phrase is shown once, and the vault is not made until it is acknowledged. */
  await page.locator('#new-vault-button').click();
  const modal = page.locator('#modal-root');
  await expect(modal.getByRole('dialog', { name: 'Your new vault' })).toBeVisible();

  const phrase = (await modal.locator('.phrase-line').textContent()).trim();
  expect(phrase.split(' ')).toHaveLength(13);

  const create = modal.getByRole('button', { name: /create vault/i });
  await expect(create).toBeDisabled();
  await expect(modal).toContainText(/I have saved these thirteen words somewhere safe/i);

  await modal.locator('input[type=checkbox]').check();
  await expect(create).toBeEnabled();
  await create.click();

  await expect(page.locator('#app-view')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('#status')).toContainText(
    'Vault created. Add a bookmark, or import a file from Settings.'
  );
  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#empty')).toHaveText(
    'No bookmarks yet. Add one above, or import a file from Settings.'
  );
  await expect(page.locator('#vault-status')).toContainText(/0 bookmarks/);
  await expect(page.locator('#add-form')).toBeVisible();
  await expect(page.locator('#add-url')).toBeFocused();
});

/* -------------------------------------------------- 2. refusals in the add form */

test('a repeated address is named as already bookmarked, and a bad one is refused in the address field', async ({
  page
}) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/once', name: 'Once' });
  await expect(rows(page)).toHaveCount(1);

  /* The same address again, under a different name. */
  await addBookmark(page, { url: 'https://e2e.local/once', name: 'Again' });

  /* The message names what is already saved, and the field is emptied so the next Add is not the same refusal. */
  await expect(page.locator('#status')).toContainText(/“Once” is already saved/);
  await expect(rows(page)).toHaveCount(1);
  expect((await vaultRows(page)).map((row) => row.name)).toEqual(['Once']);
  await expect(page.locator('#add-form')).toBeVisible();
  await expect(page.locator('#add-url')).toHaveValue('');

  /* A scheme the app will not save: the message names it, and the field is marked and focused. */
  await page.locator('#add-url').fill('javascript:alert(1)');
  await page.locator('#add-form').getByRole('button', { name: /^add$/i }).click();
  await expect(page.locator('#status')).toContainText(/not a page address/);
  await expect(page.locator('#add-url')).toBeFocused();
  await expect(page.locator('#add-url')).toHaveAttribute('aria-invalid', 'true');
  await expect(rows(page)).toHaveCount(1);

  /* Text that is not an address at all. */
  await page.locator('#add-url').fill('not a url');
  await page.locator('#add-form').getByRole('button', { name: /^add$/i }).click();
  await expect(page.locator('#status')).toContainText(/“not a url” is not a page address/);
  await expect(page.locator('#add-url')).toBeFocused();
  await expect(rows(page)).toHaveCount(1);
});

test('pressing Add with nothing typed says what is missing', async ({ page }) => {
  await createVault(page);

  await page.locator('#add-form').getByRole('button', { name: /^add$/i }).click();

  /* It used to say nothing at all, which reads as a broken button. */
  await expect(page.locator('#status')).toContainText(/type the address/i);
  await expect(page.locator('#add-url')).toBeFocused();
  await expect(page.locator('#add-url')).toHaveAttribute('aria-invalid', 'true');
  await expect(rows(page)).toHaveCount(0);
});

/* ----------------------------------------------------------------- 3. search */

test('a search with no match says so, and clearing it brings the list back', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/alpha', name: 'Alpha' });
  await addBookmark(page, { url: 'https://e2e.local/beta', name: 'Beta' });
  await expect(rows(page)).toHaveCount(2);

  await page.locator('#search').fill('zzz-nothing');

  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator('#empty')).toBeVisible();
  await expect(page.locator('#empty')).toHaveText('No bookmark matches “zzz-nothing”.');
  /* The line above the list still describes the vault, not the search. */
  await expect(page.locator('#vault-status')).toContainText(/2 bookmarks/);

  await page.locator('#search').fill('');

  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('#empty')).toBeHidden();
  await expect(page.locator('#search')).toHaveValue('');
});

/* ------------------------------------------------------------------- 4. sort */

test('the sort control reorders the rows on screen', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/alpha', name: 'Alpha' });
  await addBookmark(page, { url: 'https://e2e.local/mike', name: 'Mike' });
  await addBookmark(page, { url: 'https://e2e.local/zeta', name: 'Zeta' });

  /* Nothing has been used yet, so the default "Most used" falls back to the name. */
  await expect(page.locator('#sort')).toHaveValue('clicks');
  expect((await vaultRows(page)).map((row) => row.name)).toEqual(['Alpha', 'Mike', 'Zeta']);

  await page.locator('#sort').selectOption('recent');
  await expect
    .poll(async () => (await vaultRows(page)).map((row) => row.name))
    .toEqual(['Zeta', 'Mike', 'Alpha']);

  await page.locator('#sort').selectOption('name');
  await expect
    .poll(async () => (await vaultRows(page)).map((row) => row.name))
    .toEqual(['Alpha', 'Mike', 'Zeta']);
});

/* --------------------------------------------------------- 5. lock and unlock */

test('locking says this device holds a vault, and the phrase opens it again', async ({ page }) => {
  const phrase = await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/kept', name: 'Kept' });
  await expect(rows(page)).toHaveCount(1);

  await lockVault(page);

  await expect(page.locator('#app-view')).toBeHidden();
  await expect(page.locator('#lock-device-note')).toBeVisible();
  await expect(page.locator('#lock-device-note')).toHaveText(
    'This device holds a vault. Enter its 13 words to open it.'
  );
  await expect(page.locator('#lock-error')).toBeVisible();
  await expect(page.locator('#lock-error')).toHaveText('Locked. Enter your phrase to reopen the vault.');
  await expect(page.locator('#phrase')).toBeFocused();
  await expect(page.locator('#phrase')).toHaveValue('');

  await unlockVault(page, phrase);

  expect((await vaultRows(page)).map((row) => row.name)).toEqual(['Kept']);
  await expect(page.locator('#lock-device-note')).toBeHidden();
  await expect(page.locator('#lock-error')).toBeHidden();
});

/* -------------------------------------------------------------- 6. settings */

/* Known defect: one Escape closes the dialog and the add form behind it, and focus lands on Add. */
test('settings opens with the keyboard inside it, closes with Escape, and names the collection switch', async ({
  page
}) => {
  await createVault(page);

  const modal = await openSettings(page);
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(modal.locator('select').first()).toBeFocused();

  /* The switch says what it does while it is off, and says its state once it is on. */
  await expect(settingsItem(modal, /collect links on this device/i)).toContainText(/off by default/i);
  await expect(modal.getByRole('heading', { name: 'Collected links' })).toBeVisible();

  await page.keyboard.press('Escape');
  await expect(modal.locator('.settings-list')).toHaveCount(0);
  /* One Escape closes Settings. The add form behind it was open before and is not part of that press. */
  await expect(page.locator('#add-form')).toBeVisible();
  await expect(page.locator('#settings-button')).toBeFocused();

  await page.locator('#settings-button').click();
  await settingsItem(modal, /collect links on this device/i).click();
  /* Turning it on closes the dialog: the switch is the whole action. */
  await expect(modal.locator('.settings-list')).toHaveCount(0);

  await page.locator('#settings-button').click();
  await expect(settingsItem(modal, /collection: on/i)).toContainText(/counts the addresses this browser opens/i);
  await closeSettings(page);
});

/* ------------------------------------- 7. a setting change reaches the section */

test('a collection setting regroups the section without a reload', async ({ page, context }) => {
  await createVault(page);
  await enableCollection(page);

  /* Two pages on one host, counted one address at a time at the default level. */
  await visit(context, '/one');
  await visit(context, '/two');
  await expectCollected(page, 2);
  await expect(page.locator('#collected-count')).toContainText(/2 addresses/);

  await page.evaluate(() => {
    window.__uxNoReload = true;
  });
  await chooseSetting(page, /record each site as/i, 'hosts');

  await expectCollected(page, 1);
  const [row] = await collectedRows(page);
  expect(row.host).toBe('e2e.local');
  expect(row.visits).toBe(2);
  expect(await page.evaluate(() => window.__uxNoReload === true)).toBe(true);
});

/* -------------------------------------------------------- 8. approving a row */

test('a collected row is approved with a message, and the bar counts what is selected', async ({ page, context }) => {
  await createVault(page);
  await enableCollection(page);
  await visit(context, '/approve-me');
  await visit(context, '/keep-me');
  await expectCollected(page, 2);
  await showListView(page);

  /* The row's own Add approves just that one, and says which. */
  const approve = page.locator('#collected-list .row[data-url="https://e2e.local/approve-me"] [data-action=collect]');
  await approve.click();
  await expect(page.locator('#status')).toContainText(/added approve-me/i);
  await expect(rows(page)).toHaveCount(1);
  expect((await vaultRows(page))[0].name).toBe('approve-me');

  /* What is left: one row, nothing selected, and nothing to press yet. */
  await expectCollected(page, 1);
  await expect(page.locator('#collected-bar')).toBeVisible();
  await expect(page.locator('#collected-bar-count')).toHaveText('1 collected');
  for (const id of ['#collected-add', '#collected-dismiss', '#collected-exclude']) {
    await expect(page.locator(id)).toBeDisabled();
  }

  await page.locator('#collected-list [data-pick]').first().check();
  await expect(page.locator('#collected-bar-count')).toHaveText('1 of 1 selected');
  await expect(page.locator('#collected-add')).toBeEnabled();

  await page.locator('#collected-add').click();

  await expect(page.locator('#status')).toContainText(/added 1 link\./i);
  await expect(rows(page)).toHaveCount(2);
  await expect(page.locator('#collected')).toBeHidden({ timeout: 20_000 });
});

/* --------------------------------------------- 9. selection across the views */

test('switching views keeps the collected selection and the bar consistent', async ({ page, context }) => {
  await createVault(page);
  await enableCollection(page);
  await visit(context, '/first-choice');
  await visit(context, '/second-choice');
  await expectCollected(page, 2);
  await showListView(page);

  await expect(page.locator('#collected-bar-count')).toHaveText('2 collected');
  await page.locator('#collected-list [data-pick]').nth(1).check();
  await expect(page.locator('#collected-bar-count')).toHaveText('1 of 2 selected');
  await expect(page.locator('#collected-add')).toBeEnabled();
  await expect(page.locator('#collected-exclude')).toBeEnabled();

  /* Pills are for reading; the bar is list furniture. */
  await showPillsView(page);
  await expect(page.locator('#collected')).toBeVisible();
  await expect(page.locator('#collected-bar')).toBeHidden();

  await showListView(page);
  await expect(page.locator('#collected-bar')).toBeVisible();
  await expect(page.locator('#collected-bar-count')).toHaveText('1 of 2 selected');

  const checked = await page
    .locator('#collected-list [data-pick]')
    .evaluateAll((nodes) => nodes.filter((node) => node.checked).map((node) => node.dataset.pick));
  expect(checked).toEqual(['https://e2e.local/second-choice']);

  await page.locator('#collected-all').check();
  await expect(page.locator('#collected-bar-count')).toHaveText('2 of 2 selected');
  await expect(page.locator('#collected-add')).toBeEnabled();
});

/* ------------------------------------------------------- 10. delete and undo */

test('a deleted bookmark is offered back with Undo', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/keep-me', name: 'Keep me' });
  await showListView(page);

  await page.getByRole('button', { name: 'Delete Keep me' }).click();

  await expect(rows(page)).toHaveCount(0);
  await expect(page.locator('#status')).toContainText(/deleted keep me/i);
  const undo = page.locator('#status').getByRole('button', { name: /undo/i });
  await expect(undo).toBeVisible();

  await undo.click();

  await expect(rows(page)).toHaveCount(1);
  await expect(page.locator('#status')).toContainText(/restored keep me/i);
  expect((await vaultRows(page)).map((row) => row.name)).toEqual(['Keep me']);
});

/* -------------------------------------------- 11. import and export entry points */

test('import and export are reachable from Settings', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/exported', name: 'Exported' });

  const modal = await openSettings(page);
  await expect(modal.getByRole('heading', { name: 'Export' })).toBeVisible();
  await expect(modal.getByRole('heading', { name: 'Import' })).toBeVisible();

  for (const name of [/^sealed backup/i, /^plain json/i, /^browser bookmarks/i, /^a json or html file/i]) {
    await expect(modal.getByRole('button', { name })).toBeEnabled();
  }

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    modal.getByRole('button', { name: /^plain json/i }).click()
  ]);
  expect(download.suggestedFilename()).toMatch(/^bookmarks-\d{4}-\d{2}-\d{2}\.json$/);
  await expect(page.locator('#status')).toContainText(/plain export downloaded. it is not encrypted\./i);
  await expect(modal.locator('.settings-list')).toHaveCount(0);

  /* The import entry point opens a file picker; naming a file is not needed to prove it is there. */
  await page.locator('#settings-button').click();
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    modal.getByRole('button', { name: /^a json or html file/i }).click()
  ]);
  expect(chooser).toBeTruthy();
  await chooser.setFiles([]).catch(() => {});
});
