import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLIPBOARD_CLEAR_MS,
  clearPhraseField,
  overwriteClipboard
} from '../public/w/bookmarks/hygiene.js';

const PHRASE = 'abandon ability able about above absent absorb abstract absurd abuse access accident';

function clipboard(initial) {
  const state = { text: initial, writes: [] };
  return {
    state,
    read: async () => state.text,
    write: async (text) => {
      state.writes.push(text);
      state.text = text;
    }
  };
}

test('the field that carried the phrase is emptied', () => {
  const field = { value: PHRASE };
  clearPhraseField(field);
  assert.equal(field.value, '');
});

test('clearing a field that is not there is not an error', () => {
  assert.doesNotThrow(() => clearPhraseField(null));
});

test('a clipboard that still holds the phrase is overwritten', async () => {
  const board = clipboard(PHRASE);
  const result = await overwriteClipboard({ ...board, phrase: PHRASE });
  assert.equal(result, 'cleared');
  assert.equal(board.state.text, '');
  assert.deepEqual(board.state.writes, ['']);
});

test('a clipboard holding something else is left alone', async () => {
  const board = clipboard('a shopping list');
  const result = await overwriteClipboard({ ...board, phrase: PHRASE });
  assert.equal(result, 'kept');
  assert.equal(board.state.text, 'a shopping list');
  assert.deepEqual(board.state.writes, []);
});

test('a clipboard that cannot be read is not written to', async () => {
  const writes = [];
  const result = await overwriteClipboard({
    phrase: PHRASE,
    read: async () => {
      throw new Error('NotAllowedError');
    },
    write: async (text) => writes.push(text)
  });
  assert.equal(result, 'unreadable');
  assert.deepEqual(writes, []);
});

test('an empty phrase is never treated as a copy', async () => {
  const board = clipboard('');
  const result = await overwriteClipboard({ ...board, phrase: '' });
  assert.equal(result, 'kept');
  assert.deepEqual(board.state.writes, []);
});

test('the delay is short enough to matter and long enough to paste', () => {
  assert.equal(CLIPBOARD_CLEAR_MS, 30_000);
  assert.ok(CLIPBOARD_CLEAR_MS <= 60_000);
});
