/**
 * The page's side of the wall, as a content script.
 *
 * The vault page cannot call `chrome.*` and the extension cannot read the page's world without a content script,
 * so this file is the only passage between them. It is a relay and nothing else: one message shape in each
 * direction, no interpretation, no storage, no network — `window.postMessage` is used precisely because it needs
 * neither a route on the Worker nor a change to the page's content security policy.
 *
 * A content script is a classic script, so it cannot import `protocol.js`; the three constants are written here
 * again and `scripts/check.mjs` fails when the three copies disagree.
 */

const BRIDGE_SOURCE = 'bookmarks-collector';
const PAGE_SOURCE = 'bookmarks-page';
const BRIDGE_VERSION = 1;

const CHANGED = 'collected-changed';

window.addEventListener('message', (event) => {
  if (event.source !== window) return;

  const data = event.data;
  if (!data || data.source !== PAGE_SOURCE || data.version !== BRIDGE_VERSION) return;

  /* A worker that is asleep is woken by this call, and a worker that is missing answers with lastError and no
     reply — both are answered to the page as `unreachable` so it never waits on a channel that cannot answer. */
  chrome.runtime.sendMessage({ type: data.type, payload: data.payload }, (reply) => {
    const failed = chrome.runtime.lastError;
    window.postMessage(
      {
        source: BRIDGE_SOURCE,
        version: BRIDGE_VERSION,
        id: data.id,
        reply: failed ? { error: 'unreachable' } : reply ?? { error: 'unreachable' }
      },
      window.location.origin
    );
  });
});

/* Counting is live across windows: the worker tells every open vault tab when the list moved, and the page
   re-reads rather than patching a copy it cannot trust. */
chrome.runtime.onMessage.addListener((message) => {
  if (!message || message.type !== CHANGED) return;
  window.postMessage(
    { source: BRIDGE_SOURCE, version: BRIDGE_VERSION, changed: message.payload ?? null },
    window.location.origin
  );
});
