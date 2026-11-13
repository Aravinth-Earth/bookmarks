/**
 * Two browsers, one phrase, one total.
 *
 * The claim this proves is the one a person cannot check by looking: each browser counts only what it saw, and the
 * number they read afterwards is the sum. Nothing here is stubbed — two separate Chromium profiles with the extension
 * loaded, one real server, and the sealed backup carried from the first to the second.
 *
 * The order matters and is the order a person would use: make the vault and turn sync on in the first browser, carry
 * the sealed backup to the second, count something in each, then reconcile.
 *
 * If a device's count were written into one shared number, the second browser would read 2 and the first 3; if a device
 * counted twice on every sync, the total would climb. Both show as a wrong number here.
 */

import {
  addBookmark,
  closeSettings,
  createVault,
  enableCollection,
  expect,
  launch,
  openSettings,
  openVault,
  settingsItem,
  syncNow,
  test,
  turnOnSync,
  vaultRows,
  visit
} from './fixtures.mjs';

/** The uses count of the named row, read the way the person reads it. */
async function usesOf(page, name) {
  const rows = await vaultRows(page);
  const row = rows.find((each) => each.name === name);
  return row ? row.uses : null;
}

/** Wait until the named row reads the expected number, or say what it read instead. */
async function expectUses(page, name, expected) {
  await expect
    .poll(async () => usesOf(page, name), {
      timeout: 30_000,
      message: `${name} should read ${expected}`
    })
    .toBe(expected);
}

test('what each browser counted is added up, and nothing is counted twice', async ({ page, context }, testInfo) => {
  /* ---- the first browser: a vault, a bookmark, two visits, sync on ---- */
  const phrase = await createVault(page);

  await addBookmark(page, { url: 'https://e2e.local/shared', name: 'Shared' });
  await enableCollection(page);

  await visit(context, '/shared');
  await visit(context, '/shared');
  await expectUses(page, 'Shared', 2);

  await turnOnSync(page, phrase);
  await expect(page.locator('#vault-status')).toContainText(/Synced \d/i, { timeout: 30_000 });
  await closeSettings(page);
  await expectUses(page, 'Shared', 2);

  /* ---- the sealed backup, carried to the second browser ---- */
  const modal = await openSettings(page);
  const download = page.waitForEvent('download');
  await (await settingsItem(modal, /sealed backup/i)).click();
  const backup = testInfo.outputPath('to-the-second-browser.json');
  await (await download).saveAs(backup);
  await closeSettings(page);

  /* ---- the second browser: a separate profile, the same phrase ---- */
  const second = await launch();
  try {
    const other = await openVault(await second.context.newPage());

    await other.locator('#phrase').fill(phrase);
    const chooser = other.waitForEvent('filechooser');
    await other.locator('#restore-button').click();
    await (await chooser).setFiles(backup);
    await expect(other.locator('#app-view')).toBeVisible({ timeout: 60_000 });

    /* The backup carries the first browser's count, so the second one starts by reading it. */
    await expectUses(other, 'Shared', 2);

    /* It counts what it saw itself, once. */
    await visit(second.context, '/shared');
    await expectUses(other, 'Shared', 3);

    /* ---- and the two are added, in both directions ---- */
    await syncNow(other);
    await expect(other.locator('#vault-status')).toContainText(/Synced \d/i, { timeout: 30_000 });
    await closeSettings(other);

    await syncNow(page);
    await expect(page.locator('#vault-status')).toContainText(/Synced \d/i, { timeout: 30_000 });
    await closeSettings(page);

    await expectUses(page, 'Shared', 3);
    await expectUses(other, 'Shared', 3);

    /* Reconciling again changes nothing: the same two counts, added once. A push that added its own number to the
       other side's would read 4 here, then 5, every time someone pressed the button. */
    await syncNow(page);
    await expect(page.locator('#vault-status')).toContainText(/Synced \d/i, { timeout: 30_000 });
    await closeSettings(page);
    await syncNow(other);
    await expect(other.locator('#vault-status')).toContainText(/Synced \d/i, { timeout: 30_000 });
    await closeSettings(other);

    /* A reading taken after the round trip: neither side invented a count. */
    await expectUses(page, 'Shared', 3);
    await expectUses(other, 'Shared', 3);
  } finally {
    await second.close();
  }
});
