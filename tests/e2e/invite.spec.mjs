/**
 * The invite code, from the page's side.
 *
 * A server may refuse to create an account unless the person brings a code. What is proved here is the page's half:
 * the question appears where it is asked, the three refusals read as three sentences, the code travels on the one
 * request that creates an account, and nothing keeps a copy of it.
 *
 * The refusal answers are stubbed because the local test server is open — it takes no code, which is the subject of
 * the last test. What a refusal *means* is the registry's own behaviour and is covered by the unit tests on the
 * server side; what happens on the page when the server says it is what these tests drive in a real browser.
 */

import {
  addBookmark,
  createVault,
  expect,
  openSettings,
  settingsItem,
  test,
  turnOnSyncPatiently
} from './fixtures.mjs';

/** Everything a page could keep a string in, as one string. */
async function everythingStored(page) {
  return page.evaluate(async () => {
    const local = JSON.stringify({ ...localStorage });
    const session = JSON.stringify({ ...sessionStorage });

    const databases = (await indexedDB.databases?.()) ?? [];
    let records = '';
    for (const info of databases) {
      if (!info.name) continue;
      const db = await new Promise((done) => {
        const open = indexedDB.open(info.name);
        open.onsuccess = () => done(open.result);
        open.onerror = () => done(null);
      });
      if (!db) continue;
      for (const store of [...db.objectStoreNames]) {
        records += await new Promise((done) => {
          const read = db.transaction(store).objectStore(store).getAll();
          read.onsuccess = () => done(JSON.stringify(read.result));
          read.onerror = () => done('');
        });
      }
      db.close();
    }

    return `${local}|${session}|${records}|${location.href}`;
  });
}

test('a server that needs a code asks for one, and three refusals read as three sentences', async ({ page }) => {
  const phrase = await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/keeper', name: 'Keeper' });

  const sent = [];
  let answer = { status: 403, error: 'invite_required' };

  await page.route('**/api/a/*/account', async (route) => {
    sent.push(route.request().postDataJSON());
    await route.fulfill({
      status: answer.status,
      contentType: 'application/json',
      body: JSON.stringify({ error: answer.error })
    });
  });

  await turnOnSyncPatiently(page, phrase);

  /* The question appears on the page, in the section whose switch asked it, with the keyboard on it. */
  const row = page.locator('#modal-root [data-setting="sync-invite"]');
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('#invite-code')).toBeFocused();
  await expect(page.locator('#invite-code')).toHaveValue('');
  await expect(page.locator('#modal-root')).toContainText(/This is a code, not the phrase/i);

  /* The first request carried an empty code rather than a missing field. */
  expect(sent[0].invite, 'the first creation request carries an invite field').toBe('');

  /* A code that is spent, then one that has expired: two different sentences. */
  answer = { status: 422, error: 'invite_used' };
  await page.locator('#invite-code').fill('SPENT-CODE-1234');
  await page.getByRole('button', { name: 'Use this code' }).click();
  await expect(page.locator('body')).toContainText(/already been used/i, { timeout: 15_000 });
  await expect(page.locator('#invite-code')).toBeFocused();

  answer = { status: 410, error: 'invite_expired' };
  await page.locator('#invite-code').fill('OLD-CODE-5678');
  await page.getByRole('button', { name: 'Use this code' }).click();
  await expect(page.locator('body')).toContainText(/has expired/i, { timeout: 15_000 });

  /* Both codes travelled, and the second went out as it was typed. */
  const codes = sent.map((body) => body.invite).filter((value) => value !== '');
  expect(codes).toEqual(expect.arrayContaining(['SPENT-CODE-1234', 'OLD-CODE-5678']));

  /* Nothing kept a copy: not the device storage, not the vault's records, not the address bar. */
  const stored = await everythingStored(page);
  expect(stored, 'the spent code is nowhere on the device').not.toContain('SPENT-CODE-1234');
  expect(stored, 'the expired code is nowhere on the device').not.toContain('OLD-CODE-5678');
  /* The vault is the root of its own origin: the code never ends up in the address bar, and neither does a page. */
  const { pathname, search } = new URL(page.url());
  expect(`${pathname}${search}`, 'the code is not in the address bar').toBe('/');
});

test('an open server never asks for a code, and sync turns on', async ({ page }) => {
  const phrase = await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/keeper', name: 'Keeper' });

  await turnOnSyncPatiently(page, phrase);

  /* The local server takes no codes: the account is created and the question is never asked. */
  await expect(page.locator('#vault-status')).toContainText(/sync/i, { timeout: 30_000 });

  const modal = await openSettings(page);
  await expect(modal.locator('[data-setting="sync-invite"]')).toHaveCount(0);
  await expect(await settingsItem(modal, /^Sync: on/)).toBeVisible();
});

test('the code field fits a phone and a monitor, and says what it is to a screen reader', async ({ page }) => {
  const phrase = await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/keeper', name: 'Keeper' });

  await page.route('**/api/a/*/account', (route) =>
    route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'invite_required' })
    })
  );

  await turnOnSyncPatiently(page, phrase);
  await expect(page.locator('#modal-root [data-setting="sync-invite"]')).toBeVisible({ timeout: 15_000 });

  for (const [width, height, name] of [
    [390, 844, 'phone'],
    [2560, 1440, 'monitor']
  ]) {
    await page.setViewportSize({ width, height });
    await page.waitForTimeout(400);

    const measured = await page.evaluate(() => {
      const sheet = document.querySelector('.settings-modal .modal-body');
      const row = document.querySelector('[data-setting="sync-invite"]');
      const field = document.querySelector('#invite-code');
      const box = row.getBoundingClientRect();
      return {
        sheetOverflow: sheet.scrollWidth - sheet.clientWidth,
        rowOverflow: row.scrollWidth - row.clientWidth,
        rowWidth: Math.round(box.width),
        fieldWidth: Math.round(field.getBoundingClientRect().width),
        label: field.getAttribute('aria-label'),
        described: field.getAttribute('aria-describedby'),
        hint: document.querySelector(`#${field.getAttribute('aria-describedby')}`)?.textContent ?? ''
      };
    });

    expect(measured.sheetOverflow, `${name}: the sheet does not scroll sideways`).toBeLessThanOrEqual(1);
    expect(measured.rowOverflow, `${name}: the row does not scroll sideways`).toBeLessThanOrEqual(1);
    expect(measured.rowWidth, `${name}: the row has width`).toBeGreaterThan(120);
    expect(measured.fieldWidth, `${name}: the field has room to type in`).toBeGreaterThan(80);
    expect(measured.label, `${name}: the field has a name`).toBe('Invite code');
    expect(measured.hint, `${name}: the hint is attached and says what a code is`).toMatch(/not the phrase/i);
  }
});
