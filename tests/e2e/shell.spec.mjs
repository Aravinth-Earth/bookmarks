/**
 * The claim this file exists to hold: the app draws with stylesheets it carries, so the personal
 * site being down cannot take its look or its offline copy away.
 *
 * Before the vendoring, `/css/tokens.css` and `/css/themes.css` were proxied from www.332321.xyz.
 * Two things followed from that. The page's look depended on a different host being up, and — the
 * worse one — `sw.js` precaches both paths in one `cache.addAll`, so a site outage rejected the
 * install and the app silently lost its offline shell. Neither is visible in a test that happens
 * to run while the site is up, which is why the site is blocked here for the whole test rather
 * than assumed reachable.
 *
 * The proof is read out of the live page: the parsed rules themselves, the computed token the page
 * paints with, the service worker's own state, and the same page again with the network switched
 * off. A screenshot would show that something looks wrong; it cannot show that a stylesheet loaded.
 */

import { BASE_URL, createVault, expect, test } from './fixtures.mjs';

/** The host the app used to be dependent on, and must not contact at all now. */
const SITE = 'www.332321.xyz';

/**
 * What the page actually parsed and paints with.
 *
 * A stylesheet that 502s or 404s still appears in `document.styleSheets` with zero rules, so the
 * rules are what get read. The token and the painted background are the second half of the same
 * claim: the values are the `current` theme's, not the browser's defaults.
 */
async function styleProof(page) {
  return page.evaluate(async () => {
    const sheets = [...document.styleSheets].map((sheet) => {
      let rules = [];
      try {
        rules = [...sheet.cssRules].map((rule) => rule.cssText).join('\n');
      } catch {
        /* A sheet from another origin cannot be read; it also could not have been one of ours. */
        rules = '';
      }
      return { href: sheet.href ?? '', rules };
    });

    const body = getComputedStyle(document.body);
    const [r, g, b] = (body.backgroundColor.match(/\d+/g) ?? []).map(Number);

    /* The registered worker, read from the page that registered it. `ready` resolves only once a
       registration has an active worker, so this is the state, not a wait for one. */
    const registration = await navigator.serviceWorker
      .getRegistration('/')
      .catch(() => null);

    return {
      sheets,
      token: getComputedStyle(document.documentElement).getPropertyValue('--bg-primary').trim(),
      background: { r, g, b },
      worker: registration?.active?.state ?? 'none',
      controlled: navigator.serviceWorker.controller !== null
    };
  });
}

/** Every assertion the look depends on, applied to whichever load is in front of us. */
async function expectStyled(page) {
  const proof = await styleProof(page);

  /* The rules are the vendored files: `--slate-950` is declared in tokens.css §1 and appears
     nowhere else, and the cyberpunk block is one of themes.css's palettes. */
  const tokens = proof.sheets.find((sheet) => sheet.href.endsWith('/css/tokens.css'));
  const themes = proof.sheets.find((sheet) => sheet.href.endsWith('/css/themes.css'));

  expect(tokens, 'tokens.css is a stylesheet of this page').toBeTruthy();
  expect(themes, 'themes.css is a stylesheet of this page').toBeTruthy();
  expect(tokens.rules.length, 'tokens.css parsed into rules').toBeGreaterThan(0);
  expect(tokens.rules, 'tokens.css carries its own colour primitives').toContain('--slate-950');
  expect(themes.rules, 'themes.css carries its palettes').toContain('[data-theme="cyberpunk"]');

  /* The theme layer is on top: the painted background is the `current` theme's token value. */
  expect(proof.token, 'the --bg-primary token resolves').toBe('#0a0c10');
  expect(proof.background, 'the page paints with the token').toEqual({ r: 10, g: 12, b: 16 });
  expect(
    Math.max(proof.background.r, proof.background.g, proof.background.b),
    `body background ${proof.background.r},${proof.background.g},${proof.background.b} is dark`
  ).toBeLessThanOrEqual(64);

  return proof;
}

test('the app looks the same with the site unreachable, and still renders offline', async ({
  context,
  page
}) => {
  /* The site is refused for the whole test, before the first request goes out. Anything the app
     still asked it for would abort here rather than quietly succeed on a machine with a network. */
  const siteRequests = [];
  await context.route(`https://${SITE}/**`, (route) => {
    siteRequests.push(route.request().url());
    return route.abort();
  });

  await page.goto(BASE_URL);
  await expect(page.locator('#lock-view')).toBeVisible();

  const phrase = await createVault(page);
  expect(phrase.split(/\s+/).length, 'the vault is sealed with a phrase').toBe(13);

  /* 1. Styled, with the site blocked. */
  await expectStyled(page);

  /* 2. The service worker installed. The install is one `cache.addAll` over the whole shell, so an
     install that reached the site and was refused would leave this reading 'none'. */
  await expect.poll(async () => (await styleProof(page)).worker, { timeout: 30_000 }).toBe('activated');
  await expect.poll(async () => (await styleProof(page)).controlled, { timeout: 30_000 }).toBe(true);

  /* 3. Offline, from the cache the install filled: the same look, from the same bytes. */
  await context.setOffline(true);
  await page.reload();

  await expect(page.locator('main.shell')).toBeVisible({ timeout: 30_000 });

  /* The vault was made in this context, so what comes back is either the unlocked list or the
     lock screen — what matters is that one of them rendered rather than the browser's error page. */
  const showing = await page.evaluate(() =>
    ['#app-view', '#lock-view'].filter((selector) => {
      const view = document.querySelector(selector);
      return view !== null && view.getAttribute('hidden') === null;
    })
  );
  expect(showing.length, 'a view is rendered offline').toBe(1);

  await expectStyled(page);

  /* Nothing was fetched from the site for any of it, online or offline. */
  expect(siteRequests, 'the app asked the site for nothing').toEqual([]);

  /* Put the network back so a failure above is the only thing this test leaves behind. */
  await context.setOffline(false);
});
