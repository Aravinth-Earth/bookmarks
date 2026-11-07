/**
 * Bookmarks — the page.
 *
 * Three jobs: unlock the vault, render the list, and write every change back through the
 * crypto and storage modules. Nothing here talks to a server, and nothing here puts a
 * bookmark, a name or a note into `innerHTML`: rows are built as nodes and filled with
 * `textContent`, because the vault is user data and a bookmark name must never be markup.
 */

import {
  addBookmark,
  createDocument,
  deleteBookmark,
  filterBookmarks,
  mergeDocuments,
  recordClick,
  sortBookmarks,
  togglePin,
  updateBookmark
} from './bookmarks.js';
import { deriveAccount, generatePhrase, keyFromBytes, open, seal } from './crypto.js';
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
import { fetchIcon } from './icons.js';
import { SyncClient, SyncError } from './sync.js';

const store = createVault(indexedDbAdapter());

const state = {
  accountId: null,
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
let lastSyncedAt = 0;
let plan = null;
let units = 0;
let trialEndsAt = null;

let saving = false;
let dirty = false;
let saveStamp = '';

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
const viewInput = $('view');
const settingsButton = $('settings-button');
const addForm = $('add-form');
const addToggle = $('add-toggle');
const addCancel = $('add-cancel');
const addUrl = $('add-url');
const addName = $('add-name');
const list = $('list');
const empty = $('empty');
const vaultStatus = $('vault-status');
const status = $('status');
const planNote = $('plan-note');

/* ------------------------------------------------------------------ appearance */

/* How the list looks is a device preference, not vault data: it is not worth a write to the
   sealed blob every time a size changes, and it must be readable before the vault is open. */
const VIEW_KEY = 'bookmarks-view';
const SIZE_KEY = 'bookmarks-font-size';
const VIEWS = new Set(['pills', 'list']);
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

let currentView = readPref(VIEW_KEY, VIEWS, 'pills');
let currentSize = readPref(SIZE_KEY, SIZES, 'medium');

function applyAppearance() {
  list.dataset.view = currentView;
  document.documentElement.dataset.size = currentSize;
  viewInput.value = currentView;
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
  remove: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13'
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
      state.version += 1;
      const sealed = await seal(state.key, state.document, state.accountId);
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

/* ---------------------------------------------------------------------- sync */

function syncEnabled() {
  return state.document?.prefs?.sync === true;
}

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
  const at = new Date(lastSyncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  setSyncStatus(`Synced ${at}`);
}

function handleSyncError(error) {
  if (error?.code === 'TRIAL_ENDED') {
    trialEndsAt = Date.now();
    renderPlanNote();
    setSyncStatus('Read-only');
    return;
  }
  if (error?.code === 'PUSH_FAILED' && error.status === 413) {
    setSyncStatus('Vault too large');
    announce('This vault is larger than the free tier allows. Export a sealed backup and trim it.', {
      duration: 8000
    });
    return;
  }
  if (error?.code === 'FULL') {
    setSyncStatus('Server full');
    announce('This server is not accepting new vaults right now.', { duration: 6000 });
    return;
  }
  if (error?.code === 'NO_ACCOUNT') {
    setSyncStatus('Could not create the account');
    return;
  }
  if (error?.code === 'LOCKED') {
    setSyncStatus('Locked out');
    return;
  }
  if (error?.code === 'CONFLICT') {
    setSyncStatus('Sync conflict');
    return;
  }
  if (error?.code === 'UNAUTHORIZED') {
    sync.token = null;
    setSyncStatus('Signing in…');
    return;
  }
  setSyncStatus('Offline');
}

/**
 * One reconcile: sign in if needed, read the server's blob, merge it into this device, then
 * push if this device knows something the server does not. A conflict is merged and retried
 * once; a second conflict means two devices are writing faster than one can settle.
 */
async function syncNow() {
  if (!syncEnabled() || !state.key || !state.authSecret) return;
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
        session = await sync.login(state.accountId, state.authSecret);
      } catch (error) {
        if (error.code !== 'NO_ACCOUNT') throw error;

        /* First sync on a new phrase: the account is created from the same secrets the login
           would have used, so there is nothing to provision and no token to hold. */
        setSyncStatus('Creating the account…');
        await sync.register(state.accountId, state.authSecret);
        session = await sync.login(state.accountId, state.authSecret);
      }

      applyPlan(session);
    }

    const remote = await sync.pull();

    if (remote) {
      state.remoteVersion = remote.version;
      const remoteDocument = await open(state.key, remote, state.accountId);
      const { document: merged } = mergeDocuments(state.document, remoteDocument);

      if (fingerprint(merged) !== fingerprint(state.document)) {
        state.document = merged;
        absorbed = true;
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

    let result = await sync.push(state.remoteVersion, state.sealed);

    if (result.conflict) {
      state.remoteVersion = result.currentVersion;
      if (result.current) {
        const conflictDocument = await open(state.key, result.current, state.accountId);
        const { document: merged } = mergeDocuments(state.document, conflictDocument);
        state.document = merged;
        absorbed = true;
        render();
        await saveNow({ push: false });
      }
      result = await sync.push(state.remoteVersion, state.sealed);
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
  if (!focus) return;
  (open ? addUrl : addToggle).focus();
}

function showLockError(message) {
  lockError.textContent = message;
  lockError.hidden = !message;
}

function showLock(message = '') {
  appView.hidden = true;
  lockView.hidden = false;
  showLockError(message);
  phraseInput.focus();
}

function enter({ accountId, authSecret, key, version, sealed, document: vaultDocument }) {
  state.accountId = accountId;
  state.authSecret = authSecret ?? null;
  state.key = key;
  state.version = version;
  state.sealed = sealed;
  state.document = vaultDocument;

  lockView.hidden = true;
  appView.hidden = false;
  showLockError('');

  sortInput.value = vaultDocument.prefs?.sort ?? 'clicks';
  searchInput.value = '';
  render();

  const empty = vaultDocument.bookmarks.length === 0;
  setAddForm(empty, { focus: false });
  if (empty) addUrl.focus();
  else if (window.matchMedia?.('(pointer: fine)').matches) searchInput.focus();

  if (syncEnabled()) syncNow();
}

async function tryRemembered() {
  let remembered;
  try {
    remembered = await store.readRemembered();
  } catch {
    return showLock();
  }
  if (!remembered) return showLock();

  try {
    const key = await keyFromBytes(remembered.keyBytes);
    const stored = await store.load(remembered.accountId);
    if (!stored.sealed) throw new Error('the remembered key has no vault');

    const vaultDocument = await open(key, stored.sealed, remembered.accountId);
    enter({
      accountId: remembered.accountId,
      authSecret: remembered.authSecret,
      key,
      version: stored.version,
      sealed: stored.sealed,
      document: vaultDocument
    });
  } catch {
    await store.forget().catch(() => {});
    showLock('This device could not reopen its vault. Enter your phrase.');
  }
}

/* -------------------------------------------------------------------- unlock */

async function handleUnlock(event) {
  event.preventDefault();
  showLockError('');

  const phrase = phraseInput.value;
  if (phrase.trim() === '') {
    showLockError('Enter your 13-word phrase.');
    phraseInput.focus();
    return;
  }

  unlockButton.disabled = true;
  unlockButton.textContent = 'Unlocking…';

  try {
    const { accountId, vaultKey, vaultKeyBytes, authSecret } = await deriveAccount(phrase);
    const stored = await store.load(accountId);
    const vaultDocument = stored.sealed
      ? await open(vaultKey, stored.sealed, accountId)
      : createDocument();

    if (rememberInput.checked) await store.remember(accountId, vaultKeyBytes, authSecret);
    else await store.forget();

    enter({
      accountId,
      authSecret,
      key: vaultKey,
      version: stored.version,
      sealed: stored.sealed,
      document: vaultDocument
    });

    phraseInput.value = '';
    if (!stored.sealed) await saveNow();
  } catch (error) {
    showLockError(messageFor(error));
    phraseInput.focus();
  } finally {
    unlockButton.disabled = false;
    unlockButton.textContent = 'Unlock';
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

  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(phrase);
      feedback('Copied', true);
      return;
    } catch {
      /* Fall through to the selection-based copy. */
    }

    if (copyWithSelection()) {
      feedback('Copied', true);
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
    actions: [createButton]
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
  const { accountId, vaultKey, vaultKeyBytes, authSecret } = await deriveAccount(phrase);
  const vaultDocument = createDocument();
  const sealed = await seal(vaultKey, vaultDocument, accountId);

  await store.save(accountId, sealed, 1);
  if (remember) await store.remember(accountId, vaultKeyBytes, authSecret);
  else await store.forget();

  enter({ accountId, authSecret, key: vaultKey, version: 1, sealed, document: vaultDocument });
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
  if (phrase.trim() === '') {
    showLockError('Enter the 13-word phrase for the backup, then restore it again.');
    phraseInput.focus();
    return;
  }

  try {
    const { accountId, vaultKey, vaultKeyBytes, authSecret } = await deriveAccount(phrase);
    const vaultDocument = await open(vaultKey, sealed, accountId);
    const stored = await store.load(accountId);

    const version = Math.max(stored.version, 0) + 1;
    await store.save(accountId, sealed, version);
    if (rememberInput.checked) await store.remember(accountId, vaultKeyBytes, authSecret);
    else await store.forget();

    enter({ accountId, authSecret, key: vaultKey, version, sealed, document: vaultDocument });
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

function rowFor(bookmark) {
  const { initial, background, foreground } = tileFor(bookmark);

  const tile = el('span', { class: 'tile', 'aria-hidden': 'true' });
  if (bookmark.icon) {
    tile.append(el('img', { src: bookmark.icon, alt: '' }));
  } else {
    tile.textContent = initial;
  }

  const label = el('span', { class: 'row-label' }, [
    el('span', { class: 'row-name', text: bookmark.name || bookmark.search || bookmark.hostname }),
    el('span', { class: 'row-host', text: bookmark.hostname })
  ]);

  const link = el('a', {
    class: 'row-link',
    href: bookmark.url,
    target: '_blank',
    rel: 'noopener noreferrer'
  }, [tile, label]);

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

  const clicks = el('span', {
    class: 'clicks',
    text: String(bookmark.clickCount),
    'aria-label': `${bookmark.clickCount} clicks`
  });

  const actions = el('span', { class: 'row-actions' }, [
    actionButton('pin', `${bookmark.pinned ? 'Unpin' : 'Pin'} ${labelOf(bookmark)}`, 'pin', {
      pressed: bookmark.pinned
    }),
    actionButton('edit', `Edit ${labelOf(bookmark)}`, 'edit'),
    actionButton('remove', `Delete ${labelOf(bookmark)}`, 'remove')
  ]);

  row.append(link, clicks, actions);
  return row;
}

function render() {
  if (!state.document) return;

  const query = searchInput.value;
  const matched = filterBookmarks(state.document, query);
  const view = { ...state.document, bookmarks: matched };
  const sorted = sortBookmarks(view, sortInput.value);

  list.replaceChildren(...sorted.map(rowFor));

  empty.hidden = sorted.length !== 0;
  empty.textContent =
    state.document.bookmarks.length === 0
      ? 'No bookmarks yet. Add one above, or import a file from Settings.'
      : `No bookmark matches “${query.trim()}”.`;

  updateStatusLine();
}

/* ------------------------------------------------------------------- actions */

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
    searchInput.value = '';
    render();
    setAddForm(false);
    saveNow();
    announce(`Added ${labelOf(bookmark)}`);
    fetchAndStoreIcon(bookmark.id, bookmark.hostname);
  } catch (error) {
    if (error.code === 'DUPLICATE') {
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

async function fetchMissingIcons() {
  const missing = state.document.bookmarks.filter((bookmark) => !bookmark.icon);
  if (missing.length === 0) {
    announce('Every bookmark already has an icon.');
    return;
  }

  let done = 0;
  let added = 0;

  /* Four at a time: enough to finish a library quickly, few enough that the Worker is not the
     thing that floods someone's server. */
  for (let at = 0; at < missing.length; at += 4) {
    const batch = missing.slice(at, at + 4);
    const fetched = await Promise.all(
      batch.map(async (bookmark) => [
        bookmark.id,
        await fetchIcon(bookmark.hostname, { fresh: true }).catch(() => null)
      ])
    );

    const icons = fetched.filter(([, icon]) => typeof icon === 'string');
    if (icons.length > 0) {
      let next = state.document;
      for (const [id, icon] of icons) {
        if (next.bookmarks.some((bookmark) => bookmark.id === id && !bookmark.icon)) {
          next = updateBookmark(next, id, { icon }, Date.now);
        }
      }
      state.document = next;
      added += icons.length;
      render();
      await saveNow();
    }

    done += batch.length;
    setVaultStatus(`Fetching icons… ${done}/${missing.length}`);
  }

  announce(`Added ${added} icon${added === 1 ? '' : 's'}.`);
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
      el('label', { class: 'confirm-saved' }, [iconOnly, el('span', { text: 'Show the tile only' })]),
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
          text: `That file holds ${parsed.document.bookmarks.length} bookmarks.`
        }),
        el('p', {
          class: 'modal-note',
          text: `Skipped ${parsed.statistics.skipped}, duplicates ${parsed.statistics.duplicates}. Merge keeps what is already here; replace discards it.`
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
}

/* ------------------------------------------------------------------ settings */

/**
 * A remembered device written before sync existed carries the vault key but not the auth
 * secret. It is asked for the phrase once, and the answer is kept the way the key is kept.
 * The account id is derived from the phrase, so a wrong phrase simply derives another vault.
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
          text: 'This device was remembered before sync existed. Enter the phrase once so it can sign in. It is not stored on the server, and the key it derives stays in this browser.'
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
      try {
        const { accountId, authSecret } = await deriveAccount(phrase.value);
        if (accountId !== state.accountId) {
          throw new Error('That phrase belongs to a different vault.');
        }
        settled = true;
        resolve(authSecret);
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

  const modal = openModal({
    title: 'Settings',
    body: [
      el('p', {
        class: 'modal-note',
        text: `${count} bookmarks in this vault · version ${state.version} · ${planLabel()}.`
      }),
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
          `${missingIcons} without an icon. Each site is asked once, by this server, and the image is stored inside the sealed vault.`,
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

            if (enable && !state.authSecret) {
              const secret = await promptForSyncPhrase();
              if (!secret) return;

              state.authSecret = secret;
              const remembered = await store.readRemembered();
              if (remembered) await store.remember(state.accountId, remembered.keyBytes, secret);
            }

            state.document = {
              ...state.document,
              prefs: { ...state.document.prefs, sync: enable }
            };
            render();
            await saveNow({ push: false });

            if (!syncEnabled()) {
              await sync.logout();
              setSyncStatus('');
              return;
            }
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
        item('Clear this device', 'Delete the sealed vault and its history from this browser.', async () => {
          modal.close();
          const sure = await askModal({
            title: 'Clear this device?',
            body: [
              el('p', {
                class: 'modal-note',
                text: 'The sealed vault, its local history and the remembered key are deleted from this browser. The bookmark list is not recoverable without a backup or the phrase.'
              })
            ],
            confirmLabel: 'Clear this device',
            danger: true
          });
          if (!sure) return;
          await store.clear();
          location.reload();
        }, { danger: true })
      ]),
      el('p', {
        class: 'modal-note',
        text: 'The vault is sealed in this browser with AES-256-GCM. This server only ever holds the sealed blob.'
      })
    ]
  });
}

async function lockVault() {
  await sync.logout();
  await store.forget();
  state.accountId = null;
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
  planNote.hidden = true;
  list.replaceChildren();
  showLock('Locked. Enter your phrase to reopen the vault.');
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

  addForm.addEventListener('submit', handleAdd);
  addToggle.addEventListener('click', () => setAddForm(addForm.hidden));
  addCancel.addEventListener('click', () => setAddForm(false));
  list.addEventListener('click', handleListClick);
  searchInput.addEventListener('input', render);

  sortInput.addEventListener('change', () => {
    state.document = {
      ...state.document,
      prefs: { ...state.document.prefs, sort: sortInput.value }
    };
    render();
    saveNow();
  });

  settingsButton.addEventListener('click', openSettings);

  viewInput.addEventListener('change', () => {
    currentView = VIEWS.has(viewInput.value) ? viewInput.value : 'pills';
    writePref(VIEW_KEY, currentView);
    applyAppearance();
  });

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
