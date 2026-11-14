/**
 * A server copy sealed before the version was bound, opened on a device that holds nothing.
 *
 * The old build sealed the vault under the account id alone; the current build seals under the
 * id and the version. A device that has written a bound blob must refuse the old shape (a server
 * could otherwise serve an older ciphertext over newer data), but a device that has just accepted
 * a phrase holds nothing and is the only place its owner's old copy can be opened at all.
 *
 * The sign-in and the account are real; only the pull is answered with the old-shape bytes, which
 * is exactly the state an old vault on the server is in.
 */

import {
  addBookmark,
  closeSettings,
  createVault,
  expect,
  launch,
  openVault,
  test,
  turnOnSyncPatiently
} from './fixtures.mjs';

test('an old-shape server copy opens on a device that holds nothing', async ({ page }) => {
  test.setTimeout(420_000);

  const phrase = await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/current', name: 'Current' });
  await turnOnSyncPatiently(page, phrase);
  await expect(page.locator('#vault-status')).toContainText(/Synced/i, { timeout: 30_000 });
  await closeSettings(page);

  /* Build the blob the way the old build did: the associated data is the account id, with no
     version number in it. */
  const legacy = await page.evaluate(async (secret) => {
    const cryptoModule = await import('/crypto.js');
    const model = await import('/bookmarks.js');

    const { accountId, vaultKey } = await cryptoModule.deriveAccount(secret);
    let document = model.createDocument();
    document = model.addBookmark(document, {
      url: 'https://e2e.local/legacy',
      name: 'From the old build'
    }).document;
    const sealed = await cryptoModule.seal(vaultKey, document, accountId);

    return { iv: sealed.iv, ct: sealed.ct };
  }, phrase);

  const second = await launch();
  try {
    const other = await openVault(await second.context.newPage());

    /* The account is real and the sign-in is real; the copy comes from the old shape. */
    await other.route('**/api/a/*/vault', (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          version: 7,
          iv: legacy.iv,
          ct: legacy.ct,
          updatedAt: Date.now()
        })
      });
    });

    await other.locator('#phrase').fill(phrase);
    await other.locator('#unlock-button').click();

    const prompt = other.getByRole('dialog', { name: 'This vault is on the server' });
    await expect(prompt).toBeVisible({ timeout: 30_000 });
    await prompt.getByRole('button', { name: 'Load from server' }).click();

    await expect(other.locator('#vault-status')).toContainText(/Synced/i, { timeout: 60_000 });
    await expect
      .poll(
        async () =>
          other
            .locator('#list .row:not(.row-head) .row-name')
            .evaluateAll((nodes) => nodes.map((node) => node.textContent.trim())),
        { timeout: 30_000 }
      )
      .toContain('From the old build');
  } finally {
    await second.close();
  }
});
