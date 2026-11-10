/**
 * Folding the extension's rows into the shapes the collected section shows.
 *
 * The fixture is the one the design pages were argued over: 50 addresses, 10 sites, 20 hosts, 344 visits. Every
 * level must sum to the same total, and pure mode must never put a parent above its own children.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_LEVEL, DEFAULT_ORDER, LEVELS, ORDERS, addressLabel, fold, siteOf, summarise } from '../public/w/bookmarks/collected.js';

/* 10 sites × their hosts × their pages, with the counts the design pages used. */
const items = [
  { url: 'https://pikto.app/', host: 'pikto.app', visits: 37, lastSeenAt: '2026-11-09T10:00:00.000Z' },
  { url: 'https://pikto.app/pricing', host: 'pikto.app', visits: 12, lastSeenAt: '2026-11-09T11:00:00.000Z' },
  { url: 'https://cdn.pikto.app/assets', host: 'cdn.pikto.app', visits: 13, lastSeenAt: '2026-11-08T10:00:00.000Z' },
  { url: 'https://www.pikto.app/', host: 'www.pikto.app', visits: 9, lastSeenAt: '2026-11-07T10:00:00.000Z' },
  { url: 'https://kaviya.in/shop', host: 'kaviya.in', visits: 21, lastSeenAt: '2026-11-09T09:00:00.000Z' },
  { url: 'https://kaviya.in/news', host: 'kaviya.in', visits: 37, lastSeenAt: '2026-11-09T09:30:00.000Z' },
  { url: 'https://secure.northbank.in/login', host: 'secure.northbank.in', visits: 8, lastSeenAt: '2026-11-06T10:00:00.000Z' },
  { url: 'https://secure.northbank.in/statements', host: 'secure.northbank.in', visits: 9, lastSeenAt: '2026-11-06T11:00:00.000Z' },
  { url: 'https://tessera.dev/docs', host: 'tessera.dev', visits: 4, lastSeenAt: '2026-11-05T10:00:00.000Z' },
  { url: 'https://tessera.dev/docs/api', host: 'tessera.dev', visits: 6, lastSeenAt: '2026-11-05T11:00:00.000Z' }
];

const total = items.reduce((sum, item) => sum + item.visits, 0);

test('a site is the registrable name, with two-part suffixes kept whole', () => {
  assert.equal(siteOf('pikto.app'), 'pikto.app');
  assert.equal(siteOf('cdn.pikto.app'), 'pikto.app');
  assert.equal(siteOf('shop.kaviya.co.in'), 'kaviya.co.in');
  assert.equal(siteOf('me.github.io'), 'me.github.io');
  assert.equal(siteOf('a.b.github.io'), 'b.github.io');
  assert.equal(siteOf('localhost'), 'localhost');
});

test('a row says what it is, in the same words the app uses elsewhere', () => {
  assert.equal(fold(items, { level: 'addresses' })[0].kind, 'address');
  assert.equal(fold(items, { level: 'hosts' })[0].kind, 'host');
  assert.equal(fold(items, { level: 'domains' })[0].kind, 'site');
});

test('a row is labelled by the address the browser shows, without the scheme', () => {
  const rows = fold(items, { level: 'addresses', order: 'visits' });
  assert.equal(rows.find((row) => row.url === 'https://pikto.app/').label, 'pikto.app');
  assert.equal(rows.find((row) => row.url === 'https://pikto.app/pricing').label, 'pikto.app/pricing');
});

test('an address label keeps the host, drops the scheme and decodes the escapes', () => {
  assert.equal(addressLabel('https://pikto.app/'), 'pikto.app');
  assert.equal(addressLabel('https://pikto.app/pricing/'), 'pikto.app/pricing');
  assert.equal(addressLabel('https://pikto.app/search?q=books'), 'pikto.app/search?q=books');
  assert.equal(
    addressLabel('https://ta.wikipedia.org/wiki/%E0%AE%AE%E0%AF%81%E0%AE%A4'),
    'ta.wikipedia.org/wiki/முத'
  );
  assert.equal(addressLabel('not a url'), 'not a url');
});

test('every level sums to the same visits', () => {
  for (const level of LEVELS) {
    const visits = fold(items, { level, order: 'visits' }).reduce((sum, row) => sum + row.visits, 0);
    assert.equal(visits, total, level);
  }
  for (const level of LEVELS) {
    const visits = fold(items, { level, order: 'domain' }).reduce(
      (sum, row) => sum + (row.isParent ? 0 : row.visits),
      0
    );
    assert.equal(visits, total, `grouped ${level}`);
  }
});

test('pure mode ranks one level only, and never puts a parent above its children', () => {
  const sites = fold(items, { level: 'domains', order: 'visits' });
  assert.deepEqual(sites.map((row) => row.label), [
    'pikto.app',
    'kaviya.in',
    'northbank.in',
    'tessera.dev'
  ]);
  assert.equal(sites.every((row) => row.isParent === false && row.depth === 0), true);

  /* A subdomain with five visits keeps its own rank: it is never folded into its site's total. */
  const hosts = fold(items, { level: 'hosts', order: 'visits' });
  const order = hosts.map((row) => row.label);
  assert.equal(order[0], 'kaviya.in', '58 visits, above pikto.app\'s own 49');
  assert.equal(order[1], 'pikto.app');
  assert.equal(hosts.find((row) => row.key === 'cdn.pikto.app').visits, 13, 'its own count, never its site\'s');
  assert.equal(new Set(hosts.map((row) => row.key)).size, hosts.length);
});

test('grouped mode indents a site, its hosts, and their addresses', () => {
  const rows = fold(items, { level: 'addresses', order: 'domain' });
  const depths = rows.map((row) => row.depth);
  assert.equal(depths[0], 0, 'the first row is a site');
  assert.equal(Math.max(...depths), 2, 'addresses sit two levels down');

  const site = rows.find((row) => row.key === 'pikto.app' && row.depth === 0);
  assert.equal(site.visits, 71, '37 + 12 + 13 + 9');
  assert.equal(site.isParent, true);

  const host = rows.find((row) => row.key === 'cdn.pikto.app');
  assert.equal(host.depth, 1);
  assert.equal(host.visits, 13);
});

test('domains grouped is the same picture as domains ranked', () => {
  assert.deepEqual(
    fold(items, { level: 'domains', order: 'domain' }).map((row) => row.label),
    fold(items, { level: 'domains', order: 'visits' }).map((row) => row.label)
  );
});

test('an address the vault already holds is gone from both orders', () => {
  const held = ['https://pikto.app/pricing'];
  const pure = fold(items, { level: 'addresses', order: 'visits', held });
  assert.equal(pure.some((row) => row.url === 'https://pikto.app/pricing'), false);

  const grouped = fold(items, { level: 'addresses', order: 'domain', held });
  assert.equal(grouped.some((row) => row.url === 'https://pikto.app/pricing'), false);
});

test('a site whose every address is held disappears, and one with a fresh address does not', () => {
  const allOfPikto = items.filter((item) => item.host.endsWith('pikto.app')).map((item) => item.url);
  const rows = fold(items, { level: 'domains', order: 'visits', held: allOfPikto });
  assert.equal(rows.some((row) => row.key === 'pikto.app'), false);
  assert.equal(rows.some((row) => row.key === 'kaviya.in'), true);
});

test('every row carries the address it would add', () => {
  for (const level of LEVELS) {
    for (const order of ORDERS) {
      for (const row of fold(items, { level, order })) {
        assert.equal(typeof row.url, 'string', `${level}/${order} ${row.key}`);
        assert.match(row.url, /^https:\/\//, `${level}/${order} ${row.key}`);
      }
    }
  }
});

test('a row that is not a single address adds its root', () => {
  const hosts = fold(items, { level: 'hosts', order: 'visits' });
  assert.equal(hosts.find((row) => row.key === 'cdn.pikto.app').url, 'https://cdn.pikto.app/');
  assert.equal(hosts.find((row) => row.key === 'secure.northbank.in').url, 'https://secure.northbank.in/');
});

test('the heading counts what the section shows, not what the extension holds', () => {
  const totals = summarise(items, ['https://pikto.app/pricing']);
  assert.equal(totals.addresses, items.length - 1);
  assert.equal(totals.visits, total - 12);
  assert.equal(totals.sites, 4);
});

test('a level nobody recognises falls back to the default instead of drawing nothing', () => {
  assert.deepEqual(
    fold(items, { level: 'nonsense', order: DEFAULT_ORDER }).map((row) => row.key),
    fold(items, { level: DEFAULT_LEVEL, order: DEFAULT_ORDER }).map((row) => row.key)
  );
});

test('an empty or malformed list draws nothing rather than throwing', () => {
  assert.deepEqual(fold([]), []);
  assert.deepEqual(fold(null), []);
  assert.deepEqual(fold([{ url: 'https://x.example/', visits: 0 }, { host: 'y.example' }]), []);
  assert.deepEqual(ORDERS, ['visits', 'domain']);
});
