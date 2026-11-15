/**
 * One place ends, the other keeps working.
 *
 * Two real profiles sign in with the same phrase. One is signed out from the other's Connected
 * places list, and the next request from the ended place is refused. The account, the vault and
 * the surviving sign-in are untouched — this is a sign-out, not a deletion.
 *
 * The ended device can sign in again with the phrase: revocation ends a session, and the
 * phrase is still the account's. What it must not do is keep using the token it was given.
 */

import {
  addBookmark,
  createVault,
  expect,
  expectSynced,
  launch,
  openSettings,
  openVault,
  settingsItem,
  syncNow,
  test,
  turnOnSyncPatiently,
  vaultRows
} from './fixtures.mjs';

async function loadOnSecondDevice(phrase) {
  const device = await launch();
  const page = await openVault(await device.context.newPage());
  await page.locator('#phrase').fill(phrase);
  await page.locator('#unlock-button').click();

  const prompt = page.getByRole('dialog', { name: 'This vault is on the server' });
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await prompt.getByRole('button', { name: 'Load from server' }).click();
  await expectSynced(page, { attempts: 1 });
  return { device, page };
}

test('a place is signed out from the list, and the survivor keeps syncing', async ({ page }) => {
  test.setTimeout(600_000);

  const phrase = await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/kept', name: 'Kept' });
  await turnOnSyncPatiently(page, phrase);
  await expectSynced(page);

  const other = await loadOnSecondDevice(phrase);
  try {
    await expect
      .poll(async () => (await vaultRows(other.page)).map((row) => row.name), { timeout: 60_000 })
      .toContain('Kept');

    /* ---- this device sees both places and ends the other one ---- */
    let modal = await openSettings(page);
    await (await settingsItem(modal, /^Connected places/)).click();

    const places = page.getByRole('dialog', { name: 'Connected places' });
    await expect(places).toBeVisible({ timeout: 30_000 });
    await expect
      .poll(async () => places.locator('.places-row').count(), { timeout: 30_000 })
      .toBeGreaterThan(1);

    /* One row is marked this device; the action belongs to the other rows. A patient sync can
       have signed in more than once, so every place that is not this one ends here: the claim is
       that this device's own sign-in is the survivor, not that there is exactly one other. */
    for (;;) {
      const rows = places.locator('.places-row');
      const count = await rows.count();
      if (count <= 1) break;

      const ended = rows.filter({ hasNotText: 'this device' }).first();
      const signOut = ended.getByRole('button', { name: /^Sign out / });
      await expect(signOut).toHaveAttribute(
        'aria-label',
        /^Sign out (Phone|Computer|Unknown device)$/
      );
      await signOut.click();
      await expect(rows, 'the list drops the ended place').toHaveCount(count - 1, {
        timeout: 30_000
      });
      await expect(page.locator('#status')).toContainText(/Signed out /);
    }

    await expect(places.locator('.places-row')).toHaveCount(1);
    await expect(places.locator('.places-row')).toContainText('this device');
    await page.keyboard.press('Escape');

    /* ---- the ended place's token is refused on its very next request ---- */
    modal = await openSettings(other.page);
    await (await settingsItem(modal, /^Connected places/)).click();
    await expect(other.page.locator('#status')).toContainText(/session expired/i, {
      timeout: 30_000
    });
    await expect(other.page.getByRole('dialog', { name: 'Connected places' })).toHaveCount(0);

    /* ---- the survivor keeps syncing, with the same account and vault ---- */
    await addBookmark(page, { url: 'https://e2e.local/after', name: 'After' });
    await syncNow(page);
    await expectSynced(page);

    /* ---- and the ended device can sign in again: it was a sign-out, not a ban ---- */
    await syncNow(other.page);
    await expectSynced(other.page);
    await expect
      .poll(async () => (await vaultRows(other.page)).map((row) => row.name), { timeout: 60_000 })
      .toContain('After');
  } finally {
    await other.device.close();
  }
});
