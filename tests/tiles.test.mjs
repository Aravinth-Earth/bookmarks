/**
 * The tile: deterministic, accessible, and made without a network request.
 *
 * The two properties that matter are that the same site looks the same on every device, and
 * that the letter is readable on the colour. Both are asserted rather than assumed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { PALETTE, foregroundFor, luminance, tileFor } from '../public/w/bookmarks/tiles.js';

const HOSTS = [
  'example.com',
  'github.com',
  'news.ycombinator.com',
  'wikipedia.org',
  'youtube.com',
  'mail.google.com'
];

test('the same hostname always gets the same tile', () => {
  for (const hostname of HOSTS) {
    const first = tileFor({ hostname, name: '' });
    const second = tileFor({ hostname, name: '' });
    assert.deepEqual(first, second);
  }
});

test('the palette is spread, so a list does not look like one colour', () => {
  const used = new Set(HOSTS.map((hostname) => tileFor({ hostname, name: '' }).background));
  assert.ok(used.size >= 4, `six hosts produced only ${used.size} colours`);
});

test('the initial comes from the name, then the host, and never from "www."', () => {
  assert.equal(tileFor({ hostname: 'example.com', name: 'Example' }).initial, 'E');
  assert.equal(tileFor({ hostname: 'example.com', name: '  ' }).initial, 'E');
  assert.equal(tileFor({ hostname: 'www.github.com', name: '' }).initial, 'G');
  assert.equal(tileFor({ hostname: '', name: '' }).initial, '#');
  assert.equal(tileFor({ hostname: 'தமிழ்.example', name: '' }).initial, 'த');
});

test('a stored colour wins, and its foreground is readable', () => {
  const light = tileFor({ hostname: 'example.com', name: 'E', color: '#ffff00' });
  assert.equal(light.background, '#ffff00');
  assert.equal(light.foreground, '#101414', 'dark text on a light tile');

  const dark = tileFor({ hostname: 'example.com', name: 'E', color: '#101020' });
  assert.equal(dark.background, '#101020');
  assert.equal(dark.foreground, '#ffffff', 'light text on a dark tile');
});

test('an invalid stored colour is ignored, not rendered', () => {
  for (const color of ['not-a-colour', '#fff', 'rgb(0,0,0)', '', null]) {
    const tile = tileFor({ hostname: 'example.com', name: 'E', color });
    assert.ok(PALETTE.some((entry) => entry.background === tile.background));
  }
});

test('every palette pair carries readable contrast, and luminance is ordered', () => {
  assert.equal(new Set(PALETTE.map((entry) => entry.background)).size, PALETTE.length);

  for (const entry of PALETTE) {
    assert.equal(foregroundFor(entry.background), entry.foreground, entry.background);
  }

  assert.equal(luminance('#000000'), 0);
  assert.ok(Math.abs(luminance('#ffffff') - 1) < 1e-9);
  assert.ok(luminance('#ffff00') > luminance('#808080'));
  assert.equal(luminance('nonsense'), 0);
});
