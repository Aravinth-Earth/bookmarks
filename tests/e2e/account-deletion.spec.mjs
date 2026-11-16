/**
 * Deleting an account from one device, and what the other device is told.
 *
 * The claim is the one a person cannot check by looking: the server copy is gone, this device
 * holds nothing, and another device that still holds the phrase is refused instead of quietly
 * creating the account again. Two real profiles, one real server, no secrets and no operator
 * page.
 *
 * The phrase is asked for even though both profiles remember their signing key. That is the
 * point of the dialog: a remembered device is not a person saying yes.
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

/**
 * Open a second profile and ask the server for the copy the phrase names.
 *
 * The question about a server copy is a sign-in request, and the suite shares one source's
 * sign-in budget, so the answer can be a limiter rather than a copy. When that happens the
 * dialog is never drawn; turning sync on by hand reaches the same account, and the fixture
 * waits the window out. The account is the same either way.
 */
async function loadOnSecondDevice(phrase) {
  const device = await launch();
  const page = await openVault(await device.context.newPage());
  await page.locator('#phrase').fill(phrase);
  await page.locator('#unlock-button').click();

  const prompt = page.getByRole('dialog', { name: 'This vault is on the server' });
  const offered = await prompt
    .waitFor({ state: 'visible', timeout: 30_000 })
    .then(() => true)
    .catch(() => false);

  if (offered) {
    await prompt.getByRole('button', { name: 'Load from server' }).click();
    await expectSynced(page, { attempts: 1 });
  } else {
    await turnOnSyncPatiently(page, phrase);
    await expectSynced(page, { attempts: 1 });
  }
  return { device, page };
}

/**
 * Ask for the deletion and wait out the sign-in limiter, which this route spends.
 *
 * The refusal is a wait, not a failure: the dialog stays open with the sentence, so the retry is
 * the same three fields. Any other sentence is the test's failure and is thrown.
 */
async function deletePatiently(page, phrase) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const modal = await openSettings(page);
    await (await settingsItem(modal, /^Delete account/)).click();

    const dialog = page.getByRole('dialog', { name: 'Delete this account?' });
    await expect(dialog, 'the destructive action asks first').toBeVisible();
    await dialog.getByRole('textbox', { name: 'Your 13-word phrase' }).fill(phrase);
    await dialog.getByRole('textbox', { name: 'Type DELETE to confirm' }).fill('DELETE');
    await dialog.getByRole('button', { name: 'Delete account' }).click();

    const locked = await page
      .locator('#lock-view')
      .waitFor({ state: 'visible', timeout: 30_000 })
      .then(() => true)
      .catch(() => false);
    if (locked) return;

    const sentence = ((await dialog.locator('.form-error').textContent().catch(() => '')) ?? '').trim();
    if (!/Too many attempts/i.test(sentence)) {
      throw new Error(`the deletion was refused: ${sentence || 'no sentence on the dialog'}`);
    }

    const named = Number((/about (\d+) seconds/.exec(sentence) ?? [])[1] ?? 60);
    await page.keyboard.press('Escape');
    await page.waitForTimeout((Math.min(named, 65) + 1) * 1_000);
  }

  throw new Error('the sign-in limiter kept refusing the deletion');
}

/**
 * Wait until the other device reports the deletion, waiting out a late limiter.
 *
 * A sync started by the previous save can still be in flight when Sync now is pressed, so the
 * status can read "Synced" for a moment before the refusal replaces it. The first thing to wait
 * for is therefore either sentence, then the limiter's own window if that is what arrived.
 */
async function expectDeletedNotice(page) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await syncNow(page);
    await expect
      .poll(async () => ((await page.locator('#vault-status').textContent()) ?? '').trim(), {
        timeout: 90_000
      })
      .toMatch(/Account deleted|Not now/);

    const reading = (await page.locator('#vault-status').textContent()) ?? '';
    if (/Account deleted/i.test(reading)) return;

    const named = Number(await page.locator('#vault-status').getAttribute('data-retry-after')) || 60;
    await page.waitForTimeout((Math.min(named, 65) + 1) * 1_000);
  }

  throw new Error('the other device was never told the account was deleted');
}

test('deleting clears this device, and another device is told the account is gone', async ({ page }) => {
  test.setTimeout(600_000);

  /* ---- this device: a vault with one bookmark, synced ---- */
  const phrase = await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/erased', name: 'Erased' });
  await turnOnSyncPatiently(page, phrase);
  await expectSynced(page);

  /* ---- another device: its own local copy too, so "out of reach" is real ---- */
  const other = await loadOnSecondDevice(phrase);
  try {
    await expect
      .poll(async () => (await vaultRows(other.page)).map((row) => row.name), { timeout: 60_000 })
      .toContain('Erased');

    /* ---- the deletion ---- */
    await deletePatiently(page, phrase);

    await expect(page.locator('#app-view'), 'the page is locked after deleting').toBeHidden();
    await expect(page.locator('#lock-error'), 'the lock screen says what happened').toContainText(
      /deleted/i
    );

    /* The remembered key went with the vault: a reload cannot reopen it. This is the difference
       between locking and a wipe. */
    await page.reload();
    await expect(page.locator('#lock-view')).toBeVisible();
    await expect(page.locator('#app-view')).toBeHidden();

    /* ---- the other device is refused, and keeps its own copy ---- */
    await expectDeletedNotice(other.page);
    await expect(
      other.page.locator('#vault-status'),
      'the device is told the account was deleted'
    ).toContainText(/Account deleted/i, { timeout: 30_000 });

    /* It is still the person's local vault: a deletion is not a remote wipe. */
    expect((await vaultRows(other.page)).map((row) => row.name)).toContain('Erased');

    /* It did not take the register path: after a pause, the refusal is still the reading. */
    await other.page.waitForTimeout(2_000);
    await expect(other.page.locator('#vault-status')).toContainText(/Account deleted/i);
  } finally {
    await other.device.close();
  }
});
