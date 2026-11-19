/**
 * Bookmarks — getting a library in, and getting it out again.
 *
 * Three shapes are accepted on the way in, because three already exist in the wild: the retired
 * Python app's `sites.json` array, this app's own plain export, and a browser's
 * "bookmarks.html". Two shapes go out: the same plain array (so the file stays portable and the
 * old tool could still read it) and a sealed envelope for backup.
 *
 * An import is never all-or-nothing. One malformed URL in a 194-entry file must not cost the
 * other 193, so each entry is attempted separately and the count of what was skipped comes back
 * with the result.
 */

import {
  MAX_BOOKMARKS,
  SCHEMA,
  TOMBSTONE_DAYS,
  activityEvent,
  addBookmark,
  appendActivity,
  changedSlot,
  createDocument,
  fitActivity,
  mergeBookmark,
  mergeCollectedIcons,
  mergeIconTries,
  normaliseActivity,
  normaliseUses,
  normalizeUrl,
  useCount
} from './bookmarks.js';

export const PLAIN_FORMAT = 'bookmarks-plain/1';
export const SEALED_FORMAT = 'bookmarks-sealed/1';

/* An import is a file a person chose, not a stream: the whole text has to be in memory anyway,
   so it is refused before it is parsed or scanned. Eight mebibytes is far beyond a real bookmark
   file (the vault holds at most 500 records) and small enough that a hostile one cannot freeze
   the tab. A JavaScript string's length counts UTF-16 units, each at least one byte in UTF-8, so
   the character check is never looser than the byte check the caller makes before reading. */
export const MAX_IMPORT_BYTES = 8 * 1024 * 1024;
/* An icon in a file is a data URI, and this is the same ceiling the page applies before it keeps
   one it fetched: a file must not smuggle a megabyte of base64 into every record it names. */
const MAX_ICON_CHARS = 64 * 1024;
/* Stated here so a test can name the boundary before the reader is. */
export const MAX_IMPORT_SKEW_MS = 10 * 60 * 1000;

const COLOR = /^#[0-9a-f]{6}$/i;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" };
const TOMBSTONE_MS = TOMBSTONE_DAYS * 24 * 60 * 60 * 1000;

function fail(code, message) {
  const error = new Error(`bookmarks: ${message}`);
  error.code = code;
  return error;
}

/**
 * The one place a file's text becomes a value, so its length is refused once and before
 * `JSON.parse` spends the tab's time on syntax it was never going to accept.
 */
function importText(text) {
  if (text.length > MAX_IMPORT_BYTES) {
    throw fail('INVALID_IMPORT', 'that file is too large to import');
  }
  try {
    return JSON.parse(text);
  } catch {
    throw fail('INVALID_IMPORT', 'that file is not JSON');
  }
}

function decodeEntities(text) {
  return text.replace(/&(#?\w+);/g, (whole, name) => ENTITIES[name] ?? whole);
}

/**
 * Where a stamp from a file lands, in milliseconds.
 *
 * `at` is when the file arrived. A stamp more than `MAX_IMPORT_SKEW_MS` past it is a mistake
 * rather than a time — a file from a device whose clock is wrong, or one written to make a
 * record outrank every later edit — and is read as the arrival itself. A stamp a little ahead
 * is believed, because another device's clock really can be a little fast.
 */
function importedMillis(value, at, fallback) {
  const parsed =
    typeof value === 'number' && Number.isFinite(value)
      ? value
      : typeof value === 'string'
        ? Date.parse(value)
        : Number.NaN;
  if (Number.isNaN(parsed)) return fallback;
  return parsed > at + MAX_IMPORT_SKEW_MS ? at : parsed;
}

function legacyName(entry) {
  return typeof entry?.name === 'string' ? entry.name.trim() : '';
}

/**
 * The retired app's `actual_name` was a real site title it deliberately did not display: those
 * pills were icon-only. It is kept as a hidden search term instead of becoming a label.
 */
function legacySearch(entry) {
  if (typeof entry?.search === 'string' && entry.search.trim() !== '') return entry.search.trim();
  return typeof entry?.actual_name === 'string' ? entry.actual_name.trim() : '';
}

function legacyClicks(entry) {
  /* A file from this app spells the field `clickCount`; the retired app spelled it `click_count`.
     Reading only one of them turned an exported seven into an imported zero. */
  const value = entry?.click_count ?? entry?.clickCount;
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function legacyColor(entry) {
  /* The same split as the count above: a file from this app spells it `color`, the retired app
     spelled it `button_color`, and reading one name lost the colour written under the other. */
  const value = entry?.color ?? entry?.button_color;
  return typeof value === 'string' && COLOR.test(value) ? value : null;
}

/**
 * The icon a file carries, kept only as a data URI of a sane size.
 *
 * The retired app's icons were addresses on someone else's server, and those are deliberately
 * dropped: an icon that named a third party would make this page announce every bookmark in the
 * file to that host, which is the opposite of storing them here. Anything that is not an image
 * already in the file is fetched later, from the same endpoint every other icon comes from.
 */
function legacyIcon(entry) {
  const value = entry?.icon;
  if (typeof value !== 'string' || !value.startsWith('data:image/')) return null;
  return value.length <= MAX_ICON_CHARS ? value : null;
}

/**
 * The id a file gives its record, when this import can keep it.
 *
 * A restore is only a restore if identity crosses too: the file's tombstones and its log name
 * records by id, so minting fresh ones on the way in leaves both of them pointing at nothing. A
 * file that repeats an id, or names one that is not a name, gets a new id for the later record.
 */
function keptId(value, used) {
  if (typeof value !== 'string' || value === '') return undefined;
  return used.has(value) ? undefined : value;
}

/** The view a file was exported from, or null when it carries none this app can read. */
function legacyPrefs(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return { ...value };
}

/**
 * The deletions a file carries, so a restored vault does not bring them back.
 *
 * A tombstone is only worth keeping while it can still outrank a record: one past the tombstone
 * window is dropped exactly as a merge would drop it, and one whose deleted record the same file
 * also carries is dropped too — the record being there is the later word.
 */
function legacyTombstones(value, stamp) {
  if (!Array.isArray(value)) return [];
  const cutoff = stamp - TOMBSTONE_MS;
  const kept = [];

  for (const tombstone of value) {
    if (!tombstone || typeof tombstone !== 'object') continue;
    const { id, deletedAt } = tombstone;
    const at = typeof deletedAt === 'string' ? Date.parse(deletedAt) : Number.NaN;
    if (typeof id !== 'string' || id === '' || Number.isNaN(at) || at < cutoff) continue;
    kept.push({ id, deletedAt: new Date(at).toISOString() });
  }
  return kept;
}

/**
 * Add one imported record to a working document, keeping the source's dates rather than now's.
 *
 * `addBookmark` does the validation, the duplicate check and the limit, and then the record is
 * replaced with the same one carrying the original timestamps. Reusing that path is what keeps
 * an import from accepting something an add would refuse.
 *
 * A file that came from this app carries the per-device slots, so they cross with the record:
 * an import that kept only `clickCount` would look like a count that fell, especially on a
 * device that had no other copy. A file with counts leaves one line each, in the same sealed
 * document, because a count arrived here from outside the vault.
 */
function addImported(document, entry, now, { device, cause, id }) {
  const at = typeof now === 'function' ? now() : now;
  const createdMs = importedMillis(entry.createdAt, at, at);
  const updatedMs = importedMillis(entry.updatedAt, at, createdMs);
  const clickedMs = importedMillis(entry.lastClickedAt, at, null);

  const { document: added, bookmark } = addBookmark(
    document,
    {
      url: entry.url,
      name: entry.name,
      search: entry.search,
      clickCount: entry.clickCount,
      color: entry.color,
      pinned: entry.pinned,
      icon: entry.icon,
      hideLabel: entry.hideLabel,
      uses: entry.uses,
      openCount: entry.openCount
    },
    () => createdMs
  );

  const record = {
    ...bookmark,
    id: id ?? bookmark.id,
    /* A record cannot be created after it was last edited; a file that says so is read with the
       later of the two dates as the earlier one. */
    createdAt: new Date(Math.min(createdMs, updatedMs)).toISOString(),
    updatedAt: new Date(updatedMs).toISOString(),
    lastClickedAt: clickedMs === null ? null : new Date(clickedMs).toISOString()
  };

  const bookmarks = [...added.bookmarks];
  bookmarks[bookmarks.length - 1] = record;
  let next = { ...added, bookmarks };

  if (useCount(record) > 0) {
    next = appendActivity(
      next,
      [
        activityEvent(
          {
            device,
            bookmarkId: record.id,
            url: record.url,
            cause,
            before: 0,
            after: useCount(record),
            slot: importedSlot(record)
          },
          now
        )
      ],
      now
    );
  }

  return { document: next, bookmark: record };
}

/** The one device slot a freshly imported record carries, when it carries exactly one. */
function importedSlot(record) {
  const uses = normaliseUses(record.uses);
  const devices = Object.keys(uses);
  if (devices.length !== 1) return null;
  return { device: devices[0], before: 0, after: uses[devices[0]] };
}

/**
 * Turn a payload into a document.
 *
 * Accepts an array (the old `sites.json`), a plain export wrapper around a document, or a
 * document that was exported without the wrapper. One envelope is the whole allowance: a
 * wrapper that holds another wrapper is refused, because a file can nest envelopes as deep as
 * its writer wants and following them to the bottom spends the tab's stack on a shape no
 * exporter here produces.
 *
 * @returns {{document: object, statistics: {imported: number, skipped: number, duplicates: number}}}
 */
export function importPlain(payload, now = Date.now, options = {}) {
  const settings = { device: options.device ?? 'unsettled', cause: options.cause ?? 'import' };
  let carried = [];
  let prefs = null;
  let tombstones = [];

  let body = typeof payload === 'string' ? importText(payload) : payload;

  if (body?.format === PLAIN_FORMAT) {
    body = typeof body.document === 'string' ? importText(body.document) : body.document;
    if (body?.format === PLAIN_FORMAT) {
      throw fail('INVALID_IMPORT', 'that file is wrapped more than once');
    }
  }

  let entries;
  if (Array.isArray(body)) {
    entries = body;
  } else if (body?.schema === SCHEMA) {
    entries = body.bookmarks;
    /* An export made by this app carries its own log. It is kept only for the bookmarks this
       file really imports, so a line cannot outlive the record it describes. */
    carried = normaliseActivity(body.activity, now);
    /* The rest of the document crosses too: the deletions it holds, and the view it was taken
       from. A restore that dropped them brought deleted bookmarks back on the next merge and
       opened on a list the person had already arranged. */
    prefs = legacyPrefs(body.prefs);
    tombstones = legacyTombstones(body.tombstones, now());
  } else {
    throw fail('INVALID_IMPORT', 'that file is not a bookmark export');
  }

  if (!Array.isArray(entries)) {
    throw fail('INVALID_IMPORT', 'that file carries no bookmark list');
  }

  /* `duplicates` counts entries the file repeats (the same URL twice after normalisation);
     `repeats` names them, so the importer can say which line is the offender instead of only
     how many. A clash with the vault's own bookmarks is not this file's business. */
  const statistics = { imported: 0, skipped: 0, duplicates: 0, repeats: [] };
  let document = createDocument();
  /* The ids in a file are kept where this import can: a record's identity is what the file's
     tombstones and its log name, so a fresh id would leave both pointing at nothing. */
  const remappedIds = new Map();
  const usedIds = new Set();

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      statistics.skipped += 1;
      continue;
    }

    try {
      const result = addImported(document, legacyEntry(entry), now, {
        ...settings,
        id: keptId(entry.id, usedIds)
      });
      usedIds.add(result.bookmark.id);
      document = result.document;
      if (typeof entry.id === 'string' && entry.id !== '') {
        remappedIds.set(entry.id, result.bookmark.id);
      }
      statistics.imported += 1;
    } catch (error) {
      if (error.code === 'DUPLICATE') {
        statistics.duplicates += 1;
        statistics.repeats.push({
          url: typeof entry.url === 'string' ? entry.url.trim() : '',
          name: legacyName(entry)
        });
      } else {
        statistics.skipped += 1;
      }
    }
  }

  const carriedIds = new Set(remappedIds.keys());
  const present = new Set(document.bookmarks.map((bookmark) => bookmark.id));
  document = fitActivity({
    ...document,
    /* A tombstone that names a record this file also carries is dropped: the record being here
       is the later word, and no file gets to delete what it brings. */
    tombstones: tombstones.filter((tombstone) => !present.has(tombstone.id)),
    prefs: prefs ?? document.prefs,
    activity: normaliseActivity(
      [
        ...(document.activity ?? []),
        ...carried
          .filter((event) => carriedIds.has(event.bookmarkId))
          .map((event) => ({ ...event, bookmarkId: remappedIds.get(event.bookmarkId) }))
      ],
      now
    )
  });

  return { document, statistics };
}

function legacyEntry(entry) {
  const name = legacyName(entry);

  /* The retired app had two ways to be icon-only: an explicit `is_familiar`, and simply having
     no label. A document that already carries `hideLabel` keeps exactly what it says, so a
     round-trip does not quietly change how a bookmark looks. */
  const hideLabel =
    typeof entry.hideLabel === 'boolean'
      ? entry.hideLabel
      : Boolean(entry.hide_label) || Boolean(entry.is_familiar) || name === '';

  return {
    id: entry.id,
    url: entry.url,
    name,
    search: legacySearch(entry),
    clickCount: legacyClicks(entry),
    color: legacyColor(entry),
    pinned: entry.pinned === true,
    icon: legacyIcon(entry),
    hideLabel,
    /* Present only in a file this app exported; older shapes have neither. Both are validated
       by `addBookmark`, so a malformed slot is skipped like any other malformed record. */
    uses: entry.uses,
    openCount: entry.openCount,
    lastClickedAt: entry.lastClickedAt,
    createdAt: entry.created_date ?? entry.createdAt,
    updatedAt: entry.last_updated ?? entry.updatedAt
  };
}

/**
 * Merge an imported document into the one already on this device.
 *
 * Matching is by URL, not by id: an import has never seen this device's ids. The field rules are
 * the same ones two synced devices use, so an import cannot produce a state sync would not.
 *
 * A count that arrives from the file is a change and leaves a line. The bookmarks the file adds
 * keep the import line they were already given; a record whose URL is already here is merged
 * under the local id, so the file's own line for that record is dropped rather than left
 * pointing at an id this vault does not hold.
 */
export function mergeInto(existing, incoming, now = Date.now, options = {}) {
  const device = options.device ?? 'unsettled';
  const cause = options.cause ?? 'import';
  const byUrl = new Map(existing.bookmarks.map((bookmark) => [bookmark.url, bookmark]));
  const bookmarks = [...existing.bookmarks];
  const statistics = { added: 0, updated: 0, skipped: 0 };
  const addedIds = new Set();
  const events = [];

  for (const record of incoming.bookmarks) {
    const current = byUrl.get(record.url);

    if (current) {
      const at = bookmarks.findIndex((bookmark) => bookmark.id === current.id);
      /* Matching is by URL, so the record this vault already holds keeps its id (and the URL it
         was found under). Taking the file's id would leave every line already filed under the
         local id pointing at a record that no longer exists. */
      const merged = {
        ...mergeBookmark(current, record),
        id: current.id,
        url: current.url,
        hostname: current.hostname,
        origin: current.origin
      };
      bookmarks[at] = merged;

      const before = useCount(current);
      const after = useCount(merged);
      if (after > before) {
        events.push(
          activityEvent(
            {
              device,
              bookmarkId: merged.id,
              url: merged.url,
              cause,
              before,
              after,
              slot: changedSlot(current, merged, device)
            },
            now
          )
        );
      }
      statistics.updated += 1;
      continue;
    }

    if (bookmarks.length >= MAX_BOOKMARKS) {
      statistics.skipped += 1;
      continue;
    }
    bookmarks.push(record);
    byUrl.set(record.url, record);
    addedIds.add(record.id);
    statistics.added += 1;
  }

  const carried = normaliseActivity(incoming.activity, now).filter((event) =>
    addedIds.has(event.bookmarkId)
  );

  /* A record added from a file that carried no log still arrived with a count; it gets the line
     the import would have written. */
  for (const record of bookmarks) {
    if (!addedIds.has(record.id) || useCount(record) === 0) continue;
    if (carried.some((event) => event.bookmarkId === record.id)) continue;
    events.push(
      activityEvent(
        {
          device,
          bookmarkId: record.id,
          url: record.url,
          cause,
          before: 0,
          after: useCount(record),
          slot: importedSlot(record)
        },
        now
      )
    );
  }

  /* `...existing` carries the local icon maps over as they are; a file that travelled from another
     device may carry its own, and a merge unions the two rather than dropping either. */
  const iconTries = mergeIconTries(existing, incoming);
  const collectedIcons = mergeCollectedIcons(existing, incoming);

  return {
    document: fitActivity({
      ...existing,
      bookmarks,
      activity: normaliseActivity(
        [...events, ...carried, ...(Array.isArray(existing.activity) ? existing.activity : [])],
        now
      ),
      ...(Object.keys(iconTries).length > 0 ? { iconTries } : {}),
      ...(Object.keys(collectedIcons).length > 0 ? { collectedIcons } : {})
    }),
    statistics
  };
}

/**
 * A whole document read through the one URL rule.
 *
 * A document does not always arrive through the add form: a sealed backup, a copy from another
 * device and a merged import all reach the list without ever being typed. A record whose URL
 * `normalizeUrl` would refuse is not a bookmark, so it is dropped here and counted, the way the
 * importer already drops a malformed entry instead of losing the rest of the file.
 *
 * The input is left alone; the document and each kept record come back as new objects, with the
 * URL, hostname and origin taken from `normalizeUrl` so a file cannot keep the three disagreeing.
 *
 * @returns {{document: object, dropped: number}}
 */
export function sanitizeDocument(document) {
  /* A shape this function cannot read is handed back as it came rather than turned into an empty
     document: the callers already refuse a document with no list, and dropping every field here
     would turn one bad record into a lost vault. */
  if (!document || typeof document !== 'object' || !Array.isArray(document.bookmarks)) {
    return { document, dropped: 0 };
  }

  const bookmarks = [];
  let dropped = 0;

  for (const entry of document.bookmarks) {
    try {
      const { url, hostname, origin } = normalizeUrl(entry?.url);
      bookmarks.push({ ...entry, url, hostname, origin });
    } catch {
      dropped += 1;
    }
  }

  return { document: { ...document, bookmarks }, dropped };
}

/**
 * The address a row may point at, or `null` when the URL rule refuses it.
 *
 * The renderer's last line of defence: a row is drawn from a record, not from a form, so it
 * cannot assume the record was checked on the way in. A refused URL still gets a row — the
 * bookmark is visible and deletable — but the row carries no live link.
 *
 * @returns {string | null}
 */
export function linkHref(input) {
  try {
    return normalizeUrl(input).url;
  } catch {
    return null;
  }
}

/**
 * Every anchor in a browser export, scanned once from left to right.
 *
 * The expression this replaced had to rescan the tail from every `<a` that never closed, so a
 * file could take seconds to refuse. This walks forward by index instead. An anchor with no
 * closing tag ends the scan, because everything after it would be part of its text.
 */
function anchors(html) {
  const lower = html.toLowerCase();
  const found = [];
  let at = 0;

  while ((at = lower.indexOf('<a', at)) !== -1) {
    const after = lower[at + 2];
    if (after === undefined || !/\s/.test(after)) {
      at += 2;
      continue;
    }

    const tagEnd = lower.indexOf('>', at + 2);
    if (tagEnd === -1) break;

    const tag = html.slice(at, tagEnd + 1);
    const href = tag.match(/\shref\s*=\s*"([^"]*)"/i);
    if (!href) {
      at = tagEnd + 1;
      continue;
    }

    const close = lower.indexOf('</a>', tagEnd + 1);
    if (close === -1) break;

    found.push({ href: href[1], tag, text: html.slice(tagEnd + 1, close) });
    at = close + 4;
  }

  return found;
}

/**
 * Read a browser's "bookmarks.html".
 *
 * Only the anchors matter. Folders are structure the vault does not model, and a bookmarklet
 * (`javascript:`) or a places query (`place:`) is not a page anyone can open from here.
 */
export function importBrowserBookmarks(html, now = Date.now, options = {}) {
  if (typeof html !== 'string' || html.trim() === '') {
    throw fail('INVALID_IMPORT', 'that file is empty');
  }
  if (html.length > MAX_IMPORT_BYTES) {
    throw fail('INVALID_IMPORT', 'that file is too large to import');
  }

  const entries = [];
  for (const { href, tag, text } of anchors(html)) {
    const url = decodeEntities(href.trim());
    if (!/^https?:\/\//i.test(url)) continue;

    const addDate = tag.match(/add_date\s*=\s*"(\d+)"/i);
    /* Anchor text may hold nested tags, and one pass can leave a tag behind (`<<a>>` -> `<a>`); strip until the
       string stops changing, then decode what is left. */
    let name = text;
    for (let previous = null; previous !== name;) {
      previous = name;
      name = name.replace(/<[^>]*>/g, '');
    }
    entries.push({
      url,
      name: decodeEntities(name).trim(),
      created_date: addDate ? Number(addDate[1]) * 1000 : undefined
    });
  }

  return importPlain(entries, now, { ...options, cause: options.cause ?? 'history-import' });
}

/** The portable plain export: the document, unchanged, in a named envelope. */
export function exportPlain(document, now = Date.now) {
  return {
    format: PLAIN_FORMAT,
    exported_at: new Date(now()).toISOString(),
    document
  };
}

/** A bookmark file any browser can import. */
export function exportBrowserBookmarks(document) {
  const lines = [
    '<!DOCTYPE NETSCAPE-Bookmark-file-1>',
    '<META HTTP-EQUIV="Content-Type" CONTENT="text/html; charset=UTF-8">',
    '<TITLE>Bookmarks</TITLE>',
    '<H1>Bookmarks</H1>',
    '<DL><p>'
  ];

  /* The file is the one thing another browser trusts without asking, so the same rule runs here
     even when the caller hands over a document that never met a loader. */
  for (const bookmark of [...sanitizeDocument(document).document.bookmarks].sort((left, right) =>
    (left.name || left.hostname).localeCompare(right.name || right.hostname)
  )) {
    const name = (bookmark.name || bookmark.hostname)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
    const href = bookmark.url.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    const added = Math.floor(Date.parse(bookmark.createdAt) / 1000) || 0;
    lines.push(`    <DT><A HREF="${href}" ADD_DATE="${added}">${name}</A>`);
  }

  lines.push('</DL><p>', '');
  return lines.join('\n');
}

/**
 * The backup envelope. It carries the sealed vault and nothing else: no account id, no
 * timestamps of use, and nothing that would let the file be read without the phrase.
 *
 * `at` is the version the vault was sealed at. It is part of the associated data, so a backup
 * that dropped it could not be opened again; it names a counter, not a person or a device.
 */
export function exportSealed(sealed, now = Date.now) {
  if (!sealed || typeof sealed.iv !== 'string' || typeof sealed.ct !== 'string') {
    throw fail('INVALID_VAULT', 'there is no sealed vault to export');
  }
  const vault = { iv: sealed.iv, ct: sealed.ct };
  if (Number.isInteger(sealed.at)) vault.at = sealed.at;
  return {
    format: SEALED_FORMAT,
    exported_at: new Date(now()).toISOString(),
    vault
  };
}

/** Read a backup envelope, or throw. The caller still has to open it with the phrase. */
export function parseSealed(payload) {
  if (typeof payload === 'string') {
    try {
      return parseSealed(JSON.parse(payload));
    } catch {
      throw fail('INVALID_VAULT', 'that backup is not JSON');
    }
  }
  if (payload?.format !== SEALED_FORMAT) {
    throw fail('INVALID_VAULT', 'that file is not a sealed backup');
  }
  const vault = payload.vault;
  if (!vault || typeof vault.iv !== 'string' || typeof vault.ct !== 'string') {
    throw fail('INVALID_VAULT', 'that backup carries no sealed vault');
  }
  /* A backup written before the version was bound carries no `at`; it opens with the old
     associated data. */
  const sealed = { iv: vault.iv, ct: vault.ct };
  if (Number.isInteger(vault.at)) sealed.at = vault.at;
  return sealed;
}

/** Re-exported so a caller does not need to reach into the model for the one URL rule. */
export { normalizeUrl };
