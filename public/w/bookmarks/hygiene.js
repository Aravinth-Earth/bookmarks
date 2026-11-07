/**
 * Bookmarks — the two places a phrase outlives its single use.
 *
 * A phrase is read once, unlocks the vault, and should leave nothing behind. The field that took
 * it is cleared on every attempt, and a copy made from the create dialog is overwritten after a
 * short delay instead of sitting on the OS clipboard for the rest of the day.
 *
 * The app and `node --test` share these by keeping the browser objects as arguments: a field is
 * anything with a `value`, the clipboard is anything with `readText` and `writeText`.
 */

/* Long enough to paste one's own copy somewhere, short enough that a shared machine is not left
   holding the master secret. */
export const CLIPBOARD_CLEAR_MS = 30_000;

/** Every attempt clears the field that carried the phrase, before it is used. */
export function clearPhraseField(field) {
  if (!field) return;
  field.value = '';
}

/**
 * Overwrite the clipboard with an empty string, but only when it still holds the phrase.
 *
 * Reading is how the write stays safe: a person may have copied something else in the meantime,
 * and wiping that would be a bug of its own. A browser that refuses the read leaves the clipboard
 * alone and reports `unreadable` — the page cannot know what is there, so it must not guess.
 *
 * @returns {Promise<'cleared'|'kept'|'unreadable'>}
 */
export async function overwriteClipboard({ read, write, phrase }) {
  if (typeof phrase !== 'string' || phrase === '') return 'kept';

  let current;
  try {
    current = await read();
  } catch {
    return 'unreadable';
  }
  if (current !== phrase) return 'kept';

  try {
    await write('');
  } catch {
    return 'unreadable';
  }
  return 'cleared';
}
