/**
 * Bookmarks — the page.
 *
 * Three jobs: unlock the vault, render the list, and write every change back through the
 * crypto and storage modules. Nothing here talks to a server, and nothing here puts a
 * bookmark, a name or a note into `innerHTML`: rows are built as nodes and filled with
 * `textContent`, because the vault is user data and a bookmark name must never be markup.
 */

import {
  SEARCH_CLEAR_DELAY_MS,
  addBookmark,
  createDocument,
  deleteBookmark,
  filterBookmarks,
  mergeDocuments,
  recordClick,
  searchNarrowsList,
  sortBookmarks,
  setOpenCount,
  togglePin,
  updateBookmark,
  useCount
} from './bookmarks.js';
import {
  deriveAccount,
  generatePhrase,
  openVault,
  phraseProblem,
  sealVault
} from './crypto.js';
import { CLIPBOARD_CLEAR_MS, clearPhraseField, overwriteClipboard } from './hygiene.js';
import { createLockSignal } from './lock-signal.js';
import {
  ICON_TRIES_KEY,
  SIZE_KEY,
  VIEW_KEY,
  clearDeviceStorage,
  hostKey,
  pruneIconTries
} from './device-store.js';
import { createVault, indexedDbAdapter } from './vault.js';
import {
  exportBrowserBookmarks,
  exportPlain,
  exportSealed,
  importBrowserBookmarks,
  importPlain,
  mergeInto,
  parseSealed
} from './import-export.js';
import { tileFor } from './tiles.js';
import { fetchIcon, fetchPageTitle } from './icons.js';
import { SyncClient, SyncError, describeSyncFailure } from './sync.js';
import { DEFAULT_VIEW, VIEW_NAMES, isView, nextView, viewToggleState } from './views.js';
import { formatStamp } from './stamps.js';
import { createBridge, isSnapshot } from './collector.js';
import { DEFAULT_LEVEL, DEFAULT_ORDER, LEVELS, ORDERS, addressLabel, fold, openCounts, summarise } from './collected.js';

const store = createVault(indexedDbAdapter());

/* Every tab holds its own key, so a lock has to be told to the others rather than assumed
   to reach them. See lock-signal.js. */
const lockSignal = createLockSignal();

const state = {
  accountId: null,
  /* The signing key, non-extractable; and the base64url secret the server is given at creation,
     which is dropped as soon as the account exists. */
  authKey: null,
  authSecret: null,
  key: null,
  version: 0,
  remoteVersion: 0,
  sealed: null,
  document: null,
  lastDeleted: null
};

const sync = new SyncClient();
let syncBusy = false;
let syncQueued = false;
let syncTimer = 0;
let syncLabel = '';
/* Icon fetching: four hosts at a time, and the vault saved every fifth batch rather than each. */
const ICON_BATCH = 4;
const ICON_SAVE_EVERY = 5;
/* A host that failed is not asked again on every launch: once a week, and only a few at a time.
   The index of when each host was asked lives in device-store.js, keyed by a digest. */
const ICON_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const ICON_TOPUP_HOSTS = 20;
let iconsBusy = false;
/* True once a name has been typed for the bookmark being added, so a suggestion never wins. */
let nameTouched = false;
let lastSyncedAt = 0;
let plan = null;
let units = 0;
/* How many places are signed in to this account, as of the last sign-in or the last check. */
let placesCount = null;
/* The account's own dates, as the sign-in answer carried them, in milliseconds. */
let vaultCreatedAt = null;
let lastActivityAt = null;

let saving = false;
let dirty = false;
let saveStamp = '';
/* The pending clear of an opened search, so typing again can cancel it. */
let searchClearTimer = 0;

/* ------------------------------------------------------------------ elements */

const $ = (id) => document.getElementById(id);

const lockView = $('lock-view');
const appView = $('app-view');
const lockForm = $('lock-form');
const phraseInput = $('phrase');
const rememberInput = $('remember');
const lockError = $('lock-error');
const unlockButton = $('unlock-button');
const newVaultButton = $('new-vault-button');
const restoreButton = $('restore-button');

const searchInput = $('search');
const sortInput = $('sort');
const settingsButton = $('settings-button');
const lockButton = $('lock-button');
const deviceNote = $('lock-device-note');
const viewToggle = $('view-toggle');
const addForm = $('add-form');
const addToggle = $('add-toggle');
const addCancel = $('add-cancel');
const addUrl = $('add-url');
const addName = $('add-name');
const list = $('list');
const empty = $('empty');
const viewHint = $('view-hint');
const collected = $('collected');
const collectedList = $('collected-list');
const collectedCount = $('collected-count');
const collectedBar = $('collected-bar');
const collectedBarCount = $('collected-bar-count');
const collectedScope = $('collected-scope');
const collectedAddButton = $('collected-add');
const collectedDismissButton = $('collected-dismiss');
const collectedExcludeButton = $('collected-exclude');
const vaultStatus = $('vault-status');
const status = $('status');
const syncRefusal = $('sync-refusal');
const syncRefusalDismiss = $('sync-refusal-dismiss');

/* ------------------------------------------------------------------ appearance */

/* How the list looks is a device preference, not vault data: it is not worth a write to the
   sealed blob every time a size changes, and it must be readable before the vault is open. The
   keys live in device-store.js with the rest of the device's own storage. */
const VIEWS = new Set(VIEW_NAMES);
const SIZES = new Set(['small', 'medium', 'large']);

function readPref(key, allowed, fallback) {
  try {
    const value = localStorage.getItem(key);
    return allowed.has(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function writePref(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage is unavailable; the choice lasts for this session only. */
  }
}

let currentView = readPref(VIEW_KEY, VIEWS, DEFAULT_VIEW);
let currentSize = readPref(SIZE_KEY, SIZES, 'medium');

function applyAppearance() {
  list.dataset.view = currentView;
  /* The collected section is the same rows in the same two views, so it moves with the toggle instead of waiting
     for the next render. */
  collectedList.dataset.view = currentView;
  applyListRoles();
  document.documentElement.dataset.size = currentSize;
  renderViewToggle();
  /* Pills are for opening pages; editing and deleting live in the list, so say where they are. */
  viewHint.hidden =
    currentView !== 'pills' || (state.document?.bookmarks.length ?? 0) === 0;

  /* The collected section is the same rows in the same two views, and the bar belongs to the list: toggling has to
     repaint it now rather than waiting for the next render. */
  if (state.document) renderCollected();
}

/**
 * The toggle shows the view a tap moves to, so its icon and its accessible name always describe
 * the next state. A hidden label would leave the button unnamed, which is why the name is set
 * on the button itself.
 */
function renderViewToggle() {
  const { target, label, title } = viewToggleState(currentView);
  viewToggle.setAttribute('aria-label', label);
  viewToggle.title = title;
  viewToggle.dataset.view = currentView;
  const path = viewToggle.querySelector('path');
  path?.setAttribute('d', target === 'list' ? ICON_PATHS.list : ICON_PATHS.pills);
}

/** One tap, not two: the only other view is the one the toggle names. */
function switchView() {
  if (!state.document) return;
  currentView = nextView(currentView);
  writePref(VIEW_KEY, currentView);
  applyAppearance();
  state.document = {
    ...state.document,
    prefs: { ...state.document.prefs, view: currentView }
  };
  saveNow();
}

/* --------------------------------------------------------------- small helpers */

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key in node) node[key] = value;
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child !== null && child !== undefined && child !== false) node.append(child);
  }
  return node;
}

function clean(message) {
  return String(message ?? '').replace(/^bookmarks:\s*/i, '');
}

function messageFor(error) {
  const message = clean(error?.message ?? 'Something went wrong.');

  /* One sentence for every refused phrase, so the wording names the attempt and not the
     account. */
  if (
    /not registered on the server|does not open a vault on this server|refused the sign-in|bad_proof/i.test(
      message
    )
  ) {
    return 'That phrase does not open a vault. Check the words, or create a new vault.';
  }

  if (/holds a vault for a different phrase/.test(message)) {
    return 'This device already holds a different vault. Clear it in Settings first, or enter the phrase that matches it.';
  }
  if (/was not sealed under this key/.test(message)) {
    return 'That phrase does not open this vault.';
  }
  return message;
}

function labelOf(bookmark) {
  return bookmark.name || bookmark.search || bookmark.hostname;
}

const ICON_PATHS = {
  pin: 'M12 3.6l2.5 5.1 5.6.8-4.1 4 1 5.6-5-2.6-5 2.6 1-5.6-4.1-4 5.6-.8z',
  edit: 'M4 20h4L19 9l-4-4L4 16v4zM14.5 5.5l4 4',
  remove: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13',
  /* The view toggle draws the view it switches to: three lines for the table, four tiles for
     the pills. */
  list: 'M4 7h16M4 12h16M4 17h16',
  pills: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h6v6h-6z'
};

function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ICON_PATHS[name]);
  svg.append(path);
  return svg;
}

/* ------------------------------------------------------------------- modals */

let activeModal = null;

function closeModal() {
  activeModal?.close();
}

function openModal({ title, body = [], actions = [], onClose = null }) {
  closeModal();

  const root = $('modal-root');
  const dialog = el('div', {
    class: 'modal',
    role: 'dialog',
    'aria-modal': 'true',
    'aria-label': title
  });

  const closeButton = el('button', {
    class: 'modal-close',
    type: 'button',
    'aria-label': 'Close',
    text: '✕'
  });

  dialog.append(
    el('div', { class: 'modal-header' }, [
      el('h2', { class: 'modal-title', text: title }),
      closeButton
    ]),
    el('div', { class: 'modal-body' }, body)
  );
  if (actions.length) dialog.append(el('div', { class: 'modal-actions' }, actions));

  const backdrop = el('div', { class: 'modal-backdrop' }, dialog);
  root.append(backdrop);

  const previousFocus = document.activeElement;
  document.body.classList.add('modal-open');

  function onKeydown(event) {
    if (event.key === 'Escape') {
      /* The page has its own Escape handlers; one keypress must not close the dialog and the form behind it. */
      event.stopPropagation();
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab') return;

    const focusable = [...dialog.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )].filter((node) => !node.disabled);

    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function close() {
    if (!activeModal) return;
    activeModal = null;
    backdrop.remove();
    document.body.classList.remove('modal-open');
    document.removeEventListener('keydown', onKeydown, true);
    previousFocus?.focus?.();
    onClose?.();
  }

  closeButton.addEventListener('click', close);
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close();
  });
  document.addEventListener('keydown', onKeydown, true);

  activeModal = { close, dialog };
  requestAnimationFrame(() => {
    const body = dialog.querySelector('.modal-body');
    const actions = dialog.querySelector('.modal-actions');
    const target =
      /* The chip row is a map of the sheet, not the first control: it is skipped when the keyboard is placed. */
      body?.querySelector('input, textarea, select, .button-primary, button:not(.settings-chip)') ??
      actions?.querySelector('.button-primary, button') ??
      closeButton;
    target?.focus();
  });

  return activeModal;
}

/** A yes/no question, resolved with the button the person chose (or false on close). */
function askModal({ title, body, confirmLabel = 'Continue', cancelLabel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    let settled = false;

    function finish(value) {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(value);
    }

    const modal = openModal({
      title,
      body,
      actions: [
        el('button', {
          class: 'button button-quiet',
          type: 'button',
          text: cancelLabel,
          onclick: () => finish(false)
        }),
        el('button', {
          class: `button ${danger ? 'button-danger' : 'button-primary'}`,
          type: 'button',
          text: confirmLabel,
          onclick: () => finish(true)
        })
      ],
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(false);
        }
      }
    });
  });
}

/* ------------------------------------------------------------------- status */

let statusTimer = 0;

function announce(text, { action, onAction, duration = 3200 } = {}) {
  clearTimeout(statusTimer);
  status.hidden = false;
  status.replaceChildren(document.createTextNode(text));

  if (action) {
    status.append(
      el('button', {
        type: 'button',
        text: action,
        onclick: () => {
          clearTimeout(statusTimer);
          status.classList.remove('visible');
          onAction?.();
        }
      })
    );
  }

  status.classList.add('visible');
  statusTimer = setTimeout(() => clearStatus(), duration);
}

/**
 * Take the last message off the screen, button and all.
 *
 * The pill fades after its time; the Undo button inside it used to stay in the tab order and stay in the tree, so
 * focus could vanish into something invisible. A locked vault also used to keep the last "Added …" sentence, which
 * is a bookmark's name on a screen that is supposed to show nothing.
 */
function clearStatus() {
  clearTimeout(statusTimer);
  status.classList.remove('visible');
  status.replaceChildren();
  status.hidden = true;
}

function setVaultStatus(text) {
  vaultStatus.textContent = text;
}

function updateStatusLine() {
  const count = state.document?.bookmarks.length ?? 0;
  const noun = count === 1 ? 'bookmark' : 'bookmarks';
  const suffix = saveStamp ? ` · saved ${saveStamp}` : ' · stored on this device';
  const syncSuffix = syncEnabled() ? ` · ${syncLabel || 'Not synced'}` : '';
  setVaultStatus(`${count} ${noun}${suffix}${syncSuffix}`);
}

/* --------------------------------------------------------------- app version */

/* The Worker is the only place the running version is written down; the page keeps its answer
   for the session and states it nowhere else. A failed answer leaves the version unstated,
   because a stored one would outlive the deploy it describes. */
let runningVersion = '';

async function loadVersion() {
  try {
    const response = await fetch('/w/bookmarks/api/health', {
      headers: { accept: 'application/json' }
    });
    if (!response.ok) return;

    const payload = await response.json();
    const version = typeof payload?.version === 'string' ? payload.version.trim() : '';
    if (version === '') return;

    runningVersion = version;
    vaultStatus.title = `Version ${version}`;
  } catch {
    /* Offline, or the first run before the Worker answers: nothing is shown. */
  }
}

/* -------------------------------------------------------------------- saving */

async function saveNow({ push = true } = {}) {
  if (!state.key) return;
  if (saving) {
    dirty = true;
    return;
  }

  saving = true;
  let savedOk = false;
  try {
    do {
      dirty = false;
      /* A lock may have arrived while the previous pass was still sealing. Nothing further is
         written once the key is gone. */
      if (!state.key) return;
      state.version += 1;
      /* Sealed at the number the server will give it, so a later read under any other number
         refuses instead of handing back older bytes. */
      const sealed = await sealVault(
        state.key,
        state.document,
        state.accountId,
        state.remoteVersion + 1
      );
      await store.save(state.accountId, sealed, state.version);
      state.sealed = sealed;
    } while (dirty);

    saveStamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    updateStatusLine();
    savedOk = true;
  } catch (error) {
    announce(`Could not save: ${clean(error.message)}`, { duration: 6000 });
  } finally {
    saving = false;
  }

  if (savedOk && push) scheduleSync();
}

/* -------------------------------------------------------------- preferences */

const SORT_MODES = new Set(['clicks', 'recent', 'name', 'lastClicked']);

/**
 * The only writer for the preferences that travel with the vault.
 *
 * The whole object is stamped so a merge can tell which device changed it last. A write that did
 * not stamp would lose to any copy that did, so every preference change goes through here.
 */
function setPrefs(patch) {
  state.document = {
    ...state.document,
    prefs: { ...(state.document.prefs ?? {}), ...patch, updatedAt: Date.now() }
  };
}

/**
 * Put the document's preferences on the controls. Called on entry and after every merge: a
 * preference that arrived in a merge has to reach the select and the view, otherwise the control
 * shows a value the document does not hold until the next reload. A vault with no stored view
 * keeps the one this browser last used.
 */
function applyPrefs() {
  const prefs = state.document?.prefs ?? {};
  sortInput.value = SORT_MODES.has(prefs.sort) ? prefs.sort : 'clicks';
  if (VIEWS.has(prefs.view)) currentView = prefs.view;
  writePref(VIEW_KEY, currentView);
  applyAppearance();
  if (prefs.sync !== true) clearSyncRefusal({ reset: true });
}

/* ---------------------------------------------------------------------- sync */

function syncEnabled() {
  return state.document?.prefs?.sync === true;
}

/**
 * A refusal to create the account is not a passing message, so it is not shown in the status
 * pill: that fades, and this one has an address to read and a decision to make. It stays in the
 * page until the person dismisses it or turns Sync off, and it never covers the vault.
 */
let syncRefusalDismissed = false;

function showSyncRefusal() {
  if (syncRefusalDismissed || !syncEnabled()) return;
  syncRefusal.hidden = false;
}

function clearSyncRefusal({ reset = false } = {}) {
  syncRefusal.hidden = true;
  if (reset) syncRefusalDismissed = false;
}

/* The vault syncs after every change; the same unreachable server must not re-announce itself
   on each one. A successful sync clears this, so a later outage is news again. */
let lastSyncNotice = '';

/**
 * A stable comparison for "did this actually change". Merge order and array order are not
 * meaningful, so both are normalised before the strings are compared; otherwise every sync
 * would look like a change and push the same blob back.
 */
function fingerprint(document) {
  const bookmarks = [...document.bookmarks].sort((left, right) => left.id.localeCompare(right.id));
  const tombstones = [...document.tombstones].sort((left, right) => left.id.localeCompare(right.id));
  return JSON.stringify({
    schema: document.schema,
    prefs: document.prefs ?? {},
    bookmarks,
    tombstones
  });
}

function scheduleSync() {
  if (!syncEnabled()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncNow();
  }, 500);
}

function setSyncStatus(label) {
  syncLabel = label;
  updateStatusLine();
}

function applyPlan(payload) {
  plan = payload?.plan ?? null;
  units = Number.isInteger(payload?.units) ? payload.units : 0;
  if (Number.isInteger(payload?.places)) placesCount = payload.places;
  /* The same answer carries the account's own dates, so Settings needs no second request. Only a
     proof of the phrase receives them, and this client has one by the time it reads them. */
  vaultCreatedAt = typeof payload?.createdAt === 'number' ? payload.createdAt : null;
  lastActivityAt = typeof payload?.lastSeenAt === 'number' ? payload.lastSeenAt : null;
}

/**
 * Where this vault is signed in, as far as the account itself knows. The server keeps one
 * session per sign-in; this reads their count and stamps, and nothing else about them.
 */
function placesDetail() {
  if (!syncEnabled()) return 'Off while Sync is off.';
  if (placesCount === null) return 'See where this account is signed in.';
  const noun = placesCount === 1 ? 'place is' : 'places are';
  return `${placesCount} ${noun} signed in to this account. Tap to see them.`;
}

function placeName(client) {
  if (client === 'mobile') return 'Phone';
  if (client === 'desktop') return 'Computer';
  return 'Unknown device';
}

function whenTime(stamp) {
  if (!stamp) return 'unknown time';
  return new Date(stamp).toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

async function openPlaces() {
  if (!syncEnabled()) {
    announce('Sync is off, so this vault is not signed in anywhere.');
    return;
  }

  let data;
  try {
    if (!sync.signedIn) {
      const session = await sync.login(state.accountId, authMaterial());
      applyPlan(session);
    }
    data = await sync.sessions();
  } catch (error) {
    if (error?.code === 'UNAUTHORIZED') {
      sync.token = null;
      announce('The session expired. Try again.');
      return;
    }
    announce('Could not read the connected places.');
    return;
  }

  placesCount = data.count;

  openModal({
    title: 'Connected places',
    body: [
      el('p', {
        class: 'modal-note',
        text: `${data.count} ${data.count === 1 ? 'place is' : 'places are'} signed in to this account. Each signed in with the phrase; this list is account metadata — a session carries the sealed blob and nothing that opens it.`
      }),
      el(
        'ul',
        { class: 'places-list' },
        data.sessions.map((session) =>
          el('li', { class: 'places-row' }, [
            el('strong', {
              text: `${placeName(session.client)}${session.current ? ' · this device' : ''}`
            }),
            el('span', {
              text: `signed in ${whenTime(session.createdAt)} · last active ${whenTime(session.lastSeenAt)}`
            })
          ])
        )
      )
    ]
  });
}

function planLabel() {
  if (!syncEnabled()) return 'sync off';
  if (plan === 'owner') return units > 0 ? `owner account · ${units * 10} entries` : 'owner account';
  if (plan === 'paid') return units > 0 ? `paid · ${units * 10} entries` : 'paid';
  return 'sync on';
}

function markSynced() {
  lastSyncedAt = Date.now();
  lastSyncNotice = '';
  const at = new Date(lastSyncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  setSyncStatus(`Synced ${at}`);
}

function handleSyncError(error) {
  /* A failed attempt can land after Sync was turned off; nothing about it should repaint then. */
  if (!syncEnabled()) return;

  const failure = describeSyncFailure(error);

  if (failure.kind === 'cap') {
    setSyncStatus(failure.label);
    showSyncRefusal();
    return;
  }
  /* This branch can hold the vault key without the phrase, so creating the account needs it. */
  if (error?.code === 'NEED_PHRASE') {
    setSyncStatus('Phrase needed to create the account');
    return;
  }
  if (failure.kind === 'unauthorized') {
    sync.token = null;
    setSyncStatus(failure.label);
    return;
  }
  if (failure.kind === 'locked' || failure.kind === 'conflict') {
    setSyncStatus(failure.label);
    return;
  }

  setSyncStatus(failure.label);

  /* A local-first vault retries on its own, so the same quiet failure is announced once. */
  if (failure.message !== lastSyncNotice) {
    lastSyncNotice = failure.message;
    announce(failure.message, { duration: failure.kind === 'size' ? 8000 : 6000 });
  }
}

/**
 * What signs a login proof: the non-extractable key when this session has one, and otherwise the
 * base64url secret, which only exists between an unlock and the account's creation.
 */
function authMaterial() {
  return state.authKey ?? state.authSecret;
}

/**
 * Whether a blob sealed before the version was bound may still be opened.
 *
 * This device answers yes only while its own copy is in the old shape: once it has written a
 * bound blob, the vault has moved, and a server that later serves an unmarked ciphertext is
 * serving something older than what this device already has. A device whose first read is the
 * old shape still opens it, which is what keeps an existing vault readable across the change.
 */
function legacyBlobAllowed() {
  return state.sealed?.at === undefined;
}

/** The number a device's own copy was sealed at, falling back to its stored version. */
function localSealVersion(stored) {
  return Number.isInteger(stored?.sealed?.at) ? stored.sealed.at : stored.version;
}

/**
 * The blob to send at `baseVersion`: it must be sealed at the number it is about to occupy on
 * the server, since that number is part of its associated data. A local save made at a guess
 * that has since moved — an offline edit, another device ahead — is re-sealed here instead of
 * being sent bound to a version the server will not give it.
 */
async function sealedForPush(baseVersion) {
  const wanted = baseVersion + 1;
  if (state.sealed?.at === wanted) return state.sealed;

  const sealed = await sealVault(state.key, state.document, state.accountId, wanted);
  state.version += 1;
  await store.save(state.accountId, sealed, state.version);
  state.sealed = sealed;
  return sealed;
}

/**
 * One reconcile: sign in if needed, read the server's blob, merge it into this device, then
 * push if this device knows something the server does not. A conflict is merged and retried
 * once; a second conflict means two devices are writing faster than one can settle.
 */
async function syncNow() {
  if (!syncEnabled() || !state.key || !authMaterial()) return;
  if (syncBusy) {
    syncQueued = true;
    return;
  }

  syncBusy = true;
  let absorbed = false;
  try {
    if (!sync.signedIn) {
      setSyncStatus('Signing in…');
      let session;

      try {
        session = await sync.login(state.accountId, authMaterial());
      } catch (error) {
        if (error.code !== 'NO_ACCOUNT') throw error;

        /* First sync on a new phrase: the account is created from the same secrets the login
           would have used, so there is nothing to provision and no token to hold. A remembered
           device holds the signing key, not the secret the server is given, so it cannot create
           the account without the phrase once. */
        setSyncStatus('Creating the account…');
        if (typeof state.authSecret !== 'string') {
          throw new SyncError('NEED_PHRASE', 'This device needs the phrase once to create the account.');
        }
        await sync.register(state.accountId, state.authSecret);
        /* The server now holds the secret, so this page does not: from here the session signs
           with the non-extractable key and nothing else. */
        state.authSecret = null;
        session = await sync.login(state.accountId, authMaterial());
      }

      applyPlan(session);
    }

    const remote = await sync.pull();

    if (remote) {
      state.remoteVersion = remote.version;
      const remoteDocument = await openVault(state.key, remote, state.accountId, remote.version, {
        allowLegacy: legacyBlobAllowed()
      });
      const { document: merged } = mergeDocuments(state.document, remoteDocument);

      if (fingerprint(merged) !== fingerprint(state.document)) {
        state.document = merged;
        absorbed = true;
        /* The merge may have carried a newer sort or view from the other device; the controls
           have to show it before the list is built, or they show the state they replaced. */
        applyPrefs();
        render();
        await saveNow({ push: false });
      }
      if (fingerprint(merged) === fingerprint(remoteDocument)) {
        markSynced();
        if (absorbed) announce('Merged changes from another device.');
        return;
      }
    } else {
      state.remoteVersion = 0;
    }

    let result = await sync.push(state.remoteVersion, await sealedForPush(state.remoteVersion));

    if (result.conflict) {
      state.remoteVersion = result.currentVersion;
      if (result.current) {
        const conflictDocument = await openVault(
          state.key,
          result.current,
          state.accountId,
          result.current.version,
          { allowLegacy: legacyBlobAllowed() }
        );
        const { document: merged } = mergeDocuments(state.document, conflictDocument);
        state.document = merged;
        absorbed = true;
        applyPrefs();
        render();
        await saveNow({ push: false });
      }
      result = await sync.push(state.remoteVersion, await sealedForPush(state.remoteVersion));
      if (result.conflict) {
        throw new SyncError('CONFLICT', 'Another device is changing the vault.');
      }
    }

    state.remoteVersion = result.version;
    markSynced();
    if (absorbed) announce('Merged changes from another device.');
  } catch (error) {
    handleSyncError(error);
  } finally {
    syncBusy = false;
    if (syncQueued) {
      syncQueued = false;
      syncNow();
    }
  }
}

/* ------------------------------------------------------------------ screens */

/**
 * The add form is an action, not furniture: it is closed until it is needed, and it closes
 * again once a bookmark is in. `focus` is off when the caller is about to move focus itself.
 */
function setAddForm(open, { focus = true } = {}) {
  addForm.hidden = !open;
  addToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (!open) nameTouched = false;
  if (!focus) return;
  (open ? addUrl : addToggle).focus();
}

function showLockError(message) {
  lockError.textContent = message;
  lockError.hidden = !message;
}

/**
 * The lock screen for two different situations: a device that holds a vault and is locked, and a
 * device that holds nothing and is being asked for a phrase that belongs to a server copy. The
 * screen is the same; the sentence under the field is not.
 */
function showLock(message = '', { hasVault = null } = {}) {
  appView.hidden = true;
  lockView.hidden = false;
  if (hasVault !== null) {
    deviceNote.textContent = hasVault
      ? 'This device holds a vault. Enter its 13 words to open it.'
      : 'No vault on this device yet. Enter your 13 words to load a synced one, or create a new vault.';
    deviceNote.hidden = false;
  }
  showLockError(message);
  phraseInput.focus();
}

function enter({ accountId, authSecret, authKey = null, key, version, sealed, document: vaultDocument }) {
  state.accountId = accountId;
  state.authKey = authKey ?? null;
  state.authSecret = authSecret ?? null;
  state.key = key;
  state.version = version;
  state.sealed = sealed;
  state.document = vaultDocument;

  lockView.hidden = true;
  appView.hidden = false;
  showLockError('');

  applyPrefs();
  cancelSearchClear();
  searchInput.value = '';

  render();

  /* The add form is an action, not furniture: it opens when it is asked for. An empty vault used
     to open it on every entry, which is why it appeared after a vault was loaded from the
     server. */
  setAddForm(false);
  if (window.matchMedia?.('(pointer: fine)').matches && vaultDocument.bookmarks.length > 0) {
    searchInput.focus();
  }

  /* The vault is the only writer of the capture policy, so it states it on every unlock: an extension that was
     reinstalled, reloaded or updated starts from the defaults and has to be told what this vault decided. */
  pushCollectorPolicy();
  void loadCollected();
  maybeCollectorSetup();

  if (syncEnabled()) syncNow();
  /* A top-up that cannot read its own index is not an error worth showing: the next launch
     simply asks again. */
  scheduleIconTopUp().catch(() => {});
  if (runningVersion === '') loadVersion();
}


/* ------------------------------------------------------- setting up collection */

/**
 * The extension opens this page the first time it is installed, and the page asks here, once.
 *
 * That question is worth asking because the extension holds addresses for a vault it cannot see: "which vault, and
 * does anything leave this device" is the whole of the consent, and the answer is the one thing a person should be
 * told before a counter starts. Nothing is collected until the first button is pressed — the extension's own default
 * is off, and the vault is the only thing that ever turns it on.
 */
let collectorSetupPending = false;

/** Take `?collector=installed` off the address bar at once: a reload is a page load, and must not ask twice. */
function takeCollectorSetupLink() {
  const url = new URL(location.href);
  if (!url.searchParams.has('collector')) return;

  collectorSetupPending = true;
  url.searchParams.delete('collector');
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
}

/** Called once a vault is open, because there is no point asking about a vault that is not there yet. */
function maybeCollectorSetup() {
  if (!collectorSetupPending || !state.document) return;
  collectorSetupPending = false;
  askAboutCollection();
}

function askAboutCollection() {
  const modal = openModal({
    title: 'Set up collected links',
    body: [
      el('p', {
        text: '“Bookmarks — collected links” is installed. It can keep the address of every page this browser opens, ' +
          'and how often you opened it, so the pages you really use are here to keep.'
      }),
      el('ul', {}, [
        el('li', { text: 'Only the address and a count: no titles, no page contents, no referrer.' }),
        el('li', {
          text: 'It stays on this device. Nothing reaches this vault until you add it, and nothing leaves the device ' +
            'at all.'
        }),
        el('li', { text: 'All of it can be changed or cleared later, in Settings.' })
      ])
    ],
    actions: [
      el('button', {
        class: 'button button-quiet',
        type: 'button',
        text: 'Keep it off',
        onclick: () => modal.close()
      }),
      el('button', {
        class: 'button button-primary',
        type: 'button',
        text: 'Collect on this device',
        onclick: () => {
          modal.close();
          askAboutDefaults();
        }
      })
    ]
  });
}

/** The three answers that make the difference between "it records everything forever" and "it does what I want". */
function askAboutDefaults() {
  setCollectorPrefs({ enabled: true });

  const level = el('select', {}, [
    el('option', { value: 'addresses', text: 'Every page' }),
    el('option', { value: 'hosts', text: 'One row per hostname' }),
    el('option', { value: 'domains', text: 'One row for the whole site' })
  ]);
  level.value = collectorPrefs().level;
  level.addEventListener('change', () => setCollectorPrefs({ level: level.value }));

  const retention = el(
    'select',
    {},
    [
      [7, 'A week'],
      [30, 'A month'],
      [60, 'Two months'],
      [365, 'A year'],
      [0, 'Until I clear them']
    ].map(([value, text]) => el('option', { value: String(value), text }))
  );
  retention.value = String(collectorPrefs().retentionDays);
  retention.addEventListener('change', () => setCollectorPrefs({ retentionDays: Number(retention.value) }));

  const privateBox = el('input', { type: 'checkbox' });
  privateBox.checked = collectorPrefs().includeIncognito;
  privateBox.addEventListener('change', () => setCollectorPrefs({ includeIncognito: privateBox.checked }));

  const modal = openModal({
    title: 'How much should it keep?',
    body: [
      el('p', {
        text: 'These are the defaults for every site. In Settings a site can be given a rule of its own, and a site, a ' +
          'hostname or a single path can be left out entirely.'
      }),
      el('label', { class: 'settings-item settings-control' }, [
        el('strong', { text: 'Record each site as' }),
        level
      ]),
      el('label', { class: 'settings-item settings-control' }, [
        el('strong', { text: 'Keep collected links for' }),
        retention
      ]),
      el('label', { class: 'settings-item settings-control' }, [
        el('strong', { text: 'Include private windows' }),
        el('span', { text: 'The browser also has to allow this extension in private windows.' }),
        privateBox
      ])
    ],
    actions: [
      el('button', {
        class: 'button button-primary',
        type: 'button',
        text: 'Done',
        onclick: () => {
          modal.close();
          announce('Collection is on. Open a page and it appears below.');
        }
      })
    ]
  });
}

async function tryRemembered() {
  let remembered;
  try {
    remembered = await store.readRemembered();
  } catch {
    return showLock('', { hasVault: false });
  }
  if (!remembered) {
    /* No remembered key does not mean no vault: the record may have expired, or the box was
       never ticked. The sentence under the field says which, so the phrase is not a surprise. */
    const onDevice = await store.hasVault().catch(() => false);
    return showLock('', { hasVault: onDevice });
  }

  try {
    const key = remembered.key;
    const stored = await store.load(remembered.accountId);
    if (!stored.sealed) throw new Error('the remembered key has no vault');

    const vaultDocument = await openVault(
      key,
      stored.sealed,
      remembered.accountId,
      localSealVersion(stored),
      { allowLegacy: true }
    );
    enter({
      accountId: remembered.accountId,
      authSecret: null,
      authKey: remembered.authKey ?? null,
      key,
      version: stored.version,
      sealed: stored.sealed,
      document: vaultDocument
    });
  } catch {
    await store.forget().catch(() => {});
    showLock('This device could not reopen its vault. Enter your phrase.', { hasVault: true });
  }
}

/* -------------------------------------------------------------------- unlock */

async function handleUnlock(event) {
  event.preventDefault();
  showLockError('');

  /* The field is cleared on every attempt, before anything else can fail: a shared machine must
     not be left showing the phrase of the person who tried a moment ago. */
  const phrase = phraseInput.value;
  clearPhraseField(phraseInput);
  const problem = phraseProblem(phrase);
  if (problem) {
    showLockError(problem);
    phraseInput.focus();
    return;
  }

  unlockButton.disabled = true;
  unlockButton.textContent = 'Unlocking…';

  try {
    const { accountId, vaultKey, authKey, authSecret } = await deriveAccount(phrase);
    const stored = await store.load(accountId);
    const vaultDocument = stored.sealed
      ? await openVault(vaultKey, stored.sealed, accountId, localSealVersion(stored), {
          allowLegacy: true
        })
      : createDocument();

    if (rememberInput.checked) await store.remember(accountId, vaultKey, authKey);
    else await store.forget();

    enter({
      accountId,
      authSecret,
      authKey,
      key: vaultKey,
      version: stored.version,
      sealed: stored.sealed,
      document: vaultDocument
    });

    if (!stored.sealed) {
      await saveNow();
      await offerServerVault();
    }
  } catch (error) {
    showLockError(messageFor(error));
    phraseInput.focus();
  } finally {
    unlockButton.disabled = false;
    unlockButton.textContent = 'Unlock';
  }
}

/**
 * A phrase entered on a device that has never held this vault opens an empty one, and Sync —
 * the thing that would fetch the real copy — is a preference inside the vault. So a new device
 * sits empty and reads as lost data. The account id comes from the phrase, so the server can be
 * asked whether a copy exists without knowing the key: if it does, offer to load it.
 */
async function offerServerVault() {
  if (!authMaterial() || hasBookmarks()) return;

  let exists;
  try {
    exists = await sync.accountExists(state.accountId);
  } catch {
    return; /* Offline, or the question could not be asked: stay local, say nothing. */
  }
  if (!exists) return;

  const load = await askModal({
    title: 'This vault is on the server',
    body: [
      el('p', {
        class: 'modal-note',
        text: 'A synced copy of this account exists. Loading brings its bookmarks to this device and leaves Sync on. Starting empty keeps this device on its own for now; Sync can be turned on later in Settings.'
      })
    ],
    confirmLabel: 'Load from server',
    cancelLabel: 'Start empty'
  });
  if (!load) return;

  setPrefs({ sync: true });
  render();
  await saveNow({ push: false });
  await syncNow();
}

/* Only an empty vault is worth asking about: anything already here wins over a prompt. */
function hasBookmarks() {
  return (state.document?.bookmarks.length ?? 0) > 0;
}

function openCreateModal() {
  let phrase = generatePhrase();
  let feedbackTimer = 0;

  const text = el('p', { class: 'phrase-line' });
  const copyStatus = el('span', { class: 'visually-hidden', 'aria-live': 'polite' });

  const copyButton = el('button', {
    class: 'button button-quiet copy-button',
    type: 'button',
    text: 'Copy phrase'
  });
  const regenerateButton = el('button', {
    class: 'button button-quiet',
    type: 'button',
    text: 'Generate another'
  });
  const saved = el('input', { type: 'checkbox' });
  const createButton = el('button', {
    class: 'button button-primary',
    type: 'button',
    text: 'Create vault',
    disabled: true
  });

  text.textContent = phrase;

  /** The clipboard API can be refused; a hidden textarea with execCommand still works on a tap. */
  function copyWithSelection() {
    const field = document.createElement('textarea');
    field.value = phrase;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.top = '-1000px';
    document.body.append(field);
    field.select();

    let copied = false;
    try {
      copied = document.execCommand('copy');
    } catch {
      copied = false;
    }
    field.remove();
    return copied;
  }

  function selectPhrase() {
    const range = document.createRange();
    range.selectNodeContents(text);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  /** One tap, one visible answer: the label changes, the colour changes, the width does not. */
  function feedback(label, copied) {
    clearTimeout(feedbackTimer);
    copyButton.textContent = label;
    copyButton.classList.toggle('copied', copied);
    copyStatus.textContent = copied
      ? 'Phrase copied to the clipboard.'
      : 'The phrase is selected. Press Control C to copy it.';

    feedbackTimer = setTimeout(() => {
      copyButton.textContent = 'Copy phrase';
      copyButton.classList.remove('copied');
    }, 2400);
  }

  /* The clipboard is the second place a phrase outlives its use. A copy is overwritten after a
     short delay, and when the dialog closes, so a machine handed to someone else does not keep
     the master secret on its clipboard. The write only happens while the clipboard still holds
     the phrase: a person may have copied something else, and that is not ours to erase. */
  let clipboardTimer = 0;
  let copiedPhrase = '';

  function scheduleClipboardClear(copied) {
    copiedPhrase = copied;
    clearTimeout(clipboardTimer);
    clipboardTimer = setTimeout(clearCopiedPhrase, CLIPBOARD_CLEAR_MS);
  }

  function clearCopiedPhrase() {
    clearTimeout(clipboardTimer);
    if (!copiedPhrase) return;
    const phraseToClear = copiedPhrase;
    copiedPhrase = '';
    overwriteClipboard({
      phrase: phraseToClear,
      read: () => navigator.clipboard.readText(),
      write: (text) => navigator.clipboard.writeText(text)
    }).catch(() => {});
  }

  copyButton.addEventListener('click', async () => {
    const copied = phrase;

    try {
      await navigator.clipboard.writeText(copied);
      feedback('Copied', true);
      scheduleClipboardClear(copied);
      return;
    } catch {
      /* Fall through to the selection-based copy. */
    }

    if (copyWithSelection()) {
      feedback('Copied', true);
      scheduleClipboardClear(copied);
      return;
    }

    selectPhrase();
    feedback('Press Ctrl+C', false);
  });

  regenerateButton.addEventListener('click', () => {
    phrase = generatePhrase();
    text.textContent = phrase;
    saved.checked = false;
    createButton.disabled = true;
    clearTimeout(feedbackTimer);
    copyButton.textContent = 'Copy phrase';
    copyButton.classList.remove('copied');
  });

  saved.addEventListener('change', () => {
    createButton.disabled = !saved.checked;
  });

  const modal = openModal({
    title: 'Your new vault',
    body: [
      el('p', {
        class: 'modal-note',
        text: 'These thirteen words are the vault. They are shown once and are not stored anywhere. Copy them, or write them down, before continuing.'
      }),
      text,
      el('div', { class: 'phrase-actions' }, [copyButton, regenerateButton]),
      copyStatus,
      el('p', {
        class: 'modal-note',
        text: 'There is no recovery. Anyone with these words can read the vault; anyone without them, including this server, cannot.'
      }),
      el('label', { class: 'confirm-saved' }, [
        saved,
        el('span', { text: 'I have saved these thirteen words somewhere safe.' })
      ])
    ],
    actions: [createButton],
    onClose: clearCopiedPhrase
  });

  createButton.addEventListener('click', async () => {
    createButton.disabled = true;
    createButton.textContent = 'Creating…';
    try {
      await createNewVault(phrase, rememberInput.checked);
      modal.close();
    } catch (error) {
      createButton.disabled = false;
      createButton.textContent = 'Create vault';
      announce(`Could not create the vault: ${messageFor(error)}`, { duration: 6000 });
    }
  });
}

async function createNewVault(phrase, remember) {
  const { accountId, vaultKey, authKey, authSecret } = await deriveAccount(phrase);
  const vaultDocument = createDocument();
  const sealed = await sealVault(vaultKey, vaultDocument, accountId, 1);

  await store.save(accountId, sealed, 1);
  if (remember) await store.remember(accountId, vaultKey, authKey);
  else await store.forget();

  enter({ accountId, authSecret, authKey, key: vaultKey, version: 1, sealed, document: vaultDocument });
  setAddForm(true);
  announce('Vault created. Add a bookmark, or import a file from Settings.');
}

function pickFile(accept) {
  return new Promise((resolve) => {
    const input = el('input', { type: 'file', accept });
    input.style.display = 'none';
    document.body.append(input);

    const finish = (file) => {
      input.remove();
      resolve(file);
    };

    input.addEventListener('change', () => finish(input.files?.[0] ?? null), { once: true });
    input.addEventListener('cancel', () => finish(null), { once: true });
    input.click();
  });
}

async function handleRestore() {
  showLockError('');

  const file = await pickFile('.json,application/json');
  if (!file) return;

  let sealed;
  try {
    sealed = parseSealed(await file.text());
  } catch (error) {
    showLockError(messageFor(error));
    return;
  }

  const phrase = phraseInput.value;
  clearPhraseField(phraseInput);
  if (phrase.trim() === '') {
    showLockError('Enter the 13-word phrase for the backup, then restore it again.');
    phraseInput.focus();
    return;
  }

  try {
    const { accountId, vaultKey, authKey, authSecret } = await deriveAccount(phrase);
    const vaultDocument = await openVault(vaultKey, sealed, accountId, sealed.at ?? 1, {
      allowLegacy: sealed.at === undefined
    });
    const stored = await store.load(accountId);

    const version = Math.max(stored.version, 0) + 1;
    /* The backup is re-sealed at the number this device will store it under: the blob it came
       from was bound to its own version, and a record that names a number the bytes were not
       sealed at would not open again. */
    const resealed = await sealVault(vaultKey, vaultDocument, accountId, 1);
    await store.save(accountId, resealed, version);
    if (rememberInput.checked) await store.remember(accountId, vaultKey, authKey);
    else await store.forget();

    enter({
      accountId,
      authSecret,
      authKey,
      key: vaultKey,
      version,
      sealed: resealed,
      document: vaultDocument
    });
    announce('Backup restored.');
  } catch (error) {
    showLockError(messageFor(error));
  }
}

/* -------------------------------------------------------------------- render */

function findBookmark(id) {
  return state.document.bookmarks.find((bookmark) => bookmark.id === id) ?? null;
}

function actionButton(action, label, iconName, { pressed = null } = {}) {
  const button = el('button', {
    class: `icon-button${pressed ? ' pinned' : ''}`,
    type: 'button',
    'aria-label': label,
    title: label
  });
  button.dataset.action = action;
  /* A toggle owes a state in both positions; the name alone would describe the action and not the state. */
  if (pressed !== null) button.setAttribute('aria-pressed', pressed ? 'true' : 'false');
  button.append(icon(iconName));
  return button;
}

/**
 * The list view is a table and the pills view is a list of links, and the same nodes are drawn for both — so the
 * roles are stamped on what is already there instead of being written into two row builders.
 *
 * The name cell is left alone on purpose: it is the anchor, and a `cell` role on it would take the link away. A
 * screen reader then hears the row, the link, and the cells beside it, with the drawn header as the column names.
 */
function applyListRoles() {
  const asTable = currentView === 'list';

  for (const [container, label] of [
    [list, 'Bookmarks'],
    [collectedList, 'Collected links']
  ]) {
    if (!container) continue;

    if (asTable) {
      container.setAttribute('role', 'table');
      container.setAttribute('aria-label', label);
    } else {
      container.removeAttribute('role');
      container.removeAttribute('aria-label');
    }

    for (const row of container.children) {
      if (!row.classList.contains('row')) continue;
      const head = row.classList.contains('row-head');

      if (!asTable) row.removeAttribute('role');
      else row.setAttribute('role', 'row');

      for (const cell of row.children) {
        if (!asTable) {
          cell.removeAttribute('role');
          continue;
        }
        if (cell.tagName === 'A') continue;
        if (cell.getAttribute('aria-hidden') === 'true') {
          cell.setAttribute('role', 'presentation');
          continue;
        }
        cell.setAttribute('role', head ? 'columnheader' : 'cell');
        /* A selection column still needs a name of its own. */
        if (cell.classList.contains('row-pick')) cell.setAttribute('aria-label', 'Select');
      }
    }
  }
}

/**
 * One row. The list view is the table: name, address, clicks, last use, actions. The pills view
 * reuses the same markup, showing only the tile, the name and the count — it is a reading and
 * clicking view, not an editing one.
 */
function rowFor(bookmark) {
  const { initial, background, foreground } = tileFor(bookmark);

  const tile = el('span', { class: 'tile', 'aria-hidden': 'true' });
  if (bookmark.icon) {
    tile.append(el('img', { src: bookmark.icon, alt: '' }));
  } else {
    tile.textContent = initial;
  }

  const name = el('span', { class: 'row-name', text: labelOf(bookmark) });

  const link = el('a', {
    class: 'row-link',
    href: bookmark.url,
    target: '_blank',
    rel: 'noopener noreferrer'
  }, [tile, name]);

  /* An icon-only pill hides its label, and a hidden label leaves the link with no accessible
     name at all — so the name is stated explicitly. */
  const readable = labelOf(bookmark);
  link.setAttribute(
    'aria-label',
    readable === bookmark.hostname ? readable : `${readable} — ${bookmark.hostname}`
  );

  const row = el('li', { class: `row${bookmark.hideLabel ? ' icon-only' : ''}` });
  row.dataset.id = bookmark.id;
  row.style.setProperty('--tile-seed', background);
  row.style.setProperty('--tile-fg', foreground);

  /* The address column carries the address the browser shows. It used to carry the hostname, so three bookmarks on
     one host read as three identical rows. */
  const host = el('span', { class: 'row-host', text: addressLabel(bookmark.url) });

  const clicks = el('span', {
    class: 'clicks',
    text: String(useCount(bookmark)),
    'aria-label': `${useCount(bookmark)} uses`
  });

  const when = el('span', { class: 'row-when', text: lastUsedLabel(bookmark) });

  const actions = el('span', { class: 'row-actions' }, [
    actionButton('pin', `${bookmark.pinned ? 'Unpin' : 'Pin'} ${labelOf(bookmark)}`, 'pin', {
      pressed: bookmark.pinned
    }),
    actionButton('edit', `Edit ${labelOf(bookmark)}`, 'edit'),
    actionButton('remove', `Delete ${labelOf(bookmark)}`, 'remove')
  ]);

  row.append(link, host, clicks, when, actions);
  return row;
}

/** The day a bookmark was last opened, short enough for a column. */
function lastUsedLabel(bookmark) {
  const stamp = bookmark.lastClickedAt ?? bookmark.createdAt ?? null;
  if (!stamp) return '—';
  const when = new Date(stamp);
  if (Number.isNaN(when.getTime())) return '—';
  return when.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

function render() {
  if (!state.document) return;

  const query = searchInput.value;
  const matched = filterBookmarks(state.document, query);
  const view = { ...state.document, bookmarks: matched };
  const sorted = sortBookmarks(view, sortInput.value);

  /* The list view is a table, so it gets a header. Pills view hides it with CSS. */
  const head = el('li', { class: 'row row-head' }, [
    el('span', { 'aria-hidden': 'true' }),
    el('span', { text: 'Name' }),
    el('span', { text: 'Address' }),
    /* The number counts uses, not clicks: a bookmark opened from the browser's own list rises too. */
    el('span', { class: 'clicks', text: 'Uses' }),
    el('span', { class: 'row-when', text: 'Last used' }),
    /* The last cell holds the row's buttons; it is not a column with a name. */
    el('span', { 'aria-hidden': 'true' })
  ]);

  list.replaceChildren(head, ...sorted.map(rowFor));

  empty.hidden = sorted.length !== 0;
  empty.textContent =
    state.document.bookmarks.length === 0
      ? 'No bookmarks yet. Add one above, or import a file from Settings.'
      : `No bookmark matches “${query.trim()}”.`;

  renderCollected();
  applyListRoles();
  updateStatusLine();
  viewHint.hidden = currentView !== 'pills' || sorted.length === 0;
}

/* --------------------------------------------------------- collected (the extension) */

/* The extension is optional, so every answer can be nothing at all: a request that resolves to null means no
   extension, or one that is disabled, and the section stays hidden rather than announcing an absence. */
const collectorBridge = createBridge();
let collectedSnapshot = null;
let collectedTimer = null;

/** What the section would draw, in one string: the same answer must not repaint the list. */
function collectedKey(snapshot) {
  if (snapshot === null) return 'none';

  /* The settings are part of the shape of what is drawn, not only of what is counted: switching collection on or off
     changes whether the section appears at all, and the section used to stay as it was until the page was reloaded. */
  return `${snapshot.policy?.enabled === true ? 'on' : 'off'}|${snapshot.items.length}|${snapshot.items
    .map((item) => `${item.url}:${item.visits}`)
    .join(',')}`;
}

let collectedFingerprint = null;

/**
 * Move the extension's totals onto the bookmarks the vault already holds.
 *
 * A saved bookmark keeps counting when it is opened from the browser's own bookmarks or history, because the
 * extension counts the address and not the route. Returns whether anything moved, which is what tells the page to
 * repaint the vault as well as the section.
 */
function applyOpenCounts(snapshot) {
  if (!snapshot || !state.document) return false;

  const changes = openCounts(snapshot.items, state.document.bookmarks);
  if (changes.length === 0) return false;

  let next = state.document;
  for (const change of changes) next = setOpenCount(next, change.id, change.openCount, Date.now);
  state.document = next;
  return true;
}

async function loadCollected() {
  const reply = await collectorBridge.request();
  const next = isSnapshot(reply) ? reply : null;
  const key = collectedKey(next);
  const countsMoved = applyOpenCounts(next);

  if (key === collectedFingerprint && !countsMoved) return;

  collectedFingerprint = key;
  collectedSnapshot = next;

  if (countsMoved) {
    render();
    saveNow();
    return;
  }
  renderCollected();
}

/* A worker that was just switched on has announced nothing, so a page that was already open would never hear about
   it. Reading on a slow tick while the tab is visible is what makes "turn it on and watch the section fill" work
   without a reload; the fingerprint above means an unchanged answer costs nothing on screen. */
const COLLECTED_POLL_MS = 5000;

setInterval(() => {
  if (!state.document || document.visibilityState !== 'visible') return;
  void loadCollected();
}, COLLECTED_POLL_MS);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.document) void loadCollected();
});

/* A tab opening in another window, an approval or an exclusion all arrive as one hint. The section re-reads
   rather than patching a copy it cannot trust. */
collectorBridge.onChange(() => {
  clearTimeout(collectedTimer);
  collectedTimer = setTimeout(() => {
    if (state.document) void loadCollected();
  }, 200);
});

/* Everything about collection is a vault preference: whether it runs, what a site is recorded as, whether the list
   is grouped, and what is excluded. It is sealed with the vault, travels with the phrase, and is pushed to the
   extension whenever it changes — the page is the only writer of that policy. */
/* The bounds are the same defaults the extension ships with: a list that keeps itself in check unless the person
   says otherwise, and a zero that means "no limit" for anyone who wants that. */
const COLLECTOR_DEFAULTS = { retentionDays: 60, maxEntries: 2000, dailyCap: 0, minVisits: 1 };

function collectorPrefs() {
  const prefs = state.document?.prefs?.collector ?? {};
  const bounded = (value, fallback) => (Number.isInteger(value) && value >= 0 ? value : fallback);

  return {
    enabled: prefs.enabled === true,
    includeIncognito: prefs.includeIncognito === true,
    level: LEVELS.includes(prefs.level) ? prefs.level : DEFAULT_LEVEL,
    grouped: prefs.grouped === true,
    sites: Array.isArray(prefs.sites) ? prefs.sites : [],
    exclude: Array.isArray(prefs.exclude) ? prefs.exclude : [],
    retentionDays: bounded(prefs.retentionDays, COLLECTOR_DEFAULTS.retentionDays),
    maxEntries: bounded(prefs.maxEntries, COLLECTOR_DEFAULTS.maxEntries),
    dailyCap: bounded(prefs.dailyCap, COLLECTOR_DEFAULTS.dailyCap),
    minVisits: Number.isInteger(prefs.minVisits) && prefs.minVisits >= 1 ? prefs.minVisits : COLLECTOR_DEFAULTS.minVisits
  };
}

/** The site rules in the extension's words. Settings reads the vault's three levels; the policy names them. */
function policyLevels() {
  return collectorPrefs().sites.map((rule) => ({
    site: rule.site,
    level: LEVEL_TO_POLICY[rule.level] ?? 'address'
  }));
}

function setCollectorPrefs(patch) {
  if (!state.document) return;

  state.document = {
    ...state.document,
    prefs: { ...state.document.prefs, collector: { ...collectorPrefs(), ...patch } }
  };
  saveNow();
  pushCollectorPolicy();
  render();
}

/** Tell the extension what to count, how, and what to leave out. */
function pushCollectorPolicy(attempt = 0) {
  const prefs = collectorPrefs();
  void collectorBridge.setPolicy({
    enabled: prefs.enabled,
    includeIncognito: prefs.includeIncognito,
    levels: policyLevels(),
    exclude: prefs.exclude,
    retentionDays: prefs.retentionDays,
    maxEntries: prefs.maxEntries,
    dailyCap: prefs.dailyCap,
    minVisits: prefs.minVisits
  }).then((reply) => {
    /* No reply is what an absent extension looks like, and also what a missed message looks like. One retry costs
       nothing and turns the second case into a second chance rather than a silently switched-off collection. */
    if (reply === null && attempt < 2) {
      setTimeout(() => pushCollectorPolicy(attempt + 1), 900);
      return;
    }
    /* The extension has just been told what to collect, so ask it again: switching collection on used to leave the
       section empty until the page was reloaded. */
    void loadCollected();
  });
}

/* The section follows the toolbar it shares: the same search box narrows both lists, and the same sort control orders
   both. "Group by domain" is the one choice the toolbar has no room for, so it lives in Settings. */
const SORT_TO_ORDER = { clicks: 'visits', lastClicked: 'recent', recent: 'recent', name: 'name' };

/* The vault's words for the three levels and the three exclusion scopes, used by Settings. */
const RECORD_LABELS = {
  hosts: 'one row per hostname',
  domains: 'one row for the whole site',
  addresses: 'every page'
};
const EXCLUDE_LABELS = { site: 'the site and its subdomains', host: 'this hostname', path: 'this path and below' };

/* The policy's field names are the fold's level names; Settings reads and writes those same three words. */
const LEVEL_TO_POLICY = { domains: 'site', hosts: 'host', addresses: 'address' };
const POLICY_TO_LEVEL = { site: 'domains', host: 'hosts', address: 'addresses' };

function collectedOrder() {
  return collectorPrefs().grouped ? 'domain' : SORT_TO_ORDER[sortInput.value] ?? 'visits';
}

function collectedMatches(item, query) {
  const needle = query.trim().toLowerCase();
  if (needle === '') return true;
  return `${item.url} ${item.host ?? ''}`.toLowerCase().includes(needle);
}

function collectedHeld() {
  return (state.document?.bookmarks ?? []).map((bookmark) => bookmark.url);
}

/** The extension's rows the vault does not already hold, folded into the level and order this build shows. */
function collectedRows() {
  if (collectedSnapshot?.policy?.enabled !== true) return [];

  const prefs = collectorPrefs();
  const items = collectedSnapshot.items.filter((item) => collectedMatches(item, searchInput.value));

  return fold(items, {
    level: prefs.level,
    order: collectedOrder(),
    held: collectedHeld(),
    levels: policyLevels()
  });
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/* Icons for the collected rows come from the same server endpoint the vault's own icons use, and are kept in this
   device's `localStorage` rather than inside the sealed vault: they describe a page the vault does not hold, so
   sealing them would mean the vault grows every time an address is merely looked at. */
const COLLECTED_ICON_KEY = 'collected-icons';
const collectedIconTries = new Set();

function collectedIconCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(COLLECTED_ICON_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function collectedIcon(host) {
  return collectedIconCache()[host] ?? null;
}

async function loadCollectedIcon(host) {
  if (host === '' || collectedIconTries.has(host)) return;
  collectedIconTries.add(host);

  const icon = await fetchIcon(host).catch(() => null);
  if (!icon) return;

  try {
    const cache = collectedIconCache();
    cache[host] = icon;
    localStorage.setItem(COLLECTED_ICON_KEY, JSON.stringify(cache));
  } catch {
    /* A cache that cannot be written still leaves the lettered tile. */
    return;
  }

  for (const row of collectedList.querySelectorAll(`[data-host="${CSS.escape(host)}"] .tile`)) {
    row.replaceChildren(el('img', { src: icon, alt: '' }));
  }
}

/** The day a visit was last seen, short enough for a column. */
function seenLabel(stamp) {
  if (typeof stamp !== 'string' || stamp === '') return '—';
  const when = new Date(stamp);
  if (Number.isNaN(when.getTime())) return '—';
  return when.toLocaleDateString([], { day: 'numeric', month: 'short' });
}

/**
 * One collected row. It reuses the vault's own row markup so both views come for free: pills show the tile, the
 * label and the count, and everything that acts lives in the list, where a table already has a column for it.
 */
function collectedRowFor(item) {
  const host = hostOf(item.url);
  const { initial, background, foreground } = tileFor({ hostname: host, color: null });

  const tile = el('span', { class: 'tile', 'aria-hidden': 'true' });
  const icon = collectedIcon(host);
  if (icon) {
    tile.append(el('img', { src: icon, alt: '' }));
  } else {
    tile.textContent = initial;
    void loadCollectedIcon(host);
  }

  /* A single address is named by its site and addressed by its whole address, which is the pair the vault's own
     table uses. A grouped row is named by what it groups. */
  const isAddress = item.kind === 'address';
  const name = el('span', { class: 'row-name', text: isAddress ? host : item.label });
  const link = el('a', { class: 'row-link', href: item.url, target: '_blank', rel: 'noopener noreferrer' }, [
    tile,
    name
  ]);
  link.setAttribute('aria-label', `${item.label} — ${item.visits} ${item.visits === 1 ? 'visit' : 'visits'}`);

  const row = el('li', { class: 'row collected-row' });
  row.dataset.url = item.url;
  row.dataset.host = host;
  row.dataset.kind = item.kind;
  row.dataset.depth = String(item.depth);
  row.dataset.visits = String(item.visits);
  row.dataset.label = item.label;
  row.style.setProperty('--tile-seed', background);
  row.style.setProperty('--tile-fg', foreground);

  const address = el('span', { class: 'row-host', text: isAddress ? item.label : host });
  const visits = el('span', {
    class: 'clicks',
    text: String(item.visits),
    'aria-label': `${item.visits} ${item.visits === 1 ? 'visit' : 'visits'}`
  });
  const when = el('span', { class: 'row-when', text: seenLabel(item.lastSeenAt) });

  const add = el('button', { class: 'button button-quiet collected-add', type: 'button', text: 'Add' });
  add.dataset.action = 'collect';
  const actions = el('span', { class: 'row-actions' }, [add]);

  const pick = el('input', { type: 'checkbox' });
  pick.dataset.pick = item.url;
  pick.checked = collectedPicked.has(item.url);
  pick.setAttribute('aria-label', `Select ${item.label}`);
  const pickCell = el('span', { class: 'row-pick' }, [pick]);

  row.append(pickCell, link, address, visits, when, actions);
  return row;
}

/* Selection belongs to the list view only: in pills there is nothing to tick and nothing to press. */
const collectedPicked = new Set();

function updateCollectedBar(rows = collectedRows()) {
  const showing = currentView === 'list' && rows.length > 0;
  collectedBar.hidden = !showing;
  if (!showing) return;

  const picked = [...collectedPicked].filter((url) => rows.some((row) => row.url === url));
  collectedBarCount.textContent =
    picked.length === 0 ? `${rows.length} collected` : `${picked.length} of ${rows.length} selected`;

  for (const button of [collectedAddButton, collectedDismissButton, collectedExcludeButton]) {
    button.disabled = picked.length === 0;
  }
}

/** Add every selected row, in one save rather than one per row. */
function approveMany(rows) {
  let next = state.document;
  let added = 0;
  let skipped = 0;

  for (const row of rows) {
    try {
      const result = addBookmark(
        next,
        { url: row.url, name: nameForCollected(row), openCount: row.visits },
        Date.now
      );
      next = result.document;
      added += 1;
    } catch (error) {
      if (error.code === 'DUPLICATE') {
        skipped += 1;
        continue;
      }
      announce(clean(error.message));
      return;
    }
  }

  if (added > 0) {
    state.document = next;
    render();
    saveNow();
  }

  collectedPicked.clear();
  announce(
    added === 0
      ? 'Nothing new to add — those are already in the vault.'
      : `Added ${added} ${added === 1 ? 'link' : 'links'}${skipped > 0 ? `, ${skipped} already saved` : ''}.`
  );
  void loadCollected();
}

function pickedRows() {
  const rows = collectedRows();
  return rows.filter((row) => collectedPicked.has(row.url));
}

/* One exclusion per selected row, at the scope the bar names. A path exclusion keeps the host and the path; the
   other two keep the host alone, because that is what those scopes match. */
function excludeMany(rows, scope) {
  const entries = new Map();
  for (const row of rows) {
    const host = hostOf(row.url);
    let value = host;
    if (scope === 'path') {
      try {
        value = `${host}${new URL(row.url).pathname}`;
      } catch {
        value = host;
      }
    }
    entries.set(`${scope}|${value}`, { scope, value });
  }

  collectedPicked.clear();
  void collectorBridge.exclude([...entries.values()]).then(() => loadCollected());
  announce(`Excluding ${entries.size} ${entries.size === 1 ? 'site' : 'sites'}.`);
}

collectedBar.addEventListener('click', (event) => {
  const picked = pickedRows();
  if (picked.length === 0) return;

  if (event.target === collectedAddButton) {
    approveMany(picked);
    return;
  }

  if (event.target === collectedDismissButton) {
    const urls = picked.map((row) => row.url);
    collectedPicked.clear();
    void collectorBridge.dismiss(urls).then(() => loadCollected());
    announce(`Dismissed ${urls.length}.`);
    return;
  }

  if (event.target === collectedExcludeButton) {
    excludeMany(picked, collectedScope.value);
  }
});

collectedList.addEventListener('change', (event) => {
  const all = event.target.closest?.('#collected-all');
  if (all) {
    const rows = collectedRows();
    collectedPicked.clear();
    if (all.checked) for (const row of rows) collectedPicked.add(row.url);
    for (const box of collectedList.querySelectorAll('[data-pick]')) box.checked = all.checked;
    updateCollectedBar();
    return;
  }

  const box = event.target.closest?.('[data-pick]');
  if (!box) return;

  if (box.checked) collectedPicked.add(box.dataset.pick);
  else collectedPicked.delete(box.dataset.pick);
  updateCollectedBar();
});

function renderCollected() {
  const rows = collectedRows();
  const prefs = collectorPrefs();
  const totals = summarise(
    (collectedSnapshot?.items ?? []).filter((item) => collectedMatches(item, searchInput.value)),
    collectedHeld(),
    policyLevels()
  );

  collectedList.dataset.view = currentView;
  collected.hidden = rows.length === 0;

  if (rows.length === 0) {
    collectedList.replaceChildren();
    collectedCount.textContent = '';
    collectedPicked.clear();
    updateCollectedBar(rows);
    return;
  }

  const all = el('input', { type: 'checkbox' });
  all.id = 'collected-all';
  all.checked = rows.length > 0 && rows.every((row) => collectedPicked.has(row.url));
  all.setAttribute('aria-label', 'Select every collected row');

  /* The list is a table, so it gets a header; the pills view hides it with the rest of the furniture. */
  const head = el('li', { class: 'row row-head' }, [
    el('span', { class: 'row-pick' }, [all]),
    el('span', { 'aria-hidden': 'true' }),
    el('span', { text: 'Name' }),
    el('span', { text: 'Address' }),
    el('span', { class: 'clicks', text: 'Visits' }),
    el('span', { class: 'row-when', text: 'Last seen' }),
    el('span', { 'aria-hidden': 'true' })
  ]);

  collectedList.replaceChildren(head, ...rows.map(collectedRowFor));
  collectedCount.textContent = `${totals.addresses} ${totals.addresses === 1 ? 'address' : 'addresses'} · ${
    totals.visits
  } ${totals.visits === 1 ? 'visit' : 'visits'}`;
  updateCollectedBar(rows);
  applyListRoles();
}

/**
 * Add a collected row to the vault, then let the extension forget it.
 *
 * The order matters: the bookmark is written first, so a lost reply leaves a duplicate the person can dismiss
 * rather than a link that was never saved. A row that is already in the vault is promoted away and said so.
 */
/* A collected row is named by its path when it has one: three pages of one host would otherwise all be called the
   host, and the name is the only column that tells them apart at a glance. */
function nameForCollected(row) {
  try {
    const path = new URL(row.url).pathname.replace(/^\/+|\/+$/g, '');
    return path;
  } catch {
    return '';
  }
}

function approveCollected(url, visits, label = '') {
  try {
    /* The count crosses with the row: the visits were made to this address, and starting the bookmark at zero
       would throw away the only thing the extension was counting. */
    const { document: next, bookmark } = addBookmark(
      state.document,
      { url, name: nameForCollected({ url }), openCount: Number.isInteger(visits) ? visits : 0 },
      Date.now
    );
    state.document = next;
    render();
    saveNow();
    announce(`Added ${labelOf(bookmark)}`);
    fetchAndStoreIcon(bookmark.id, bookmark.hostname);
    /* The row is not deleted: the extension keeps counting this address, and the count keeps arriving here, which
       is what makes a bookmark opened from the browser's own list count too. The section hides it because the vault
       holds it, so it can never appear in both places. */
    void loadCollected();
  } catch (error) {
    if (error.code === 'DUPLICATE') {
      void collectorBridge.promote([url]);
      void loadCollected();
      announce('That address is already in your vault.');
      return;
    }
    announce(clean(error.message));
  }
}

collectedList.addEventListener('click', (event) => {
  const button = event.target.closest?.('[data-action="collect"]');
  if (!button) return;
  const row = button.closest('.row');
  if (row?.dataset.url) approveCollected(row.dataset.url, Number(row.dataset.visits), row.dataset.label);
});

/* ------------------------------------------------------------------- actions */

/**
 * The site usually says what it is called. Leaving the address field asks for its <title> and
 * offers it as the name — but only while the name field is still empty and untouched, so nothing
 * the person typed is ever replaced. A failure is silence, and the host stands in as the label.
 */
async function suggestName() {
  const raw = addUrl.value.trim();
  if (raw === '' || nameTouched || addName.value.trim() !== '') return;

  let url;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return;
  }
  if (!/^https?:$/.test(url.protocol)) return;

  const hostname = url.hostname.replace(/^www\./i, '');
  const original = addName.placeholder;
  addName.dataset.suggesting = '1';
  addName.placeholder = 'Looking for the site name…';

  const title = await fetchPageTitle(hostname).catch(() => null);

  if (addName.dataset.suggesting === '1') {
    delete addName.dataset.suggesting;
    addName.placeholder = original;
  }
  if (!title || nameTouched || addName.value.trim() !== '' || addUrl.value.trim() !== raw) return;
  /* The answer can land after the person has moved into the field; typing wins. */
  if (document.activeElement === addName) return;

  addName.value = shortenTitle(title);
}

/**
 * Page titles are written for search engines, not for a chip in a list: "GitHub · Change is
 * constant. GitHub keeps you ahead. · GitHub · GitHub" is the site's name plus its whole pitch.
 * The first segment is the name; the rest is kept only when there is no separator to cut at.
 */
function shortenTitle(title) {
  const flat = String(title).replace(/\s+/g, ' ').trim();
  if (flat.length <= 48) return flat;

  for (const separator of [' | ', ' · ', ' — ', ' - ']) {
    const [head] = flat.split(separator);
    const candidate = head.trim();
    if (candidate.length >= 3 && candidate.length < flat.length) return candidate;
  }

  /* No separator worth trusting: cut on a word boundary rather than mid-word. */
  const clipped = flat.slice(0, 48);
  const space = clipped.lastIndexOf(' ');
  return (space > 24 ? clipped.slice(0, space) : clipped).trimEnd();
}

async function handleAdd(event) {
  event.preventDefault();

  const url = addUrl.value.trim();
  const name = addName.value.trim();
  if (url === '') {
    /* Silence reads as a broken button. */
    refuseAdd('Type the address you want to keep, then Add.');
    return;
  }

  try {
    const { document: next, bookmark } = addBookmark(state.document, { url, name }, Date.now);
    state.document = next;
    addUrl.value = '';
    addName.value = '';
    cancelSearchClear();
    searchInput.value = '';
    render();
    setAddForm(false);
    saveNow();
    announce(`Added ${labelOf(bookmark)}`);
    fetchAndStoreIcon(bookmark.id, bookmark.hostname);

    /* Submitting before the suggestion arrived leaves the host as the label; if the site does
       have a name, put it in — unless one was typed meanwhile. */
    if (bookmark.name === '') {
      fetchPageTitle(bookmark.hostname)
        .then((title) => {
          if (!title) return;
          const current = findBookmark(bookmark.id);
          if (!current || current.name !== '') return;
          state.document = updateBookmark(state.document, bookmark.id, { name: shortenTitle(title) }, Date.now);
          render();
          saveNow();
        })
        .catch(() => {});
    }
  } catch (error) {
    if (error.code === 'DUPLICATE') {
      cancelSearchClear();
      searchInput.value = '';
      render();
      const row = list.querySelector(`[data-id="${CSS.escape(error.existingId)}"]`);
      const label = row ? labelOf(findBookmark(error.existingId)) : 'That address';
      row?.scrollIntoView({ block: 'center' });
      row?.classList.add('flash');
      setTimeout(() => row?.classList.remove('flash'), 1400);
      /* Clear the field so the next Add is not the same refusal again, and put the person on the row that has it. */
      addUrl.value = '';
      addUrl.removeAttribute('aria-invalid');
      announce(`“${label}” is already saved.`);
      row?.querySelector('.row-link')?.focus();
      return;
    }
    refuseAdd(refusalFor(url, error));
  }
}

/**
 * Say what is wrong with the address, mark the field, and put the cursor back in it — the message used to be a
 * lowercase fragment in a corner while the field looked untouched.
 */
function refuseAdd(message) {
  addUrl.setAttribute('aria-invalid', 'true');
  addUrl.classList.add('invalid');
  announce(message);
  addUrl.focus();
  addUrl.select();
}

/** A refusal in a sentence, naming what was typed instead of restating the parser's own words. */
function refusalFor(url, error) {
  const typed = url.length > 60 ? `${url.slice(0, 60)}…` : url;
  const said = clean(error?.message ?? '');
  if (/not a bookmark scheme/.test(said)) {
    return `“${typed}” is not a page address. Only http and https links can be kept.`;
  }
  if (/has no host|not a URL/.test(said)) return `“${typed}” is not a page address — it has no site in it.`;
  if (/at most/.test(said)) return 'That address is too long to keep.';
  return said || 'That address could not be added.';
}

function removeBookmark(bookmark) {
  state.document = deleteBookmark(state.document, bookmark.id, Date.now);
  state.lastDeleted = bookmark;
  render();
  saveNow();
  announce(`Deleted ${labelOf(bookmark)}`, {
    action: 'Undo',
    duration: 6000,
    onAction: () => {
      const deleted = state.lastDeleted;
      if (!deleted) return;
      state.lastDeleted = null;
      try {
        const { document: next } = addBookmark(
          state.document,
          {
            url: deleted.url,
            name: deleted.name,
            clickCount: deleted.clickCount,
            pinned: deleted.pinned,
            hideLabel: deleted.hideLabel,
            icon: deleted.icon,
            color: deleted.color
          },
          Date.now
        );
        state.document = next;
        render();
        saveNow();
        announce(`Restored ${labelOf(deleted)}`);
      } catch (error) {
        announce(clean(error.message));
      }
    }
  });
}

async function fetchAndStoreIcon(id, hostname) {
  const icon = await fetchIcon(hostname).catch(() => null);
  if (!icon) return;

  const bookmark = findBookmark(id);
  if (!bookmark || bookmark.icon) return;

  state.document = updateBookmark(state.document, id, { icon }, Date.now);
  render();
  saveNow();
}

/* When each host was last asked for an icon. Kept on the device rather than in the vault: it is
   a local courtesy about retries, not something worth syncing or sealing. It is keyed by a digest
   of the hostname so the stored index names no site in the clear. */
function readIconTries() {
  try {
    const raw = localStorage.getItem(ICON_TRIES_KEY);
    const value = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== 'object') return {};
    const { kept, dropped } = pruneIconTries(value);
    /* A map written before the digest existed, or one holding a malformed entry, is rewritten
       without it rather than left in place until the season turns over. */
    if (dropped > 0) writeIconTries(kept);
    return kept;
  } catch {
    return {};
  }
}

function writeIconTries(tries) {
  try {
    /* The map is one entry per host ever asked; anything older than a season is noise. */
    const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
    const kept = Object.fromEntries(
      Object.entries(tries).filter(([, at]) => Number.isFinite(Number(at)) && Number(at) >= cutoff)
    );
    localStorage.setItem(ICON_TRIES_KEY, JSON.stringify(kept));
  } catch {
    /* Storage refused; the next launch simply asks again. */
  }
}

async function fetchMissingIcons({ announceDone = true, onlyHosts = null } = {}) {
  if (iconsBusy) return 0;

  const missing = state.document.bookmarks.filter((bookmark) => !bookmark.icon);
  if (missing.length === 0) {
    if (announceDone) announce('Every bookmark already has an icon.');
    return 0;
  }

  /* One request per host. A library repeats a few domains, and the Worker caches per hash, so
     asking once per bookmark only buys the same answer twice inside this page. */
  const byHost = new Map();
  for (const bookmark of missing) {
    const ids = byHost.get(bookmark.hostname);
    if (ids) ids.push(bookmark.id);
    else byHost.set(bookmark.hostname, [bookmark.id]);
  }

  const hosts = onlyHosts
    ? [...byHost.keys()].filter((hostname) => onlyHosts.includes(hostname))
    : [...byHost.keys()];
  if (hosts.length === 0) return 0;
  const tries = readIconTries();
  let done = 0;
  let added = 0;
  let unsavedBatches = 0;

  iconsBusy = true;
  try {
    /* Four at a time: enough to finish a library quickly, few enough that the Worker is not the
       thing that floods someone's server. */
    for (let at = 0; at < hosts.length; at += ICON_BATCH) {
      const batch = hosts.slice(at, at + ICON_BATCH);
      const fetched = await Promise.all(
        batch.map(async (hostname) => [
          hostname,
          await fetchIcon(hostname, { fresh: true }).catch(() => null)
        ])
      );

      const filled = fetched.filter(([, icon]) => typeof icon === 'string');
      if (filled.length > 0) {
        let next = state.document;
        for (const [hostname, icon] of filled) {
          for (const id of byHost.get(hostname) ?? []) {
            if (next.bookmarks.some((bookmark) => bookmark.id === id && !bookmark.icon)) {
              next = updateBookmark(next, id, { icon }, Date.now);
              added += 1;
            }
          }
        }
        state.document = next;
        render();

        /* Saving after every four icons would push the whole sealed blob fifty times for one
           import; this keeps the loss window small without that. */
        unsavedBatches += 1;
        if (unsavedBatches >= ICON_SAVE_EVERY) {
          await saveNow();
          unsavedBatches = 0;
        }
      }

      done += batch.length;
      setVaultStatus(`Fetching icons… ${done}/${hosts.length}`);

      /* A host that just answered — with an icon or not — is not worth asking again this week.
         Written per batch so a closed tab does not lose what it already spent. */
      const triedAt = Date.now();
      const keys = await Promise.all(batch.map((hostname) => hostKey(hostname)));
      for (const key of keys) tries[key] = triedAt;
      writeIconTries(tries);
    }

    if (unsavedBatches > 0) await saveNow();
    if (announceDone) announce(`Added ${added} icon${added === 1 ? '' : 's'}.`);
    return added;
  } finally {
    iconsBusy = false;
    updateStatusLine();
  }
}

/**
 * Icons that never arrived — a host with none, a fetch that failed while offline, an import cut
 * short by a closed tab — are topped up when the vault opens: a few hosts at a time, and no host
 * more than once a week. Quiet, because nobody asked for this run.
 */
async function scheduleIconTopUp() {
  if (!state.document) return;

  const missingHosts = [
    ...new Set(
      state.document.bookmarks.filter((bookmark) => !bookmark.icon).map((bookmark) => bookmark.hostname)
    )
  ];
  if (missingHosts.length === 0) return;

  const tries = readIconTries();
  const keys = await Promise.all(missingHosts.map((hostname) => hostKey(hostname)));
  const now = Date.now();
  const due = missingHosts.filter((hostname, at) => {
    const triedAt = Number(tries[keys[at]]);
    return !Number.isFinite(triedAt) || now - triedAt >= ICON_RETRY_AFTER_MS;
  });
  if (due.length === 0) return;

  /* After the first paint and the first sync, so the vault is usable before any of this starts. */
  setTimeout(() => {
    if (!state.document || state.document.bookmarks.length === 0) return;
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    fetchMissingIcons({ announceDone: false, onlyHosts: due.slice(0, ICON_TOPUP_HOSTS) });
  }, 3000);
}

async function removeAllIcons() {
  const at = new Date().toISOString();
  state.document = {
    ...state.document,
    bookmarks: state.document.bookmarks.map((bookmark) =>
      bookmark.icon ? { ...bookmark, icon: null, updatedAt: at } : bookmark
    )
  };
  render();
  await saveNow();
  announce('Icons removed.');
}

function openEditModal(bookmark) {
  const url = el('input', { type: 'text', value: bookmark.url, autocomplete: 'off', spellcheck: 'false' });
  const name = el('input', { type: 'text', value: bookmark.name, maxlength: 120, autocomplete: 'off' });
  const clicks = el('input', { type: 'number', value: String(bookmark.clickCount), min: '0', step: '1' });
  const pinned = el('input', { type: 'checkbox', checked: bookmark.pinned });
  const iconOnly = el('input', { type: 'checkbox', checked: bookmark.hideLabel });

  const error = el('p', { class: 'form-error', hidden: true });

  const saveButton = el('button', { class: 'button button-primary', type: 'button', text: 'Save' });
  const deleteButton = el('button', {
    class: 'button button-danger',
    type: 'button',
    text: 'Delete'
  });
  const cancelButton = el('button', { class: 'button button-quiet', type: 'button', text: 'Cancel' });

  const modal = openModal({
    title: 'Edit bookmark',
    body: [
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Address' }),
        url
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Name' }),
        name
      ]),
      el('label', { class: 'field' }, [
        /* Only the clicks made from this list are editable; the browser's own opens are counted and mirrored, so
           they cannot be typed over. */
        el('span', { class: 'field-label', text: 'Clicks from this list' }),
        clicks
      ]),
      el('label', { class: 'confirm-saved' }, [pinned, el('span', { text: 'Pin to the top' })]),
      el('label', { class: 'confirm-saved' }, [
        iconOnly,
        el('span', { text: 'Show as icon only' })
      ]),
      error
    ],
    actions: [deleteButton, cancelButton, saveButton]
  });

  cancelButton.addEventListener('click', () => modal.close());

  saveButton.addEventListener('click', () => {
    error.hidden = true;
    try {
      state.document = updateBookmark(
        state.document,
        bookmark.id,
        {
          url: url.value,
          name: name.value,
          clickCount: Number.parseInt(clicks.value, 10),
          pinned: pinned.checked,
          hideLabel: iconOnly.checked
        },
        Date.now
      );
      modal.close();
      render();
      saveNow();
      announce('Saved.');
    } catch (problem) {
      error.textContent = clean(problem.message);
      error.hidden = false;
    }
  });

  deleteButton.addEventListener('click', () => {
    modal.close();
    removeBookmark(bookmark);
  });

  url.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') saveButton.click();
  });
}

/**
 * A search is how one bookmark is found. Opening it schedules the field and the filtered list
 * to clear, so the person lands back on everything instead of a filter they no longer typed.
 *
 * Nothing is scheduled unless the query is actually narrowing the list, and typing again
 * cancels the pending clear. The callback re-checks both the query and the document, so a
 * render, a reload or a lock between the open and the delay leaves the field alone.
 */
function scheduleSearchClear() {
  if (!state.document || !searchNarrowsList(state.document, searchInput.value)) return;

  const query = searchInput.value;
  cancelSearchClear();
  searchClearTimer = setTimeout(() => {
    searchClearTimer = 0;
    if (!state.document || searchInput.value !== query) return;
    if (!searchNarrowsList(state.document, query)) return;
    searchInput.value = '';
    render();
  }, SEARCH_CLEAR_DELAY_MS);
}

function cancelSearchClear() {
  if (!searchClearTimer) return;
  clearTimeout(searchClearTimer);
  searchClearTimer = 0;
}

function handleListClick(event) {
  const button = event.target.closest('button[data-action]');
  if (button) {
    event.preventDefault();
    event.stopPropagation();

    const row = button.closest('.row');
    const bookmark = row ? findBookmark(row.dataset.id) : null;
    if (!bookmark) return;

    if (button.dataset.action === 'pin') {
      state.document = togglePin(state.document, bookmark.id, Date.now);
      render();
      saveNow();
      return;
    }

    if (button.dataset.action === 'edit') {
      openEditModal(bookmark);
      return;
    }

    if (button.dataset.action === 'remove') {
      removeBookmark(bookmark);
    }
    return;
  }


  /* A click on the link counts the visit. It is not prevented: the browser opens the tab, and
     the count is written behind it. The list re-sorts only after the click has been handled. */
  const link = event.target.closest('a.row-link');
  if (!link) return;

  const row = link.closest('.row');
  const bookmark = row ? findBookmark(row.dataset.id) : null;
  if (!bookmark) return;

  state.document = recordClick(state.document, bookmark.id, Date.now);
  const counter = row.querySelector('.clicks');
  if (counter) counter.textContent = String(bookmark.clickCount + 1);

  /* The browser has the page; the filtered list behind it is no longer being read. */
  scheduleSearchClear();

  const reorder = sortInput.value === 'clicks' || sortInput.value === 'lastClicked';
  setTimeout(() => {
    if (reorder && state.document) render();
  }, 900);

  saveNow();
}

/* --------------------------------------------------------------- import / export */

function download(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = el('a', { href: url, download: filename });
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function exportSealedBackup() {
  await saveNow();
  if (!state.sealed) {
    announce('The vault has not been saved yet.');
    return;
  }
  const envelope = exportSealed(state.sealed);
  download(`bookmarks-backup-${today()}.json`, JSON.stringify(envelope, null, 2), 'application/json');
  announce('Sealed backup downloaded.');
}

function exportPlainFile() {
  const envelope = exportPlain(state.document);
  download(`bookmarks-${today()}.json`, JSON.stringify(envelope, null, 2), 'application/json');
  announce('Plain export downloaded. It is not encrypted.');
}

function exportBrowserFile() {
  download(`bookmarks-${today()}.html`, exportBrowserBookmarks(state.document), 'text/html');
  announce('Browser bookmark file downloaded.');
}

async function handleImport() {
  const file = await pickFile('.json,.html,.htm,application/json,text/html');
  if (!file) return;

  const text = await file.text();
  let parsed;

  try {
    const looksLikeHtml = /netscape-bookmark-file|<a\s[^>]*href\s*=/i.test(text);
    parsed = looksLikeHtml ? importBrowserBookmarks(text) : importPlain(text);
  } catch (error) {
    announce(clean(error.message), { duration: 6000 });
    return;
  }

  if (parsed.document.bookmarks.length === 0) {
    announce('Nothing in that file could be imported.', { duration: 5000 });
    return;
  }

  /* Two different collisions, counted apart: the file repeating itself, and the file meeting
     what this vault already holds. Saying "duplicates 1" for either one is what made the dialog
     unreadable. */
  const incoming = parsed.document.bookmarks;
  const existingUrls = new Set(state.document.bookmarks.map((bookmark) => bookmark.url));
  const alreadyHere = incoming.filter((bookmark) => existingUrls.has(bookmark.url)).length;
  const fresh = incoming.length - alreadyHere;
  const repeats = parsed.statistics.repeats ?? [];
  const unreadable = parsed.statistics.skipped ?? 0;

  const choice = await new Promise((resolve) => {
    let settled = false;

    function finish(value) {
      if (settled) return;
      settled = true;
      modal.close();
      resolve(value);
    }

    const modal = openModal({
      title: 'Import bookmarks',
      body: [
        el('p', {
          class: 'modal-note',
          text: `That file holds ${incoming.length} bookmark${incoming.length === 1 ? '' : 's'}.`
        }),
        el('p', {
          class: 'modal-note',
          text:
            repeats.length === 0
              ? 'It lists every site once — no repeats inside the file.'
              : `${repeats.length} of them ${repeats.length === 1 ? 'is' : 'are'} the same site twice, so ${repeats.length === 1 ? 'it is' : 'they are'} kept once: ${repeats
                  .slice(0, 2)
                  .map((repeat) => repeat.url)
                  .join(', ')}${repeats.length > 2 ? ', …' : ''}.`
        }),
        el('p', {
          class: 'modal-note',
          text:
            alreadyHere === 0
              ? 'None of them are in this vault yet.'
              : fresh === 0
                ? `All ${alreadyHere} are already in this vault — nothing new to add.`
                : `${alreadyHere} ${alreadyHere === 1 ? 'is' : 'are'} already in this vault; Merge keeps your copy and adds the other ${fresh}.`
        }),
        ...(unreadable === 0
          ? []
          : [
              el('p', {
                class: 'modal-note',
                text: `${unreadable} could not be read and would be left out.`
              })
            ]),
        el('p', {
          class: 'modal-note',
          text: 'Merge keeps what this vault already has. Replace discards it and keeps only the file.'
        })
      ],
      actions: [
        el('button', {
          class: 'button button-quiet',
          type: 'button',
          text: 'Cancel',
          onclick: () => finish(null)
        }),
        el('button', {
          class: 'button button-danger',
          type: 'button',
          text: 'Replace',
          onclick: () => finish('replace')
        }),
        el('button', {
          class: 'button button-primary',
          type: 'button',
          text: 'Merge',
          onclick: () => finish('merge')
        })
      ],
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }
    });
  });

  if (!choice) return;

  if (choice === 'replace') {
    if (state.document.bookmarks.length > 0) {
      const sure = await askModal({
        title: 'Replace this vault?',
        body: [
          el('p', {
            class: 'modal-note',
            text: 'Every bookmark currently in this vault is removed and replaced by the file. This cannot be undone except from a backup.'
          })
        ],
        confirmLabel: 'Replace everything',
        danger: true
      });
      if (!sure) return;
    }
    state.document = parsed.document;
  } else {
    state.document = mergeInto(state.document, parsed.document).document;
  }

  render();
  await saveNow();
  announce(`Imported ${parsed.document.bookmarks.length} bookmarks.`);

  /* An imported file carries no icons of its own — the legacy URLs point at a third party and
     are deliberately not used — so the same fetch the Settings action runs starts here, without
     being asked for. */
  if (state.document.bookmarks.some((bookmark) => !bookmark.icon)) {
    fetchMissingIcons();
  }
}

/* ------------------------------------------------------------------ settings */

/**
 * A remembered device can sign in, but the account secret it would send to be registered is
 * only derivable from the phrase. It is asked for once, and the answer is kept the way the keys
 * are kept. The account id is derived from the phrase, so a wrong phrase simply derives another
 * vault.
 */
function promptForSyncPhrase() {
  return new Promise((resolve) => {
    const phrase = el('textarea', {
      class: 'phrase-input',
      rows: 3,
      autocomplete: 'off',
      autocapitalize: 'none',
      autocorrect: 'off',
      spellcheck: 'false'
    });
    const error = el('p', { class: 'form-error', hidden: true });
    const confirm = el('button', {
      class: 'button button-primary',
      type: 'button',
      text: 'Turn on sync'
    });
    const cancel = el('button', { class: 'button button-quiet', type: 'button', text: 'Cancel' });

    let settled = false;
    const modal = openModal({
      title: 'Turn on sync',
      body: [
        el('p', {
          class: 'modal-note',
          text: 'Enter the phrase once so this device can complete the sign-in. It is not stored on the server; what stays in this browser is a key that signs in, not the secret itself.'
        }),
        el('label', { class: 'field' }, [
          el('span', { class: 'field-label', text: 'Your 13-word phrase' }),
          phrase
        ]),
        error
      ],
      actions: [cancel, confirm],
      onClose: () => {
        if (!settled) {
          settled = true;
          resolve(null);
        }
      }
    });

    cancel.addEventListener('click', () => modal.close());
    confirm.addEventListener('click', async () => {
      error.hidden = true;
      confirm.disabled = true;
      confirm.textContent = 'Checking…';
      const typed = phrase.value;
      clearPhraseField(phrase);
      try {
        const { accountId, authSecret, authKey } = await deriveAccount(typed);
        if (accountId !== state.accountId) {
          throw new Error('That phrase belongs to a different vault.');
        }
        settled = true;
        resolve({ authSecret, authKey });
        modal.close();
      } catch (problem) {
        error.textContent = clean(problem.message);
        error.hidden = false;
        confirm.disabled = false;
        confirm.textContent = 'Turn on sync';
      }
    });
  });
}

function openSettings() {
  const count = state.document.bookmarks.length;
  const missingIcons = state.document.bookmarks.filter((bookmark) => !bookmark.icon).length;

  const sizeSelect = el('select', {}, [
    el('option', { value: 'small', text: 'Small' }),
    el('option', { value: 'medium', text: 'Medium' }),
    el('option', { value: 'large', text: 'Large' })
  ]);
  sizeSelect.value = currentSize;
  sizeSelect.addEventListener('change', () => {
    currentSize = SIZES.has(sizeSelect.value) ? sizeSelect.value : 'medium';
    writePref(SIZE_KEY, currentSize);
    applyAppearance();
  });

  /* On its own origin the app can no longer inherit the site's saved theme, so it carries the
     same ten names and the same key. */
  /* No "light": a bookmark list is read in the dark, and the picker does not offer what this page will not go back to. */
  const THEMES = [
    'current', 'amber', 'teal', 'charcoal',
    'greenish', 'colorful', 'sunset', 'nord', 'cyberpunk'
  ];
  const themeSelect = el('select', {}, THEMES.map((name) => el('option', { value: name, text: name })));
  themeSelect.value = THEMES.includes(document.documentElement.dataset.theme)
    ? document.documentElement.dataset.theme
    : 'current';
  themeSelect.addEventListener('change', () => {
    const value = THEMES.includes(themeSelect.value) ? themeSelect.value : 'current';
    try {
      localStorage.setItem('site-theme', value);
    } catch {
      /* The choice applies for this session only. */
    }
    document.documentElement.dataset.theme = value;
  });

  const item = (title, detail, onClick, { danger = false } = {}) => {
    const button = el('button', {
      class: `settings-item${danger ? ' button-danger' : ''}`,
      type: 'button'
    }, [el('strong', { text: title }), el('span', { text: detail })]);
    button.addEventListener('click', onClick);
    return button;
  };

  /* A change says so in its own row instead of closing the sheet and opening it again: the sheet used to jump back to
     the top on every switch, which is what made it feel like a form. */
  const savedTick = (row) => {
    if (!row) return;
    row.classList.add('just-saved');
    const tick = el('span', { class: 'settings-saved', text: 'Saved' });
    row.append(tick);
    setTimeout(() => {
      tick.remove();
      row.classList.remove('just-saved');
    }, 1600);
  };

  /* A place to jump to. The chips are drawn after the sheet is built, from the headings it made. */
  const chipsHost = el('div', { class: 'settings-chips', 'aria-label': 'Settings sections' });
  const sections = [];
  const heading = (text) => {
    const node = el('h3', { class: 'settings-heading', text });
    sections.push({ text, node });
    return node;
  };

  /* A list that changed shape (a rule removed, a rule added) has to be drawn again, so it is — at the same place. */
  const rebuild = () => {
    const scroll = modal.dialog.querySelector('.modal-body')?.scrollTop ?? 0;
    modal.close();
    const next = openSettings();
    const body = next.dialog.querySelector('.modal-body');
    if (body) body.scrollTop = scroll;
  };

  /* ---- the collected-links controls ---- */

  const collector = collectorPrefs();

  const collectorChoice = (label, options, value, onPick) => {
    const select = el('select', {}, options.map(([option, text]) => el('option', { value: option, text })));
    select.value = value;
    const row = el('label', { class: 'settings-item settings-control' }, [el('strong', { text: label }), select]);
    select.addEventListener('change', () => {
      onPick(select.value);
      savedTick(row);
    });
    return row;
  };

  const collectorToggle = (label, detail, checked, onToggle) => {
    const box = el('input', { type: 'checkbox' });
    box.checked = checked;
    const row = el('label', { class: 'settings-item settings-control' }, [
      el('strong', { text: label }),
      el('span', { text: detail }),
      box
    ]);
    box.addEventListener('change', () => {
      onToggle(box.checked);
      savedTick(row);
    });
    return row;
  };

  const collectorRemove = (label, onRemove) => {
    const button = el('button', { class: 'icon-button', type: 'button', 'aria-label': label, title: label });
    button.append(icon('remove'));
    button.addEventListener('click', () => {
      onRemove();
      rebuild();
    });
    return button;
  };

  const askForRule = async ({ title, fieldLabel, placeholder, options, confirmLabel }) => {
    const field = el('input', { type: 'text', placeholder, 'aria-label': fieldLabel });
    const select = el('select', {}, options.map(([value, text]) => el('option', { value, text })));
    const sure = await askModal({ title, body: [field, select], confirmLabel });
    if (!sure) return null;

    const value = field.value.trim().toLowerCase();
    if (value === '') return null;
    return { value, choice: select.value };
  };

  async function addSiteRule() {
    modal.close();
    const answer = await askForRule({
      title: 'Record a site differently',
      fieldLabel: 'Site',
      placeholder: 'youtube.com',
      options: [
        ['hosts', 'One row per hostname'],
        ['domains', 'One row for the whole site'],
        ['addresses', 'Every page']
      ],
      confirmLabel: 'Save'
    });
    if (answer === null) return;

    setCollectorPrefs({
      sites: [...collector.sites.filter((rule) => rule.site !== answer.value), { site: answer.value, level: answer.choice }]
    });
    rebuild();
  }

  async function addExclusion() {
    modal.close();
    const answer = await askForRule({
      title: 'Never collect this',
      fieldLabel: 'Site, hostname or path',
      placeholder: 'bank.example/statements',
      options: [
        ['site', 'The site and every subdomain'],
        ['host', 'Exactly this hostname'],
        ['path', 'This hostname and this path']
      ],
      confirmLabel: 'Exclude'
    });
    if (answer === null) return;

    setCollectorPrefs({
      exclude: [...collector.exclude, { scope: answer.choice, value: answer.value }]
    });
    rebuild();
  }

  /* A fact about the account, not an action: no press, and a dash where the vault has no such
     moment. Both are read on this device's clock, so the hour is the hour the owner sees. The
     value element is kept so it can be filled when the account answers later. */
  const stampRows = [];
  const stampRow = (title, read) => {
    const value = el('span', { text: formatStamp(read()) });
    stampRows.push({ read, value });
    return el('div', { class: 'settings-item settings-stamp' }, [
      el('strong', { text: title }),
      value
    ]);
  };

  /* A session lives only in memory, so a reload leaves the account's dates unknown until the next
     sign-in. Opening Settings asks for them once, rather than showing a dash until something else
     happens to sync. A failure leaves the dashes in place and says nothing. */
  const fillStamps = async () => {
    if (!syncEnabled() || (vaultCreatedAt && lastActivityAt)) return;
    try {
      if (!sync.signedIn) applyPlan(await sync.login(state.accountId, authMaterial()));
      for (const row of stampRows) row.value.textContent = formatStamp(row.read());
    } catch {
      /* The dash stands for "not known on this device yet". */
    }
  };

  const bodyNodes = [
      chipsHost,
      el('p', {
        class: 'modal-note',
        text: `${count} ${count === 1 ? 'bookmark' : 'bookmarks'} in this vault · version ${state.version} · ${planLabel()}.`
      }),
      el('p', {
        class: 'modal-note',
        text: 'Sync keeps a sealed copy on the server. Your local vault never expires.'
      }),
      heading('Account'),
      el('div', { class: 'settings-list' }, [
        stampRow('Vault created', () => vaultCreatedAt),
        stampRow('Last activity', () => lastActivityAt)
      ]),
      heading('Appearance'),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Text size' }),
        sizeSelect
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Theme' }),
        themeSelect
      ]),
      heading('Export'),
      el('div', { class: 'settings-list' }, [
        item('Sealed backup', 'Encrypted. Restores with the same 13 words.', async () => {
          await exportSealedBackup();
          modal.close();
        }),
        item('Plain JSON', 'Unencrypted. Portable, and readable by anyone who has the file.', () => {
          exportPlainFile();
          modal.close();
        }),
        item('Browser bookmarks', 'An HTML file any browser can import.', () => {
          exportBrowserFile();
          modal.close();
        })
      ]),
      heading('Import'),
      el('div', { class: 'settings-list' }, [
        item('A JSON or HTML file', 'Your old sites.json, a plain export, or a browser file.', () => {
          modal.close();
          handleImport();
        })
      ]),
      heading('Collected links'),
      el('div', { class: 'settings-list' }, [
        (() => {
          const strong = el('strong', {
            text: collector.enabled ? 'Collection: on' : 'Collect links on this device'
          });
          const detail = el('span', {
            text: collector.enabled
              ? 'Counting addresses on this device. Add one to keep it in the vault.'
              : 'Off by default. Nothing leaves this browser.'
          });
          const box = el('input', { type: 'checkbox' });
          box.checked = collector.enabled;
          const row = el('label', { class: 'settings-item settings-control', 'data-setting': 'collector-enabled' }, [
            strong,
            detail,
            box
          ]);

          box.addEventListener('change', () => {
            setCollectorPrefs({ enabled: box.checked });
            strong.textContent = box.checked ? 'Collection: on' : 'Collect links on this device';
            detail.textContent = box.checked
              ? 'Counting addresses on this device. Add one to keep it in the vault.'
              : 'Off by default. Nothing leaves this browser.';
            savedTick(row);
          });
          return row;
        })(),
        collectorChoice(
          'Record each site as',
          [
            ['addresses', 'Every page'],
            ['hosts', 'One row per hostname'],
            ['domains', 'One row for the whole site']
          ],
          collector.level,
          (value) => setCollectorPrefs({ level: value })
        ),
        collectorToggle('Group by domain', 'Show a site and its hostnames as a nested list instead of one ranking.', collector.grouped, (checked) =>
          setCollectorPrefs({ grouped: checked })
        ),
        ...collector.sites.map((rule) =>
          el('div', { class: 'settings-item settings-rule' }, [
            el('strong', { text: rule.site }),
            el('span', { text: RECORD_LABELS[rule.level] ?? rule.level }),
            collectorRemove(`Stop recording ${rule.site} differently`, () =>
              setCollectorPrefs({ sites: collector.sites.filter((entry) => entry.site !== rule.site) })
            )
          ])
        ),
        ...collector.exclude.map((rule) =>
          el('div', { class: 'settings-item settings-rule' }, [
            el('strong', { text: rule.value }),
            el('span', { text: `never collect — ${EXCLUDE_LABELS[rule.scope] ?? rule.scope}` }),
            collectorRemove(`Stop excluding ${rule.value}`, () =>
              setCollectorPrefs({ exclude: collector.exclude.filter((entry) => entry !== rule) })
            )
          ])
        ),
        collectorToggle(
          'Include private windows',
          'Off by default. The browser also has to allow this extension in private windows, at the extensions page.',
          collector.includeIncognito,
          (checked) => setCollectorPrefs({ includeIncognito: checked })
        ),
        collectorChoice(
          'Keep collected links for',
          [
            ['7', 'A week'],
            ['30', 'A month'],
            ['60', 'Two months'],
            ['365', 'A year'],
            ['0', 'Until I clear them']
          ],
          String(collector.retentionDays),
          (value) => setCollectorPrefs({ retentionDays: Number(value) })
        ),
        collectorChoice(
          'Keep at most',
          [
            ['500', '500 addresses'],
            ['2000', '2,000 addresses'],
            ['5000', '5,000 addresses'],
            ['0', 'No limit']
          ],
          String(collector.maxEntries),
          (value) => setCollectorPrefs({ maxEntries: Number(value) })
        ),
        collectorChoice(
          'New addresses a day',
          [
            ['0', 'No limit'],
            ['50', '50 a day'],
            ['100', '100 a day'],
            ['250', '250 a day']
          ],
          String(collector.dailyCap),
          (value) => setCollectorPrefs({ dailyCap: Number(value) })
        ),
        collectorChoice(
          'Show rows seen at least',
          [
            ['1', 'Once'],
            ['2', 'Twice'],
            ['3', 'Three times']
          ],
          String(collector.minVisits),
          (value) => setCollectorPrefs({ minVisits: Number(value) })
        ),
        item('Add a site rule', 'Record one site at a level of its own — a video site as hostnames, everything else page by page.', addSiteRule),
        item('Exclude a site or a page', 'Never collect a site, a hostname, or one path.', addExclusion),
        item('Clear collected links', 'Delete every address the extension counted on this device. Bookmarks are untouched.', async () => {
          const sure = await askModal({
            title: 'Clear what was collected?',
            body: [
              el('p', {
                class: 'modal-note',
                text: 'Every address the extension counted on this device is deleted, along with the day’s counter. Your bookmarks are untouched, and collection keeps running with the settings above.'
              })
            ],
            confirmLabel: 'Clear',
            danger: true
          });
          if (!sure) return;

          await collectorBridge.clear();
          modal.close();
          await loadCollected();
          announce('Collected links cleared.');
        })
      ]),
      heading('Icons'),
      el('div', { class: 'settings-list' }, [
        item(
          'Fetch missing icons',
          `${missingIcons} without an icon. This server asks each site for its icon, and asks again in a week if there is none. The image is stored inside the sealed vault.`,
          async () => {
            modal.close();
            await fetchMissingIcons();
          }
        ),
        item('Remove icons', 'Delete every stored icon and go back to lettered tiles.', async () => {
          modal.close();
          const sure = await askModal({
            title: 'Remove every icon?',
            body: [
              el('p', {
                class: 'modal-note',
                text: 'The icons are deleted from the sealed vault and the lettered tiles come back. Bookmarks themselves are untouched.'
              })
            ],
            confirmLabel: 'Remove icons',
            danger: true
          });
          if (sure) await removeAllIcons();
        })
      ]),
      heading('Server'),
      el('div', { class: 'settings-list' }, [
        item(
          `Sync: ${syncEnabled() ? 'on' : 'off'}`,
          syncEnabled()
            ? 'This vault is copied to the server as a sealed blob it cannot read.'
            : 'Keep this vault on this device only.',
          async () => {
            const enable = !syncEnabled();
            modal.close();

            if (enable && typeof state.authSecret !== 'string') {
              const derived = await promptForSyncPhrase();
              if (!derived) return;

              state.authSecret = derived.authSecret;
              state.authKey = derived.authKey;
              /* The remembered record takes the signing key: the secret the server is given is
                 the one value that must not be written to this device. */
              const remembered = await store.readRemembered();
              if (remembered) await store.remember(state.accountId, remembered.key, derived.authKey);
            }

            setPrefs({ sync: enable });
            render();
            await saveNow({ push: false });

            if (!syncEnabled()) {
              await sync.logout();
              setSyncStatus('');
              clearSyncRefusal({ reset: true });
              return;
            }
            clearSyncRefusal({ reset: true });
            await syncNow();
          }
        ),
        item('Sync now', 'Reconcile with the server immediately.', async () => {
          modal.close();
          if (!syncEnabled()) {
            announce('Sync is off.');
            return;
          }
          await syncNow();
          announce(syncLabel || 'Synced.');
        }),
        item('Connected places', placesDetail(), async () => {
          modal.close();
          await openPlaces();
        }),
        item(
          'Account id',
          state.accountId ?? 'not signed in',
          async () => {
            if (!state.accountId) return;
            try {
              await navigator.clipboard.writeText(state.accountId);
              announce('Account id copied. It names this account; it cannot log in.');
            } catch {
              announce(`Account id: ${state.accountId}`, { duration: 8000 });
            }
          }
        )
      ]),
      heading('This device'),
      el('div', { class: 'settings-list' }, [
        item('Lock the vault', 'Forget the key on this device until the phrase is entered again.', async () => {
          modal.close();
          await lockVault();
        }),
        item('Clear this device', 'Delete the sealed vault, its history and this device’s local settings from this browser.', async () => {
          modal.close();
          const sure = await askModal({
            title: 'Clear this device?',
            body: [
              el('p', {
                class: 'modal-note',
                text: 'The sealed vault, its local history, the remembered key and the settings this page keeps on this device are deleted from this browser. The bookmark list is not recoverable without a backup or the phrase.'
              })
            ],
            confirmLabel: 'Clear this device',
            danger: true
          });
          if (!sure) return;
          await store.clear();
          clearDeviceStorage();
          /* Another tab still holds the key and would write the vault back to this device. */
          lockSignal.broadcast();
          location.reload();
        }, { danger: true })
      ]),
      el('p', {
        class: 'modal-note',
        text: 'The vault is sealed in this browser with AES-256-GCM. The server holds the sealed copy, an account record with dates, plan and size, and the list of signed-in devices.'
      }),
  ];

  /* One section at a time. The sheet had grown into thirty rows in one column, and a map that shows every street at
     once is a wall: the chips became doors, and each door opens onto the handful of controls that belong together. */
  const BY_HEADING = {
    Account: 'vault',
    Appearance: 'vault',
    Export: 'vault',
    Import: 'vault',
    Icons: 'vault',
    'Collected links': 'collected',
    Server: 'sync',
    'This device': 'device'
  };
  const PLAN = [
    ['vault', 'Vault'],
    ['collected', 'Collected links'],
    ['sync', 'Sync'],
    ['device', 'This device']
  ];

  const groups = new Map(PLAN.map(([key, label]) => [key, { label, nodes: [] }]));
  const headerNodes = [];
  let bucket = null;

  for (const node of bodyNodes) {
    if (node.classList?.contains('settings-heading')) bucket = BY_HEADING[node.textContent] ?? bucket;
    if (bucket === null) headerNodes.push(node);
    else groups.get(bucket).nodes.push(node);
  }

  /* The chips are a map, not a door: every section stays on the page, open, always. Nothing in this sheet hides
     another part of it — a jump moves the reader to a place, it never closes the rest. */
  const goToSection = (key) => {
    groups.get(key)?.node.scrollIntoView({ block: 'start', behavior: 'smooth' });
    for (const chip of chipsHost.querySelectorAll('.settings-chip')) {
      chip.classList.toggle('is-current', chip.dataset.section === key);
    }
  };

  for (const [key, { label, nodes }] of groups) {
    const node = el('section', { class: 'settings-section', 'data-section': key }, nodes);
    groups.get(key).node = node;
    const chip = el('button', { class: 'settings-chip', type: 'button', text: label });
    chip.dataset.section = key;
    chip.addEventListener('click', () => goToSection(key));
    chipsHost.append(chip);
  }

  const modal = openModal({
    title: 'Settings',
    body: [chipsHost, ...headerNodes, ...[...groups.values()].map((group) => group.node)]
  });

  /* The first chip is marked as a starting point; it hides nothing. */
  chipsHost.firstChild?.classList.add('is-current');

  /* Two columns where the sheet has the room, and the keyboard lands on the first control of the open section. */
  modal.dialog.classList.add('settings-modal');
  modal.dialog.querySelector('.settings-section select, .settings-section input, .settings-section button')?.focus();

  fillStamps();
}

/**
 * Drops the key, the open document and the session, here and in every other tab.
 *
 * The page's own state goes first, before the first await: a save that is already in flight
 * checks `state.key`, and a tab that has been told to lock must not seal one more snapshot on its
 * way out. `sync.logout()` and `store.forget()` then take the session and the remembered key off
 * the device. Only the tab that started the lock broadcasts — a tab that hears the signal runs
 * this with `broadcast: false`, so the message cannot travel back and forth.
 */
async function lockVault({ broadcast = true } = {}) {
  state.accountId = null;
  state.authKey = null;
  state.authSecret = null;
  state.key = null;
  state.version = 0;
  state.remoteVersion = 0;
  state.sealed = null;
  state.document = null;
  state.lastDeleted = null;
  saveStamp = '';
  syncLabel = '';
  lastSyncedAt = 0;
  plan = null;
  units = 0;
  vaultCreatedAt = null;
  lastActivityAt = null;
  list.replaceChildren();
  clearStatus();
  showLock('Locked. Enter your phrase to reopen the vault.', { hasVault: true });

  if (broadcast) lockSignal.broadcast();

  await sync.logout();
  await store.forget();
}

/* --------------------------------------------------------------------- boot */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const { protocol, hostname } = location;
  if (protocol !== 'https:' && hostname !== 'localhost' && hostname !== '127.0.0.1') return;

  navigator.serviceWorker.register('/w/bookmarks/sw.js', { scope: '/w/bookmarks/' }).catch(() => {
    /* Offline caching is an enhancement; the app works without it. */
  });
}

function bindEvents() {
  lockForm.addEventListener('submit', handleUnlock);
  newVaultButton.addEventListener('click', openCreateModal);
  restoreButton.addEventListener('click', handleRestore);

  /* The toolbar has carried a lock button with no handler bound to it: drawn, named, and inert. */
  lockButton.addEventListener('click', () => void lockVault());
  syncRefusalDismiss.addEventListener('click', () => {
    syncRefusalDismissed = true;
    syncRefusal.hidden = true;
  });

  addForm.addEventListener('submit', handleAdd);
  /* Open, it means "type here" — pressing it used to close the form being typed in and lose the words. */
  addToggle.addEventListener('click', () => {
    if (addForm.hidden) setAddForm(true);
    else addUrl.focus();
  });
  addCancel.addEventListener('click', () => setAddForm(false));

  /* Suggest the site's own name once the address is settled, and stand out of the way the moment
     a name is typed. */
  addUrl.addEventListener('blur', suggestName);
  addUrl.addEventListener('input', () => {
    addUrl.removeAttribute('aria-invalid');
    addUrl.classList.remove('invalid');
  });
  addName.addEventListener('input', () => {
    nameTouched = true;
    delete addName.dataset.suggesting;
  });
  list.addEventListener('click', handleListClick);

  searchInput.addEventListener('input', () => {
    cancelSearchClear();
    render();
  });

  sortInput.addEventListener('change', () => {
    setPrefs({ sort: sortInput.value });
    render();
    saveNow();
  });

  settingsButton.addEventListener('click', openSettings);

  viewToggle.addEventListener('click', switchView);

  document.addEventListener('keydown', (event) => {
    if (activeModal) return;

    const target = event.target;
    const typing =
      target instanceof HTMLElement &&
      (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

    if (event.key === '/' && !typing) {
      event.preventDefault();
      searchInput.focus();
      return;
    }

    if (event.key === 'n' && !typing && state.key) {
      event.preventDefault();
      setAddForm(true);
      return;
    }

    if (event.key === 'Escape' && !addForm.hidden) {
      event.preventDefault();
      setAddForm(false);
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });

  /* Another tab locked. Drop this tab's key too, without telling anyone else. */
  lockSignal.watch(() => {
    void lockVault({ broadcast: false });
  });

  window.addEventListener('online', () => {
    if (syncEnabled()) syncNow();
  });

  /* A phrase pasted with line breaks would otherwise fail as a 1-word phrase. */
  phraseInput.addEventListener('paste', () => {
    setTimeout(() => {
      phraseInput.value = phraseInput.value.replace(/\s+/g, ' ').trim();
    }, 0);
  });
}

function boot() {
  bindEvents();
  applyAppearance();
  registerServiceWorker();
  takeCollectorSetupLink();
  tryRemembered();
}

boot();
