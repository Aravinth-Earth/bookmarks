/**
 * Edges and refusals: addresses that are not web pages, a section with no extension behind it, and the controls that
 * narrow the list.
 */

import {
  addBookmark,
  collectedRows,
  createVault,
  enableCollection,
  expect,
  expectCollectedCount,
  launch,
  test,
  visit,
  vaultRows,
  BASE_URL
} from './fixtures.mjs';

test('a page that is not a web address is never collected', async ({ page, context }) => {
  await createVault(page);
  await enableCollection(page);

  const about = await context.newPage();
  await about.goto('about:blank');
  const internal = await context.newPage();
  await internal.goto('chrome://version').catch(() => {});

  await visit(context, '/real-page');
  await expectCollectedCount(page, 1);

  const urls = (await collectedRows(page)).map((row) => row.url);
  expect(urls).toEqual(['https://e2e.local/real-page']);
});

test('the search box narrows the collected list as well as the vault', async ({ page, context }) => {
  await createVault(page);
  await enableCollection(page);

  await visit(context, '/alpha');
  await visit(context, '/beta');
  await expectCollectedCount(page, 2);

  /* The name column carries the site; the address column carries the page, which is what search matched. */
  await page.locator('#search').fill('alpha');
  await expect(page.locator('#collected-list .row:not(.row-head)')).toHaveCount(1);
  await expect(page.locator('#collected-list .row-host').first()).toContainText('/alpha');

  await page.locator('#search').fill('nothing-matches');
  await expect(page.locator('#collected')).toBeHidden();
});

test('an address that is not a web address is refused by the add form', async ({ page }) => {
  await createVault(page);

  await addBookmark(page, { url: 'javascript:alert(1)', name: 'Nope' });

  await expect(page.locator('#status')).toContainText(/./);
  await expect(page.locator('#list .row:not(.row-head)')).toHaveCount(0);
});

test('without the extension the vault works and no section appears', async () => {
  const browser = await launch({ withExtension: false });
  try {
    const page = await browser.context.newPage();
    await page.goto(`${BASE_URL}/w/bookmarks/`);
    await createVault(page);

    await addBookmark(page, { url: 'https://e2e.local/alone', name: 'Alone' });
    await expect(page.locator('#list .row:not(.row-head)')).toHaveCount(1);
    expect((await vaultRows(page)).map((row) => row.name)).toEqual(['Alone']);

    await expect(page.locator('#collected')).toBeHidden();
  } finally {
    await browser.close();
  }
});
