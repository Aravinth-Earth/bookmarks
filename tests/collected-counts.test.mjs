/**
 * The bridge between the extension's total and the vault's own count.
 *
 * A bookmark counts the same however it was opened, so the extension's number is mirrored into this device's slot.
 * It is a mirror and not an addition: the same total arriving twice must not raise the count twice, and a device
 * never writes another device's slot.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

test('a bookmark takes the browser count for its address, and never a smaller one', async () => {
  const { openCounts } = await import('../public/collected.js');
  const bookmarks = [
    { id: 'a', url: 'https://a.example/', uses: {} },
    { id: 'b', url: 'https://b.example/' },
    { id: 'c', url: 'https://never.example/', uses: { mine: 4 } }
  ];
  const items = [
    { url: 'https://a.example/', visits: 3 },
    { url: 'https://b.example/', visits: 2 }
  ];

  assert.deepEqual(openCounts(items, bookmarks, 'mine'), [
    { id: 'a', openCount: 3 },
    { id: 'b', openCount: 2 }
  ]);
  assert.deepEqual(
    openCounts(items, [{ id: 'a', url: 'https://a.example/', uses: { mine: 3 } }], 'mine'),
    [],
    'the same total twice changes nothing'
  );
  assert.deepEqual(
    openCounts([{ url: 'https://a.example/', visits: 1 }], [{ id: 'a', url: 'https://a.example/', uses: { mine: 5 } }], 'mine'),
    [],
    'a lower total is ignored'
  );
});
