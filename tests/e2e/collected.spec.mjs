/**
 * The collection: what the extension counts, what the section shows, and every way a row leaves it.
 *
 * Each test starts from a fresh profile, so the extension's storage is empty and the counts are its own.
 */

import {
  addBookmark,
  chooseSetting,
  closeSettings,
  collectedRows,
  createVault,
  enableCollection,
  expect,
  expectCollectedCount,
  openSettings,
  settingsItem,
  test,
  toggleSetting,
  vaultRows,
  visit
} from './fixtures.mjs';

test('nothing is collected until the vault turns it on', async ({ page, context }) => {
  await createVault(page);

  await visit(context, '/while-off');
  await page.waitForTimeout(3_000);

  await expect(page.locator('#collected')).toBeHidden();
  await expect(page.locator('#collected-list .row')).toHaveCount(0);
});

test('a page opened in the browser is listed with its count once collection is on', async ({ page, context }) => {
  await createVault(page);
  await enableCollection(page);

  await visit(context, '/first');
  await expectCollectedCount(page, 1);

  const [row] = await collectedRows(page);
  expect(row.url).toBe('https://e2e.local/first');
  expect(row.visits).toBe(1);
  await expect(page.locator('#collected-count')).toContainText(/1 address . 1 visit/);
});

test('opening the same page again raises its count instead of adding a row', async ({ page, context }) => {
  await createVault(page);
  await enableCollection(page);

  await visit(context, '/again');
  await expectCollectedCount(page, 1);

  await visit(context, '/again');
  await visit(context, '/again');

  await expect(page.locator('#collected-count')).toContainText(/1 address . 3 visits/, { timeout: 30_000 });
  expect((await collectedRows(page))[0].visits).toBe(3);
});

test('a page added to the vault leaves the section and keeps its visits', async ({ page, context }) => {
  await createVault(page);
  await enableCollection(page);

  await visit(context, '/keep');
  await visit(context, '/keep');
  await expectCollectedCount(page, 1);

  await page.locator('#view-toggle').click();
  await page.locator('#collected-list [data-action=collect]').first().click();

  await expect(page.locator('#list .row:not(.row-head)')).toHaveCount(1);
  await expect(page.locator('#collected')).toBeHidden({ timeout: 20_000 });

  const [bookmark] = await vaultRows(page);
  expect(bookmark.name).toBe('keep');
  expect(bookmark.uses).toBe(2);
});

test('a bookmark opened in the browser raises its own count', async ({ page, context }) => {
  await createVault(page);
  await enableCollection(page);

  await visit(context, '/mirror');
  await expectCollectedCount(page, 1);
  await page.locator('#view-toggle').click();
  await page.locator('#collected-list [data-action=collect]').first().click();
  await expect(page.locator('#list .row:not(.row-head)')).toHaveCount(1);
  expect((await vaultRows(page))[0].uses).toBe(1);

  /* The address is opened again in the browser, not in the vault: the count must follow. */
  await visit(context, '/mirror');
  await expect
    .poll(async () => (await vaultRows(page))[0].uses, { timeout: 30_000 })
    .toBe(2);
});

test('a batch of collected rows is added in one action', async ({ page, context }) => {
  await createVault(page);
  await enableCollection(page);

  await visit(context, '/batch-one');
  await visit(context, '/batch-two');
  await visit(context, '/batch-three');
  await expectCollectedCount(page, 3);

  await page.locator('#view-toggle').click();
  await page.locator('#collected-all').check();
  await expect(page.locator('#collected-bar-count')).toHaveText(/3 of 3 selected/);
  await page.locator('#collected-add').click();

  await expect(page.locator('#list .row:not(.row-head)')).toHaveCount(3);
  await expect(page.locator('#status')).toContainText(/added 3 links/i);
});

test('dismissing a row removes it and leaves the vault alone', async ({ page, context }) => {
  await createVault(page);
  await enableCollection(page);

  await visit(context, '/dismiss-me');
  await expectCollectedCount(page, 1);

  await page.locator('#view-toggle').click();
  await page.locator('#collected-list [data-pick]').first().check();
  await page.locator('#collected-dismiss').click();

  await expect(page.locator('#collected')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('#list .row:not(.row-head)')).toHaveCount(0);
});

test('an exclusion stops collection and takes the rows it covered with it', async ({ page, context }) => {
  await createVault(page);
  await enableCollection(page);

  await visit(context, '/excluded-page');
  await expectCollectedCount(page, 1);

  const modal = await openSettings(page);
  await settingsItem(modal, /exclude a site or a page/i).click();
  await page.locator('#modal-root input[type=text]').fill('e2e.local');
  await page.locator('#modal-root select').selectOption('site');
  await page.locator('#modal-root').getByRole('button', { name: /^exclude$/i }).click();
  await closeSettings(page);

  await expect(page.locator('#collected')).toBeHidden({ timeout: 20_000 });

  await visit(context, '/after-exclusion');
  await page.waitForTimeout(4_000);
  await expect(page.locator('#collected')).toBeHidden();
});

test('a site rule records one row per hostname instead of one per page', async ({ page, context }) => {
  await createVault(page);
  await enableCollection(page);

  const modal = await openSettings(page);
  await settingsItem(modal, /add a site rule/i).click();
  await page.locator('#modal-root input[type=text]').fill('e2e.local');
  await page.locator('#modal-root select').selectOption('hosts');
  await page.locator('#modal-root').getByRole('button', { name: /^save$/i }).click();
  await closeSettings(page);

  await visit(context, '/ruled-a');
  await visit(context, '/ruled-b');
  await visit(context, '/ruled-c');

  await expectCollectedCount(page, 1);
  const [row] = await collectedRows(page);
  expect(row.url).toBe('https://e2e.local/');
  expect(row.visits).toBe(3);
});

test('turning collection back on fills the section without a reload', async ({ page, context }) => {
  await createVault(page);
  await enableCollection(page);

  await visit(context, '/kept-while-off');
  await expectCollectedCount(page, 1);

  /* Off: the addresses stay in the browser but the section goes, which is what makes them look lost. */
  const off = await openSettings(page);
  await settingsItem(off, /collection: on|collect links on this device/i).click();
  await closeSettings(page);
  await expect(page.locator('#collected')).toBeHidden({ timeout: 20_000 });

  /* On again, with no reload: the list comes back on its own. */
  const on = await openSettings(page);
  await settingsItem(on, /collect links on this device/i).click();
  await closeSettings(page);
  await expectCollectedCount(page, 1);
});

test('clearing removes what was collected and keeps the vault', async ({ page, context }) => {
  await createVault(page);
  await enableCollection(page);
  await addBookmark(page, { url: 'https://e2e.local/saved', name: 'Saved' });

  await visit(context, '/cleared');
  await expectCollectedCount(page, 1);

  const modal = await openSettings(page);
  await settingsItem(modal, /clear collected links/i).click();
  await page.locator('#modal-root').getByRole('button', { name: /^clear$/i }).click();

  await expect(page.locator('#collected')).toBeHidden({ timeout: 20_000 });
  await expect(page.locator('#list .row:not(.row-head)')).toHaveCount(1);
});

test('the visit floor hides a row that has been seen once, and shows it again later', async ({ page, context }) => {
  await createVault(page);
  await enableCollection(page);
  await chooseSetting(page, /show rows seen at least/i, '2');

  await visit(context, '/floor');
  await page.waitForTimeout(4_000);
  await expect(page.locator('#collected')).toBeHidden();

  await visit(context, '/floor');
  await expectCollectedCount(page, 1);
});
