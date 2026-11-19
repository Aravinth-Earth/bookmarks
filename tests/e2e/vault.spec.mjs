/**
 * The vault itself, without the extension: create, add, find, sort, lock, unlock, and the refusals.
 */

import {
  addBookmark,
  closeSettings,
  createVault,
  expect,
  lockVault,
  openSettings,
  openVault,
  settingsItem,
  test,
  unlockVault,
  vaultRows,
  BASE_URL
} from './fixtures.mjs';

import { LOCK_CHANNEL } from '../../public/lock-signal.js';

test('a new vault opens on an empty list and says so', async ({ page }) => {
  const phrase = await createVault(page);

  expect(phrase.split(' ')).toHaveLength(13);
  await expect(page.locator('#list .row:not(.row-head)')).toHaveCount(0);
  await expect(page.locator('#empty')).toContainText(/no bookmarks yet/i);
  await expect(page.locator('#vault-status')).toContainText(/0 bookmarks/i);
});

test('a bookmark is added, found by search, and is still there after a lock and unlock', async ({ page }) => {
  const phrase = await createVault(page);

  await addBookmark(page, { url: 'https://e2e.local/alpha', name: 'Alpha' });
  await addBookmark(page, { url: 'https://e2e.local/beta', name: 'Beta' });
  await expect(page.locator('#list .row:not(.row-head)')).toHaveCount(2);

  await page.locator('#search').fill('alpha');
  await expect(page.locator('#list .row:not(.row-head)')).toHaveCount(1);
  await expect(page.locator('#list .row-name').first()).toHaveText('Alpha');

  await page.locator('#search').fill('');
  await lockVault(page);
  await unlockVault(page, phrase);
  expect((await vaultRows(page)).map((row) => row.name).sort()).toEqual(['Alpha', 'Beta']);
});

test('the same address is refused twice', async ({ page }) => {
  await createVault(page);

  await addBookmark(page, { url: 'https://e2e.local/once', name: 'Once' });
  await addBookmark(page, { url: 'https://e2e.local/once', name: 'Again' });

  await expect(page.locator('#status')).toContainText(/already saved/i);
  await expect(page.locator('#list .row:not(.row-head)')).toHaveCount(1);
});

test('a wrong phrase does not open the vault', async ({ page }) => {
  await createVault(page);
  await lockVault(page);

  await page.locator('#phrase').fill('wrong words only');
  await page.locator('#unlock-button').click();

  await expect(page.locator('#lock-error')).toBeVisible();
  await expect(page.locator('#app-view')).toBeHidden();
});

test('the pills view is for reading and the list is for editing', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/pill', name: 'Pill' });

  /* Pills first: the controls exist in the markup but the row offers no visible action. */
  await expect(page.locator('#view-toggle')).toHaveAttribute('aria-label', /switch to list view/i);
  await expect(page.locator('#list .row-actions').first()).toBeHidden();

  await page.locator('#view-toggle').click();
  await expect(page.locator('#view-toggle')).toHaveAttribute('aria-label', /switch to pills view/i);
  await expect(page.locator('#list .row-actions').first()).toBeVisible();
  await expect(page.locator('#list .row-head')).toBeVisible();
});

test('the settings screen opens, and closes with Escape', async ({ page }) => {
  await createVault(page);

  const modal = await openSettings(page);
  await expect(await settingsItem(modal, /collected links|collect links/i)).toBeVisible();
  await closeSettings(page);
});

test('a vault that was never created shows the lock screen on a fresh visit', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/`);
  await expect(page.locator('#lock-view')).toBeVisible();
  await expect(page.locator('#app-view')).toBeHidden();
  await page.close();
});

/**
 * A lock that arrives from another tab takes the open dialog with it.
 *
 * The dialog is appended to `#modal-root`, beside `#app-view`, so hiding the app leaves it painted
 * over the lock screen with a bookmark's address and name still readable — and the global key
 * handler stands aside while a dialog is open, so Escape cannot dismiss it either. The other tab
 * locks through the toolbar button, which is the path a person uses without opening Settings.
 */
test('a lock from another tab closes the open bookmark dialog', async ({ page, context }) => {
  const phrase = await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/kept', name: 'Kept' });

  /* The row's own buttons are in the list view; the pills view is for reading. */
  await page.locator('#view-toggle').click();
  await expect(page.locator('#view-toggle')).toHaveAttribute('aria-label', /switch to pills view/i);
  await page.getByRole('button', { name: 'Edit Kept' }).click();
  const sheet = page.getByRole('dialog', { name: 'Edit bookmark' });
  await expect(sheet.locator('input[type=text]').first()).toHaveValue('https://e2e.local/kept');
  await expect(sheet.getByLabel('Name')).toHaveValue('Kept');

  /* A second tab on the same profile, opened with the phrase: the lock it sends reaches the first. */
  const other = await context.newPage();
  try {
    await other.goto(`${BASE_URL}/`);
    await other.locator('#phrase').fill(phrase);
    await other.locator('#unlock-button').click();
    await expect(other.locator('#app-view')).toBeVisible({ timeout: 60_000 });

    await other.locator('#lock-button').click();
    await expect(other.locator('#lock-view')).toBeVisible({ timeout: 30_000 });

    await expect(page.locator('#lock-view')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#modal-root')).toBeEmpty();
    await expect(page.locator('#modal-root')).not.toContainText('e2e.local/kept');
    await expect(page.locator('#phrase')).toBeFocused();
  } finally {
    await other.close();
  }
});

/**
 * The recovery phrase must not outlive the lock either.
 *
 * A device with no vault offers the new-vault dialog, which draws the 13 words in `#modal-root`. A
 * lock from another tab reaches this page as well, and the sheet — and the words in it — have to
 * go with the app. The signal is sent the way the page sends it: the module's own channel name,
 * and a message that carries nothing but its type.
 */
test('a lock from another tab closes the new-vault dialog and takes the phrase with it', async ({ page, context }) => {
  await page.locator('#new-vault-button').click();
  const phrase = (await page.locator('#modal-root .phrase-line').textContent()).trim();
  expect(phrase.split(' ')).toHaveLength(13);

  const other = await context.newPage();
  try {
    await other.goto(`${BASE_URL}/`);
    await other.evaluate((channel) => {
      const sender = new BroadcastChannel(channel);
      sender.postMessage({ type: 'locked' });
      sender.close();
    }, LOCK_CHANNEL);

    await expect(page.locator('#lock-view')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#modal-root')).toBeEmpty();
    await expect(page.locator('body')).not.toContainText(phrase);
    await expect(page.locator('#phrase')).toBeFocused();
  } finally {
    await other.close();
  }
});
