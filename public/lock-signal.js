/**
 * Bookmarks — the signal that closes every tab at once.
 *
 * Locking is a promise about the device, not about the tab that pressed the button. Each tab
 * holds its own copy of the key, the open document and its server session in memory, so a lock
 * that only cleared the tab on screen left the same vault open in the tab behind it. A broadcast
 * is the one way to reach tabs the page did not open.
 *
 * The message carries nothing but its type: no key, no phrase, no account id. Anything that can
 * listen on this origin can already read the page, so the message names no data at all.
 *
 * A browser without `BroadcastChannel` gets the old behaviour rather than an error — one tab at a
 * time still locks correctly, and the page keeps working.
 */

export const LOCK_CHANNEL = 'bookmarks-lock';

/** The only message this module sends. Frozen so a listener cannot be handed a mutable one. */
const LOCKED = 'locked';

/**
 * @param {{ createChannel?: (name: string) => object }} options `createChannel` exists so the
 *   tests can drive the signal without a browser; it is not for the page.
 */
export function createLockSignal({ createChannel } = {}) {
  let channel = null;
  try {
    const make = createChannel ?? ((name) => new BroadcastChannel(name));
    channel = make(LOCK_CHANNEL);
  } catch {
    channel = null;
  }

  return {
    /**
     * Tells every other tab on this origin to drop its key. Returns whether it went out, which is
     * only useful to a test; the page does not care.
     */
    broadcast() {
      if (!channel) return false;
      try {
        channel.postMessage({ type: LOCKED });
        return true;
      } catch {
        return false;
      }
    },

    /**
     * Runs `handler` here when another tab locks. Returns an unwatch function. A message this tab
     * sent itself never arrives — `BroadcastChannel` does not deliver to its own sender, which is
     * what keeps a lock from looping.
     */
    watch(handler) {
      const target = channel;
      if (!target || typeof handler !== 'function') return () => {};

      const onMessage = (event) => {
        if (event?.data?.type !== LOCKED) return;
        handler();
      };
      target.addEventListener('message', onMessage);

      return () => {
        try {
          target.removeEventListener('message', onMessage);
        } catch {
          /* The channel is already gone; nothing is listening either. */
        }
      };
    },

    close() {
      try {
        channel?.close();
      } catch {
        /* Closing a channel that a browser already dropped is not a failure. */
      }
      channel = null;
    }
  };
}
