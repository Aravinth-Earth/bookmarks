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
  assert.equal(light.foreground, '#000000', 'dark text on a light tile');

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

test('every seed colour gets the readable foreground, mid-tones included', async () => {
  const lin = (channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const lumOf = (hex) => {
    const [red, green, blue] = hex.match(/[0-9a-f]{2}/gi).map((pair) => Number.parseInt(pair, 16));
    return 0.2126 * lin(red) + 0.7152 * lin(green) + 0.0722 * lin(blue);
  };
  const ratio = (left, right) => {
    const [high, low] = [lumOf(left), lumOf(right)].sort((a, b) => b - a);
    return (high + 0.05) / (low + 0.05);
  };

  /* A sweep of seeds, including the mid-tones where a naive threshold picks white and fails. */
  const seeds = ['#000000', '#101020', '#3c654f', '#6b4a8f', '#808080', '#9a9a9a', '#ffcc00', '#ffffff'];
  for (const seed of seeds) {
    const { foreground } = tileFor({ hostname: 'example.com', name: 'E', color: seed });
    const reachable = ratio(seed, foreground);
    assert.ok(reachable >= 4.5, `${seed} with ${foreground} is ${reachable.toFixed(2)}:1`);
  }

  /* The crossing point itself: a mid grey is better with ink than with white. */
  assert.equal(foregroundFor('#808080'), '#000000');
});
