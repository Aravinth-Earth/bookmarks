/**
 * The collector: counting, retention, exclusions, and the ways a row leaves the list.
 *
 * Counting is the whole feature — one navigation to one address is one visit — so there is no dwell, no timer and
 * nothing about which tab is in front. A visit that arrives twice within half a minute is the browser reporting the
 * same navigation again, not a person coming back.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCollector, importHistory } from '../extension/collector-core.js';
import { DEFAULT_POLICY } from '../extension/policy.js';

function memory() {
  const map = new Map();
  return {
    async get(key) { return map.get(key); },
    async put(key, value) { map.set(key, structuredClone(value)); },
    async putMany(entries) { for (const [key, value] of Object.entries(entries)) map.set(key, structuredClone(value)); },
    async remove(key) { map.delete(key); },
    async removeMany(keys) { for (const key of keys) map.delete(key); },
    async all() { return structuredClone(Object.fromEntries(map)); },
    dump() { return Object.fromEntries(map); }
  };
}

function build({ now = 1_700_000_000_000 } = {}) {
  let clock = now;
  const persistent = memory();
  const collector = createCollector({ persistent, now: () => clock });
  const advance = (ms) => { clock += ms; };
  const enable = (patch = {}) => collector.setPolicy({ enabled: true, ...patch });
  return { collector, persistent, enable, advance };
}

test('collection is off until a policy says otherwise', async () => {
  const { collector } = build();
  assert.equal(await collector.capture('https://a.example/x'), 'off');
  assert.deepEqual((await collector.list()).items, []);
});

test('a repeat visit raises the count instead of adding a row', async () => {
  const { collector, enable, advance } = build();
  await enable();
  assert.equal(await collector.capture('https://a.example/x'), 'captured');
  advance(60_000);
  assert.equal(await collector.capture('https://a.example/x'), 'captured');

  const { items } = await collector.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].visits, 2);
});

test('an open is an open: two loads a second apart are two visits', async () => {
  const { collector, enable, advance } = build();
  await enable();
  assert.equal(await collector.capture('https://a.example/x'), 'captured');
  advance(1_000);
  assert.equal(await collector.capture('https://a.example/x'), 'captured');
  assert.equal((await collector.list()).items[0].visits, 2, 'nothing here compares times');
});

test('a hundred reloads are a hundred visits', async () => {
  const { collector, enable } = build();
  await enable();
  for (let open = 0; open < 100; open += 1) await collector.capture('https://a.example/');
  assert.equal((await collector.list()).items[0].visits, 100);
});

test('two fragments of one page are one address', async () => {
  const { collector, enable, advance } = build();
  await enable();
  await collector.capture('https://a.example/doc#one');
  advance(60_000);
  await collector.capture('https://a.example/doc#two');
  const { items } = await collector.list();
  assert.deepEqual(items.map((item) => item.url), ['https://a.example/doc']);
  assert.equal(items[0].visits, 2);
});

test('there is no time-based gate: five visits that arrive together are five rows', async () => {
  const { collector, enable } = build();
  await enable();
  const answers = await Promise.all(
    ['a', 'b', 'c', 'd', 'e'].map((name) => collector.capture(`https://${name}.example/`))
  );
  assert.deepEqual(answers, ['captured', 'captured', 'captured', 'captured', 'captured']);
  assert.equal((await collector.list()).items.length, 5);
});

test('a promotion that lands beside a capture is not resurrected by it', async () => {
  const { collector, enable, advance } = build();
  await enable();
  await collector.capture('https://race.example/');
  advance(60_000);
  const [, removed] = await Promise.all([
    collector.capture('https://race.example/'),
    collector.promote(['https://race.example/'])
  ]);
  assert.equal(removed, 1);
  assert.deepEqual((await collector.list()).items, []);
});

test('promotion and dismissal are idempotent', async () => {
  const { collector, enable } = build();
  await enable();
  await collector.capture('https://a.example/');
  assert.equal(await collector.promote(['https://a.example/']), 1);
  assert.equal(await collector.promote(['https://a.example/']), 0);
  assert.equal(await collector.dismiss(['https://never.example/']), 0);
});

test('retention keeps the newest rows and a zero means unlimited', async () => {
  const { collector, enable, advance } = build();
  await enable({ retentionDays: 1 });
  await collector.capture('https://old.example/');
  advance(3 * 86_400_000);
  await collector.capture('https://new.example/');
  assert.deepEqual((await collector.list()).items.map((item) => item.host), ['new.example']);

  const unlimited = build();
  await unlimited.enable({ retentionDays: 0 });
  await unlimited.collector.capture('https://old.example/');
  unlimited.advance(3 * 86_400_000);
  await unlimited.collector.capture('https://new.example/');
  assert.equal((await unlimited.collector.list()).items.length, 2);
});

test('the entry cap keeps the rows seen most recently', async () => {
  const { collector, enable, advance } = build();
  await enable({ maxEntries: 2 });
  for (const name of ['a', 'b', 'c']) {
    await collector.capture(`https://${name}.example/`);
    advance(60_000);
  }
  assert.deepEqual((await collector.list()).items.map((item) => item.host).sort(), ['b.example', 'c.example']);
});

test('a cap is not spent on rows the visit floor is hiding', async () => {
  const { collector, enable, advance } = build();
  await enable({ minVisits: 3, maxEntries: 2 });

  for (let visit = 0; visit < 3; visit += 1) {
    await collector.capture('https://keep.example/');
    advance(60_000);
  }
  await collector.capture('https://once-a.example/');
  advance(60_000);
  await collector.capture('https://once-b.example/');

  assert.deepEqual((await collector.list()).items.map((item) => item.host), ['keep.example']);
});

test('a visit floor hides a row and never deletes it', async () => {
  const { collector, enable, advance } = build();
  await enable({ minVisits: 2 });
  await collector.capture('https://once.example/');
  assert.deepEqual((await collector.list()).items, []);

  advance(60_000);
  await collector.capture('https://once.example/');
  assert.equal((await collector.list()).items.length, 1);
});

test('a row that is already held does not spend the daily budget', async () => {
  const { collector, enable, advance } = build();
  await enable({ dailyCap: 2 });

  await collector.capture('https://one.example/');
  advance(60_000);
  await collector.capture('https://one.example/');
  advance(60_000);
  await collector.capture('https://one.example/');
  advance(60_000);

  assert.equal(await collector.capture('https://two.example/'), 'captured');
  assert.equal(await collector.capture('https://three.example/'), 'capped');
});

test('the daily budget rolls over on the local calendar day', async () => {
  /* The day the cap rolls on is the machine's own, so these two moments are built in its zone rather than pinned to
     one offset — a fixed `+05:30` reads as the same UTC day on a CI runner and never rolls over there. */
  let clock = new Date(2026, 10, 10, 23, 50).getTime();
  const collector = createCollector({ persistent: memory(), now: () => clock });
  await collector.setPolicy({ enabled: true, dailyCap: 1 });

  assert.equal(await collector.capture('https://one.example/'), 'captured');
  clock = new Date(2026, 10, 11, 0, 10).getTime();
  assert.equal(await collector.capture('https://two.example/'), 'captured');
});

test('an excluded site is refused, and an exclusion written as a policy sweeps what is held', async () => {
  const { collector, enable } = build();
  await enable();
  await collector.capture('https://bank.example/statement');

  await collector.setPolicy({ exclude: [{ scope: 'site', value: 'bank.example' }] });

  assert.deepEqual((await collector.list()).items, []);
  assert.equal(await collector.capture('https://secure.bank.example/other'), 'excluded');
});

test('an exclusion past the cap is dropped whole — the rule goes, and so does nothing else', async () => {
  const { collector, enable } = build();
  await enable();
  const filler = Array.from({ length: 200 }, (_, index) => ({ scope: 'host', value: `f${index}.example` }));
  await collector.exclude(filler);

  await collector.capture('https://secret.example/row');
  const policy = await collector.exclude([{ scope: 'site', value: 'secret.example' }]);

  assert.equal(policy.exclude.length, 200);
  assert.equal(policy.exclude.some((entry) => entry.value === 'secret.example'), false);
  assert.deepEqual((await collector.list()).items.map((item) => item.host), ['secret.example']);
});

test('a private window is refused and nothing is written', async () => {
  const { collector, enable, persistent } = build();
  await enable({ includeIncognito: false });

  assert.equal(await collector.capture('https://bank.example/accounts/1', { incognito: true }), 'incognito');
  assert.deepEqual(Object.keys(await persistent.all()).filter((key) => key.startsWith('u:')), [], 'the address is nowhere on disk');
});

test('a private window is counted when the policy allows it, and marked', async () => {
  const { collector, enable } = build();
  await enable({ includeIncognito: true });
  assert.equal(await collector.capture('https://a.example/', { incognito: true }), 'captured');
  assert.equal((await collector.list()).items[0].private, true);
});

test('withdrawing consent stops counting and keeps what is held', async () => {
  const { collector, enable } = build();
  await enable();
  await collector.capture('https://a.example/');
  await collector.setPolicy({ enabled: false });

  assert.equal(await collector.capture('https://b.example/'), 'off');
  assert.equal((await collector.list()).items.length, 1);
});

test('a tidy applies the retention without needing a visit', async () => {
  const { collector, enable, advance } = build();
  await enable({ retentionDays: 1 });
  await collector.capture('https://old.example/');
  advance(2 * 86_400_000);
  assert.equal(await collector.tidy(), 0);
});


test('clearing forgets the rows and the day counter, and keeps collecting', async () => {
  const { collector, enable, advance, persistent } = build();
  await enable({ dailyCap: 1 });
  await collector.capture('https://a.example/');
  await collector.capture('https://b.example/');

  await collector.clear();

  assert.deepEqual((await collector.list()).items, []);
  assert.deepEqual(Object.keys(await persistent.all()).filter((key) => key.startsWith('u:')), [], 'no row survives a clear');
  assert.equal(await persistent.get('day'), undefined, 'the day counter goes with the rows');

  advance(1_000);
  assert.equal(await collector.capture('https://c.example/'), 'captured', 'clearing is not stopping');
  assert.equal(await persistent.get('policy').then((policy) => policy.enabled), true, 'the policy survives');
});

test('a visit writes one row, not the whole list', async () => {
  const { collector, enable, persistent } = build();
  await enable();
  await collector.capture('https://a.example/one');
  await collector.capture('https://b.example/two');

  const keys = Object.keys(await persistent.all()).sort();
  assert.deepEqual(keys, [
    'day',
    'policy',
    'u:https://a.example/one',
    'u:https://b.example/two'
  ]);
});

test('a list kept in the old single object is split into rows and the old key is dropped', async () => {
  const { collector, enable, persistent } = build();
  await enable();
  await persistent.put('items', {
    'https://kept.example/': {
      url: 'https://kept.example/',
      host: 'kept.example',
      visits: 4,
      firstSeenAt: '2023-11-14T22:00:00.000Z',
      lastSeenAt: '2023-11-14T22:13:20.000Z',
      private: false
    }
  });

  const { items } = await collector.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].visits, 4, 'the count came across whole');

  const all = await persistent.all();
  assert.equal(all.items, undefined, 'the old map is gone');
  assert.equal(all['u:https://kept.example/'].visits, 4);
});

test('the entry cap reaches the store on a tidy, not on every visit', async () => {
  const { collector, enable, advance, persistent } = build();
  await enable({ maxEntries: 2 });
  for (const name of ['a', 'b', 'c']) {
    await collector.capture(`https://${name}.example/`);
    advance(60_000);
  }

  assert.equal(Object.keys(await persistent.all()).filter((key) => key.startsWith('u:')).length, 3);
  assert.equal(await collector.tidy(), 2);
  const rows = Object.entries(await persistent.all()).filter(([key]) => key.startsWith('u:'));
  assert.deepEqual(rows.map(([, row]) => row.host).sort(), ['b.example', 'c.example']);
});

/* A history import is a fold over values, so every case below hands it entries and rows and reads the answer. */

const AT = Date.parse('2026-06-01T12:00:00.000Z');
const withPolicy = (patch = {}) => ({ ...DEFAULT_POLICY, enabled: true, ...patch });
const iso = (at) => new Date(at).toISOString();

test('history entries become rows with the counts they already had', () => {
  const { items, counts } = importHistory({
    entries: [
      { url: 'https://a.example/read', visitCount: 7, lastVisitTime: AT - 60_000 },
      { url: 'https://b.example/read', visitCount: 1, lastVisitTime: AT }
    ],
    policy: withPolicy(),
    at: AT
  });

  assert.deepEqual(counts, { imported: 2, merged: 0, excluded: 0, capped: 0, invalid: 0 });
  assert.deepEqual(Object.keys(items).sort(), ['https://a.example/read', 'https://b.example/read']);
  assert.deepEqual(items['https://a.example/read'], {
    url: 'https://a.example/read',
    host: 'a.example',
    visits: 7,
    firstSeenAt: iso(AT - 60_000),
    lastSeenAt: iso(AT - 60_000),
    private: false
  });
  assert.equal(items['https://b.example/read'].visits, 1, 'the count is the history count, not one visit');
  assert.equal(items['https://b.example/read'].lastSeenAt, iso(AT));
});

test('a credential query parameter never reaches a row', () => {
  const { items } = importHistory({
    entries: [{ url: 'https://a.example/reset?token=s3cret-value&page=2', visitCount: 2, lastVisitTime: AT }],
    policy: withPolicy(),
    at: AT
  });

  const [row] = Object.values(items);
  assert.equal(row.url.includes('token'), false, 'the parameter is dropped with the rest of the credentials');
  assert.equal(JSON.stringify(items).includes('s3cret-value'), false, 'the value is nowhere in the result');
});

test('an excluded site leaves no row and is counted', () => {
  const { items, counts } = importHistory({
    entries: [{ url: 'https://bank.example/statement', visitCount: 3, lastVisitTime: AT }],
    policy: withPolicy({ exclude: [{ scope: 'site', value: 'bank.example' }] }),
    at: AT
  });

  assert.equal(counts.excluded, 1);
  assert.equal(counts.imported, 0);
  assert.deepEqual(items, {});
});

test('an address that is not a link is counted, not stored', () => {
  const { items, counts } = importHistory({
    entries: ['chrome://settings', 'file:///x', 'not a url'].map((url) => ({
      url,
      visitCount: 1,
      lastVisitTime: AT
    })),
    policy: withPolicy(),
    at: AT
  });

  assert.equal(counts.invalid, 3);
  assert.equal(counts.imported, 0);
  assert.deepEqual(items, {});

  /* A null entry, an entry with no address and an entry with no count are refused rather than guessed at. */
  const odd = importHistory({
    entries: [null, {}, { url: 'https://countless.example/' }],
    policy: withPolicy(),
    at: AT
  });
  assert.equal(odd.counts.invalid, 3);
  assert.deepEqual(odd.items, {});
});

test('a held row keeps the larger count and the later time', () => {
  const day = 86_400_000;
  const held = {
    url: 'https://a.example/held',
    host: 'a.example',
    visits: 3,
    firstSeenAt: iso(AT - 5 * day),
    lastSeenAt: iso(AT - 2 * day),
    private: true
  };
  const items = { 'https://a.example/held': held };

  const later = importHistory({
    entries: [{ url: 'https://a.example/held', visitCount: 9, lastVisitTime: AT }],
    policy: withPolicy(),
    items,
    at: AT
  });

  assert.equal(later.counts.merged, 1);
  assert.equal(later.items['https://a.example/held'].visits, 9, 'the larger count wins');
  assert.equal(later.items['https://a.example/held'].lastSeenAt, iso(AT), 'the later time wins');
  assert.equal(later.items['https://a.example/held'].firstSeenAt, iso(AT - 5 * day), 'the earlier sighting stands');
  assert.equal(later.items['https://a.example/held'].private, true, 'a held row stays as private as it was');

  const earlier = importHistory({
    entries: [{ url: 'https://a.example/held', visitCount: 2, lastVisitTime: AT - 3 * day }],
    policy: withPolicy(),
    items,
    at: AT
  });

  assert.equal(earlier.items['https://a.example/held'].visits, 3, 'a smaller history count does not lower it');
  assert.equal(earlier.items['https://a.example/held'].lastSeenAt, held.lastSeenAt, 'an older entry does not go back');
  assert.equal(held.visits, 3, 'the row handed in is not written to');
});

test('two entries for one address fold into one row', () => {
  const { items, counts } = importHistory({
    entries: [
      { url: 'https://a.example/repeat', visitCount: 2, lastVisitTime: AT - 60_000 },
      { url: 'https://a.example/repeat#again', visitCount: 5, lastVisitTime: AT }
    ],
    policy: withPolicy(),
    at: AT
  });

  assert.equal(counts.imported, 1);
  assert.equal(counts.merged, 1);
  assert.deepEqual(Object.keys(items), ['https://a.example/repeat']);
  assert.equal(items['https://a.example/repeat'].visits, 5, 'the larger of the two counts');
  assert.equal(items['https://a.example/repeat'].lastSeenAt, iso(AT));
});

test('retention and the entry cap still bound what is imported', () => {
  const day = 86_400_000;
  const { items, counts } = importHistory({
    entries: [
      { url: 'https://stale.example/', visitCount: 4, lastVisitTime: AT - 20 * day },
      { url: 'https://a.example/', visitCount: 1, lastVisitTime: AT - 3 * day },
      { url: 'https://b.example/', visitCount: 1, lastVisitTime: AT - 2 * day },
      { url: 'https://c.example/', visitCount: 1, lastVisitTime: AT - day }
    ],
    policy: withPolicy({ retentionDays: 10, maxEntries: 2 }),
    at: AT
  });

  assert.equal(counts.imported, 4);
  assert.equal(counts.capped, 2, 'one row left the window and one lost the cap');
  assert.deepEqual(Object.keys(items).sort(), ['https://b.example/', 'https://c.example/'], 'the newest two survive');
});

test('an import with the policy off changes nothing', () => {
  const items = {
    'https://a.example/': {
      url: 'https://a.example/',
      host: 'a.example',
      visits: 2,
      firstSeenAt: iso(AT - 1_000),
      lastSeenAt: iso(AT - 1_000),
      private: false
    }
  };

  const result = importHistory({
    entries: [{ url: 'https://b.example/', visitCount: 4, lastVisitTime: AT }],
    policy: { ...DEFAULT_POLICY, enabled: false },
    items,
    at: AT
  });

  assert.deepEqual(Object.keys(result.items), ['https://a.example/']);
  assert.deepEqual(result.items, items);
  assert.deepEqual(result.counts, { imported: 0, merged: 0, excluded: 0, capped: 0, invalid: 0 });
});

test('an empty history is a no-op', () => {
  const items = {
    'https://a.example/': {
      url: 'https://a.example/',
      host: 'a.example',
      visits: 1,
      firstSeenAt: iso(AT),
      lastSeenAt: iso(AT),
      private: false
    }
  };

  const result = importHistory({ entries: [], policy: withPolicy(), items, at: AT });

  assert.deepEqual(result.items, items);
  assert.deepEqual(Object.keys(result.items), Object.keys(items));
  assert.deepEqual(result.counts, { imported: 0, merged: 0, excluded: 0, capped: 0, invalid: 0 });
});
