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
  addBookmark,
  createDocument,
  mergeBookmark,
  normalizeUrl
} from './bookmarks.js';

export const PLAIN_FORMAT = 'bookmarks-plain/1';
export const SEALED_FORMAT = 'bookmarks-sealed/1';

const COLOR = /^#[0-9a-f]{6}$/i;
const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", apos: "'" };

function fail(code, message) {
  const error = new Error(`bookmarks: ${message}`);
  error.code = code;
  return error;
}

function decodeEntities(text) {
  return text.replace(/&(#?\w+);/g, (whole, name) => ENTITIES[name] ?? whole);
}

function isoOr(value, fallbackMs) {
  return new Date(toMillis(value, fallbackMs)).toISOString();
}

function toMillis(value, fallbackMs) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isNaN(parsed) ? fallbackMs : parsed;
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
  const value = entry?.click_count;
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function legacyColor(entry) {
  const value = entry?.button_color;
  return typeof value === 'string' && COLOR.test(value) ? value : null;
}

/**
 * Add one imported record to a working document, keeping the source's dates rather than now's.
 *
 * `addBookmark` does the validation, the duplicate check and the limit, and then the record is
 * replaced with the same one carrying the original timestamps. Reusing that path is what keeps
 * an import from accepting something an add would refuse.
 */
function addImported(document, entry, now) {
  const createdMs = toMillis(entry.createdAt, now());

  const { document: added, bookmark } = addBookmark(
    document,
    {
      url: entry.url,
      name: entry.name,
      search: entry.search,
      clickCount: entry.clickCount,
      color: entry.color,
      hideLabel: entry.hideLabel
    },
    () => createdMs
  );

  const record = {
    ...bookmark,
    createdAt: new Date(createdMs).toISOString(),
    updatedAt: isoOr(entry.updatedAt, createdMs)
  };

  const bookmarks = [...added.bookmarks];
  bookmarks[bookmarks.length - 1] = record;
  return { document: { ...added, bookmarks }, bookmark: record };
}

/**
 * Turn a payload into a document.
 *
 * Accepts an array (the old `sites.json`), a plain export wrapper, or a document that was
 * exported without the wrapper.
 *
 * @returns {{document: object, statistics: {imported: number, skipped: number, duplicates: number}}}
 */
export function importPlain(payload, now = Date.now) {
  let entries;

  if (typeof payload === 'string') {
    try {
      entries = JSON.parse(payload);
    } catch {
      throw fail('INVALID_IMPORT', 'that file is not JSON');
    }
    return importPlain(entries, now);
  }

  if (Array.isArray(payload)) {
    entries = payload;
  } else if (payload?.format === PLAIN_FORMAT && payload.document) {
    return importPlain(payload.document, now);
  } else if (payload?.schema === SCHEMA) {
    entries = payload.bookmarks;
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

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') {
      statistics.skipped += 1;
      continue;
    }

    try {
      const result = addImported(document, legacyEntry(entry), now);
      document = result.document;
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
    url: entry.url,
    name,
    search: legacySearch(entry),
    clickCount: legacyClicks(entry),
    color: legacyColor(entry),
    hideLabel,
    createdAt: entry.created_date ?? entry.createdAt,
    updatedAt: entry.last_updated ?? entry.updatedAt
  };
}

/**
 * Merge an imported document into the one already on this device.
 *
 * Matching is by URL, not by id: an import has never seen this device's ids. The field rules are
 * the same ones two synced devices use, so an import cannot produce a state sync would not.
 */
export function mergeInto(existing, incoming, now = Date.now) {
  const byUrl = new Map(existing.bookmarks.map((bookmark) => [bookmark.url, bookmark]));
  const bookmarks = [...existing.bookmarks];
  const statistics = { added: 0, updated: 0, skipped: 0 };

  for (const record of incoming.bookmarks) {
    const current = byUrl.get(record.url);

    if (current) {
      const at = bookmarks.findIndex((bookmark) => bookmark.id === current.id);
      bookmarks[at] = mergeBookmark(current, record);
      statistics.updated += 1;
      continue;
    }

    if (bookmarks.length >= MAX_BOOKMARKS) {
      statistics.skipped += 1;
      continue;
    }
    bookmarks.push(record);
    byUrl.set(record.url, record);
    statistics.added += 1;
  }

  return { document: { ...existing, bookmarks }, statistics };
}

/**
 * Read a browser's "bookmarks.html".
 *
 * Only the anchors matter. Folders are structure the vault does not model, and a bookmarklet
 * (`javascript:`) or a places query (`place:`) is not a page anyone can open from here.
 */
export function importBrowserBookmarks(html, now = Date.now) {
  if (typeof html !== 'string' || html.trim() === '') {
    throw fail('INVALID_IMPORT', 'that file is empty');
  }

  const pattern = /<a\s[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const entries = [];
  for (const match of html.matchAll(pattern)) {
    const url = decodeEntities(match[1].trim());
    if (!/^https?:\/\//i.test(url)) continue;

    const addDate = match[0].match(/add_date\s*=\s*"(\d+)"/i);
    entries.push({
      url,
      name: decodeEntities(match[2].replace(/<[^>]*>/g, '')).trim(),
      created_date: addDate ? Number(addDate[1]) * 1000 : undefined
    });
  }

  return importPlain(entries, now);
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

  for (const bookmark of [...document.bookmarks].sort((left, right) =>
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
