/**
 * The capture policy — the one place that decides what the extension may keep.
 *
 * The defaults are the promise: every visit is a candidate, nothing is gated, and collection is off until the
 * vault hands over a policy that says otherwise. Every field a stored or received object can carry is re-derived
 * here, so a hand-edited `chrome.storage` value cannot widen what is kept, and a `0` means "no limit" rather than
 * "keep nothing".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_POLICY,
  canonicalUrl,
  isExcluded,
  normalizeExclude,
  normalizePolicy,
  recordedUrl
} from '../extension/policy.js';

test('the default captures every visit and bounds retention at both ends', () => {
  assert.equal(DEFAULT_POLICY.enabled, false);
  assert.equal(DEFAULT_POLICY.minVisits, 1);
  assert.equal(DEFAULT_POLICY.dailyCap, 0);
  assert.equal(DEFAULT_POLICY.maxEntries, 2000);
  assert.equal(DEFAULT_POLICY.retentionDays, 60);
  assert.equal(DEFAULT_POLICY.includeIncognito, false);
  assert.deepEqual(DEFAULT_POLICY.exclude, []);
});

test('a URL is stored whole, without its fragment, and never with another scheme', () => {
  assert.equal(canonicalUrl('https://example.com/a?b=1#part'), 'https://example.com/a?b=1');
  assert.equal(canonicalUrl('HTTP://Example.COM/x'), 'http://example.com/x');
  assert.equal(canonicalUrl('  https://example.com  '), 'https://example.com/');
  assert.equal(canonicalUrl('javascript:alert(1)'), null);
  assert.equal(canonicalUrl('chtelegram://x'), null);
  assert.equal(canonicalUrl('intranet'), null);
  assert.equal(canonicalUrl(''), null);
  assert.equal(canonicalUrl(null), null);
});

test('a policy is clamped, never trusted, and never silently enables collection', () => {
  assert.equal(normalizePolicy({}).enabled, false);
  assert.equal(normalizePolicy({ enabled: 'yes' }).enabled, false);
  assert.equal(normalizePolicy({ enabled: true }).enabled, true);
  assert.equal(normalizePolicy({ minVisits: 0 }).minVisits, 1);
  assert.equal(normalizePolicy({ minVisits: -3 }).minVisits, 1);
  assert.equal(normalizePolicy({ maxEntries: 0 }).maxEntries, 0);
  assert.equal(normalizePolicy({ maxEntries: 'lots' }).maxEntries, 2000);
  assert.equal(normalizePolicy({ retentionDays: 0 }).retentionDays, 0);
  assert.equal(normalizePolicy(null).maxEntries, 2000);
});

test('an exclusion names a scope, and a malformed one is dropped rather than widened', () => {
  assert.deepEqual(normalizeExclude({ scope: 'host', value: 'Bank.Example' }), {
    scope: 'host',
    value: 'bank.example'
  });
  assert.deepEqual(normalizeExclude({ scope: 'site', value: 'bank.example' }), {
    scope: 'site',
    value: 'bank.example'
  });
  assert.deepEqual(
    normalizeExclude({ scope: 'subdomain', value: 'bank.example' }),
    { scope: 'site', value: 'bank.example' },
    'the word a policy used before tracking levels existed is read as the word now'
  );
  assert.deepEqual(normalizeExclude({ scope: 'path', value: 'bank.example/account' }), {
    scope: 'path',
    value: 'bank.example/account'
  });
  assert.equal(normalizeExclude({ scope: 'regex', value: '.*' }), null);
  assert.equal(normalizeExclude({ scope: 'host', value: '' }), null);
  assert.equal(normalizeExclude(null), null);
});

test('a site exclusion covers its subdomains, a host exclusion covers exactly one hostname', () => {
  const exclude = normalizePolicy({
    exclude: [
      { scope: 'site', value: 'bank.example' },
      { scope: 'host', value: 'mail.example' }
    ]
  }).exclude;

  assert.equal(isExcluded('https://bank.example/x', exclude), true);
  assert.equal(isExcluded('https://secure.bank.example/x', exclude), true);
  assert.equal(isExcluded('https://notbank.example/x', exclude), false);

  assert.equal(isExcluded('https://mail.example/inbox', exclude), true);
  assert.equal(isExcluded('https://eu.mail.example/inbox', exclude), false);
});

test('a path exclusion covers whole segments, never a prefix that only looks similar', () => {
  const exclude = normalizePolicy({ exclude: [{ scope: 'path', value: 'shop.example/orders' }] }).exclude;

  assert.equal(isExcluded('https://shop.example/orders', exclude), true);
  assert.equal(isExcluded('https://shop.example/orders/42?x=1', exclude), true);
  assert.equal(isExcluded('http://shop.example/orders', exclude), true, 'the scheme is not part of the match');
  assert.equal(isExcluded('https://shop.example/orders-old', exclude), false);
  assert.equal(isExcluded('https://shop.example/cart', exclude), false);
  assert.equal(isExcluded('https://sub.shop.example/orders', exclude), false);
});

test('a page the extension cannot read is not captured at all', () => {
  assert.equal(isExcluded('chrome://settings', []), true);
  assert.equal(isExcluded('not a url', []), true);
});


/* ---------------------------------------------------------------- the review's regressions */

test('a value that is not a number falls back instead of reading as "unlimited"', () => {
  for (const bad of [null, '', false, [], {}, 'lots', Number.NaN]) {
    const policy = normalizePolicy({ maxEntries: bad, retentionDays: bad, dailyCap: bad });
    assert.equal(policy.maxEntries, 2000, `maxEntries ${JSON.stringify(bad)}`);
    assert.equal(policy.retentionDays, 60, `retentionDays ${JSON.stringify(bad)}`);
    assert.equal(policy.dailyCap, 0, `dailyCap ${JSON.stringify(bad)}`);
  }
  assert.equal(normalizePolicy({ maxEntries: 0 }).maxEntries, 0, 'a written zero still means unlimited');
});

test('a path exclusion keeps the case of the path and lowers only the host', () => {
  assert.deepEqual(normalizeExclude({ scope: 'path', value: 'shop.example/Orders' }), {
    scope: 'path',
    value: 'shop.example/Orders'
  });
  const exclude = normalizePolicy({ exclude: [{ scope: 'path', value: 'Shop.Example/Orders' }] }).exclude;
  assert.equal(isExcluded('https://shop.example/Orders/42', exclude), true);
  assert.equal(isExcluded('https://shop.example/orders/42', exclude), false, 'two paths, two pages');
});

test('an exclusion pasted from a URL loses its port and keeps its host', () => {
  const exclude = normalizePolicy({
    exclude: [{ scope: 'host', value: 'https://bank.example:8443/login' }]
  }).exclude;
  assert.deepEqual(exclude, [{ scope: 'host', value: 'bank.example' }]);
  assert.equal(isExcluded('https://bank.example/x', exclude), true);
});

test('the same exclusion written twice is stored once', () => {
  const policy = normalizePolicy({
    exclude: [
      { scope: 'site', value: 'bank.example' },
      { scope: 'subdomain', value: 'BANK.example' },
      { scope: 'host', value: 'bank.example' }
    ]
  });
  assert.deepEqual(policy.exclude, [
    { scope: 'site', value: 'bank.example' },
    { scope: 'host', value: 'bank.example' }
  ]);
});

test('credentials and secret parameters are stripped before the address is stored', () => {
  assert.equal(
    canonicalUrl('https://user:pw@bank.example/login?token=SECRET&user=42#/accounts'),
    'https://bank.example/login?user=42'
  );
  assert.equal(
    canonicalUrl('https://example.com/reset?code=abc&state=xyz&next=/home'),
    'https://example.com/reset?next=%2Fhome'
  );
  /* A presigned link is a credential in the query string, and the name a provider gives it is prefixed. */
  assert.equal(
    canonicalUrl('https://bucket.example/x?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA&part=2'),
    'https://bucket.example/x?part=2'
  );
  assert.equal(
    canonicalUrl('https://shop.example/search?q=books&page=2'),
    'https://shop.example/search?q=books&page=2',
    'a query that names no secret is left alone'
  );
});


test('a site can ask to be recorded as a hostname or as one row', () => {
  const levels = normalizePolicy({
    levels: [
      { site: 'youtube.com', level: 'host' },
      { site: 'https://News.Example/watch', level: 'site' },
      { site: 'ignored.example', level: 'nonsense' },
      { site: 'youtube.com', level: 'site' }
    ]
  }).levels;

  assert.deepEqual(levels, [
    { site: 'youtube.com', level: 'host' },
    { site: 'news.example', level: 'site' }
  ], 'normalised, de-duplicated by site, and an unknown level is dropped');

  assert.equal(recordedUrl('https://www.youtube.com/watch?v=a', levels), 'https://www.youtube.com/');
  assert.equal(recordedUrl('http://127.0.0.1:8787/one.html', [{ site: '127.0.0.1', level: 'host' }]), 'http://127.0.0.1:8787/');
  assert.equal(recordedUrl('https://m.youtube.com/watch?v=c', levels), 'https://m.youtube.com/');
  assert.equal(recordedUrl('https://news.example/a/b', levels), 'https://news.example/');
  assert.equal(recordedUrl('https://other.example/a/b', levels), 'https://other.example/a/b');
  assert.equal(recordedUrl('https://notyoutube.com/x', levels), 'https://notyoutube.com/x');
});

test('the policy has no field that measures time', () => {
  assert.equal('minOpenMs' in normalizePolicy({}), false);
});
