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
/* A device offline for longer than this can resurrect a bookmark. Six months is the trade
   against a tombstone list that grows forever. */
export const TOMBSTONE_DAYS = 180;

const TOMBSTONE_MS = TOMBSTONE_DAYS * 24 * 60 * 60 * 1000;
const SORTS = new Set(['clicks', 'recent', 'name', 'lastClicked']);
const PATCHABLE = new Set(['name', 'url', 'clickCount', 'pinned', 'hideLabel', 'icon', 'color']);

function fail(code, message) {
  const error = new Error(`bookmarks: ${message}`);
  error.code = code;
  return error;
}

function iso(now) {
  return new Date(now()).toISOString();
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
      changes.clickCount = value;
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
export function recordClick(document, id, now = Date.now) {
  assertDocument(document, 'the document');
  const at = findIndex(document, id);
  const clickedAt = iso(now);

  const bookmarks = [...document.bookmarks];
  bookmarks[at] = {
    ...bookmarks[at],
    clickCount: bookmarks[at].clickCount + 1,
    lastClickedAt: clickedAt,
    updatedAt: clickedAt
  };
  return { ...document, bookmarks };
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
 * A sorted copy. Pinned bookmarks come first in every mode except `name`, where an alphabet the
 * user is reading should not jump around.
 */
export function sortBookmarks(document, mode = 'clicks') {
  assertDocument(document, 'the document');
  if (!SORTS.has(mode)) throw fail('INVALID_SORT', `"${mode}" is not a sort mode`);

  const order = {
    clicks: (left, right) =>
      right.clickCount - left.clickCount || compareNames(left, right),
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
export function mergeDocuments(local, remote, now = Date.now) {
  assertDocument(local, 'the local document');
  assertDocument(remote, 'the remote document');

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

  return {
    document: {
      schema: SCHEMA,
      bookmarks,
      tombstones: keptTombstones,
      prefs: newerPrefs(local.prefs, remote.prefs)
    },
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
  return { ...(rightAt > leftAt ? right : left) };
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
    lastClickedAt: later(left.lastClickedAt, right.lastClickedAt)
  };
}
