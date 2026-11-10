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
  await expect(settingsItem(modal, /collected links|collect links/i)).toBeVisible();
  await closeSettings(page);
});

test('a vault that was never created shows the lock screen on a fresh visit', async ({ context }) => {
  const page = await context.newPage();
  await page.goto(`${BASE_URL}/w/bookmarks/`);
  await expect(page.locator('#lock-view')).toBeVisible();
  await expect(page.locator('#app-view')).toBeHidden();
  await page.close();
});
