/**
 * Collected links — the page's half of the bridge.
 *
 * Only the contract lives here so far: the two parcels ship separately and share no build step, so the version
 * they agree on is written in both files and compared by `scripts/check.mjs`. The folding and promotion rules join
 * it in the phase that renders the section; until then this module is imported by nothing but that guard.
 */

export const BRIDGE_SOURCE = 'bookmarks-collector';
export const PAGE_SOURCE = 'bookmarks-page';
export const BRIDGE_VERSION = 1;
