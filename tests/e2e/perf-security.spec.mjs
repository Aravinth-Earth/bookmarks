/**
 * Performance, load behaviour and the security surface a browser can reach.
 *
 * Two kinds of test live here. The load tests measure and then assert a ceiling that is stated once, at the top, and
 * deliberately far above what a local `wrangler dev` costs, so a slow machine does not turn a budget into a flake.
 * The security tests attack the parts a page can actually be attacked through: what the network is asked for, what
 * the response says it may do, what sits in IndexedDB, localStorage, the DOM and the extension's own storage.
 *
 * Nothing here is a proxy for a rule. A bookmark is added and then read back out of the databases, because "the blob
 * is sealed" is only worth asserting against the bytes that were stored.
 */

import {
  BASE_URL,
  addBookmark,
  createVault,
  expect,
  lockVault,
  test,
  vaultRows
} from './fixtures.mjs';

const ORIGIN = new URL(BASE_URL).origin;

/* Measured, then given room. The run that wrote these numbers on this machine: 21 requests, DOMContentLoaded 1.4s,
   load 1.4s, first-contentful-paint 1.4s, an interactive lock screen at 1.5s, and a phrase to a visible vault in
   about 0.12s. The budgets below are one order of magnitude above that, which is what makes them a check on a page
   that waits for a third party or blocks for tens of seconds rather than a coin-toss on a busy machine. */
const FCP_BUDGET_MS = 8_000;
const DOM_CONTENT_LOADED_BUDGET_MS = 10_000;
const LOAD_BUDGET_MS = 20_000;
const LOCK_SCREEN_BUDGET_MS = 10_000;
const UNLOCK_BUDGET_MS = 10_000;
/* A cold load is an HTML file, one theme script, three stylesheets, the module graph and a service worker. Forty is
   well above the count and still catches a page that started pulling a bundle per widget. */
const REQUEST_CEILING = 40;

/** localStorage keys the page is allowed to write. It is the list device-store.js keeps, so a new key fails here. */
const DEVICE_KEYS = new Set([
  'bookmarks-icon-tries',
  'bookmarks-view',
  'bookmarks-font-size',
  'site-theme',
  'collected-icons',
  /* Eight random bytes that name this browser profile and nothing else: it is what lets two devices' counts be
     added without counting one device's visits twice. It outlives "clear this device" for that reason. */
  'bookmarks-device-id'
]);

/** Every record in the vault's IndexedDB store, decoded far enough to read as bytes and strings. */
async function readVaultRecords(page) {
  return page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('bookmarks');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const read = (method) =>
      new Promise((resolve, reject) => {
        const request = db.transaction('vault', 'readonly').objectStore('vault')[method]();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });

    const keys = (await read('getAllKeys')).map(String);
    const values = await read('getAll');
    db.close();

    /* A CryptoKey stringifies to `{}`, which is the point: the remembered record carries no bytes a script can use. */
    return { keys, values: JSON.parse(JSON.stringify(values)) };
  });
}

test('a cold load asks only this origin, answers every request, and is usable inside its budget', async ({
  context
}) => {
  const page = await context.newPage();

  const requests = [];
  const responses = [];
  const failedRequests = [];

  page.on('request', (request) =>
    requests.push({ url: request.url(), method: request.method(), type: request.resourceType() })
  );
  page.on('response', (response) => responses.push({ url: response.url(), status: response.status() }));
  page.on('requestfailed', (request) =>
    failedRequests.push(`${request.method()} ${request.url()} (${request.failure()?.errorText ?? 'unknown'})`)
  );

  await page.goto(`${BASE_URL}/`, { waitUntil: 'load' });
  await expect(page.locator('#lock-view')).toBeVisible();
  await expect(page.locator('#unlock-button')).toBeEnabled();

  /* Usable is more than visible: the phrase field has to take input and the button has to be clickable. */
  const usableAt = await page.evaluate(() => Math.round(performance.now()));
  await page.locator('#phrase').click();
  await page.keyboard.type('x');
  await expect(page.locator('#phrase')).toHaveValue('x');
  await page.locator('#phrase').fill('');

  await page.waitForLoadState('networkidle').catch(() => {});

  const timing = await page.evaluate(() => {
    const [navigation] = performance.getEntriesByType('navigation');
    const paint = performance.getEntriesByName('first-contentful-paint')[0];
    return {
      domContentLoaded: Math.round(navigation?.domContentLoadedEventEnd ?? 0),
      load: Math.round(navigation?.loadEventEnd ?? 0),
      fcp: paint ? Math.round(paint.startTime) : null
    };
  });

  console.log(
    `cold load: ${requests.length} requests, dcl ${timing.domContentLoaded}ms, load ${timing.load}ms, ` +
      `fcp ${timing.fcp}ms, lock screen usable ${usableAt}ms`
  );
  console.log(
    `cold load requests: ${requests.map((request) => `${request.type} ${request.url.slice(ORIGIN.length)}`).join(' | ')}`
  );

  /* Nothing leaves for a CDN, a font host, an icon service or an analytics endpoint. */
  const foreign = requests.filter((request) => !request.url.startsWith(`${ORIGIN}/`));
  expect(foreign, `requests that left ${ORIGIN}: ${JSON.stringify(foreign, null, 2)}`).toEqual([]);

  /* The icon and title proxies fetch a site the caller names. No bookmark exists yet, so nothing may be asked. */
  const proxied = requests.filter((request) => /\/api\/(icon|title)\b/.test(request.url));
  expect(proxied, `the icon or title proxy was called on an empty vault: ${JSON.stringify(proxied, null, 2)}`).toEqual(
    []
  );

  /* The two site stylesheets are proxied from the site's own host: a local server reaches over the network with no
     cache in front of it, so a run can see them refused, rate limited or aborted, and none of that is about the
     app's own assets. They are counted and printed here; what has to be there is the app's own stylesheet. */
  const proxiedStylesheet = (url) => /\/css\/(tokens|themes)\.css$/.test(url);
  const rejected = responses.filter((response) => response.status >= 400 && !proxiedStylesheet(response.url));
  const refused = responses.filter((response) => response.status >= 400 && proxiedStylesheet(response.url));
  expect(rejected, `failed responses: ${JSON.stringify(rejected, null, 2)}`).toEqual([]);
  if (refused.length > 0) {
    console.log(`the site's stylesheets were refused here: ${refused.map((r) => `${r.status} ${r.url}`).join(', ')}`);
  }

  const ownStylesheet = responses.find((response) => response.url.endsWith('/bookmarks.css'));
  expect(ownStylesheet?.status, "the app's own stylesheet").toBe(200);

  const failedOwn = failedRequests.filter((entry) => !proxiedStylesheet(entry));
  expect(failedOwn, `requests that never completed: ${failedOwn.join(', ')}`).toEqual([]);

  expect(requests.length).toBeGreaterThan(5);
  expect(requests.length).toBeLessThanOrEqual(REQUEST_CEILING);
  expect(requests.some((request) => request.type === 'document')).toBe(true);
  expect(requests.some((request) => request.type === 'script')).toBe(true);

  expect(timing.fcp, 'first-contentful-paint was never recorded').not.toBeNull();
  expect(timing.fcp, 'first-contentful-paint').toBeLessThanOrEqual(FCP_BUDGET_MS);
  expect(timing.domContentLoaded, 'DOMContentLoaded').toBeLessThanOrEqual(DOM_CONTENT_LOADED_BUDGET_MS);
  expect(timing.load, 'load event').toBeLessThanOrEqual(LOAD_BUDGET_MS);
  expect(usableAt, 'time to an interactive lock screen').toBeLessThanOrEqual(LOCK_SCREEN_BUDGET_MS);
});

test('the page and its scripts carry the security headers the Worker sets', async ({ page, context }) => {
  const pageResponse = await context.request.get(`${BASE_URL}/`);
  expect(pageResponse.status()).toBe(200);

  const headers = pageResponse.headers();
  const csp = headers['content-security-policy'] ?? '';
  const directive = (name) => csp.split(';').map((part) => part.trim()).find((part) => part.startsWith(name)) ?? '';

  expect(csp, 'no Content-Security-Policy on the document').not.toBe('');
  expect(directive('default-src')).toBe("default-src 'self'");
  expect(directive('script-src')).toBe("script-src 'self'");
  expect(directive('connect-src')).toBe("connect-src 'self'");
  expect(directive('img-src')).toBe("img-src 'self' data:");
  expect(directive('frame-ancestors')).toBe("frame-ancestors 'none'");
  expect(directive('object-src')).toBe("object-src 'none'");
  expect(directive('base-uri')).toBe("base-uri 'none'");
  expect(directive('form-action')).toBe("form-action 'self'");
  /* No source outside this origin is allowed anywhere, and no string of script is allowed at all. */
  expect(csp).not.toMatch(/https?:\/\//);
  expect(directive('script-src')).not.toContain('unsafe-inline');
  expect(directive('script-src')).not.toContain('unsafe-eval');

  expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  expect(headers['x-content-type-options']).toBe('nosniff');
  expect(headers['cross-origin-opener-policy']).toBe('same-origin');
  expect(headers['permissions-policy']).toContain('camera=()');
  expect(headers['permissions-policy']).toContain('microphone=()');
  expect(headers['permissions-policy']).toContain('geolocation=()');
  expect(headers['strict-transport-security']).toContain('max-age=15552000');
  expect(headers['strict-transport-security']).toContain('includeSubDomains');

  /* A static module is served through the Worker too, so the policy cannot be dodged by asking for the file. */
  const scriptResponse = await context.request.get(`${BASE_URL}/app.js`);
  expect(scriptResponse.status()).toBe(200);
  expect(scriptResponse.headers()['content-security-policy']).toBe(csp);
  expect(scriptResponse.headers()['x-content-type-options']).toBe('nosniff');
  expect(scriptResponse.headers()['referrer-policy']).toBe('strict-origin-when-cross-origin');

  /* The policy is enforced, not just announced. A same-origin fetch succeeds first, so the refusal below is the
     policy talking and not a dead network. */
  const sameOrigin = await page.evaluate(async () => (await fetch('/api/health')).ok);
  expect(sameOrigin, 'a same-origin request works, so the probes below mean something').toBe(true);

  const inlineRan = await page.evaluate(() => {
    window.__cspInline = 0;
    const script = document.createElement('script');
    script.textContent = 'window.__cspInline = 1';
    document.head.append(script);
    script.remove();
    return window.__cspInline;
  });
  expect(inlineRan, "an inline script ran under script-src 'self'").toBe(0);

  const egress = await page.evaluate(async () => {
    try {
      await fetch('https://example.com/csp-probe', { mode: 'no-cors', signal: AbortSignal.timeout(3_000) });
      return 'allowed';
    } catch {
      return 'blocked';
    }
  });
  expect(egress, "a cross-origin fetch was allowed under connect-src 'self'").toBe('blocked');
});

test('the sealed vault in IndexedDB and the device storage hold no readable bookmark', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/secret-path', name: 'SEKRET-TITLE' });
  await expect(page.locator('#list .row-name').first()).toHaveText('SEKRET-TITLE');

  const records = await readVaultRecords(page);

  expect(records.keys, `records in the vault store: ${records.keys.join(', ')}`).toContain('document');
  const stored = records.values[records.keys.indexOf('document')];
  expect(typeof stored.sealed?.ct).toBe('string');
  expect(typeof stored.sealed?.iv).toBe('string');
  expect(stored.sealed.ct.length, 'sealed ciphertext length').toBeGreaterThan(40);
  expect(stored.sealed.iv.length, 'sealed iv length').toBeGreaterThan(8);

  /* The claim is that nothing readable about the bookmark is stored, so the search runs over
     everything except the ciphertext itself. Ciphertext is base64 of opaque bytes, and a short
     needle can fall out of base64 by chance — `http` did once, about once in a few thousand runs,
     and a test that fails on luck teaches people to ignore it. The ciphertext is checked the other
     way round: it must look like ciphertext and be long enough to be one. */
  const readable = JSON.stringify({
    keys: records.keys,
    values: records.keys.map((key) => {
      const value = records.values[records.keys.indexOf(key)] ?? {};
      return { ...value, sealed: { ...value.sealed, ct: undefined, iv: undefined } };
    })
  }).toLowerCase();
  for (const needle of ['e2e.local', 'sekret-title', 'secret-path', 'http']) {
    expect(readable, `"${needle}" is readable inside the sealed IndexedDB record`).not.toContain(needle);
  }
  expect(stored.sealed.ct, 'the ciphertext is base64, not text').toMatch(/^[A-Za-z0-9+/_-]+={0,2}$/);

  const storage = await page.evaluate(() => ({ keys: Object.keys(localStorage), all: JSON.stringify(localStorage) }));
  console.log(
    `sealed record: keys ${records.keys.join(',')} ct ${stored.sealed.ct.length} chars iv ${stored.sealed.iv.length}; ` +
      `localStorage keys ${storage.keys.join(',')}`
  );
  const localDump = storage.all.toLowerCase();
  for (const needle of ['e2e.local', 'sekret-title', 'secret-path']) {
    expect(localDump, `"${needle}" is readable in localStorage`).not.toContain(needle);
  }
  expect(
    storage.keys.filter((key) => !DEVICE_KEYS.has(key)),
    `localStorage keys outside the page's own list: ${storage.keys.join(', ')}`
  ).toEqual([]);
});

test('a bookmark name that is markup is shown as text, and a javascript: address is refused', async ({ page }) => {
  await createVault(page);

  const payload = '<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>';
  await addBookmark(page, { url: 'https://e2e.local/payload', name: payload });
  await expect(page.locator('#list .row:not(.row-head)')).toHaveCount(1);

  /* The name comes back as the characters that were typed, and the markup is not in the tree. */
  await expect(page.locator('#list .row-name').first()).toHaveText(payload);
  expect(await page.locator('#list script').count(), 'a script element was built from a bookmark name').toBe(0);
  expect(await page.locator('#list img[onerror]').count(), 'an image with a handler was built').toBe(0);
  expect(await page.evaluate(() => window.__xss), 'the payload ran').toBeUndefined();

  const rowHtml = await page.locator('#list .row').first().innerHTML();
  expect(rowHtml).not.toContain('<img src=x');
  expect(rowHtml).not.toContain('<script');

  await addBookmark(page, { url: 'javascript:window.__xss=3', name: 'Script' });

  await expect(page.locator('#status')).toContainText(/not a page address/i);
  await expect(page.locator('#list .row:not(.row-head)')).toHaveCount(1);
  expect(await page.evaluate(() => window.__xss), 'a javascript: address ran').toBeUndefined();

  const hrefs = await page.locator('#list .row-link').evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute('href') ?? '')
  );
  expect(hrefs.filter((href) => /^javascript:/i.test(href))).toEqual([]);
});

test('a lock takes the document out of the page and leaves no plaintext in localStorage', async ({ page }) => {
  const phrase = await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/lock-me', name: 'LOCK-SEKRET' });
  await expect(page.locator('#list .row-name').first()).toHaveText('LOCK-SEKRET');

  await lockVault(page);

  await expect(page.locator('#lock-view')).toBeVisible();
  await expect(page.locator('#app-view')).toBeHidden();
  await expect(page.locator('#list .row')).toHaveCount(0);

  const after = await page.evaluate(() => ({
    app: document.getElementById('app-view').innerHTML,
    list: document.getElementById('list').innerHTML,
    storage: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
    phraseField: document.getElementById('phrase').value,
    url: location.href
  }));

  /* Everything the vault rendered is gone from the document it was unlocked in. */
  for (const [name, haystack] of [
    ['the app view', after.app],
    ['the list', after.list],
    ['localStorage', after.storage],
    ['sessionStorage', after.session],
    ['the address bar', after.url]
  ]) {
    expect(haystack.toLowerCase(), `${name} still holds the bookmark name`).not.toContain('lock-sekret');
    expect(haystack.toLowerCase(), `${name} still holds the bookmark address`).not.toContain('e2e.local');
    expect(haystack, `${name} still holds the phrase`).not.toContain(phrase);
  }
  expect(after.phraseField, 'the phrase field was left filled').toBe('');

  /* The key is not remembered when the box was not ticked, so the sealed record is all that stays behind. */
  const records = await readVaultRecords(page);
  expect(records.keys).not.toContain('remembered');
});

/**
 * Known defect, logged rather than fixed: a lock drops the key, the open document and the rendered list, but the live
 * region at the foot of the page keeps its last announcement — for an add, the bookmark's own name. The lock screen
 * therefore still displays a name from the vault. `test()` is deliberate: when the app clears that line on lock,
 * this test reports "passed unexpectedly" and the annotation is removed.
 */
test('a lock clears the page of the last announcement as well as the list (known defect)', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/status-leak', name: 'STATUS-SEKRET' });
  await expect(page.locator('#status')).toContainText(/added status-sekret/i);

  await lockVault(page);
  await expect(page.locator('#lock-view')).toBeVisible();

  const residue = await page.evaluate(() => {
    const status = document.getElementById('status');
    return {
      text: status.textContent,
      visible: status.classList.contains('visible'),
      opacity: getComputedStyle(status).opacity
    };
  });
  console.log(`after lock, #status is ${JSON.stringify(residue)}`);

  await expect(page.locator('#status')).not.toContainText(/status-sekret/i, { timeout: 3_000 });
});

test('an empty vault is opened without asking any site for an icon or a title', async ({ page }) => {
  const asked = [];
  page.on('request', (request) => {
    if (/\/api\/(icon|title)\b/.test(request.url())) asked.push(request.url());
  });

  await createVault(page);
  await expect(page.locator('#empty')).toContainText(/no bookmarks yet/i);

  /* Entry schedules a top-up of missing icons. A vault with no bookmarks has nothing missing, so the walk ends
     without a request; a second of quiet is enough for a schedule that would have fired immediately. */
  await page.waitForTimeout(1_000);
  expect(asked, `the vault asked a site for an icon or a title with no bookmark to fill: ${asked.join(', ')}`).toEqual(
    []
  );
});

test('every row link opens in a new tab with noopener', async ({ page }) => {
  await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/link', name: 'Link' });

  await expect(page.locator('#list .row-link')).toHaveCount(1);

  /* The collected list reuses this anchor, so both selectors are read. At this port the extension's content script is
     not injected into this origin, so the collected section cannot be filled here and only the
     vault's own links are actually exercised. */
  const links = page.locator('#list a[href], #collected-list a[href]');
  const count = await links.count();
  expect(count).toBeGreaterThan(0);

  const read = await links.evaluateAll((nodes) =>
    nodes.map((node) => ({ href: node.getAttribute('href'), rel: node.getAttribute('rel') ?? '', target: node.getAttribute('target') }))
  );

  for (const link of read) {
    const rel = link.rel.split(/\s+/).filter(Boolean);
    expect(rel, `${link.href} has rel="${link.rel}"`).toContain('noopener');
    expect(rel, `${link.href} has rel="${link.rel}"`).toContain('noreferrer');
    expect(link.target, `${link.href} opens in place`).toBe('_blank');
  }
});

test("the extension's own storage holds nothing from the vault", async ({ page, context }) => {
  const phrase = await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/extension', name: 'EXT-SEKRET' });
  await expect(page.locator('#list .row-name').first()).toHaveText('EXT-SEKRET');

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  expect(worker, 'the extension never started a service worker').toBeTruthy();

  const roundTrip = await worker.evaluate(async () => {
    await chrome.storage.local.set({ __e2e_probe: 'live' });
    const stored = await chrome.storage.local.get('__e2e_probe');
    await chrome.storage.local.remove('__e2e_probe');
    return stored.__e2e_probe ?? null;
  });
  expect(roundTrip, "the worker's storage could not be read, so an empty answer proves nothing").toBe('live');

  await worker.evaluate(() => chrome.storage.local.remove('__e2e_probe'));
  const dump = await worker.evaluate(() => chrome.storage.local.get(null));
  const flat = JSON.stringify(dump).toLowerCase();
  console.log(`extension storage: ${JSON.stringify(dump).slice(0, 400)}`);

  for (const needle of ['e2e.local', 'ext-sekret', phrase.toLowerCase()]) {
    expect(flat, `the extension holds "${needle}"`).not.toContain(needle);
  }
});

test('the phrase opens the vault inside its budget and is not left in the page afterwards', async ({ page }) => {
  const phrase = await createVault(page);
  await addBookmark(page, { url: 'https://e2e.local/timing', name: 'Timing' });
  await lockVault(page);

  await expect(page.locator('#phrase')).toBeVisible();
  await page.locator('#phrase').fill(phrase);

  const startedAt = await page.evaluate(() => performance.now());
  await page.locator('#unlock-button').click();
  await expect(page.locator('#app-view')).toBeVisible();
  const visibleAt = await page.evaluate(() => performance.now());

  const elapsed = Math.round(visibleAt - startedAt);
  console.log(`unlock: phrase to a visible vault in ${elapsed}ms`);
  expect(elapsed, 'the vault never became visible').toBeGreaterThan(0);
  expect(elapsed, 'phrase to a visible vault').toBeLessThanOrEqual(UNLOCK_BUDGET_MS);

  /* The document is back, so the measurement above was not a screen that appeared empty. */
  await expect(page.locator('#list .row-name').first()).toHaveText('Timing');

  const residue = await page.evaluate(() => ({
    field: document.getElementById('phrase').value,
    html: document.documentElement.outerHTML,
    text: document.body.innerText,
    storage: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
    url: location.href
  }));

  expect(residue.field, 'the phrase field was left filled').toBe('');
  for (const [name, haystack] of [
    ['the page HTML', residue.html],
    ['the page text', residue.text],
    ['localStorage', residue.storage],
    ['sessionStorage', residue.session],
    ['the address bar', residue.url]
  ]) {
    expect(haystack, `${name} still holds the phrase`).not.toContain(phrase);
  }

  /* Sanity: the vault really is open, so the checks above were made in the state they claim. */
  expect((await vaultRows(page)).map((row) => row.name)).toEqual(['Timing']);
});
