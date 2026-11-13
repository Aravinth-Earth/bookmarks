/**
 * The first install: the extension opens this page, the page asks once, and nothing is counted until it is answered.
 *
 * The extension's own default is off, so the question is the only thing that can turn collection on — which is what
 * makes "install" and "consent" two separate acts instead of one.
 */

import {
  BASE_URL,
  collectedRows,
  createVault,
  expect,
  enableCollection,
  openVault,
  test,
  unlockVault,
  visit
} from './fixtures.mjs';

const SETUP = `${BASE_URL}/?collector=installed`;

/** The extension's own idea of what it should be doing, read where it keeps it. */
async function extensionPolicy(context) {
  const worker = context.serviceWorkers().find((entry) => entry.url().startsWith('chrome-extension://'));
  if (!worker) return null;
  return worker.evaluate(async () => (await chrome.storage.local.get('policy')).policy ?? null);
}

test('an install link opens the vault and asks before anything is counted', async ({ page }) => {
  const phrase = await createVault(page);

  /* The link is a page load, so the vault is locked again by it; the question waits for the phrase. */
  await page.goto(SETUP);
  await unlockVault(page, phrase);

  await expect(page.getByRole('dialog', { name: 'Set up collected links' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collect on this device' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Keep it off' })).toBeVisible();

  /* The address bar is cleaned at once: a reload is a page load, and must not ask a second time. */
  expect(page.url()).not.toContain('collector=');
});

test('answering the question turns collection on and asks for the defaults', async ({ page, context }) => {
  const phrase = await createVault(page);

  await page.goto(SETUP);
  await unlockVault(page, phrase);
  await page.getByRole('button', { name: 'Collect on this device' }).click();

  const defaults = page.getByRole('dialog', { name: 'How much should it keep?' });
  await expect(defaults).toBeVisible();
  await expect(defaults.getByRole('combobox').first()).toHaveValue('addresses');

  await defaults.getByRole('button', { name: 'Done' }).click();
  await expect(defaults).toBeHidden();

  /* What the extension now believes, read from its own storage. */
  await expect.poll(async () => (await extensionPolicy(context))?.enabled).toBe(true);

  await visit(context, '/after-setup');
  await expect(page.locator('#collected-list .row:not(.row-head)')).toHaveCount(1, { timeout: 30_000 });
  expect((await collectedRows(page))[0].url).toBe('https://e2e.local/after-setup');
});

test('"Keep it off" leaves collection off, and nothing is collected', async ({ page, context }) => {
  const phrase = await createVault(page);

  await page.goto(SETUP);
  await unlockVault(page, phrase);
  await page.getByRole('button', { name: 'Keep it off' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  await page.waitForTimeout(1_500);
  expect((await extensionPolicy(context))?.enabled ?? false).toBe(false);

  await visit(context, '/declined');
  await page.waitForTimeout(4_000);
  await expect(page.locator('#collected')).toBeHidden();
});

test('the question waits for a vault, and is asked once there is one', async ({ page }) => {
  /* A device that holds nothing: the setup link lands on the lock screen, and the question is kept for later. */
  await openVault(page);
  await page.goto(SETUP);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('#lock-view')).toBeVisible();

  await createVault(page);
  await expect(page.getByRole('dialog', { name: 'Set up collected links' })).toBeVisible();

  /* And it is asked once: a reload after answering does not raise it again. */
  await page.getByRole('button', { name: 'Keep it off' }).click();
  await page.reload();
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
