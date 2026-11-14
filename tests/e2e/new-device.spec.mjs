/**
 * A device that holds nothing, and the phrase that names a vault on the server.
 *
 * This is the screen Aravinth asked for: enter the 13 words on a laptop that has never seen the
 * vault, and the app asks the server whether a copy exists before leaving you on an empty list
 * that reads as lost data. Two real profiles, one real server, and the ordinary phrase — nothing
 * here carries the sealed backup across by hand.
 *
 * The two answers are both tests: loading brings the bookmarks over and turns sync on; starting
 * empty leaves the device on its own and keeps sync off, without asking again on every unlock.
 */

import {
  addBookmark,
  closeSettings,
  createVault,
  expect,
  launch,
  openSettings,
  openVault,
  settingsItem,
  test,
  turnOnSyncPatiently,
  vaultRows
} from './fixtures.mjs';

/** Device A: a vault with one bookmark, synced. Returns the phrase that names it. */
async function syncedVault(page) {
  const phrase = await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/carried', name: 'Carried' });
  await turnOnSyncPatiently(page, phrase);
  await expect(page.locator('#vault-status')).toContainText(/Synced/i, { timeout: 30_000 });
  return phrase;
}

/** Device B: a fresh profile, the phrase, and the question the app asks before the empty list. */
async function askOnDevice(phrase) {
  const device = await launch();
  const other = await openVault(await device.context.newPage());
  await other.locator('#phrase').fill(phrase);
  await other.locator('#unlock-button').click();

  const prompt = other.getByRole('dialog', { name: 'This vault is on the server' });
  await expect(prompt, 'a device that holds nothing is asked about the server copy').toBeVisible({
    timeout: 30_000
  });
  await expect(prompt, 'the question says what loading does').toContainText(/Loading brings its bookmarks/i);
  return { device, page: other, prompt };
}

test('loading the server copy brings the bookmarks across and turns sync on', async ({ page }) => {
  test.setTimeout(420_000);
  const phrase = await syncedVault(page);

  const { device, page: other, prompt } = await askOnDevice(phrase);
  try {
    await prompt.getByRole('button', { name: 'Load from server' }).click();

    /* The pull is a real sync on a device that had nothing; the row arrives from the server. */
    await expect(other.locator('#vault-status')).toContainText(/Synced/i, { timeout: 60_000 });
    await expect
      .poll(async () => (await vaultRows(other)).map((row) => row.name), { timeout: 60_000 })
      .toContain('Carried');

    const modal = await openSettings(other);
    await expect(await settingsItem(modal, /^Sync: on/), 'loading leaves sync on').toBeVisible();
    await closeSettings(other);
  } finally {
    await device.close();
  }
});

test('starting empty leaves this device alone, with sync still off', async ({ page }) => {
  test.setTimeout(420_000);
  const phrase = await syncedVault(page);

  const { device, page: other, prompt } = await askOnDevice(phrase);
  try {
    await prompt.getByRole('button', { name: 'Start empty' }).click();

    /* No bookmarks, and nothing was turned on behind the answer. */
    await expect.poll(async () => (await vaultRows(other)).length, { timeout: 15_000 }).toBe(0);

    const modal = await openSettings(other);
    await expect(await settingsItem(modal, /^Sync: off/), 'starting empty keeps sync off').toBeVisible();
    await closeSettings(other);

    /* The vault was written when the phrase was accepted, so the question is not asked again. */
    await other.reload();
    await expect(other.locator('#lock-view')).toBeVisible();
  } finally {
    await device.close();
  }
});

test('a server that cannot answer says so instead of opening silently empty', async ({ page }) => {
  test.setTimeout(420_000);
  const phrase = await syncedVault(page);

  const device = await launch();
  try {
    const other = await openVault(await device.context.newPage());

    /* The existence check is the one request that could be refused by the limiter or lost to an
       outage. It is answered with a refusal here, which is the shape the client treats as "could
       not ask" — the branch that must not leave an empty list unexplained. */
    await other.route('**/api/a/*/challenge', (route) =>
      route.fulfill({
        status: 429,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'rate_limited' })
      })
    );

    await other.locator('#phrase').fill(phrase);
    await other.locator('#unlock-button').click();

    await expect(other.locator('#status'), 'the device says it could not ask').toContainText(
      /Could not ask the server about this vault/i,
      { timeout: 15_000 }
    );
    await expect(other.getByRole('dialog'), 'no question is drawn when the answer is unknown').toHaveCount(0);
    await expect.poll(async () => (await vaultRows(other)).length, { timeout: 15_000 }).toBe(0);
  } finally {
    await device.close();
  }
});
