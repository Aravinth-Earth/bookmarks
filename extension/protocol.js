/**
 * The two ends of the bridge, named once.
 *
 * The page and the extension ship separately and share no build step, so the only thing keeping them in agreement
 * is this constant written in two files and the guard in `scripts/check.mjs` that compares them. Bump
 * BRIDGE_VERSION in both in the same commit, or `npm run check` fails — which is the point.
 */

export const BRIDGE_SOURCE = 'bookmarks-collector';
export const PAGE_SOURCE = 'bookmarks-page';
export const BRIDGE_VERSION = 1;

export const TYPES = Object.freeze({
  hello: 'hello',
  request: 'request',
  reply: 'reply',
  policy: 'policy',
  promote: 'promote',
  dismiss: 'dismiss',
  exclude: 'exclude',
  clear: 'clear',
  revoke: 'revoke'
});
