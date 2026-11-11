/**
 * The service worker: tab events in, storage out, answers back.
 *
 * Every decision lives in `collector-core.js` so this file is only wiring — and wiring is the part that cannot be
 * tested without a browser, which is why it is kept to nothing else. Nothing here throws out of a listener: a
 * rejected promise in a tab handler is a tab the person cannot use.
 *
 * One event is a visit: the tab committed a new address. How long the page stayed open and which tab is in front
 * are not observed — this worker has no timer, no dwell state and nothing to remember about a tab.
 */

import { BRIDGE_VERSION, TYPES } from './protocol.js';
import { createCollector } from './collector-core.js';

const TIDY_ALARM = 'collector-tidy';
const TIDY_MINUTES = 360;
const BADGE_COLOUR = '#c98a1b';
const CHANGED = 'collected-changed';

/* Who may talk to this worker, and which tabs hear about a change, are one answer: the vault page the manifest
   injects the bridge into. Reading it from the manifest means the extension cannot name an origin the guard has
   not reviewed, and the local dev server is covered without a second copy of the address here. */
const VAULT_PATTERNS = (chrome.runtime.getManifest().content_scripts ?? []).flatMap((script) => script.matches ?? []);
const VAULT_ORIGINS = new Set(VAULT_PATTERNS.map((pattern) => new URL(pattern.replace('*', 'x')).origin));

/**
 * The same origins without their port.
 *
 * A match pattern cannot name a port, and a loopback vault runs on whatever port the developer's server picked, so
 * an exact origin comparison refuses every local vault except the one port the pattern happened to spell out.
 */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);
const VAULT_HOSTS = new Set(
  [...VAULT_ORIGINS].filter((origin) => LOOPBACK.has(new URL(origin).hostname)).map((origin) => {
    const url = new URL(origin);
    return `${url.protocol}//${url.hostname}`;
  })
);

/**
 * Where the vault lives, taken from the one place that names it — the content script's own matches — so no origin is
 * written down twice and a review of the manifest covers this too.
 */
const VAULT_SETUP_URL = (() => {
  const pattern = VAULT_PATTERNS.find((entry) => entry.startsWith('https://')) ?? VAULT_PATTERNS[0] ?? '';
  if (pattern === '') return null;
  const url = new URL(pattern.split('*')[0]);
  return `${url.origin}/w/bookmarks/?collector=installed`;
})();

/** Before the vault has answered, the toolbar says so; afterwards it says nothing. */
async function clearSetupHint() {
  await chrome.action.setBadgeText({ text: '' });
  await chrome.action.setTitle({ title: 'Bookmarks — collected links' });
}

const persistent = {
  async get(key) {
    const all = await chrome.storage.local.get(key);
    return all[key];
  },
  async put(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.local.remove(key);
  }
};

const collector = createCollector({ persistent });

/* What the vault tabs were last told. A reply to the page is not news, so nothing is pushed unless this actually
   moved — pushing on every answer turned the page's re-read into a loop that repainted the section many times a
   second. The signature carries the counts as well as the addresses: a fourth visit to a row already held is a
   change the vault has to hear about, and the number of rows does not move for it. */
let announced = null;

function signature(items) {
  return items
    .map((item) => `${item.url}:${item.visits}`)
    .join('|');
}

async function badge() {
  try {
    const { policy, items } = await collector.list();
    const count = policy.enabled ? items.length : 0;
    const text = count === 0 ? '' : count > 9 ? '9+' : String(count);
    await chrome.action.setBadgeText({ text });
    if (text !== '') await chrome.action.setBadgeBackgroundColor({ color: BADGE_COLOUR });

    const stamp = signature(items);
    if (stamp === announced) return;
    announced = stamp;

    /* Every vault tab still open hears about it, in every window: the section counts a browser-wide list, so a
       count that only refreshed on reload would be wrong the moment two windows are open. */
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
 * One finished page load is one visit.
 *
 * `status: 'complete'` fires once for each document a tab finishes loading, which makes a reload, a duplicated tab
 * and a new window each count on their own — there is no timer and nothing to compare against a previous visit.
 * The address is read from the tab rather than from `info.url`, because on a plain reload nothing about the URL
 * changed and `info.url` is absent.
 */
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== 'complete') return;

  const url = tab?.url ?? '';
  if (!/^https?:/i.test(url)) return;

  collector.capture(url, { incognito: tab?.incognito === true }).then(badge);
});

chrome.runtime.onInstalled.addListener(async (details) => {
  ensureAlarm();
  void badge();

  /* A first install, and only a first install, opens the vault to ask the one question worth asking: which vault
     these addresses belong to, and that nothing leaves this device. An update interrupts nobody — the vault states
     its policy on the next unlock, and a fresh tab in the middle of someone's work is a rude way to be updated. */
  if (details?.reason !== 'install' || !VAULT_SETUP_URL) return;

  try {
    await chrome.tabs.create({ url: VAULT_SETUP_URL });
    await chrome.action.setBadgeText({ text: '!' });
    await chrome.action.setBadgeBackgroundColor({ color: '#1f6feb' });
    await chrome.action.setTitle({ title: 'Finish setting up collected links' });
  } catch {
    /* A tab that cannot be opened is not worth a broken worker; the toolbar title still says what to do. */
  }
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
 * content script injected on one origin. Everything else — another extension, a page that somehow got a handle, a
 * frame on a look-alike host — is refused before any handler runs, because the handler's first act would be to hand
 * back every collected address.
 */
function trusted(sender) {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  if (!sender.tab) return true;
  if (VAULT_ORIGINS.has(sender.origin)) return true;

  /* A local vault: the host must be one the manifest named, and the port is the developer's business. */
  let url;
  try {
    url = new URL(sender.origin);
  } catch {
    return false;
  }
  return LOOPBACK.has(url.hostname) && VAULT_HOSTS.has(`${url.protocol}//${url.hostname}`);
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
      /* A vault has stated what it wants, so the "finish setting up" hint has done its job. */
      if (policy.enabled) await clearSetupHint();
      return { ok: true, policy };
    }

    case TYPES.promote:
      return { ok: true, removed: await collector.promote(message.payload ?? []) };

    case TYPES.dismiss:
      return { ok: true, removed: await collector.dismiss(message.payload ?? []) };

    case TYPES.exclude:
      return { ok: true, policy: await collector.exclude(message.payload ?? []) };

    case TYPES.clear:
      await collector.clear();
      return { ok: true, removed: 0 };

    case TYPES.revoke: {
      const { policy } = await collector.list();
      return { ok: true, policy: await collector.setPolicy({ ...policy, enabled: false }) };
    }

    default:
      return { error: 'refused' };
  }
}

/* `return true` is what keeps the channel open for the asynchronous reply; without it the page sees `undefined` and
   the collected section never fills. */
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
    /* Answering the page is not a change: re-announcing it here made the page re-read, which announced again. */
    .catch(() => sendResponse({ error: 'refused' }));

  return true;
});
