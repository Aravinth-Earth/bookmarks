import { addBookmark, createVault, expect, openSettings, settingsItem, test } from './fixtures.mjs';

/** The page's own background, as three numbers. */
async function bodyColour(page) {
  return page.evaluate(() => {
    const [r, g, b] = getComputedStyle(document.body).backgroundColor.match(/\d+/g).map(Number);
    return { r, g, b };
  });
}

test('a device that asks for a light colour scheme still opens in the dark', async ({ page }) => {
  await createVault(page);
  await page.emulateMedia({ colorScheme: 'light' });
  await page.reload();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'current');
  const { r, g, b } = await bodyColour(page);
  expect(Math.max(r, g, b), `body background ${r},${g},${b} is not dark`).toBeLessThanOrEqual(64);
});

test('a light theme saved by an older build is forgotten, not honoured', async ({ page }) => {
  await createVault(page);
  await page.evaluate(() => localStorage.setItem('site-theme', 'light'));
  await page.reload();

  await expect(page.locator('html')).toHaveAttribute('data-theme', 'current');
  expect(await page.evaluate(() => localStorage.getItem('site-theme'))).toBeNull();

  const { r, g, b } = await bodyColour(page);
  expect(Math.max(r, g, b), `body background ${r},${g},${b} is not dark`).toBeLessThanOrEqual(64);
});

test('the theme picker does not offer a light theme', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/one', name: 'One' });
  await openSettings(page);

  /* The picker is the select that lists theme names, wherever the sheet has put it. */
  const themes = await page.evaluate(() =>
    [...document.querySelectorAll('#modal-root select')]
      .map((select) => [...select.options].map((option) => option.value))
      .find((values) => values.includes('cyberpunk'))
  );

  expect(themes, 'a theme picker in the sheet').toBeTruthy();
  expect(themes.length, 'themes offered').toBeGreaterThan(3);
  expect(themes, 'themes offered').not.toContain('light');
});
