/**
 * Bookmarks — the document, and every operation that changes it.
 *
 * The document is the only thing the vault seals, and every function here is pure: it takes a
 * document and returns a new one. Nothing in this module touches storage, the network or the
 * clock beyond the `now` a caller passes in.
 *
 * `mergeDocuments` is the rule that lets two devices converge without the server ever seeing a
 * bookmark. It is last-write-wins per field, `clickCount` takes the larger side because a click
 * happened or it did not, and a deletion is a tombstone that outlives the record it removed.
 */

export const SCHEMA = 1;
export const MAX_BOOKMARKS = 500;
export const MAX_URL_LENGTH = 2048;
export const MAX_NAME_LENGTH = 120;
/* How long the field and the filtered list stay as they are after a bookmark is opened from a
   search. A search exists to find one bookmark; once it is open, the filter is no longer what
   the person is reading. */
export const SEARCH_CLEAR_DELAY_MS = 5000;
/* A device offline for longer than this can resurrect a bookmark. Six months is the trade
   against a tombstone list that grows forever. */
export const TOMBSTONE_DAYS = 180;

/* The audit log is a ring, not a history: the vault is small and sealed, and a line kept for
   every count change since the beginning would grow without bound inside it. */
export const MAX_ACTIVITY = 100;
export const ACTIVITY_DAYS = 90;
/* A log is a small part of the vault, not most of it. At roughly 280 characters for a full
   line with a real address, 24,000 characters is about 80 lines; a shorter address holds more,
   up to the 100-line cap. The oldest lines fall first. */
export const MAX_ACTIVITY_CHARS = 24_000;
/* The whole document, as JSON, that still seals inside the free hosted copy. The copy is
   160,000 ciphertext characters (`FREE_MAX_CT_CHARS`); a 1 KiB-padded plaintext plus the GCM tag
   becomes 4/3 as many base64url characters, so 120,000 plaintext bytes is the ceiling. The
   envelope and the padding bucket need a little of that, and this leaves a margin. The size is
   the whole document, not only the log: a large vault leaves the log less room, and `fitActivity`
   drops the oldest lines until both fit. tests/activity.test.mjs checks this against the real
   server cap. */
export const FREE_DOCUMENT_BYTES = 117_000;
export const ACTIVITY_CAUSES = Object.freeze([
  'click',
  'open',
  'merge',
  'restore',
  'import',
  'history-import'
]);

const ACTIVITY_MS = ACTIVITY_DAYS * 24 * 60 * 60 * 1000;
const ACTIVITY_CAUSE_SET = new Set(ACTIVITY_CAUSES);
/* The name a count change is filed under when the caller did not say who was looking. It is not
   a device id and names nobody; it only keeps the event shape whole. */
const UNSETTLED_DEVICE = 'unsettled';

const TOMBSTONE_MS = TOMBSTONE_DAYS * 24 * 60 * 60 * 1000;
const SORTS = new Set(['clicks', 'recent', 'name', 'lastClicked']);
const PATCHABLE = new Set(['name', 'url', 'clickCount', 'pinned', 'hideLabel', 'icon', 'color']);

function fail(code, message) {
  const error = new Error(`bookmarks: ${message}`);
  error.code = code;
  return error;
}

function iso(now) {
  return new Date(typeof now === 'function' ? now() : now).toISOString();
}

function later(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;
  return left >= right ? left : right;
}

function earlier(left, right) {
  if (!left) return right ?? null;
  if (!right) return left;
  return left <= right ? left : right;
}

/**
 * A URL as the app stores it, or a refusal.
 *
 * Only http and https are accepted. A `javascript:` bookmark is a script the page would run,
 * and a `data:` one is a document that would replace the vault; neither is a bookmark.
 *
 * @returns {{url: string, hostname: string, origin: string}}
 */
export function normalizeUrl(input) {
  if (typeof input !== 'string' || input.trim() === '') {
    throw fail('INVALID_URL', 'a bookmark needs a URL');
  }
  const trimmed = input.trim();
  if (trimmed.length > MAX_URL_LENGTH) {
    throw fail('INVALID_URL', `a URL is at most ${MAX_URL_LENGTH} characters`);
  }

  const scheme = trimmed.match(/^([a-z][a-z0-9+.-]*):(.*)$/i);
  let candidate = trimmed;
  if (scheme) {
    const [, name, rest] = scheme;
    /* "localhost:8080" and "example.com:8080/x" are host:port, not a scheme with no slashes. */
    const isHostPort = /^\d+(?:\/|$|\?|#)/.test(rest);
    if (!isHostPort) {
      if (!['http', 'https'].includes(name.toLowerCase())) {
        throw fail('INVALID_URL', `"${name}:" is not a bookmark scheme`);
      }
      if (!/^https?:\/\//i.test(trimmed)) candidate = `${name}://${rest}`;
    }
  }

  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`);
  } catch {
    throw fail('INVALID_URL', 'that is not a URL');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw fail('INVALID_URL', 'that is not a bookmark scheme');
  }
  if (!parsed.hostname.includes('.') && parsed.hostname !== 'localhost') {
    throw fail('INVALID_URL', 'that URL has no host');
  }

  return { url: parsed.href, hostname: parsed.hostname, origin: parsed.origin };
}

function isIso(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function assertDocument(document, what) {
  if (!document || typeof document !== 'object') {
    throw fail('INVALID_DOCUMENT', `${what} is not a document`);
  }
  if (document.schema !== SCHEMA) {
    throw fail('INVALID_DOCUMENT', `${what} is schema ${document.schema}, not ${SCHEMA}`);
  }
  if (!Array.isArray(document.bookmarks) || !Array.isArray(document.tombstones)) {
    throw fail('INVALID_DOCUMENT', `${what} carries bookmarks and tombstones`);
  }
}

/** An empty document. Preferences live here so they are sealed with everything else. */
export function createDocument() {
  return {
    schema: SCHEMA,
    bookmarks: [],
    tombstones: [],
    activity: [],
    prefs: { iconOnly: false }
  };
}

function findIndex(document, id) {
  const at = document.bookmarks.findIndex((bookmark) => bookmark.id === id);
  if (at === -1) throw fail('NOT_FOUND', `no bookmark with id ${id}`);
  return at;
}

function findByUrl(document, url) {
  return document.bookmarks.find((bookmark) => bookmark.url === url) ?? null;
}

function nextId() {
  return crypto.randomUUID();
}

/**
 * Add one bookmark.
 *
 * @returns {{document: object, bookmark: object}} the new document and the record added
 */
export function addBookmark(document, input, now = Date.now) {
  assertDocument(document, 'the document');
  if (document.bookmarks.length >= MAX_BOOKMARKS) {
    throw fail('LIMIT', `a vault holds at most ${MAX_BOOKMARKS} bookmarks`);
  }

  const { url, hostname, origin } = normalizeUrl(input?.url);
  const existing = findByUrl(document, url);
  if (existing) {
    const error = fail('DUPLICATE', 'that URL is already bookmarked');
    error.existingId = existing.id;
    throw error;
  }

  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  if (name.length > MAX_NAME_LENGTH) {
    throw fail('INVALID_NAME', `a name is at most ${MAX_NAME_LENGTH} characters`);
  }

  const clickCount = input?.clickCount ?? 0;
  if (!Number.isInteger(clickCount) || clickCount < 0) {
    throw fail('INVALID_CLICKS', 'a click count is a whole number, zero or more');
  }

  /* Opens made in the browser are counted by the extension, on each device separately, and mirrored here: a
     bookmark's uses are the sum of what every device saw. Each device writes only its own slot, so a merge can add
     them up without ever adding the same visit twice. */
  const uses = normaliseUses(input?.uses);

  /* A document written before the slots existed carries one number and no device name; it becomes the slot called
     `legacy`, which keeps the count and never grows. */
  if (Object.keys(uses).length === 0 && input?.openCount !== undefined) {
    const openCount = input.openCount;
    if (!Number.isInteger(openCount) || openCount < 0) {
      throw fail('INVALID_CLICKS', 'an open count is a whole number, zero or more');
    }
    if (openCount > 0) uses[LEGACY_DEVICE] = openCount;
  }

  const at = iso(now);
  const bookmark = {
    id: nextId(),
    url,
    hostname,
    origin,
    name,
    /* A hidden search term from an imported library (the retired app's `actual_name`). It is
       never rendered: a pill that used to be icon-only stays icon-only, but searching for the
       site's real title still finds it. */
    search: typeof input?.search === 'string' ? input.search.trim() : '',
    clickCount,
    uses,
    pinned: Boolean(input?.pinned),
    hideLabel: Boolean(input?.hideLabel),
    icon: input?.icon ?? null,
    color: input?.color ?? null,
    createdAt: at,
    updatedAt: at,
    lastClickedAt: null
  };

  return {
    document: { ...document, bookmarks: [...document.bookmarks, bookmark] },
    bookmark
  };
}

/** The slot a count from a build that kept one number instead of one per device lands in. */
export const LEGACY_DEVICE = 'legacy';

/**
 * Per-device counts, cleaned: a device name that is not a name and a count that is not a whole number are refused,
 * a zero is not stored, and anything that is not an object is no counts at all.
 */
export function normaliseUses(input) {
  const source = input && typeof input === 'object' ? input : {};
  const uses = {};
  for (const [device, count] of Object.entries(source)) {
    if (typeof device !== 'string' || device === '') {
      throw fail('INVALID_CLICKS', 'a device count is filed under a device name');
    }
    if (!Number.isInteger(count) || count < 0) {
      throw fail('INVALID_CLICKS', 'a device count is a whole number, zero or more');
    }
    if (count > 0) uses[device] = count;
  }
  return uses;
}

/** Two devices' counts, slot by slot, keeping the larger of each: each slot only ever rises on its own device. */
export function mergeUses(left, right) {
  const merged = { ...normaliseUses(left) };
  for (const [device, count] of Object.entries(normaliseUses(right))) {
    if ((merged[device] ?? 0) < count) merged[device] = count;
  }
  return merged;
}

/** A bookmark's counts, including a number carried by a document written before the slots existed. */
function usesOf(bookmark) {
  const uses = normaliseUses(bookmark?.uses);
  if (Object.keys(uses).length === 0 && Number.isInteger(bookmark?.openCount)) {
    if (bookmark.openCount > 0) uses[LEGACY_DEVICE] = bookmark.openCount;
  }
  return uses;
}

/**
 * Record what one device has seen.
 *
 * The extension's count is that device's running total, so this is a mirror and never an addition: the same total
 * arriving twice leaves the bookmark where it was, and a lower total is ignored. Two devices never write each
 * other's slot, which is what lets a merge add the slots up.
 */
export function recordUses(document, id, deviceId, count, now = Date.now) {
  assertDocument(document, 'the document');
  if (typeof deviceId !== 'string' || deviceId === '') {
    throw fail('INVALID_CLICKS', 'a device count needs a device');
  }
  if (!Number.isInteger(count) || count < 0) {
    throw fail('INVALID_CLICKS', 'a device count is a whole number, zero or more');
  }

  const at = findIndex(document, id);
  const current = document.bookmarks[at];
  const uses = usesOf(current);
  if ((uses[deviceId] ?? 0) >= count) return document;

  const updated = { ...current, uses: { ...uses, [deviceId]: count }, updatedAt: iso(now) };
  const bookmarks = [...document.bookmarks];
  bookmarks[at] = updated;

  const event = activityEvent(
    {
      device: deviceId,
      bookmarkId: id,
      url: current.url,
      cause: 'open',
      before: useCount(current),
      after: useCount(updated),
      slot: { device: deviceId, before: uses[deviceId] ?? 0, after: count }
    },
    now
  );

  return appendActivity({ ...document, bookmarks }, [event], now);
}

/**
 * Record how many times the browser has opened this bookmark, for a document from a build that had one number and
 * no device names. Kept for that caller; nothing in the page uses it.
 */
export function setOpenCount(document, id, count, now = Date.now) {
  return recordUses(document, id, LEGACY_DEVICE, count, now);
}

/** How many times a bookmark has been used: opened from this list, or opened in the browser. */
export function useCount(bookmark) {
  const opened = Object.values(usesOf(bookmark)).reduce((total, count) => total + count, 0);
  const clicks = Number.isInteger(bookmark?.clickCount) ? bookmark.clickCount : 0;
  return clicks + opened;
}

/**
 * How a bookmark's uses divide between this profile and the other ones that share the vault.
 *
 * The device ids are random and name nothing, so the honest split is two-way: what this profile
 * counted, and what every other slot counted. The legacy single number belongs to the device whose
 * build wrote it, which is the one asking, so it counts as "here" and so does the old unnamed slot.
 */
export function useSplit(bookmark, device) {
  const uses = usesOf(bookmark);
  let here = bookmark?.clickCount ?? 0;
  let elsewhere = 0;
  for (const [id, count] of Object.entries(uses)) {
    if (id === device || id === LEGACY_DEVICE) here += count;
    else elsewhere += count;
  }
  return { here, elsewhere, total: here + elsewhere };
}

/* --------------------------------------------------------------- the activity log */

/**
 * One line about one count change.
 *
 * It is stored inside the sealed document, never beside it: `device` names the device that saw
 * the change and `slot` names the device whose count moved where that is known, so a merge can
 * say "another device counted this" without pretending the visit happened here. The two totals
 * are the sum the person reads on the row, before and after.
 *
 * A URL is kept because a line without an address cannot be checked against anything. Nothing
 * in this shape is written anywhere except the vault blob.
 */
function normaliseEvent(input) {
  if (!input || typeof input !== 'object') return null;

  const { id, at, device, bookmarkId, url, cause, before, after } = input;
  if (typeof id !== 'string' || id === '') return null;
  if (!isIso(at)) return null;
  if (typeof device !== 'string' || device === '') return null;
  if (typeof bookmarkId !== 'string' || bookmarkId === '') return null;
  if (typeof url !== 'string') return null;
  if (!ACTIVITY_CAUSE_SET.has(cause)) return null;
  if (!Number.isInteger(before) || before < 0) return null;
  if (!Number.isInteger(after) || after < 0) return null;

  let slot = null;
  if (input.slot && typeof input.slot === 'object') {
    const moved = input.slot;
    if (
      typeof moved.device === 'string' &&
      moved.device !== '' &&
      Number.isInteger(moved.before) &&
      moved.before >= 0 &&
      Number.isInteger(moved.after) &&
      moved.after >= 0
    ) {
      slot = { device: moved.device, before: moved.before, after: moved.after };
    }
  }

  return { id, at, device, bookmarkId, url, cause, before, after, slot };
}

/**
 * The log as the vault holds it: newest first, one entry per id, at most `MAX_ACTIVITY` lines,
 * nothing older than `ACTIVITY_DAYS`, and no larger than the vault's room for it. A vault
 * written before the log existed has no `activity`, which reads as no lines rather than an
 * error.
 */
export function normaliseActivity(input, now = Date.now) {
  if (!Array.isArray(input)) return [];

  const stamp = typeof now === 'function' ? now() : now;
  const cutoff = stamp - ACTIVITY_MS;
  const kept = new Map();
  for (const raw of input) {
    const event = normaliseEvent(raw);
    if (!event) continue;
    if (Date.parse(event.at) < cutoff) continue;

    /* The id is what makes a merge idempotent; when two copies disagree about one id, the later
       observation is the one kept, and equal stamps keep the first seen. */
    const seen = kept.get(event.id);
    if (!seen || event.at > seen.at) kept.set(event.id, event);
  }

  const newest = [...kept.values()].sort(compareActivity).slice(0, MAX_ACTIVITY);

  /* The size bound is applied newest first: an old line falls before a recent one, and the
     newest line is kept even when it is the only one that would exceed the budget. */
  const bounded = [];
  let chars = 0;
  for (const event of newest) {
    const size = JSON.stringify(event).length + 1;
    if (bounded.length > 0 && chars + size > MAX_ACTIVITY_CHARS) break;
    bounded.push(event);
    chars += size;
  }
  return bounded;
}

function compareActivity(left, right) {
  return right.at.localeCompare(left.at) || right.id.localeCompare(left.id);
}

/** The document's size as the sealed envelope will carry it: UTF-8 bytes of its JSON. */
function documentBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

/**
 * Drop the oldest lines until the whole document fits the free hosted copy.
 *
 * The log budget above bounds the log on its own; this bounds it against everything else in the
 * vault. A library already near the cap leaves little room, and a log is the part that can go —
 * bookmarks are never cut. The newest line is kept as long as it fits at all; a document whose
 * bookmarks alone are over the cap is returned with an empty log rather than pretending to fix
 * something the log did not cause.
 */
export function fitActivity(document, { maxBytes = FREE_DOCUMENT_BYTES } = {}) {
  const activity = Array.isArray(document.activity) ? document.activity : [];
  if (activity.length === 0) return document;

  let bytes = documentBytes(document);
  if (bytes <= maxBytes) return document;

  const kept = [...activity];
  while (kept.length > 0 && bytes > maxBytes) {
    /* One event plus the comma that separated it from the next; the oldest is last. */
    bytes -= documentBytes(kept.pop()) + 1;
  }
  return { ...document, activity: kept };
}

/** Build one event for the log, refusing a shape that could not be read back. */
export function activityEvent(input, now = Date.now) {
  const event = normaliseEvent({
    id: input?.id ?? nextId(),
    at: input?.at ?? iso(now),
    device: input?.device ?? UNSETTLED_DEVICE,
    bookmarkId: input?.bookmarkId,
    url: input?.url,
    cause: input?.cause,
    before: input?.before,
    after: input?.after,
    slot: input?.slot ?? null
  });

  if (!event) {
    throw fail(
      'INVALID_ACTIVITY',
      'an activity event needs a device, a bookmark, a URL, a known cause and two totals'
    );
  }
  return event;
}

/** Add lines to the ring, dropping duplicates, anything past the bound and anything past the document's room. */
export function appendActivity(document, events, now = Date.now) {
  assertDocument(document, 'the document');
  const incoming = Array.isArray(events) ? events : [events];
  const activity = normaliseActivity(
    [...incoming, ...(Array.isArray(document.activity) ? document.activity : [])],
    now
  );
  return fitActivity({ ...document, activity });
}

/**
 * Which device's slot moved between two readings of one bookmark, when exactly one did.
 *
 * A merge can raise one device slot, both, or only the list-click number. The first case can
 * name the device; the second cannot, and its event says nothing about a slot rather than
 * guessing. The click number is not filed under a device, so an observer is named when it is
 * the only thing that moved.
 */
export function changedSlot(before, after, observer = UNSETTLED_DEVICE) {
  const beforeUses = before ? usesOf(before) : {};
  const afterUses = after ? usesOf(after) : {};
  const moved = [];

  for (const device of new Set([...Object.keys(beforeUses), ...Object.keys(afterUses)])) {
    const was = beforeUses[device] ?? 0;
    const now = afterUses[device] ?? 0;
    if (now > was) moved.push({ device, before: was, after: now });
  }
  if (moved.length === 1) return moved[0];

  const beforeClicks = Number.isInteger(before?.clickCount) ? before.clickCount : 0;
  const afterClicks = Number.isInteger(after?.clickCount) ? after.clickCount : 0;
  if (moved.length === 0 && afterClicks > beforeClicks) {
    return { device: observer, before: beforeClicks, after: afterClicks };
  }
  return null;
}

/**
 * The deterministic id a merge line is filed under.
 *
 * Random ids would grow the log each time the same remote copy was merged; the same change seen
 * twice must be the same line. The values that make the change are what name it.
 */
function mergeEventId(cause, bookmark, before, after, slot) {
  return `${cause}:${bookmark.id}:${before}:${after}:${bookmark.updatedAt}:${slot?.device ?? '-'}`;
}

/** Change one bookmark. A URL change is re-normalised and re-checked for duplicates. */
export function updateBookmark(document, id, patch, now = Date.now) {
  assertDocument(document, 'the document');
  const at = findIndex(document, id);
  const current = document.bookmarks[at];

  const changes = {};
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!PATCHABLE.has(key)) continue;

    if (key === 'url') {
      const { url, hostname, origin } = normalizeUrl(value);
      const clash = findByUrl(document, url);
      if (clash && clash.id !== id) {
        const error = fail('DUPLICATE', 'that URL is already bookmarked');
        error.existingId = clash.id;
        throw error;
      }
      Object.assign(changes, { url, hostname, origin });
      continue;
    }

    if (key === 'name') {
      const name = typeof value === 'string' ? value.trim() : '';
      if (name.length > MAX_NAME_LENGTH) {
        throw fail('INVALID_NAME', `a name is at most ${MAX_NAME_LENGTH} characters`);
      }
      changes.name = name;
      continue;
    }

    if (key === 'clickCount') {
      if (!Number.isInteger(value) || value < 0) {
        throw fail('INVALID_CLICKS', 'a click count is a whole number, zero or more');
      }
      /* The edit sheet is drawn from a reading. A merge that raised the count while it was open,
         or a number typed by hand, must not write a lower total back into the vault: the count
         only moves up, exactly like a device slot. */
      const currentClicks = Number.isInteger(current.clickCount) ? current.clickCount : 0;
      changes.clickCount = Math.max(currentClicks, value);
      continue;
    }

    if (key === 'pinned' || key === 'hideLabel') {
      changes[key] = Boolean(value);
      continue;
    }

    if (key === 'icon') {
      if (value !== null && typeof value !== 'string') {
        throw fail('INVALID_ICON', 'an icon is a data URI or null');
      }
      changes.icon = value;
      continue;
    }

    if (key === 'color') {
      if (value !== null && !/^#[0-9a-f]{6}$/i.test(value)) {
        throw fail('INVALID_COLOR', 'a colour is #rrggbb or null');
      }
      changes.color = value;
    }
  }

  if (Object.keys(changes).length === 0) return document;

  const updated = { ...current, ...changes, updatedAt: iso(now) };
  const bookmarks = [...document.bookmarks];
  bookmarks[at] = updated;
  return { ...document, bookmarks };
}

/** Remove one bookmark and leave a tombstone, so the removal reaches the other device. */
export function deleteBookmark(document, id, now = Date.now) {
  assertDocument(document, 'the document');
  findIndex(document, id);

  const deletedAt = iso(now);
  const tombstones = [
    ...document.tombstones.filter((tombstone) => tombstone.id !== id),
    { id, deletedAt }
  ];

  return {
    ...document,
    bookmarks: document.bookmarks.filter((bookmark) => bookmark.id !== id),
    tombstones
  };
}

/** One click: the count and the moment are what the ordering uses. */
export function recordClick(document, id, now = Date.now, { device = UNSETTLED_DEVICE } = {}) {
  assertDocument(document, 'the document');
  const at = findIndex(document, id);
  const current = document.bookmarks[at];
  const clickedAt = iso(now);
  const beforeClicks = Number.isInteger(current.clickCount) ? current.clickCount : 0;

  const updated = {
    ...current,
    clickCount: beforeClicks + 1,
    lastClickedAt: clickedAt,
    updatedAt: clickedAt
  };

  const event = activityEvent(
    {
      device,
      bookmarkId: id,
      url: current.url,
      cause: 'click',
      before: useCount(current),
      after: useCount(updated),
      slot: { device, before: beforeClicks, after: beforeClicks + 1 }
    },
    now
  );

  const bookmarks = [...document.bookmarks];
  bookmarks[at] = updated;
  return appendActivity({ ...document, bookmarks }, [event], now);
}

export function togglePin(document, id, now = Date.now) {
  assertDocument(document, 'the document');
  const at = findIndex(document, id);
  const bookmarks = [...document.bookmarks];
  bookmarks[at] = {
    ...bookmarks[at],
    pinned: !bookmarks[at].pinned,
    updatedAt: iso(now)
  };
  return { ...document, bookmarks };
}

/** Case-insensitive substring over the name, the host and the full URL. */
export function filterBookmarks(document, query) {
  assertDocument(document, 'the document');
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  if (needle === '') return [...document.bookmarks];

  return document.bookmarks.filter((bookmark) =>
    `${bookmark.name}\n${bookmark.search ?? ''}\n${bookmark.hostname}\n${bookmark.url}`
      .toLowerCase()
      .includes(needle)
  );
}

/**
 * Whether a query is narrowing the list.
 *
 * An empty query, and a query every bookmark matches, both leave the list as it was: opening a
 * bookmark from either of them changes nothing, so there is nothing to clear afterwards.
 */
export function searchNarrowsList(document, query) {
  assertDocument(document, 'the document');
  const needle = typeof query === 'string' ? query.trim() : '';
  if (needle === '') return false;
  return filterBookmarks(document, query).length < document.bookmarks.length;
}

/**
 * A sorted copy. Pinned bookmarks come first in every mode except `name`, where an alphabet the
 * user is reading should not jump around.
 */
export function sortBookmarks(document, mode = 'clicks') {
  assertDocument(document, 'the document');
  if (!SORTS.has(mode)) throw fail('INVALID_SORT', `"${mode}" is not a sort mode`);

  const order = {
    clicks: (left, right) =>
      useCount(right) - useCount(left) || compareNames(left, right),
    recent: (left, right) => right.createdAt.localeCompare(left.createdAt),
    name: (left, right) => compareNames(left, right),
    lastClicked: (left, right) =>
      (right.lastClickedAt ?? '').localeCompare(left.lastClickedAt ?? '') ||
      compareNames(left, right)
  }[mode];

  return [...document.bookmarks].sort((left, right) => {
    if (mode !== 'name' && left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return order(left, right);
  });
}

function compareNames(left, right) {
  const leftName = left.name || left.hostname;
  const rightName = right.name || right.hostname;
  return leftName.localeCompare(rightName, undefined, { sensitivity: 'base' });
}

function isExpired(tombstone, now) {
  const deletedAt = Date.parse(tombstone.deletedAt);
  return Number.isNaN(deletedAt) || now() - deletedAt > TOMBSTONE_MS;
}

/**
 * Converge two documents.
 *
 * The fields of a bookmark come from whichever side edited it last; the click count and the
 * last click are merged by value, because a click is an event that either happened or did not.
 * A tombstone removes a record unless the record was edited strictly after the deletion, which
 * is how an intentional re-add survives a delete that reached the other device first.
 *
 * @returns {{document: object, statistics: {added: number, updated: number, removed: number}}}
 */
export function mergeDocuments(local, remote, now = Date.now, options = {}) {
  assertDocument(local, 'the local document');
  assertDocument(remote, 'the remote document');

  const device = options.device ?? UNSETTLED_DEVICE;
  const cause = options.cause ?? 'merge';
  if (!ACTIVITY_CAUSE_SET.has(cause)) {
    throw fail('INVALID_ACTIVITY', `"${cause}" is not a reason a count can change`);
  }

  const localById = new Map(local.bookmarks.map((bookmark) => [bookmark.id, bookmark]));
  const remoteById = new Map(remote.bookmarks.map((bookmark) => [bookmark.id, bookmark]));

  const tombstones = new Map();
  for (const tombstone of [...local.tombstones, ...remote.tombstones]) {
    const seen = tombstones.get(tombstone.id);
    if (!seen || tombstone.deletedAt > seen.deletedAt) tombstones.set(tombstone.id, tombstone);
  }

  const ids = new Set([...localById.keys(), ...remoteById.keys(), ...tombstones.keys()]);
  const bookmarks = [];
  const keptTombstones = [];
  const statistics = { added: 0, updated: 0, removed: 0 };

  for (const id of ids) {
    const left = localById.get(id);
    const right = remoteById.get(id);
    const tombstone = tombstones.get(id);

    const merged = left && right ? mergeOne(left, right) : (left ?? right);

    if (!merged) {
      if (tombstone && !isExpired(tombstone, now)) keptTombstones.push(tombstone);
      continue;
    }

    const deletedAfterEdit = tombstone && tombstone.deletedAt >= merged.updatedAt;
    if (deletedAfterEdit) {
      if (left) statistics.removed += 1;
      if (!isExpired(tombstone, now)) keptTombstones.push(tombstone);
      continue;
    }

    bookmarks.push(merged);
    if (!left) statistics.added += 1;
    else if (right && merged.updatedAt !== left.updatedAt) statistics.updated += 1;
  }

  /* A merge that raised a total leaves one line per bookmark whose total moved. A merge that
     changed only a name, a colour or a click's moment leaves none: the log is about counts. */
  const events = [];
  for (const merged of bookmarks) {
    const before = localById.get(merged.id);
    const was = before ? useCount(before) : 0;
    const is = useCount(merged);
    if (is <= was) continue;

    const slot = changedSlot(before ?? null, merged, device);
    events.push(
      activityEvent(
        {
          id: mergeEventId(cause, merged, was, is, slot),
          device,
          bookmarkId: merged.id,
          url: merged.url,
          cause,
          before: was,
          after: is,
          slot
        },
        now
      )
    );
  }

  return {
    document: fitActivity({
      schema: SCHEMA,
      bookmarks,
      tombstones: keptTombstones,
      activity: normaliseActivity(
        [...events, ...(local.activity ?? []), ...(remote.activity ?? [])],
        now
      ),
      prefs: newerPrefs(local.prefs, remote.prefs)
    }),
    statistics
  };
}

function mergeOne(left, right) {
  return mergeBookmark(left, right);
}

/**
 * The whole preferences object from whichever side wrote it last.
 *
 * Preferences are changed on one settings screen and stored together, so the object moves as a
 * unit rather than field by field: a device that changed the sort also set the view it was
 * showing at the same moment, and mixing two devices' fields would produce a state neither of
 * them had.
 * `updatedAt` is the stamp the page writes on every change. A vault written before the stamp
 * existed carries none and loses to a stamped copy; with no stamp on either side the local
 * object is kept, so an older device can still open and sync.
 */
export function newerPrefs(local, remote) {
  const left = local ?? {};
  const right = remote ?? {};
  const leftAt = prefStamp(left);
  const rightAt = prefStamp(right);

  if (rightAt === null) return { ...left };
  if (leftAt === null) return { ...right };

  /* The newer copy wins on every key it carries, and the older one fills the keys it does not. Replacing the whole
     object lost settings whenever the newer copy had never carried them — a build that predates a preference, or an
     import with none — and the loss is silent: the collection settings live here, so losing them switches collection
     off without a word. */
  const newer = rightAt > leftAt ? right : left;
  const older = newer === right ? left : right;
  return { ...older, ...newer };
}

function prefStamp(prefs) {
  const stamp = prefs.updatedAt;
  return typeof stamp === 'number' && Number.isFinite(stamp) ? stamp : null;
}

/**
 * The field rules for one bookmark seen on both sides. Exported because an import needs the
 * same rules: an import must not be able to produce a state two synced devices could not.
 */
export function mergeBookmark(left, right) {
  const newer = left.updatedAt >= right.updatedAt ? left : right;
  return {
    ...newer,
    createdAt: earlier(left.createdAt, right.createdAt),
    updatedAt: later(left.updatedAt, right.updatedAt),
    clickCount: Math.max(left.clickCount, right.clickCount),
    /* Each device counts its own browser's opens in its own slot, so a merge takes the larger number inside each
       slot and keeps both slots: the total is their sum. Adding the totals of two devices would grow the count
       every time the same merge ran; adding the slots is what the slots are for. */
    uses: mergeUses(usesOf(left), usesOf(right)),
    lastClickedAt: later(left.lastClickedAt, right.lastClickedAt)
  };
}
