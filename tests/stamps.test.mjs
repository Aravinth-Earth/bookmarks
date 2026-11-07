/**
 * The line the owner reads for a vault's dates: a day, an hour, and the zone the hour is in.
 *
 * The two properties that matter are that the hour is there at all — a date alone cannot tell
 * two sessions on one day apart — and that an absent stamp is a dash rather than an empty
 * line. The zone is named once, so two rows from the same vault do not look like two clocks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { MISSING_STAMP, formatStamp } from '../public/w/bookmarks/stamps.js';

/* 2026-11-08T09:04:00Z. Both zones below are named so the expected string does not move with
   the machine the tests run on. */
const STAMP = Date.UTC(2026, 10, 8, 9, 4);

test('a stamp is read as the day, the hour and the minute in the named zone', () => {
  assert.equal(
    formatStamp(STAMP, { locale: 'en-GB', timeZone: 'UTC' }),
    '8 Nov 2026, 09:04 UTC'
  );
});

test('the hour follows the zone, so the same instant reads differently elsewhere', () => {
  assert.equal(
    formatStamp(STAMP, { locale: 'en-US', timeZone: 'America/New_York' }),
    'Nov 8, 2026, 04:04 AM EST'
  );
});

test('the zone is named once, beside the time', () => {
  const label = formatStamp(STAMP, { locale: 'en-GB', timeZone: 'UTC' });
  assert.equal(label.split('UTC').length - 1, 1);
  assert.match(label, /\d{2}:\d{2}/, 'the minutes are there, not just the day');
});

test('an absent stamp is a dash and not an empty line', () => {
  for (const absent of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY, '', '1700000000000', {}]) {
    assert.equal(formatStamp(absent), MISSING_STAMP, `${String(absent)} has no date`);
  }
});

test('the dash is the one the rest of the app uses', () => {
  assert.equal(MISSING_STAMP, '—');
});
