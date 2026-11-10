/**
 * The collector: counting, retention, exclusions, and the ways a row leaves the list.
 *
 * Counting is the whole feature — one navigation to one address is one visit — so there is no dwell, no timer and
 * nothing about which tab is in front. A visit that arrives twice within half a minute is the browser reporting the
 * same navigation again, not a person coming back.
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

test('the same navigation reported twice within half a minute is one visit', async () => {
  const { collector, enable, advance } = build();
  await enable();
  assert.equal(await collector.capture('https://a.example/x'), 'captured');
  advance(29_999);
  assert.equal(await collector.capture('https://a.example/x'), 'debounced');
  advance(1);
  assert.equal(await collector.capture('https://a.example/x'), 'captured');
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
  let clock = Date.parse('2026-11-10T23:50:00+05:30');
  const collector = createCollector({ persistent: memory(), now: () => clock });
  await collector.setPolicy({ enabled: true, dailyCap: 1 });

  assert.equal(await collector.capture('https://one.example/'), 'captured');
  clock = Date.parse('2026-11-11T00:10:00+05:30');
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
  assert.deepEqual((await persistent.get('items')) ?? {}, {}, 'the address is nowhere on disk');
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
