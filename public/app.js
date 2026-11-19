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
  activityEvent,
  addBookmark,
  appendActivity,
  changedSlot,
  collectedIconFor,
  createDocument,
  deleteBookmark,
  filterBookmarks,
  fitActivity,
  fitIconTries,
  mergeDocuments,
  normaliseActivity,
  recordClick,
  searchNarrowsList,
  sortBookmarks,
  recordUses,
  togglePin,
  updateBookmark,
  useCount,
  useSplit,
  withCollectedIcon
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
  SIZE_KEY,
  VIEW_KEY,
  clearDeviceStorage,
  deviceId,
  forgetLegacyIconMaps,
  hostKey,
  pruneIconTries
} from './device-store.js';
import { createVault, indexedDbAdapter } from './vault.js';
import {
  MAX_IMPORT_BYTES,
  exportBrowserBookmarks,
  exportPlain,
  exportSealed,
  importBrowserBookmarks,
  importPlain,
  linkHref,
  mergeInto,
  parseSealed,
  sanitizeDocument
} from './import-export.js';
import { tileFor } from './tiles.js';
import {
  OUTCOME_VALUE,
  fetchIconOutcome,
  fetchPageTitle,
  isAnswer,
  retryDelayMs,
  stampAnswers
} from './icons.js';
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
  /* The phrase's own id: the PBKDF2 salt, the vault's associated data and this device's store key.
     It is what seals and saves, and it is not what the server calls the account. */
  accountId: null,
  /* The server's name for this account — the id its public key commits to — and the signing key
     that proves it. Both are absent on a device remembered before ids were committed to a key,
     and the phrase's own id is the name used then. */
  serverId: null,
  proofKey: null,
  /* The public half of the signing key, kept only until the account is created: the server is
     given it once and there is no reason to hold it after that. A vault reopened from a
     remembered record has `null` here, and that is what asks for the phrase when sync is turned
     on. */
  proofKeyText: null,
  /* The signing key, non-extractable, and the credential a phrase's own id is signed with: the
     account's base64url secret is the same bytes, so this key proves the same thing and cannot be
     read back out. The secret itself is never kept — the creation is described by `proofKeyText`
     and a sign-in by this key, so nothing on the page needs it. */
  authKey: null,
  /* The code an invite-only server asks for before it will create an account, and whether one is
     owed. Both live in memory for one attempt: a code is spent when it is used, so a copy kept
     anywhere would be a copy left behind. */
  invite: '',
  inviteNeeded: false,
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
/* Icon runs: four hosts are folded into the vault together, so a save is not pushed per icon. This
   number no longer decides how fast requests go out — the queue in icons.js does, paced by the
   Worker's own ceiling — and it is not a reason to think of the run as parallel. */
const ICON_BATCH = 4;
const ICON_SAVE_EVERY = 5;
/* A host that failed is not asked again on every launch: once a week, and only a few at a time.
   The index of when each host was asked lives in device-store.js, keyed by a digest. */
const ICON_RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
/* A refusal is not a failure of the host, so it is retried rather than stamped — this is how many
   times, at the pauses icons.js derives (`retryDelayMs`), before the next sweep takes over. */
const ICON_RETRY_ATTEMPTS = 3;
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

/**
 * The sentence the import dialog uses for an entry it cannot read, for the same loss when the
 * entry arrived with a document instead of a file: one refused URL is left out, never fatal.
 */
function droppedSentence(dropped) {
  return `${dropped} could not be read and ${dropped === 1 ? 'was' : 'were'} left out.`;
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
    const response = await fetch('/api/health', {
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
      /* A library near the free copy's size leaves the log less room; the oldest lines go before
         the seal, so the log can never be why a push is refused. */
      state.document = fitActivity(state.document);
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
  if (prefs.sync !== true) {
    clearSyncRefusal({ reset: true });
    forgetInvite();
  }
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

/**
 * Drop the invite question. A code opens one account and is spent doing it, so nothing about it
 * outlives the attempt it was typed for: turning Sync off or locking the vault ends the question.
 */
function forgetInvite() {
  state.invite = '';
  state.inviteNeeded = false;
}

/**
 * Give the code in the field to the creation route.
 *
 * `syncNow` reports its own failures and returns nothing, so the answer to "did this code open
 * the server" is the session it left behind: a refused code leaves the client signed out and the
 * refusal on the page, while an accepted one signs in before anything else can fail.
 */
async function submitInvite(code) {
  state.invite = code;
  await syncNow();
  /* A reconcile already in flight queued this one rather than running it, and the answer belongs
     to the attempt that actually ran. */
  while (syncBusy || syncQueued) {
    await new Promise((resolve) => {
      setTimeout(resolve, 40);
    });
  }
  return sync.signedIn;
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
    tombstones,
    activity: document.activity ?? []
  });
}

function scheduleSync() {
  if (!syncEnabled()) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncNow();
  }, 500);
}

/**
 * The one line that says what sync is doing.
 *
 * `retryAfter` is the server's own number when it asked to be left alone. It is kept on the
 * element rather than in the sentence because the person reading it does not need the count and
 * the next attempt does: anything that repaints this line without one has no wait to honour and
 * clears it.
 */
function setSyncStatus(label, { retryAfter = 0 } = {}) {
  syncLabel = label;
  if (retryAfter > 0) vaultStatus.dataset.retryAfter = String(retryAfter);
  else delete vaultStatus.dataset.retryAfter;
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

function placesSummary(count) {
  return `${count} ${count === 1 ? 'place is' : 'places are'} signed in to this account. Each signed in with the phrase; this list is account metadata — a session carries the sealed blob and nothing that opens it.`;
}

/** One row of the place list, with the action that ends that sign-in and nothing else. */
function placeRow(session, { modal, refresh }) {
  const name = placeName(session.client);
  const label = `${name}${session.current ? ' · this device' : ''}`;
  const row = el('li', { class: 'places-row' }, [
    el('strong', { text: label }),
    el('span', {
      text: `signed in ${whenTime(session.createdAt)} · last active ${whenTime(session.lastSeenAt)}`
    })
  ]);

  /* A place from before public ids existed has nothing to name it by, so it has no action. It
     still expires on its own. */
  if (!session.id) return row;

  const button = el('button', {
    class: 'button button-quiet places-signout',
    type: 'button',
    text: 'Sign out',
    /* The row's own sentence names the place, so the button does too: "Sign out" alone would be
       heard without saying which of several. */
    'aria-label': `Sign out ${label}`
  });
  button.addEventListener('click', () => {
    void revokePlace(session, { name, button, modal, refresh });
  });
  row.append(button);
  return row;
}

async function openPlaces() {
  if (!syncEnabled()) {
    announce('Sync is off, so this vault is not signed in anywhere.');
    return;
  }

  let data;
  try {
    if (!sync.signedIn) {
      const session = await signIn();
      applyPlan(session);
    }
    data = await sync.sessions();
  } catch (error) {
    if (error?.code === 'UNAUTHORIZED') {
      sync.token = null;
      announce('The session expired. Try again.');
      return;
    }
    if (error?.code === 'ACCOUNT_DELETED') {
      announce(deletedNotice().message, { duration: 8000 });
      return;
    }
    announce('Could not read the connected places.');
    return;
  }

  const note = el('p', { class: 'modal-note' });
  const rows = el('ul', { class: 'places-list' });
  const modal = openModal({ title: 'Connected places', body: [note, rows] });

  /* The list is painted from an answer, so the count, the rows and the "this device" mark always
     come from one reading of the server rather than from an edit made here. */
  const paint = (payload) => {
    placesCount = payload.count;
    note.textContent = placesSummary(payload.count);
    rows.replaceChildren(
      ...payload.sessions.map((session) => placeRow(session, { modal, refresh }))
    );
  };

  async function refresh() {
    try {
      paint(await sync.sessions());
    } catch {
      modal.close();
      announce('Could not read the connected places.');
    }
  }

  paint(data);
}

async function revokePlace(session, { name, button, modal, refresh }) {
  button.disabled = true;
  let answer;
  try {
    answer = await sync.revokeSession(session.id);
  } catch (error) {
    const failure = describeSyncFailure(error);
    announce(failure.message, { duration: 6000 });
    button.disabled = false;
    return;
  }

  if (answer.current) {
    /* This place ended itself. There is no session left to use, so the page locks rather than
       pretending it can still sync: the account and its vault are untouched. */
    modal.close();
    await lockVault();
    announce('This place is signed out. Enter the phrase to sign in again.', { duration: 8000 });
    return;
  }

  announce(`Signed out ${name}.`);
  await refresh();
}

/**
 * Delete the account: the server copy first, then everything this device holds.
 *
 * The modal asks for the phrase even when this device remembers the signing key, because a
 * remembered device is not a person saying yes. The typed word is the second guard: one control
 * for a destructive act is too easy to press. Neither value is stored, sent anywhere but to the
 * delete route, or put in the page's status line.
 */
function deleteAccountSheet() {
  if (!state.accountId) {
    announce('There is no account open.');
    return;
  }

  const phraseField = el('textarea', {
    id: 'delete-phrase',
    class: 'phrase-input',
    rows: '3',
    autocomplete: 'off',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: false,
    'aria-describedby': 'delete-phrase-hint'
  });

  const confirmField = el('input', {
    type: 'text',
    id: 'delete-confirm',
    autocomplete: 'off',
    autocapitalize: 'none',
    autocorrect: 'off',
    spellcheck: false,
    'aria-describedby': 'delete-confirm-hint'
  });

  const errorLine = el('p', { class: 'form-error', role: 'alert' });
  errorLine.hidden = true;

  const deleteButton = el('button', {
    class: 'button button-danger',
    type: 'button',
    text: 'Delete account',
    disabled: true
  });

  const check = () => {
    deleteButton.disabled =
      phraseField.value.trim() === '' || confirmField.value.trim().toUpperCase() !== 'DELETE';
  };
  phraseField.addEventListener('input', check);
  confirmField.addEventListener('input', check);

  const showError = (message) => {
    errorLine.textContent = message;
    errorLine.hidden = message === '';
  };

  const modal = openModal({
    title: 'Delete this account?',
    body: [
      el('p', {
        text: 'This deletes the account and the sealed copy on the server: its bookmarks, its history, every place signed in to it, and its slot on the server. The slot goes back to the server’s count.'
      }),
      el('p', {
        text: 'This device deletes its sealed vault, its local history, the remembered key and this page’s settings, turns sync off, and locks.'
      }),
      el('p', {
        text: 'Other devices keep their own local copies. They cannot sync again: each will say the account was deleted. Do not turn sync on there.'
      }),
      el('p', {
        text: 'There is no recovery. The phrase names the same account id, but it cannot bring the account back. A new account needs a new invite code.'
      }),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Your 13-word phrase' }),
        phraseField
      ]),
      el('p', {
        class: 'field-hint',
        id: 'delete-phrase-hint',
        text: 'Asked again for this action, even when this device remembers the key. It is not kept.'
      }),
      el('label', { class: 'field' }, [
        el('span', { class: 'field-label', text: 'Type DELETE to confirm' }),
        confirmField
      ]),
      el('p', {
        class: 'field-hint',
        id: 'delete-confirm-hint',
        text: 'The word DELETE, so this is not one tap away from an ordinary setting.'
      }),
      errorLine
    ],
    actions: [
      el('button', {
        class: 'button button-quiet',
        type: 'button',
        text: 'Cancel',
        onclick: () => modal.close()
      }),
      deleteButton
    ],
    onClose: () => {
      /* A phrase must not outlive the dialog, whichever way it was closed. */
      clearPhraseField(phraseField);
      clearPhraseField(confirmField);
    }
  });

  deleteButton.addEventListener('click', async () => {
    showError('');
    const phrase = phraseField.value;
    clearPhraseField(phraseField);
    clearPhraseField(confirmField);
    check();

    const problem = phraseProblem(phrase);
    if (problem) {
      showError(problem);
      phraseField.focus();
      return;
    }

    deleteButton.disabled = true;
    deleteButton.textContent = 'Deleting…';

    try {
      const derived = await deriveAccount(phrase);
      if (derived.accountId !== state.accountId) {
        showError('That phrase does not open this account.');
        phraseField.focus();
        return;
      }

      /* The account is deleted under the name the server knows it by, and it is signed with the
         credential that name takes: the Ed25519 key for an id a public key committed to, the
         secret for the id the phrase itself hashed to. */
      const name = await liveAccountName(derived);
      const credential = committedName(name) ? derived.proofKey : derived.authSecret;
      await sync.deleteAccount(name, credential);
      modal.close();
      await forgetDeletedVault('This account was deleted. Nothing is left on this device, and sync is off.');
    } catch (error) {
      if (error?.code === 'ACCOUNT_DELETED') {
        modal.close();
        await forgetDeletedVault(
          'This account was already deleted. Nothing is left on this device, and sync is off.'
        );
        return;
      }
      if (error?.code === 'NO_ACCOUNT') {
        modal.close();
        await forgetDeletedVault('There was no server copy. This device has been cleared.');
        return;
      }
      /* The phrase was wrong, the server asked to wait, or the network is gone: the dialog stays
         open with the sentence, so the attempt can be repeated without losing the decision. */
      showError(describeSyncFailure(error).message);
      phraseField.focus();
    } finally {
      if (document.body.contains(deleteButton)) {
        deleteButton.disabled = false;
        deleteButton.textContent = 'Delete account';
        check();
      }
    }
  });
}

/**
 * Run a vault as if it had signed out, the way a lock does, plus the wipe a deletion needs.
 *
 * The state goes first, before the first await: an edit that is already sealing checks
 * `state.key`, and must not write one more snapshot on its way out. `store.clear()` removes the
 * sealed document, its history and the remembered key in one pass, so the activity log and the two
 * icon maps — which live inside the document — go with it. The page's own settings are removed
 * too, including the key names earlier versions kept icon maps under, so "nothing is left" covers
 * a device that has not been opened since the upgrade.
 */
async function forgetDeletedVault(message) {
  clearTimeout(syncTimer);
  state.accountId = null;
  state.serverId = null;
  state.proofKey = null;
  state.proofKeyText = null;
  state.authKey = null;
  forgetInvite();
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
  placesCount = null;
  vaultCreatedAt = null;
  lastActivityAt = null;
  /* Nothing may use the dead session, and no tab may think sync is still on. */
  sync.token = null;
  sync.accountId = null;
  list.replaceChildren();
  clearStatus();

  try {
    await store.clear();
  } catch {
    /* The server copy is gone; a storage refusal leaves the seal behind, not the account. */
  }
  clearDeviceStorage();

  /* Another tab still holds the key and would write the vault back to this device. */
  lockSignal.broadcast();

  showLock(message, { hasVault: false });
  /* The generic empty-device note offers to load a synced copy; there is none to load. */
  deviceNote.textContent =
    'No vault on this device. The deleted account cannot be reopened here; a new vault starts a new account.';
  deviceNote.hidden = false;
  announce(message, { duration: 8000 });
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
  /* A server that will not create an account without a code is asking a question, and the sheet
     has the field for it: `describeSyncFailure` maps INVITE_REQUIRED, INVITE_USED and
     INVITE_EXPIRED to this kind. The code that was just refused is dropped — it is spent or
     wrong, and the next sync would otherwise send it again. */
  if (failure.kind === 'invite') {
    const first = !state.inviteNeeded;
    state.inviteNeeded = true;
    state.invite = '';
    setSyncStatus(failure.label);
    announce(failure.message, { duration: 8000 });
    /* The question is asked on the page, not left as a sentence pointing at a control the person
       cannot see: the sheet opens at the section that answers it, with the keyboard on the field.
       A refusal of a code already typed needs no redraw and keeps the field it was typed in. */
    if (first) {
      if (settingsOpen()) repaintSettings();
      else openSettings();
      requestAnimationFrame(() => activeModal?.dialog.querySelector('#invite-code')?.focus());
    }
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
  /* A deleted account is not a passing failure: say it once, at length, and stop there. */
  if (failure.kind === 'deleted') {
    sync.token = null;
    setSyncStatus(failure.label);
    if (failure.message !== lastSyncNotice) {
      lastSyncNotice = failure.message;
      announce(failure.message, { duration: 8000 });
    }
    return;
  }

  setSyncStatus(failure.label, { retryAfter: failure.retryAfter ?? 0 });

  /* A local-first vault retries on its own, so the same quiet failure is announced once. */
  if (failure.message !== lastSyncNotice) {
    lastSyncNotice = failure.message;
    announce(failure.message, {
      duration:
        failure.kind === 'size' || failure.kind === 'unreadable' || failure.kind === 'disabled'
          ? 8000
          : 6000
    });
  }
}

/**
 * What signs a login proof for an id a phrase hashed to: the non-extractable HMAC key the phrase
 * derives. The base64url text behind it is the same bytes, so it signs the same proof
 * (`crypto.test.mjs` pins that), and unlike the text it cannot be read out of the page.
 *
 * `null` means this session holds no credential at all: a record kept from before the key
 * existed. The routes that need one ask for the phrase rather than guessing.
 */
function authMaterial() {
  return state.authKey;
}

/* The server's name for an account is 64 lowercase hex characters, and the phrase's own id is 22
   base64url ones. The length is the whole of the rule, and it is the same rule the server applies
   when it refuses a creation. */
const COMMITTED_ACCOUNT_ID = /^[0-9a-f]{64}$/;

/** Whether a name is an id a public key committed to, rather than the id a phrase hashed to. */
function committedName(accountId) {
  return typeof accountId === 'string' && COMMITTED_ACCOUNT_ID.test(accountId);
}

/**
 * The credential a name is proved with.
 *
 * The shape of the name decides it: 64 hex characters is an id a public key committed to, so only
 * the phrase's Ed25519 key can sign for it; 22 characters is the id the phrase itself hashed to,
 * so the HMAC key the phrase derives signs. Every call site asks this rather than testing the
 * shape itself, because a credential of the wrong kind is a sign-in that cannot work.
 */
function credentialFor(accountId) {
  return committedName(accountId) ? state.proofKey : authMaterial();
}

/**
 * Sign in to this device's account, under whichever name the server knows it by.
 *
 * A vault created since ids committed to a key lives under `serverId`; one created before lives
 * under the phrase's own `accountId`. Asking for the committed name first and falling back when
 * the server says there is no such account is what lets both kinds sign in from the same page
 * without either being told it does not exist. `login` keeps the name it was given, so every later
 * route — pull, push, places, delete — is addressed with the one that answered.
 */
async function signIn() {
  const name = committedName(state.serverId) ? state.serverId : state.accountId;
  try {
    return await sync.login(name, credentialFor(name));
  } catch (error) {
    if (error?.code !== 'NO_ACCOUNT' || name === state.accountId) throw error;
    return sync.login(state.accountId, authMaterial());
  }
}

/**
 * The name the server knows this vault by, for a route that has to address it without a session.
 *
 * An open session already knows the answer. Otherwise the committed name is asked about first —
 * it is what this build creates — and the phrase's own id second, because either kind of vault may
 * be there. Neither existing is not an error here: the route the caller is about to use answers
 * `no_account`, which it already reads.
 */
async function liveAccountName(derived) {
  if (sync.signedIn && typeof sync.accountId === 'string') return sync.accountId;
  try {
    if (await sync.accountExists(derived.serverId)) return derived.serverId;
  } catch (error) {
    /* A deleted or switched-off account is an answer about the account, not a failure of the
       question, so the caller gets it. Anything else — offline, throttled — leaves the phrase's
       own id as the name to try, which is the name this route used before either was asked. */
    if (error?.code === 'ACCOUNT_DELETED' || error?.code === 'ACCOUNT_DISABLED') throw error;
  }
  return derived.accountId;
}

/**
 * Whether a blob sealed before the version was bound may still be opened.
 *
 * This device answers yes while its own copy is in the old shape: once it has written a bound
 * blob, the vault has moved, and a server that later serves an unmarked ciphertext is serving
 * something older than what this device already has.
 *
 * It also answers yes while the device holds nothing at all. An empty vault is a placeholder
 * written seconds ago, not data a rollback could lose, and a device that has just accepted a
 * phrase is the one that has to be able to open a server copy sealed before the binding — the
 * alternative is a person whose old vault exists on the server and cannot be opened anywhere.
 */
function legacyBlobAllowed() {
  return state.sealed?.at === undefined || holdsNothing();
}

/** True while this device's own copy is the empty document a new phrase starts with. */
function holdsNothing() {
  const document = state.document;
  return !document || ((document.bookmarks?.length ?? 0) === 0 && (document.tombstones?.length ?? 0) === 0);
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
  /* The same whole-document trim as a save: a vault that grew enough to need the log's room
     must not be pushed with a log that no longer fits. A stale sealed copy is dropped here so
     the re-seal below sees the trimmed document. */
  const fitted = fitActivity(state.document);
  if (fitted !== state.document) {
    state.document = fitted;
    state.sealed = null;
  }

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
  /* Creation was refused for want of a code, and the field that answers it is on the page. A
     background sync would ask the same question and be refused the same way, so it waits for the
     code instead of spending the server's attempts on it. */
  if (state.inviteNeeded && state.invite === '') return;
  if (syncBusy) {
    syncQueued = true;
    return;
  }

  syncBusy = true;
  try {
    let absorbed = false;
    let retried = false;

    for (;;) {
      try {
        absorbed = await reconcile();
        break;
      } catch (error) {
        /* A token that died between two requests is not a dead end: the client has already
           dropped it, and signing in again is what tells a deleted account (410) from an
           expired session. One retry, then the error is reported. */
        if (error?.code === 'UNAUTHORIZED' && !retried) {
          retried = true;
          continue;
        }
        throw error;
      }
    }

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

/** The one pass over the server: sign in if needed, read, merge, push. */
async function reconcile() {
  let absorbed = false;

  if (!sync.signedIn) {
    setSyncStatus('Signing in…');
    let session;

    try {
      session = await signIn();
    } catch (error) {
      if (error.code !== 'NO_ACCOUNT') throw error;

      /* First sync on a new phrase: the account is created from the same key the login would have
         used, so there is nothing to provision and no token to hold. A remembered device holds the
         signing key but not its public half, so it cannot describe the creation without the phrase
         once. The code, when the server wants one, is the third argument and is empty until a
         refusal asks for it. */
      setSyncStatus('Creating the account…');
      /* The creation is described by the committed name and the public half of the signing key,
         which are the two things a request sends. A session without them — one reopened from a
         remembered record — is exactly the case the phrase answers, and nothing about the account's
         base64url secret is consulted to decide it. */
      if (!committedName(state.serverId) || !state.proofKey || typeof state.proofKeyText !== 'string') {
        throw new SyncError('NEED_PHRASE', 'This device needs the phrase once to create the account.');
      }
      await sync.register(
        state.serverId,
        { proofKey: state.proofKey, proofKeyText: state.proofKeyText },
        state.invite
      );
      /* The server holds the public half now and the session is the only other thing a creation
         leaves behind. The public text is kept until that session exists: a registration that
         succeeded and a sign-in that failed on the network is answered by signing in again, and a
         retried creation has to describe the same one. */
      session = await sync.login(state.serverId, state.proofKey);
      state.proofKeyText = null;
      /* The creation is done, so the code has no further use: it was spent on this account. */
      forgetInvite();
    }

    applyPlan(session);
  }

  const remote = await sync.pull();

  if (remote) {
    state.remoteVersion = remote.version;
    let remoteDocument;
    try {
      remoteDocument = await openVault(state.key, remote, state.accountId, remote.version, {
        allowLegacy: legacyBlobAllowed()
      });
    } catch {
      /* The bytes arrived and this page could not open them. That is not a lost connection, and
         the difference is the whole of why this error exists. */
      throw new SyncError(
        'REMOTE_UNREADABLE',
        'The copy on the server could not be opened with this phrase.'
      );
    }
    /* A copy from another device is a document like any other: it is read through the URL rule
       before it is merged, so a refused record cannot ride a merge into the list. */
    const { document: safeRemote, dropped } = sanitizeDocument(remoteDocument);
    remoteDocument = safeRemote;
    if (dropped > 0) announce(droppedSentence(dropped));

    const { document: merged } = mergeDocuments(state.document, remoteDocument, Date.now, {
      device: deviceId()
    });

    if (fingerprint(merged) !== fingerprint(state.document)) {
      state.document = merged;
      absorbed = true;
      /* The merge may have carried a newer sort or view from the other device; the controls
         have to show it before the list is built, or they show the state they replaced. */
      applyPrefs();
      render();
      await saveNow({ push: false });
    }
    if (fingerprint(merged) === fingerprint(remoteDocument)) return absorbed;
  } else {
    state.remoteVersion = 0;
  }

  let result = await sync.push(state.remoteVersion, await sealedForPush(state.remoteVersion));

  if (result.conflict) {
    state.remoteVersion = result.currentVersion;
    if (result.current) {
      let conflictDocument;
      try {
        conflictDocument = await openVault(
          state.key,
          result.current,
          state.accountId,
          result.current.version,
          { allowLegacy: legacyBlobAllowed() }
        );
      } catch {
        throw new SyncError(
          'REMOTE_UNREADABLE',
          'The copy on the server could not be opened with this phrase.'
        );
      }
      /* The copy that won the conflict is read through the same rule; a conflict is not a reason
         to trust one document more than the other. */
      const { document: safeConflict, dropped } = sanitizeDocument(conflictDocument);
      conflictDocument = safeConflict;
      if (dropped > 0) announce(droppedSentence(dropped));

      const { document: merged } = mergeDocuments(state.document, conflictDocument, Date.now, {
        device: deviceId()
      });
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
  return absorbed;
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

function enter({
  accountId,
  serverId = null,
  proofKey = null,
  proofKeyText = null,
  authKey = null,
  key,
  version,
  sealed,
  document: vaultDocument
}) {
  state.accountId = accountId;
  /* The name the server knows the account by, and the key that signs for it. A device restored
     from a record written before ids committed to a key has neither, and the phrase's own id is
     what every route uses then. */
  state.serverId = serverId;
  state.proofKey = proofKey;
  state.proofKeyText = proofKeyText;
  state.authKey = authKey ?? null;
  state.key = key;
  state.version = version;
  state.sealed = sealed;
  /* The two icon maps used to sit on this device in the clear, under their own localStorage keys.
     Both live inside the document now, so the old keys are deleted here — as soon as a vault is
     open and the document is in hand — and their contents are not copied across first: a clear
     map carried into the seal would keep the leak alive on every profile copied before this ran.
     Nothing waits on the sweep, and a storage refusal is simply tried again next unlock. */
  forgetLegacyIconMaps();
  /* A vault written before the log existed has no `activity`, and one written by a newer build
     may carry a line this build cannot read: both are read into the shape the page draws. */
  const { document: safeDocument, dropped } = sanitizeDocument(vaultDocument);
  state.document = fitActivity({
    ...safeDocument,
    activity: normaliseActivity(safeDocument.activity, Date.now)
  });

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
  if (window.matchMedia?.('(pointer: fine)').matches && safeDocument.bookmarks.length > 0) {
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

  /* The caller says what it was doing; the count of entries the URL rule refused travels back
     with it, so a drop is reported instead of silently changing the size of the vault. */
  return dropped;
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
    const dropped = enter({
      accountId: remembered.accountId,
      /* A record written under the committed scheme names the server's id and holds the key that
         signs for it; one from before has neither, and the phrase's own id is then the account's
         name. Nothing else differs, which is why an older record still opens here. */
      serverId: remembered.serverId ?? null,
      proofKey: remembered.proofKey ?? null,
      authKey: remembered.authKey ?? null,
      key,
      version: stored.version,
      sealed: stored.sealed,
      document: vaultDocument
    });
    if (dropped > 0) announce(droppedSentence(dropped));
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
    const { accountId, serverId, vaultKey, authKey, proofKey, proofKeyText } =
      await deriveAccount(phrase);
    const stored = await store.load(accountId);
    const vaultDocument = stored.sealed
      ? await openVault(vaultKey, stored.sealed, accountId, localSealVersion(stored), {
          allowLegacy: true
        })
      : createDocument();

    /* A remembered device is remembered under both names, so it can sign in without the phrase:
       the vault key opens, the signing key proves, and the server's name is where it proves it. */
    if (rememberInput.checked) {
      await store.remember(accountId, vaultKey, authKey, { serverId, proofKey });
    } else {
      await store.forget();
    }

    const dropped = enter({
      accountId,
      serverId,
      proofKey,
      proofKeyText,
      authKey,
      key: vaultKey,
      version: stored.version,
      sealed: stored.sealed,
      document: vaultDocument
    });

    if (!stored.sealed) {
      await saveNow();
      await offerServerVault();
    } else if (syncEnabled()) {
      /* A local vault opens without the server; still ask, once, whether the operator has
         switched this account off, so the sentence appears at the moment the person unlocks. */
      void noticeIfDisabled();
    }
    if (dropped > 0) announce(droppedSentence(dropped));
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
    /* The committed name first: it is the one this build creates. An account from before that
       lives under the phrase's own id is asked about next, or a person returning to it would be
       told their vault exists nowhere. */
    const first = committedName(state.serverId) ? state.serverId : state.accountId;
    exists = await sync.accountExists(first);
    if (!exists && first !== state.accountId) exists = await sync.accountExists(state.accountId);
  } catch (error) {
    if (error?.code === 'ACCOUNT_DISABLED') {
      const failure = disabledNotice();
      lastSyncNotice = failure.message;
      announce(failure.message, { duration: 8000 });
      return;
    }
    /* The phrase names an account that was deleted. It is not offered a server copy, because
       there is none; the device stays local and the sentence says why. */
    if (error?.code === 'ACCOUNT_DELETED') {
      const failure = deletedNotice();
      lastSyncNotice = failure.message;
      announce(failure.message, { duration: 8000 });
      return;
    }
    /* Offline, throttled, or the question could not be asked. Stay local — but say so: an empty
       list with no explanation is the state this prompt exists to prevent, and a silent version of
       it is worse than the question never being asked. */
    announce('Could not ask the server about this vault. This device starts empty.');
    return;
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

/** The one sentence for a vault the operator has switched off. */
function disabledNotice() {
  return describeSyncFailure(new SyncError('ACCOUNT_DISABLED', 'disabled'));
}

/** The one sentence for an account that was deleted, wherever the page meets the answer. */
function deletedNotice() {
  return describeSyncFailure(new SyncError('ACCOUNT_DELETED', 'deleted', { status: 410 }));
}

/**
 * Ask the server whether this account is gone or switched off, at unlock, without blocking the
 * local vault. A failure is silent: the next sync says the same thing if it matters.
 */
async function noticeIfDisabled() {
  try {
    /* Both names are asked, committed first, so an account created before ids were committed to a
       key is still reported as disabled rather than as missing. */
    const first = committedName(state.serverId) ? state.serverId : state.accountId;
    let status = await sync.accountStatus(first);
    if (!status.exists && first !== state.accountId) {
      status = await sync.accountStatus(state.accountId);
    }
    if (!status.disabled) return;
    const failure = disabledNotice();
    setSyncStatus(failure.label);
    if (failure.message !== lastSyncNotice) {
      lastSyncNotice = failure.message;
      announce(failure.message, { duration: 8000 });
    }
  } catch (error) {
    /* A deleted account is not silent: the local vault opens, and the person is told that the
       server copy is gone and that this device's own copy is all there is. */
    if (error?.code === 'ACCOUNT_DELETED') {
      const failure = deletedNotice();
      sync.token = null;
      setSyncStatus(failure.label);
      if (failure.message !== lastSyncNotice) {
        lastSyncNotice = failure.message;
        announce(failure.message, { duration: 8000 });
      }
    }
    /* Offline or throttled: the local vault opens, and sync will say it when it can. */
  }
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
  const { accountId, serverId, vaultKey, authKey, proofKey, proofKeyText } =
    await deriveAccount(phrase);
  const vaultDocument = createDocument();
  const sealed = await sealVault(vaultKey, vaultDocument, accountId, 1);

  await store.save(accountId, sealed, 1);
  if (remember) await store.remember(accountId, vaultKey, authKey, { serverId, proofKey });
  else await store.forget();

  enter({
    accountId,
    serverId,
    proofKey,
    proofKeyText,
    authKey,
    key: vaultKey,
    version: 1,
    sealed,
    document: vaultDocument
  });
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
    const { accountId, serverId, vaultKey, authKey, proofKey, proofKeyText } =
      await deriveAccount(phrase);
    const backupDocument = await openVault(vaultKey, sealed, accountId, sealed.at ?? 1, {
      allowLegacy: sealed.at === undefined
    });
    const stored = await store.load(accountId);

    /* A backup is a copy from another moment, not a replacement for what this device has seen.
       It is merged into the vault already here, so restoring one taken before a visit cannot
       erase that visit, and a count can never fall on this path. A device that cannot open its
       own copy is the one case where the backup is all there is. */
    let vaultDocument = {
      ...backupDocument,
      activity: normaliseActivity(backupDocument.activity, Date.now)
    };
    let mergedWithCurrent = false;
    if (stored.sealed) {
      try {
        const current = await openVault(
          vaultKey,
          stored.sealed,
          accountId,
          localSealVersion(stored),
          { allowLegacy: true }
        );
        vaultDocument = mergeDocuments(current, backupDocument, Date.now, {
          device: deviceId(),
          cause: 'restore'
        }).document;
        mergedWithCurrent = true;
      } catch {
        /* The device's own vault was sealed under another phrase, so the backup is the only
           copy this phrase can open. */
      }
    }

    vaultDocument = fitActivity(vaultDocument);
    /* The backup is read before it is re-sealed, so a URL the page cannot use is left out of the
       copy written back to this device and not only out of the list drawn from it. */
    const { document: safeDocument, dropped } = sanitizeDocument(vaultDocument);
    vaultDocument = safeDocument;
    const version = Math.max(stored.version, 0) + 1;
    /* The backup is re-sealed at the number this device will store it under: the blob it came
       from was bound to its own version, and a record that names a number the bytes were not
       sealed at would not open again. */
    const resealed = await sealVault(vaultKey, vaultDocument, accountId, 1);
    await store.save(accountId, resealed, version);
    if (rememberInput.checked) {
      await store.remember(accountId, vaultKey, authKey, { serverId, proofKey });
    } else {
      await store.forget();
    }

    enter({
      accountId,
      serverId,
      proofKey,
      proofKeyText,
      authKey,
      key: vaultKey,
      version,
      sealed: resealed,
      document: vaultDocument
    });
    announce(
      `${mergedWithCurrent ? 'Backup restored and merged with this device’s vault.' : 'Backup restored.'}${
        dropped > 0 ? ` ${droppedSentence(dropped)}` : ''
      }`
    );
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

  /* The renderer's last line of defence. A document is supposed to be clean by the time it gets
     here, but a row must not become a live `javascript:` link just because that promise failed:
     a refused URL still draws the row, with no address to navigate to. */
  const href = linkHref(bookmark.url);
  const link = el(
    'a',
    {
      class: 'row-link',
      ...(href === null
        ? { 'aria-disabled': 'true' }
        : { href, target: '_blank', rel: 'noopener noreferrer' })
    },
    [tile, name]
  );

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

  const split = useSplit(bookmark, deviceId());
  const clicks = el('span', {
    class: 'clicks',
    text: String(split.total),
    'aria-label': splitLabel(split)
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

/** The count as a screen reader hears it, with the two contributions when there are two. */
function splitLabel({ here, elsewhere, total }) {
  const noun = total === 1 ? 'use' : 'uses';
  if (elsewhere === 0) return `${total} ${noun}`;
  const other = elsewhere === 1 ? 'another device' : 'other devices';
  return `${total} ${noun}: ${here} from this device, ${elsewhere} from ${other}`;
}

/** The count as the bookmark's own sheet says it: one sentence, so the total and its parts agree. */
function splitSentence({ here, elsewhere, total }) {
  if (total === 0) return 'No uses counted yet.';
  const noun = total === 1 ? 'use' : 'uses';
  if (elsewhere === 0) return `${total} ${noun} in total, all counted on this device.`;
  const other = elsewhere === 1 ? 'another device' : 'other devices';
  return `${total} ${noun} in total: ${here} counted on this device, ${elsewhere} on ${other}.`;
}

/* Every count change the vault records, in the words a person reads rather than the field names
   the model uses. A cause outside this list is shown as it came, because a newer build may have
   added one and a line is still better than a blank. */
const ACTIVITY_CAUSE_LABELS = Object.freeze({
  click: 'Opened from this list',
  open: 'Opened in the browser',
  merge: 'Merged from another device',
  restore: 'Restored from a backup',
  import: 'Imported from a file',
  'history-import': 'Added from browsing history'
});

/** A device named the way the split names it: this one, or the start of an anonymous id. */
function deviceName(id) {
  if (id === deviceId()) return 'this device';
  if (id === 'legacy') return 'an older build';
  if (id === 'unsettled') return 'an unnamed device';
  return id.length > 8 ? id.slice(0, 8) : id;
}

function activityWhen(at) {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return String(at);
  return when.toLocaleString([], {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit'
  });
}

/** One line: time, device, cause, and the total before and after, with the slot when it moved. */
function activityRow(event, { showBookmark = false } = {}) {
  const parts = [];

  if (showBookmark) {
    const bookmark = findBookmark(event.bookmarkId);
    parts.push(
      el('strong', {
        class: 'activity-bookmark',
        text: bookmark ? labelOf(bookmark) : event.url
      })
    );
  }

  parts.push(
    el('time', { class: 'activity-when', datetime: event.at, text: activityWhen(event.at) }),
    el('span', { class: 'activity-device', text: deviceName(event.device) }),
    el('span', {
      class: 'activity-cause',
      text: ACTIVITY_CAUSE_LABELS[event.cause] ?? event.cause
    }),
    el('span', {
      class: 'activity-count',
      text: `${event.before} → ${event.after} ${event.after === 1 ? 'use' : 'uses'}`
    })
  );

  if (event.slot) {
    parts.push(
      el('span', {
        class: 'activity-slot',
        text: `${deviceName(event.slot.device)}: ${event.slot.before} → ${event.slot.after}`
      })
    );
  }

  return el('li', { class: 'activity-row' }, parts);
}

/**
 * The activity list as the page draws it: newest first, capped so a sheet never becomes a wall.
 * A bookmark's sheet asks for its own id; Settings asks for every bookmark, with the name first.
 */
function activityList(
  vault,
  { bookmarkId = null, limit = 20, showBookmark = false, label = 'Count activity', empty = 'No count changes recorded yet.' } = {}
) {
  const events = (Array.isArray(vault?.activity) ? vault.activity : []).filter(
    (event) => bookmarkId === null || event.bookmarkId === bookmarkId
  );
  if (events.length === 0) return el('p', { class: 'modal-note', text: empty });

  const shown = events.slice(0, limit);
  const list = el(
    'ul',
    { class: 'activity-list', 'aria-label': label },
    shown.map((event) => activityRow(event, { showBookmark }))
  );
  if (events.length <= limit) return list;

  return el('div', { class: 'activity-block' }, [
    list,
    el('p', { class: 'modal-note', text: `Showing the latest ${limit} of ${events.length}.` })
  ]);
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

  const changes = openCounts(snapshot.items, state.document.bookmarks, deviceId());
  if (changes.length === 0) return false;

  let next = state.document;
  for (const change of changes) next = recordUses(next, change.id, deviceId(), change.openCount, Date.now);
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

/* Icons for the collected rows come from the same server endpoint the vault's own icons use, and
   are kept inside the sealed document with everything else: they describe a page the vault does not
   hold, but a list of sites looked at is exactly what this app exists to keep out of a copy of the
   browser profile, so they are sealed with it. `fitCollectedIcons` in bookmarks.js caps how many
   there may be and how many bytes they may take, so a vault full of them is never the reason a save
   is refused. `collectedIconTries` below is only this page's record of which requests are in flight;
   it is never written anywhere. */
const collectedIconTries = new Set();

function collectedIcon(host) {
  return collectedIconFor(state.document, host);
}

/**
 * One collected row's icon.
 *
 * The host is marked while its request is in flight, so a re-render does not open a second one.
 * The mark is dropped again unless the host actually answered: a refusal during the burst a clear
 * leaves behind is exactly when a retry matters, and a mark left standing would keep the lettered
 * tile until the page was reloaded.
 */
async function loadCollectedIcon(host, { attempt = 0 } = {}) {
  /* Nothing to look in before the vault is open: the row keeps its letter, and no request is
     opened to fill a gap that only the sealed document can fill. */
  if (!state.document) return;
  if (host === '' || collectedIconTries.has(host)) return;
  collectedIconTries.add(host);

  const outcome = await fetchIconOutcome(host);

  if (outcome.kind !== OUTCOME_VALUE) {
    /* A host that answered "no icon" keeps its mark: the lettered tile is its answer for this
       page, and re-asking on every render would spend the budget on hosts with nothing to give. */
    if (isAnswer(outcome)) return;

    /* The edge refused us, or the request never left. That says nothing about the host, so the
       mark goes and it is asked again after the backoff icons.js derives — a few seconds,
       doubling — no more than a few times. */
    collectedIconTries.delete(host);
    if (attempt < ICON_RETRY_ATTEMPTS) {
      setTimeout(() => {
        void loadCollectedIcon(host, { attempt: attempt + 1 });
      }, retryDelayMs(attempt, outcome.retryAfterMs));
    }
    return;
  }

  const icon = outcome.value;

  /* The request may outlive the vault: a lock can arrive while it is in flight. There is no
     document to put the picture in then, and `withCollectedIcon` would build a partial one that
     holds the map and nothing else. The row keeps its letter, the mark goes, and the next open
     asks again. */
  if (!state.document) {
    collectedIconTries.delete(host);
    return;
  }

  /* The picture goes into the document and the normal save seals it, so the map is flushed with
     the vault rather than written anywhere in the clear. `saveNow` coalesces: a row that asks
     while a seal is running marks the document dirty instead of opening a second one. */
  state.document = withCollectedIcon(state.document, host, icon);
  void saveNow();

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

/**
 * A collected row that becomes a bookmark brings its visits with it. That is a count arriving
 * from the browser's history rather than from this list or another device, so it is filed under
 * its own cause; a row with no visits changes no count and writes nothing.
 */
function recordHistoryImport(document, bookmark) {
  const after = useCount(bookmark);
  if (after === 0) return document;

  const at = Date.now();
  return appendActivity(
    document,
    [
      activityEvent(
        {
          device: deviceId(),
          bookmarkId: bookmark.id,
          url: bookmark.url,
          cause: 'history-import',
          before: 0,
          after,
          slot: changedSlot(null, bookmark, deviceId())
        },
        at
      )
    ],
    at
  );
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
        { url: row.url, name: nameForCollected(row), uses: { [deviceId()]: Number(row.visits) || 0 } },
        Date.now
      );
      next = recordHistoryImport(result.document, result.bookmark);
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
    const { document: added, bookmark } = addBookmark(
      state.document,
      { url, name: nameForCollected({ url }), uses: { [deviceId()]: Number.isInteger(visits) ? visits : 0 } },
      Date.now
    );
    state.document = recordHistoryImport(added, bookmark);
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
            /* The per-device visits came with the record and go back with it: an undo that
               restored only the list-click number would lose every browser open. */
            uses: deleted.uses,
            openCount: deleted.openCount,
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
  const outcome = await fetchIconOutcome(hostname);
  if (outcome.kind !== OUTCOME_VALUE) return;

  const icon = outcome.value;
  const bookmark = findBookmark(id);
  if (!bookmark || bookmark.icon) return;

  state.document = updateBookmark(state.document, id, { icon }, Date.now);
  render();
  saveNow();
}

/* When each host was last asked for an icon. Kept inside the sealed document, under `iconTries`:
   it is a local courtesy about retries rather than something to show on another device, but a
   profile copy has to hold ciphertext, so it is sealed with everything else. It is keyed by a
   digest of the hostname, which keeps the map small and one shape; the digest is not what hides
   the names, the seal is. */
function readIconTries() {
  if (!state.document) return {};
  const { kept, dropped } = pruneIconTries(state.document.iconTries);
  /* A map holding a name from an earlier version, a malformed entry, or one past the season is
     rewritten without it rather than kept until the next save. */
  if (dropped > 0) writeIconTries(kept);
  return kept;
}

function writeIconTries(tries) {
  if (!state.document) return;
  /* One entry per host asked in the season; anything older is noise inside a document that is
     sealed and pushed. The document is the map's only home now, and `saveNow` is what seals it:
     a sweep writes once per batch, and the save coalesces the batches into one seal. The count
     cap is applied here as well as at the seal, so a long sweep never builds a map the save would
     then have to cut. */
  const { kept } = pruneIconTries(tries);
  state.document = fitIconTries(
    { ...state.document, iconTries: kept },
    { maxDocumentBytes: Number.POSITIVE_INFINITY }
  );
  void saveNow();
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
    /* The queue in icons.js paces the requests; a batch is only how many answers are folded into
       the vault, and saved, at once. The rounds exist for refusals: the edge may decline a few
       hosts in a big run, and those are asked again after a pause instead of being stamped. */
    let pending = hosts;
    for (let attempt = 0; pending.length > 0; attempt += 1) {
      const refused = [];

      for (let at = 0; at < pending.length; at += ICON_BATCH) {
        const batch = pending.slice(at, at + ICON_BATCH);
        const results = await Promise.all(
          batch.map(async (hostname) => ({
            host: hostname,
            outcome: await fetchIconOutcome(hostname, { fresh: true }),
            attempt
          }))
        );

        const filled = results.filter(({ outcome }) => outcome.kind === OUTCOME_VALUE);
        if (filled.length > 0) {
          let next = state.document;
          for (const { host: hostname, outcome } of filled) {
            for (const id of byHost.get(hostname) ?? []) {
              if (next.bookmarks.some((bookmark) => bookmark.id === id && !bookmark.icon)) {
                next = updateBookmark(next, id, { icon: outcome.value }, Date.now);
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
        setVaultStatus(
          attempt === 0
            ? `Fetching icons… ${Math.min(done, hosts.length)}/${hosts.length}`
            : `Retrying ${pending.length} refused ${pending.length === 1 ? 'host' : 'hosts'}…`
        );

        /* A host that answered — with an icon or with "no icon" — is not worth asking again this
           week. A refusal is not an answer: it leaves the index alone and comes back scheduled.
           Written per batch so a closed tab does not lose what it already spent. */
        refused.push(...(await stampAnswers(tries, results, Date.now())));
        if (results.some(({ outcome }) => isAnswer(outcome))) writeIconTries(tries);
      }

      if (refused.length === 0 || attempt >= ICON_RETRY_ATTEMPTS) break;

      /* Only the refused hosts, and only after the pause the edge or the backoff asked for. The
         queue spaces these like any other request, so a retry is not a second burst. */
      await new Promise((resolve) => setTimeout(resolve, Math.max(...refused.map((entry) => entry.delayMs))));
      pending = refused.map(({ host }) => host);
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
      /* The row shows only the sum; this is where the sum is explained — what this device counted and what the
         other devices that share the vault counted. */
      el('p', { class: 'field-hint', text: splitSentence(useSplit(bookmark, deviceId())) }),
      /* The timeline that explains when the sum moved. Read-only: a count is changed by using the
         bookmark, not by editing this list. */
      el('div', { class: 'activity-block' }, [
        el('p', { class: 'field-label', text: 'Activity' }),
        activityList(state.document, {
          bookmarkId: bookmark.id,
          limit: 20,
          label: `Activity for ${labelOf(bookmark)}`
        })
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
  /* A row with no address — the URL rule refused it — has nothing to open, so a click on it is
     not a visit. */
  if (!link || !link.hasAttribute('href')) return;

  const row = link.closest('.row');
  const bookmark = row ? findBookmark(row.dataset.id) : null;
  if (!bookmark) return;

  state.document = recordClick(state.document, bookmark.id, Date.now, { device: deviceId() });
  /* The row shows uses, not list clicks: a bookmark opened twice in the browser reads three
     uses after a click here, and writing the click count alone would make the number fall on
     screen until the next render. */
  const counter = row.querySelector('.clicks');
  const clicked = findBookmark(bookmark.id);
  if (counter && clicked) {
    const split = useSplit(clicked, deviceId());
    counter.textContent = String(split.total);
    counter.setAttribute('aria-label', splitLabel(split));
  }

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

  /* The size is known before the file is read, so a hostile or mistaken file is refused without
     ever being held in the tab as text. The module refuses the same length again once it has a
     string, because this check is the one a caller can forget. */
  if (file.size > MAX_IMPORT_BYTES) {
    announce('That file is too large to import; nothing was read.', { duration: 6000 });
    return;
  }

  const text = await file.text();
  let parsed;

  try {
    const looksLikeHtml = /netscape-bookmark-file|<a\s[^>]*href\s*=/i.test(text);
    parsed = looksLikeHtml ? importBrowserBookmarks(text) : importPlain(text);
  } catch (error) {
    announce(clean(error.message), { duration: 6000 });
    return;
  }

  /* The file's reader already drops an entry it cannot open; the whole document it built is read
     through the same rule once more, so a file cannot reach the list through a reader that ever
     grows laxer than `normalizeUrl`. */
  const { document: parsedDocument, dropped } = sanitizeDocument(parsed.document);

  if (parsedDocument.bookmarks.length === 0) {
    announce(
      `Nothing in that file could be imported.${dropped > 0 ? ` ${droppedSentence(dropped)}` : ''}`,
      { duration: 5000 }
    );
    return;
  }

  /* Two different collisions, counted apart: the file repeating itself, and the file meeting
     what this vault already holds. Saying "duplicates 1" for either one is what made the dialog
     unreadable. */
  const incoming = parsedDocument.bookmarks;
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
            text: 'Every bookmark currently in this vault is removed and replaced by the file, along with the counts and count activity this vault holds. This cannot be undone except from a backup.'
          })
        ],
        confirmLabel: 'Replace everything',
        danger: true
      });
      if (!sure) return;
    }
    state.document = parsedDocument;
  } else {
    state.document = mergeInto(state.document, parsedDocument, Date.now, {
      device: deviceId()
    }).document;
  }

  render();
  await saveNow();
  announce(
    `Imported ${parsedDocument.bookmarks.length} bookmarks.${dropped > 0 ? ` ${droppedSentence(dropped)}` : ''}`
  );

  /* An imported file carries no icons of its own — the legacy URLs point at a third party and
     are deliberately not used — so the same fetch the Settings action runs starts here, without
     being asked for. */
  if (state.document.bookmarks.some((bookmark) => !bookmark.icon)) {
    fetchMissingIcons();
  }
}

/* ------------------------------------------------------------------ settings */

/**
 * A device can sign in with the key it remembers, but the account's creation is described by the
 * signing key's public half, and only the phrase derives that. It is asked for once, when sync is
 * turned on for a session that does not already hold the material, and the answer is the account
 * name, the signing key and its public half — not the base64url secret, which no request here
 * sends and no page state keeps.
 *
 * The account id is derived from the phrase, so a wrong phrase simply derives another vault; it is
 * refused here rather than turning sync on for an account this device cannot open.
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
        const { accountId, serverId, authKey, proofKey, proofKeyText } = await deriveAccount(typed);
        if (accountId !== state.accountId) {
          throw new Error('That phrase belongs to a different vault.');
        }
        settled = true;
        resolve({ serverId, authKey, proofKey, proofKeyText });
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

  /* ---- the invite field ---- */

  /**
   * The one question an invite-only server asks. It is drawn only while a creation has been
   * refused for want of a code, and the value is read from the field into `state.invite` when it
   * is pressed: the code is never stored, and the field holds it no longer than the attempt.
   */
  const inviteRow = () => {
    const field = el('input', {
      type: 'text',
      id: 'invite-code',
      class: 'settings-invite-field',
      autocomplete: 'off',
      spellcheck: false,
      inputmode: 'text',
      'aria-label': 'Invite code',
      'aria-describedby': 'invite-code-hint',
      value: state.invite
    });

    const button = el('button', {
      class: 'button button-primary settings-invite-use',
      type: 'button',
      text: 'Use this code'
    });

    const use = async () => {
      const code = field.value.trim();
      if (code === '') {
        field.focus();
        return;
      }

      button.disabled = true;
      const accepted = await submitInvite(code);
      button.disabled = false;

      if (!accepted) {
        /* The refusal sentence is on the page and the next attempt starts where this one was
           typed, so a mistyped code can be corrected in place. */
        field.focus();
        return;
      }

      forgetInvite();
      field.value = '';
      if (settingsOpen()) repaintSettings();
      announce('Sync is on for this vault.');
    };

    button.addEventListener('click', use);
    /* One field, one action: the key that people press after typing a code should run it. */
    field.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      button.click();
    });

    return el(
      'div',
      { class: 'settings-item settings-control settings-invite', 'data-setting': 'sync-invite' },
      [
        el('strong', { text: 'Invite code' }),
        field,
        button,
        el('span', {
          class: 'settings-invite-hint',
          id: 'invite-code-hint',
          text: 'This is a code, not the phrase, and it is spent once used.'
        })
      ]
    );
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
      repaintSettings();
    });
    return button;
  };

  const askForRule = async ({ title, fieldLabel, placeholder, options, selectLabel, confirmLabel }) => {
    const field = el('input', { type: 'text', placeholder, 'aria-label': fieldLabel });
    /* The select has no visible label of its own — the dialog title is the question — so it carries
       the same kind of name the field does, instead of being announced as "combo box" and nothing. */
    const select = el('select', { 'aria-label': selectLabel }, options.map(([value, text]) => el('option', { value, text })));
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
      selectLabel: 'How to record this site',
      confirmLabel: 'Save'
    });
    if (answer === null) return;

    setCollectorPrefs({
      sites: [...collector.sites.filter((rule) => rule.site !== answer.value), { site: answer.value, level: answer.choice }]
    });
    repaintSettings();
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
      selectLabel: 'What to exclude',
      confirmLabel: 'Exclude'
    });
    if (answer === null) return;

    setCollectorPrefs({
      exclude: [...collector.exclude, { scope: answer.choice, value: answer.value }]
    });
    repaintSettings();
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
      if (!sync.signedIn) applyPlan(await signIn());
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
      heading('Activity'),
      el('p', {
        class: 'modal-note',
        text: 'Count changes recorded in this sealed vault, newest first. A bookmark’s own sheet shows its lines.'
      }),
      activityList(state.document, {
        limit: 20,
        showBookmark: true,
        label: 'Recent count activity'
      }),
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

            /* The creation is described by the committed name and the public half of the signing
               key, so the phrase is asked for when this page does not hold them: a vault created a
               moment ago does, and one reopened from a remembered record does not. */
            if (enable && (typeof state.proofKeyText !== 'string' || !committedName(state.serverId))) {
              const derived = await promptForSyncPhrase();
              if (!derived) return;

              /* The phrase names the account under both ids and holds both credentials, so the
                 page takes all of it: the committed name is what the creation and the sign-in
                 will use from here. */
              state.serverId = derived.serverId;
              state.proofKey = derived.proofKey;
              state.proofKeyText = derived.proofKeyText;
              state.authKey = derived.authKey;
              /* The remembered record takes the signing key: the secret behind it is what the
                 server would store, and it is neither derived here nor written anywhere. */
              const remembered = await store.readRemembered();
              if (remembered) {
                await store.remember(state.accountId, remembered.key, derived.authKey, {
                  serverId: derived.serverId,
                  proofKey: derived.proofKey
                });
              }
            }

            setPrefs({ sync: enable });
            render();
            await saveNow({ push: false });

            if (!syncEnabled()) {
              await sync.logout();
              setSyncStatus('');
              clearSyncRefusal({ reset: true });
              /* Off is not the same vault: the code was for a server this vault no longer talks to. */
              forgetInvite();
              return;
            }
            clearSyncRefusal({ reset: true });
            await syncNow();
          }
        ),
        /* The field that answers an invite-only server, in the section whose switch asked it: a
           question about creating the account has to be on the page, not behind a chip. */
        ...(state.inviteNeeded ? [inviteRow()] : []),
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
        ),
        item(
          'Delete account',
          syncEnabled()
            ? 'Erase the sealed copy, its history and every sign-in on the server, and clear this device.'
            : 'This vault is not syncing; this clears this device and any copy the server still holds.',
          () => {
            modal.close();
            deleteAccountSheet();
          },
          { danger: true }
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
    Activity: 'activity',
    Icons: 'vault',
    'Collected links': 'collected',
    Server: 'sync',
    'This device': 'device'
  };
  const PLAN = [
    ['vault', 'Vault'],
    ['activity', 'Activity'],
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

/** Whether the sheet is the dialog currently on the page. */
function settingsOpen() {
  return activeModal?.dialog?.classList.contains('settings-modal') === true;
}

/**
 * Draw the sheet again where it stands, for a change that alters which rows it holds. The sheet
 * is built once and left alone, so a row that becomes needed is drawn by building the sheet
 * again — at the same scroll position, which is where the person is reading.
 */
function repaintSettings() {
  const scroll = activeModal?.dialog?.querySelector('.modal-body')?.scrollTop ?? 0;
  const next = openSettings();
  const body = next.dialog.querySelector('.modal-body');
  if (body) body.scrollTop = scroll;
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
  state.serverId = null;
  state.proofKey = null;
  state.proofKeyText = null;
  state.authKey = null;
  /* A code is a secret like the phrase, so a lock drops it with everything else the page held. */
  forgetInvite();
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
  placesCount = null;
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

  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
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
