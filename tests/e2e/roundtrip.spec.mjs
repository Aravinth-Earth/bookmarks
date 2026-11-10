/**
 * One real journey, end to end: a vault is made, a bookmark is added by hand and another comes from the collection,
 * the sealed backup is downloaded, the device is cleared, and the backup is restored with the same phrase.
 *
 * This is the only test that walks the export path, and the only one that proves a cleared device can be brought
 * back — the two things a person cannot check by looking at the screen.
 */

import {
  addBookmark,
  closeSettings,
  collectedRows,
  createVault,
  enableCollection,
  expect,
  expectCollectedCount,
  openSettings,
  settingsItem,
  test,
  vaultRows,
  visit
} from './fixtures.mjs';

test('a vault, a collected page, a backup, a wiped device, and the same vault back again', async ({ page, context }, testInfo) => {
  const phrase = await createVault(page);

  await addBookmark(page, { url: 'https://e2e.local/hand-added', name: 'Hand added' });

  await enableCollection(page);
  await visit(context, '/journey');
  await visit(context, '/journey');
  await expectCollectedCount(page, 1);
  await page.locator('#view-toggle').click();
  await page.locator('#collected-list [data-action=collect]').first().click();
  await expect(page.locator('#list .row:not(.row-head)')).toHaveCount(2);

  /* Export: the sealed backup is a download, so it is captured rather than found in a folder. */
  const modal = await openSettings(page);
  const download = page.waitForEvent('download');
  await settingsItem(modal, /sealed backup/i).click();
  const backup = testInfo.outputPath('vault-backup.json');
  await (await download).saveAs(backup);
  await closeSettings(page);

  const before = await vaultRows(page);
  expect(before.map((row) => row.name).sort()).toEqual(['Hand added', 'journey']);

  /* Wipe the device, which is what someone would do before handing a laptop on. */
  const clearModal = await openSettings(page);
  await settingsItem(clearModal, /clear this device/i).click();
  await page.locator('#modal-root').getByRole('button', { name: /^clear/i }).click();
  await expect(page.locator('#lock-view')).toBeVisible({ timeout: 30_000 });

  /* Restore: the phrase first, then the file. */
  await page.locator('#phrase').fill(phrase);
  const chooser = page.waitForEvent('filechooser');
  await page.locator('#restore-button').click();
  await (await chooser).setFiles(backup);

  await expect(page.locator('#app-view')).toBeVisible({ timeout: 60_000 });
  const after = await vaultRows(page);
  expect(after.map((row) => row.name).sort()).toEqual(['Hand added', 'journey']);
  expect(after.find((row) => row.name === 'journey').uses).toBe(2);
});
