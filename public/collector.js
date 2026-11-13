/**
 * Collected links — the page's half of the bridge.
 *
 * The extension keeps a list of the addresses this browser opened; this module is how the vault asks for it. The
 * two parcels ship separately and share no build step, so `BRIDGE_SOURCE`, `PAGE_SOURCE` and `BRIDGE_VERSION` are
 * written in both and compared by `scripts/check.mjs`. Everything else here is the page's own.
 *
 * The transport is `window.postMessage` to a content script the extension injects into this origin: no route on
 * the Worker, no network request from the extension, and nothing for the page's content security policy to allow.
 * A reply that does not arrive is not an error — the extension is optional, and the answer to "is it installed?"
 * is a timeout.
 */

export const BRIDGE_SOURCE = 'bookmarks-collector';
export const PAGE_SOURCE = 'bookmarks-page';
export const BRIDGE_VERSION = 1;

/* Long enough for a waking service worker, short enough that a page with no extension does not sit waiting. */
export const REPLY_TIMEOUT_MS = 1200;

/** A reply as the rest of the page reads it: a snapshot, a count, or nothing. */
export function isSnapshot(reply) {
  return Boolean(reply) && reply.ok === true && Array.isArray(reply.items) && Boolean(reply.policy);
}

/**
 * The page's handle on the extension.
 *
 * `request` resolves with the reply, or with null when nothing answers inside the timeout — which is what an
 * uninstalled, disabled or asleep-and-unreachable extension looks like, and all three are the same thing to the
 * page: show nothing and stay quiet.
 */
export function createBridge({ window: host = window, timeout = REPLY_TIMEOUT_MS } = {}) {
  const waiting = new Map();
  const listeners = new Set();
  let nextId = 1;

  function onMessage(event) {
    if (event.source !== host) return;

    const data = event.data;
    if (!data || data.source !== BRIDGE_SOURCE || data.version !== BRIDGE_VERSION) return;

    if (data.id !== undefined && waiting.has(data.id)) {
      const settle = waiting.get(data.id);
      waiting.delete(data.id);
      settle(data.reply ?? null);
      return;
    }

    if (data.changed !== undefined) {
      for (const listener of listeners) listener(data.changed);
    }
  }

  host.addEventListener('message', onMessage);

  function send(type, payload = null) {
    return new Promise((resolve) => {
      const id = nextId;
      nextId += 1;

      const timer = setTimeout(() => {
        waiting.delete(id);
        resolve(null);
      }, timeout);

      waiting.set(id, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });

      host.postMessage({ source: PAGE_SOURCE, version: BRIDGE_VERSION, id, type, payload }, host.location.origin);
    });
  }

  return {
    hello: () => send('hello'),
    request: () => send('request'),
    promote: (urls) => send('promote', urls),
    dismiss: (urls) => send('dismiss', urls),
    exclude: (entries) => send('exclude', entries),
    clear: () => send('clear'),
    setPolicy: (policy) => send('policy', policy),

    /** Called whenever the extension says the collected list moved — a new tab, an approval, an exclusion. */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    close() {
      host.removeEventListener('message', onMessage);
      listeners.clear();
      for (const settle of waiting.values()) settle(null);
      waiting.clear();
    }
  };
}
