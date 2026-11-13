/**
 * The harness: one browser profile with the extension in it, one mock site, and the few actions every test needs.
 *
 * The mock site is intercepted by Playwright rather than fetched, so a test that says "three pages of one host" does
 * not depend on a network, a port, or a server somebody has to remember to start.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, expect, test as base } from '@playwright/test';

const here = path.dirname(fileURLToPath(import.meta.url));

/** The extension that lives beside this test, never an absolute path from the machine it was written on. */
export const EXTENSION_DIR = path.resolve(here, '..', '..', 'extension');

export const BASE_URL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${process.env.E2E_PORT ?? 8899}`;
export const SITE = 'https://e2e.local';

/** A profile in the system temp directory, deleted when the test ends. */
export function profileDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bookmarks-e2e-'));
}

/**
 * Turn sync on through the sheet.
 *
 * The phrase is only asked for when this page does not already hold it: a vault created in this session has it, so the
 * prompt is a question that may not be asked — both cases have to work, and this waits for whichever happens.
 */
export async function turnOnSync(page, phrase) {
  const modal = await openSettings(page);
  await (await settingsItem(modal, /^Sync: off/)).click();

  const prompt = page.locator('#modal-root .phrase-input');
  const asked = await prompt
    .waitFor({ state: 'visible', timeout: 3000 })
    .then(() => true)
    .catch(() => false);

  if (asked) {
    await prompt.fill(phrase);
    await page.locator('#modal-root').getByRole('button', { name: 'Turn on sync' }).click();
  }
}

/** Ask the server for the other device's copy now, rather than waiting for the next change. */
export async function syncNow(page) {
  const modal = await openSettings(page);
  await (await settingsItem(modal, /^Sync now/)).click();
}

/**
 * A real Chromium with (or without) the extension.
 *
 * `channel: 'chromium'` is what makes headless carry an extension: the headless shell has no extension machinery at
 * all, and a test that silently ran without the extension would pass for the wrong reason.
 */
export async function launch({ withExtension = true, slowMo = 0 } = {}) {
  const dir = profileDir();
  const context = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: true,
    slowMo,
    viewport: { width: 1280, height: 1000 },
    args: withExtension
      ? [
          `--disable-extensions-except=${EXTENSION_DIR}`,
          `--load-extension=${EXTENSION_DIR}`,
          /* A first install opens the hosted vault before any route is registered, so the name is pointed at the
             machine itself: it fails at once instead of reaching for the deployed build on every test. */
          '--host-resolver-rules=MAP bookmarks.332321.xyz 127.0.0.1'
        ]
      : ['--host-resolver-rules=MAP bookmarks.332321.xyz 127.0.0.1']
  });

  /* A first install opens the hosted vault to ask its question. The suite answers that origin itself, so a test run
     never reaches the network and never depends on the deployed build. */
  await context.route('https://bookmarks.332321.xyz/**', (route) =>
    route.fulfill({ status: 204, contentType: 'text/html', body: '' })
  );

  await context.route(`${SITE}/**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><title>${route.request().url()}</title><body><h1>mock page</h1></body>`
    })
  );

  return {
    context,
    async close() {
      await context.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/** The id the browser gave the unpacked extension, read from its own worker rather than assumed. */
export async function extensionId(context) {
  let workers = context.serviceWorkers();
  if (workers.length === 0) {
    await context.waitForEvent('serviceworker', { timeout: 15_000 }).catch(() => {});
    workers = context.serviceWorkers();
  }
  const url = workers[0]?.url() ?? '';
  return url.startsWith('chrome-extension://') ? url.split('/')[2] : null;
}

/* ------------------------------------------------------------------ the vault */

export async function openVault(page) {
  await page.goto(`${BASE_URL}/w/bookmarks/`);
  await expect(page.locator('#lock-view')).toBeVisible();
  return page;
}

/** Make a vault and return the phrase it was sealed with, which the screen shows once. */
export async function createVault(page) {
  await page.locator('#new-vault-button').click();

  const phraseLine = page.locator('#modal-root .phrase-line');
  await expect(phraseLine).toBeVisible();
  const phrase = (await phraseLine.textContent()).trim();

  await page.locator('#modal-root input[type=checkbox]').check();
  await page.locator('#modal-root').getByRole('button', { name: /create vault/i }).click();

  await expect(page.locator('#app-view')).toBeVisible({ timeout: 60_000 });
  return phrase;
}

export async function unlockVault(page, phrase) {
  await expect(page.locator('#lock-view')).toBeVisible();
  await page.locator('#phrase').fill(phrase);
  await page.locator('#unlock-button').click();
  await expect(page.locator('#app-view')).toBeVisible({ timeout: 60_000 });
}

/**
 * Lock through Settings.
 *
 * The toolbar carries a Lock button, but it has no handler bound to it, so clicking it does nothing; the Settings
 * item is the path that actually locks. That defect is logged rather than fixed here.
 */
export async function lockVault(page) {
  const modal = await openSettings(page);
  await (await settingsItem(modal, /lock the vault/i)).click();
  await expect(page.locator('#lock-view')).toBeVisible({ timeout: 30_000 });
}

/**
 * Add one bookmark.
 *
 * An empty vault already has the form open, so the toggle is only pressed when the form is closed — pressing it on
 * an open form closes it, and the typing then lands nowhere.
 */
export async function addBookmark(page, { url, name = '' }) {
  if (!(await page.locator('#add-form').isVisible())) await page.locator('#add-toggle').click();
  await expect(page.locator('#add-form')).toBeVisible();
  await page.locator('#add-url').fill(url);
  if (name !== '') await page.locator('#add-name').fill(name);
  await page.locator('#add-form').getByRole('button', { name: /^add$/i }).click();
}

/* ------------------------------------------------------------------ settings */

export async function openSettings(page) {
  await page.locator('#settings-button').click();
  const modal = page.locator('#modal-root');
  await expect(modal.locator('.settings-list').first()).toBeVisible();
  return modal;
}

/**
 * One row of the settings sheet. Every section of the sheet is open at once, so the row is simply found.
 */
export async function settingsItem(modal, label) {
  return modal.locator('.settings-item').filter({ hasText: label }).first();
}

/** Settings closes and reopens itself after a change, so this is the way back out. */
export async function closeSettings(page) {
  await page.keyboard.press('Escape');
  await expect(page.locator('#modal-root .settings-list')).toHaveCount(0);
}

/** Collection is off until the vault says otherwise, and the vault says it here. */
export async function enableCollection(page) {
  const modal = await openSettings(page);
  await (await settingsItem(modal, /collect links on this device/i)).click();
  await closeSettings(page);
}

export async function chooseSetting(page, label, value) {
  const modal = await openSettings(page);
  await (await settingsItem(modal, label)).locator('select').selectOption(value);
  await closeSettings(page);
}

export async function toggleSetting(page, label) {
  const modal = await openSettings(page);
  await (await settingsItem(modal, label)).locator('input[type=checkbox]').click();
  await closeSettings(page);
}

/* ------------------------------------------------------------------ the collected section */

export async function collectedRows(page) {
  const rows = page.locator('#collected-list .row:not(.row-head)');
  return rows.evaluateAll((nodes) =>
    nodes.map((node) => ({
      url: node.dataset.url,
      host: node.dataset.host,
      visits: Number(node.dataset.visits),
      depth: Number(node.dataset.depth),
      name: node.querySelector('.row-name')?.textContent ?? '',
      address: node.querySelector('.row-host')?.textContent ?? ''
    }))
  );
}

export async function vaultRows(page) {
  return page
    .locator('#list .row:not(.row-head)')
    .evaluateAll((nodes) =>
      nodes.map((node) => ({
        name: node.querySelector('.row-name')?.textContent ?? '',
        address: node.querySelector('.row-host')?.textContent ?? '',
        uses: Number(node.querySelector('.clicks')?.textContent ?? '0')
      }))
    );
}

/** Open a mocked page in the same browser, which is what the extension counts. */
export async function visit(context, pathname) {
  const page = await context.newPage();
  await page.goto(`${SITE}${pathname}`);
  await page.waitForLoadState('load');
  return page;
}

/** Wait until the section agrees with the condition, because it fills from a message rather than a reload. */
export async function expectCollectedCount(page, count) {
  await expect(page.locator('#collected-list .row:not(.row-head)')).toHaveCount(count, { timeout: 30_000 });
}

export const test = base.extend({
  /* One browser per test file, because the profile carries the extension and its storage. */
  context: async ({}, use) => {
    const browser = await launch();
    await use(browser.context);
    await browser.close();
  },
  page: async ({ context }, use) => {
    const page = await openVault(await context.newPage());
    await use(page);
  }
});

export { expect };
