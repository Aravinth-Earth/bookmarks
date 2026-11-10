/**
 * The collector: counting, the dwell gate, retention, and the two ways a row leaves the list.
 *
 * Storage is a Map pair with the clock injected, so every case names the moment it depends on. A service worker
 * that falls asleep mid-visit must neither lose the visit nor invent one, which is why the dwell state lives in
 * the injected `session` store rather than in a variable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createCollector } from '../extension/collector-core.js';

function memory() {
  const map = new Map();
  return {
    async get(key) { return map.get(key); },
    async put(key, value) { map.set(key, structuredClone(value)); },
    async remove(key) { map.delete(key); },
    dump() { return Object.fromEntries(map); }
  };
}

function build({ now = 1_700_000_000_000 } = {}) {
  let clock = now;
  const persistent = memory();
  const session = memory();
  const collector = createCollector({ persistent, session, now: () => clock });
  const advance = (ms) => { clock += ms; };
  const enable = (patch = {}) => collector.setPolicy({ enabled: true, ...patch });
  return { collector, persistent, session, enable, advance };
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
  assert.equal(items[0].host, 'a.example');
  assert.equal(items[0].url, 'https://a.example/x');
});

test('a reload within the debounce window is one visit, not two', async () => {
  const { collector, enable, advance } = build();
  await enable();
  await collector.capture('https://a.example/x');
  advance(5_000);
  assert.equal(await collector.capture('https://a.example/x'), 'debounced');
  assert.equal((await collector.list()).items[0].visits, 1);
});

test('the fragment never splits one page into two rows', async () => {
  const { collector, enable } = build();
  await enable();
  await collector.capture('https://a.example/doc#a');
  await collector.capture('https://a.example/doc#b');
  const { items } = await collector.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://a.example/doc');
});

test('a private window is refused unless it was asked for, and the flag follows the last visit', async () => {
  const { collector, enable } = build();
  await enable();
  assert.equal(await collector.capture('https://a.example/x', { incognito: true }), 'incognito');

  await enable({ includeIncognito: true });
  assert.equal(await collector.capture('https://a.example/x', { incognito: true }), 'captured');
  assert.equal((await collector.list()).items[0].private, true);
});

test('an excluded site is not captured, and excluding one deletes what was already kept', async () => {
  const { collector, enable } = build();
  await enable();
  await collector.capture('https://bank.example/x');
  await collector.capture('https://news.example/y');

  const policy = await collector.exclude([{ scope: 'site', value: 'bank.example' }]);
  assert.deepEqual(policy.exclude, [{ scope: 'site', value: 'bank.example' }]);

  assert.equal(await collector.capture('https://secure.bank.example/z'), 'excluded');
  assert.deepEqual((await collector.list()).items.map((item) => item.host), ['news.example']);
});

test('the dwell gate holds a visit until the tab is left for long enough', async () => {
  const { collector, enable, advance } = build();
  await enable({ minOpenMs: 2_000 });

  assert.equal(await collector.note(7, 'https://a.example/x'), 'dwelling');
  assert.deepEqual((await collector.list()).items, []);

  advance(500);
  assert.equal(await collector.leave(7), 'tooBrief');
  assert.deepEqual((await collector.list()).items, []);

  await collector.note(8, 'https://b.example/y');
  advance(3_000);
  assert.equal(await collector.leave(8), 'captured');
  assert.deepEqual((await collector.list()).items.map((item) => item.host), ['b.example']);
});

test('with no dwell gate a visit is counted on the spot and the tab holds nothing', async () => {
  const { collector, enable } = build();
  await enable();
  assert.equal(await collector.note(3, 'https://a.example/x'), 'captured');
  assert.equal(await collector.leave(3), 'nothing');
});

test('the entry cap keeps the rows seen most recently', async () => {
  const { collector, enable, advance } = build();
  await enable({ maxEntries: 2 });

  await collector.capture('https://one.example/');
  advance(1_000);
  await collector.capture('https://two.example/');
  advance(1_000);
  await collector.capture('https://three.example/');

  assert.deepEqual(
    (await collector.list()).items.map((item) => item.host).sort(),
    ['three.example', 'two.example']
  );
});

test('a retention window drops rows last seen before the cutoff, and 0 keeps them forever', async () => {
  const { collector, enable, advance } = build();
  await enable({ retentionDays: 1 });
  await collector.capture('https://old.example/');
  advance(2 * 86_400_000);
  await collector.capture('https://new.example/');

  let { items } = await collector.list();
  assert.deepEqual(items.map((item) => item.host), ['new.example']);

  await enable({ retentionDays: 0 });
  advance(30 * 86_400_000);
  ({ items } = await collector.list());
  assert.deepEqual(items.map((item) => item.host), ['new.example']);
});

test('a daily cap stops new rows for the day but keeps counting the ones already held', async () => {
  const { collector, enable, advance } = build();
  await enable({ dailyCap: 2 });
  await collector.capture('https://one.example/');
  await collector.capture('https://two.example/');
  assert.equal(await collector.capture('https://three.example/'), 'capped');

  /* Past the reload window, so this is a real second visit rather than the same one firing twice. */
  advance(60_000);
  assert.equal(await collector.capture('https://one.example/'), 'captured');
  assert.equal((await collector.list()).items.length, 2);
});

test('promoting and dismissing both remove the row, and the count says how many went', async () => {
  const { collector, enable } = build();
  await enable();
  await collector.capture('https://one.example/');
  await collector.capture('https://two.example/');
  await collector.capture('https://three.example/');

  assert.equal(await collector.promote(['https://one.example/']), 1);
  assert.equal(await collector.dismiss(['https://two.example/', 'https://absent.example/']), 1);
  assert.deepEqual((await collector.list()).items.map((item) => item.host), ['three.example']);
});

test('a row below the visit floor is kept but hidden, so raising the floor later still finds it', async () => {
  const { collector, enable, advance } = build();
  await enable({ minVisits: 3 });
  await collector.capture('https://once.example/');
  advance(60_000);
  await collector.capture('https://thrice.example/');
  advance(60_000);
  await collector.capture('https://thrice.example/');
  advance(60_000);
  await collector.capture('https://thrice.example/');

  assert.deepEqual((await collector.list()).items.map((item) => item.host), ['thrice.example']);

  await enable({ minVisits: 1 });
  assert.deepEqual(
    (await collector.list()).items.map((item) => item.host).sort(),
    ['once.example', 'thrice.example']
  );
});


/* ---------------------------------------------------------------- the review's regressions */

test('five visits that arrive together are five rows, not one', async () => {
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

test('navigating within a tab decides the page that tab was holding', async () => {
  const { collector, enable, advance } = build();
  await enable({ minOpenMs: 2_000 });

  await collector.note(1, 'https://a.example/read');
  advance(600_000);
  await collector.note(1, 'https://b.example/next');
  advance(5_000);
  await collector.leave(1);

  assert.deepEqual(
    (await collector.list()).items.map((item) => item.host).sort(),
    ['a.example', 'b.example'],
    'a page read for ten minutes qualifies and must not be replaced unrecorded'
  );
});

test('revisiting a held address does not spend the daily budget for new ones', async () => {
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

test('the daily budget rolls over on the local calendar day, not at 05:30', async () => {
  /* 23:50 in India, then 00:10 the next day: a new local day means a fresh budget even though UTC is still on the
     previous date. */
  let clock = Date.parse('2026-11-10T23:50:00+05:30');
  const persistent = memory();
  const session = memory();
  const collector = createCollector({ persistent, session, now: () => clock });
  await collector.setPolicy({ enabled: true, dailyCap: 1 });

  assert.equal(await collector.capture('https://one.example/'), 'captured');
  clock = Date.parse('2026-11-11T00:10:00+05:30');
  assert.equal(await collector.capture('https://two.example/'), 'captured');
});

test('a policy push carries exclusions, and the rows they cover are swept with it', async () => {
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

  assert.equal(policy.exclude.length, 200, 'the cap still holds');
  assert.equal(
    policy.exclude.some((entry) => entry.value === 'secret.example'),
    false,
    'the rule was not stored'
  );
  assert.deepEqual(
    (await collector.list()).items.map((item) => item.host),
    ['secret.example'],
    'so the row it would have covered must survive'
  );
});

test('a dwell visit keeps the moment it began and the moment it was decided', async () => {
  const start = Date.parse('2026-11-10T10:00:00+05:30');
  let clock = start;
  const collector = createCollector({ persistent: memory(), session: memory(), now: () => clock });
  await collector.setPolicy({ enabled: true, minOpenMs: 1_000, retentionDays: 1 });

  await collector.note(1, 'https://long.example/read');
  clock += 3 * 86_400_000;
  await collector.leave(1);

  const { items } = await collector.list();
  assert.equal(items.length, 1, 'three days later the retention window would have deleted a row stamped at arrival');
  assert.equal(items[0].firstSeenAt, new Date(start).toISOString());
  assert.equal(items[0].lastSeenAt, new Date(clock).toISOString());
});

test('a private visit writes nothing at all, not even the dwell entry', async () => {
  const { collector, enable, session } = build();
  await enable({ minOpenMs: 5_000, includeIncognito: false });

  assert.equal(await collector.note(4, 'https://bank.example/accounts/12345', { incognito: true }), 'incognito');
  assert.equal(session.dump().dwell, undefined, 'the address must not be on disk for the length of the visit');
});

test('a visit held in session storage survives the worker being replaced', async () => {
  const persistent = memory();
  const session = memory();
  let clock = 1_700_000_000_000;

  const first = createCollector({ persistent, session, now: () => clock });
  await first.setPolicy({ enabled: true, minOpenMs: 1_000 });
  await first.note(9, 'https://a.example/x');

  /* A new worker over the same stores is what MV3 hands you after half a minute of quiet. */
  clock += 5_000;
  const second = createCollector({ persistent, session, now: () => clock });
  assert.equal(await second.leave(9), 'captured');
  assert.deepEqual((await second.list()).items.map((item) => item.host), ['a.example']);
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

  assert.deepEqual(
    (await collector.list()).items.map((item) => item.host),
    ['keep.example'],
    'the only row the person may see must survive the cap'
  );
});
