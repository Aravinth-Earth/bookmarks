/**
 * The service worker: tab events in, storage out, answers back.
 *
 * Every decision lives in `collector-core.js` so this file is only wiring — and wiring is the part that cannot be
 * tested without a browser, which is why it is kept to nothing else. Nothing here throws out of a listener: a
 * rejected promise in a tab handler is a tab the person cannot use.
 *
 * Two habits matter for MV3 specifically. The worker is stopped after about half a minute of quiet, so anything
 * that must survive is written down (the active tab, the dwell entries) and every listener is registered at the
 * top level, where it is registered before any event can arrive.
 */

import { BRIDGE_VERSION, TYPES } from './protocol.js';
import { createCollector } from './collector-core.js';

const TIDY_ALARM = 'collector-tidy';
const TIDY_MINUTES = 360;
const ACTIVE_KEY = 'activeTab';
const BADGE_COLOUR = '#c98a1b';
/* Who may talk to this worker, and which tabs hear about a change, are one answer: the vault page the manifest
   injects the bridge into. Reading it from the manifest means the extension cannot name an origin the guard has
   not reviewed, and the local dev server is covered without a second copy of the address here. */
const VAULT_PATTERNS = (chrome.runtime.getManifest().content_scripts ?? []).flatMap((script) => script.matches ?? []);
const VAULT_ORIGINS = new Set(VAULT_PATTERNS.map((pattern) => new URL(pattern.replace('*', 'x')).origin));
const CHANGED = 'collected-changed';

/* The two storage areas differ only in which `chrome.storage` they are, so the wrapper is written once. */
function area(name) {
  return {
    async get(key) {
      const all = await chrome.storage[name].get(key);
      return all[key];
    },
    async put(key, value) {
      await chrome.storage[name].set({ [key]: value });
    },
    async remove(key) {
      await chrome.storage[name].remove(key);
    }
  };
}

const persistent = area('local');
const session = area('session');

const collector = createCollector({ persistent, session });

async function badge() {
  try {
    const { policy, items } = await collector.list();
    const count = policy.enabled ? items.length : 0;
    const text = count === 0 ? '' : count > 9 ? '9+' : String(count);
    await chrome.action.setBadgeText({ text });
    if (text !== '') await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOUR });

    /* Every vault tab still open hears about it, in every window: the section counts a browser-wide list, so a
       count that only refreshes on reload would be wrong the moment two windows are open. */
    for (const tab of await chrome.tabs.query({ url: VAULT_PATTERNS })) {
      if (typeof tab.id === 'number') {
        chrome.tabs.sendMessage(tab.id, { type: CHANGED, payload: { count } }).catch(() => {});
      }
    }
  } catch {
    /* A badge that cannot be drawn is not worth a broken worker. */
  }
}

/** The alarm is created on install and re-created after any restart, because a worker restart does not keep it. */
function ensureAlarm() {
  chrome.alarms.get(TIDY_ALARM, (alarm) => {
    if (!alarm) chrome.alarms.create(TIDY_ALARM, { periodInMinutes: TIDY_MINUTES });
  });
}

/**
 * A navigation is a completed main frame, or a main frame that moved to another address. `info.url` is the value
 * that actually changed; the tab snapshot can still be the previous page, and counting that would be a visit that
 * never happened.
 */
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (!tab) return;
  if (info.status !== 'complete' && typeof info.url !== 'string') return;

  const url = info.url ?? tab.url ?? '';
  if (!/^https?:/i.test(url)) {
    collector.leave(tabId).then(badge);
    return;
  }

  collector.note(tabId, url, { incognito: tab.incognito === true }).then(badge);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  collector.leave(tabId).then(badge);
});

/* A tab replaced by another (a prerender committing, a discarded tab reloading) keeps its id, so the visit the old
   tab was holding belongs to the new one. */
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  collector.leave(removedTabId).then(badge);
});

/* Switching away is "leaving" a page: with a dwell gate this is the moment the visit is decided. The tab that was
   active is written to session storage because a sleeping worker remembers nothing else. */
chrome.tabs.onActivated.addListener(({ tabId }) => {
  session
    .get(ACTIVE_KEY)
    .then(async (previous) => {
      if (typeof previous === 'number' && previous !== tabId) await collector.leave(previous);
      await session.put(ACTIVE_KEY, tabId);
    })
    .then(badge);
});

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  void badge();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  void badge();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== TIDY_ALARM) return;
  collector.tidy().then(badge);
});

/**
 * Who may talk to this worker.
 *
 * The vault's page is the only thing that should ever carry a policy or an approval, and it speaks through a
 * content script injected on one origin. Everything else — another extension, a page that somehow got a handle,
 * a frame on a look-alike host — is refused before any handler runs, because the handler's first act would be to
 * hand back every collected address.
 */
function trusted(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (!sender.tab) return true;
  return VAULT_ORIGINS.has(sender.origin);
}

async function handle(message) {
  switch (message.type) {
    case TYPES.hello:
    case TYPES.request: {
      const { policy, items } = await collector.list();
      return { ok: true, version: BRIDGE_VERSION, policy, items };
    }

    case TYPES.policy: {
      const policy = await collector.setPolicy(message.payload ?? {});
      return { ok: true, policy };
    }

    case TYPES.promote:
      return { ok: true, removed: await collector.promote(message.payload ?? []) };

    case TYPES.dismiss:
      return { ok: true, removed: await collector.dismiss(message.payload ?? []) };

    case TYPES.exclude:
      return { ok: true, policy: await collector.exclude(message.payload ?? []) };

    case TYPES.revoke: {
      const { policy } = await collector.list();
      return { ok: true, policy: await collector.setPolicy({ ...policy, enabled: false }) };
    }

    default:
      return { error: 'refused' };
  }
}

/* `return true` is what keeps the channel open for the asynchronous reply; without it the page sees `undefined`
   and the collected section never fills. */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== 'string') return false;

  if (!trusted(sender)) {
    sendResponse({ error: 'refused' });
    return false;
  }

  handle(message)
    /* A thrown error is answered with a word, never with its text: an exception message is written by whatever
       failed, and that is not something to hand back over a channel. */
    .then((reply) => sendResponse(reply))
    .catch(() => sendResponse({ error: 'refused' }))
    .then(badge);

  return true;
});
