/**
 * A moment as a person reads it, with the zone it is read in.
 *
 * The owner is shown two account dates: when the vault was created, and when the account last
 * moved. Both arrive as milliseconds, and both are read on the viewer's own clock — the same
 * instant is a different hour in another place, and a date without the hour cannot tell two
 * sessions on one day apart. The zone's short name is stated once, beside the hour, so a reader
 * who is travelling knows which clock the hour belongs to.
 *
 * The day and month are written in one fixed locale, `en-IN`, because every other word on this
   page is English: a browser set to another language would otherwise print the same row in a
   script the rest of the page is not in. The zone stays the reader's own. The tests name both so
   the expected string does not move with the machine.
 */

/** What a line shows when the account has no such moment: a dash, never an empty line. */
export const MISSING_STAMP = '—';

/**
 * A stored millisecond stamp as `8 Nov 2026, 14:34 GMT+5:30`, or a dash when it is absent.
 *
 * A stamp of zero and a stamp that is not a number are absent: the account record writes these
 * once it exists, so a caller that never saw one is reading a vault that was never told.
 */
export function formatStamp(stamp, { locale = 'en-IN', timeZone = undefined } = {}) {
  if (typeof stamp !== 'number' || !Number.isFinite(stamp) || stamp <= 0) return MISSING_STAMP;

  const when = new Date(stamp);
  if (Number.isNaN(when.getTime())) return MISSING_STAMP;

  return when.toLocaleString(locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {})
  });
}
