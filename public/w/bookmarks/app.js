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
  togglePin,
  updateBookmark
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
let trialEndsAt = null;
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
const vaultStatus = $('vault-status');
const status = $('status');
const planNote = $('plan-note');
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
  document.documentElement.dataset.size = currentSize;
  renderViewToggle();
  /* Pills are for opening pages; editing and deleting live in the list, so say where they are. */
  viewHint.hidden =
    currentView !== 'pills' || (state.document?.bookmarks.length ?? 0) === 0;
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
      body?.querySelector('input, textarea, select, .button-primary, button') ??
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
  statusTimer = setTimeout(() => status.classList.remove('visible'), duration);
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

function trialDaysLeft() {
  if (typeof trialEndsAt !== 'number') return null;
  return Math.ceil((trialEndsAt - Date.now()) / 86_400_000);
}

function applyPlan(payload) {
  plan = payload?.plan ?? null;
  units = Number.isInteger(payload?.units) ? payload.units : 0;
  trialEndsAt = typeof payload?.trialEndsAt === 'number' ? payload.trialEndsAt : null;
  if (Number.isInteger(payload?.places)) placesCount = payload.places;
  /* The same answer carries the account's own dates, so Settings needs no second request. Only a
     proof of the phrase receives them, and this client has one by the time it reads them. */
  vaultCreatedAt = typeof payload?.createdAt === 'number' ? payload.createdAt : null;
  lastActivityAt = typeof payload?.lastSeenAt === 'number' ? payload.lastSeenAt : null;
  renderPlanNote();
}

/** The owner and paying accounts carry no banner; a free trial carries a live countdown. */
function renderPlanNote() {
  if (!syncEnabled() || !plan || plan === 'owner' || plan === 'paid') {
    planNote.hidden = true;
    return;
  }

  const days = trialDaysLeft();
  planNote.hidden = false;
  planNote.classList.toggle('ended', days !== null && days <= 0);

  if (days === null) {
    planNote.textContent = 'Free sync.';
    return;
  }
  if (days <= 0) {
    planNote.textContent =
      'Free sync has ended. Your bookmarks are still on this device — export a sealed backup from Settings before the server copy is deleted.';
    return;
  }
  planNote.textContent = `Free sync · ${days} day${days === 1 ? '' : 's'} left. Your bookmarks stay on this device either way.`;
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
  if (plan === 'free') {
    const days = trialDaysLeft();
    return days !== null && days > 0 ? `free trial · ${days} days left` : 'free trial ended · read-only';
  }
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
  if (failure.kind === 'trial') {
    trialEndsAt = Date.now();
    renderPlanNote();
    setSyncStatus(failure.label);
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

  if (syncEnabled()) syncNow();
  /* A top-up that cannot read its own index is not an error worth showing: the next launch
     simply asks again. */
  scheduleIconTopUp().catch(() => {});
  if (runningVersion === '') loadVersion();
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

function actionButton(action, label, iconName, { pressed = false } = {}) {
  const button = el('button', {
    class: `icon-button${pressed ? ' pinned' : ''}`,
    type: 'button',
    'aria-label': label,
    title: label
  });
  button.dataset.action = action;
  if (pressed) button.setAttribute('aria-pressed', 'true');
  button.append(icon(iconName));
  return button;
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

  const host = el('span', { class: 'row-host', text: bookmark.hostname });

  const clicks = el('span', {
    class: 'clicks',
    text: String(bookmark.clickCount),
    'aria-label': `${bookmark.clickCount} clicks`
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
    el('span', { class: 'clicks', text: 'Clicks' }),
    el('span', { class: 'row-when', text: 'Last used' }),
    el('span')
  ]);

  list.replaceChildren(head, ...sorted.map(rowFor));

  empty.hidden = sorted.length !== 0;
  empty.textContent =
    state.document.bookmarks.length === 0
      ? 'No bookmarks yet. Add one above, or import a file from Settings.'
      : `No bookmark matches “${query.trim()}”.`;

  updateStatusLine();
  viewHint.hidden = currentView !== 'pills' || sorted.length === 0;
}

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
    addUrl.focus();
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
      row?.scrollIntoView({ block: 'center' });
      row?.classList.add('flash');
      setTimeout(() => row?.classList.remove('flash'), 1400);
      announce('That address is already bookmarked.');
      return;
    }
    announce(clean(error.message));
    addUrl.focus();
  }
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
        el('span', { class: 'field-label', text: 'Clicks' }),
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
  const THEMES = [
    'current', 'light', 'amber', 'teal', 'charcoal',
    'greenish', 'colorful', 'sunset', 'nord', 'cyberpunk'
  ];
  const themeSelect = el('select', {}, THEMES.map((name) => el('option', { value: name, text: name })));
  themeSelect.value = document.documentElement.dataset.theme || 'current';
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

  const modal = openModal({
    title: 'Settings',
    body: [
      el('p', {
        class: 'modal-note',
        text: `${count} bookmarks in this vault · version ${state.version} · ${planLabel()}.`
      }),
      el('h3', { class: 'settings-heading', text: 'Account' }),
      el('div', { class: 'settings-list' }, [
        stampRow('Vault created', () => vaultCreatedAt),
        stampRow('Last activity', () => lastActivityAt)
      ]),
      el('h3', { class: 'settings-heading', text: 'Appearance' }),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Text size' }),
        sizeSelect
      ]),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Theme' }),
        themeSelect
      ]),
      el('h3', { class: 'settings-heading', text: 'Export' }),
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
      el('h3', { class: 'settings-heading', text: 'Import' }),
      el('div', { class: 'settings-list' }, [
        item('A JSON or HTML file', 'Your old sites.json, a plain export, or a browser file.', () => {
          modal.close();
          handleImport();
        })
      ]),
      el('h3', { class: 'settings-heading', text: 'Icons' }),
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
      el('h3', { class: 'settings-heading', text: 'Server' }),
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
      el('h3', { class: 'settings-heading', text: 'This device' }),
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
      ...(runningVersion === ''
        ? []
        : [el('p', { class: 'modal-note settings-version', text: `Version ${runningVersion}` })])
    ]
  });

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
  trialEndsAt = null;
  vaultCreatedAt = null;
  lastActivityAt = null;
  planNote.hidden = true;
  list.replaceChildren();
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
  syncRefusalDismiss.addEventListener('click', () => {
    syncRefusalDismissed = true;
    syncRefusal.hidden = true;
  });

  addForm.addEventListener('submit', handleAdd);
  addToggle.addEventListener('click', () => setAddForm(addForm.hidden));
  addCancel.addEventListener('click', () => setAddForm(false));

  /* Suggest the site's own name once the address is settled, and stand out of the way the moment
     a name is typed. */
  addUrl.addEventListener('blur', suggestName);
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
  tryRemembered();
}

boot();
