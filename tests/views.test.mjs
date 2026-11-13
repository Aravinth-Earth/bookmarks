/**
 * The view toggle: two states, one tap, and a name that states where the tap goes.
 *
 * The toggle replaced a select, so the cases that matter are the round trip between the two
 * views and the fallback for a value the app cannot show.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_VIEW, VIEW_NAMES, isView, nextView, viewToggleState } from '../public/views.js';

test('two views exist and both are recognised', () => {
  assert.deepEqual([...VIEW_NAMES], ['pills', 'list']);
  assert.equal(isView('pills'), true);
  assert.equal(isView('list'), true);
  assert.equal(isView('grid'), false);
  assert.equal(isView(undefined), false);
  assert.equal(isView(null), false);
});

test('one tap moves to the other view and one more tap comes back', () => {
  assert.equal(nextView('pills'), 'list');
  assert.equal(nextView('list'), 'pills');
  assert.equal(nextView(nextView('pills')), 'pills');
});

test('an unknown view is treated as the default, not carried forward', () => {
  assert.equal(DEFAULT_VIEW, 'pills');
  assert.equal(nextView('grid'), 'list');
  assert.equal(nextView(undefined), 'list');
  assert.equal(viewToggleState('grid').current, DEFAULT_VIEW);
});

test('the toggle names the view it switches to and the tooltip names both', () => {
  const pills = viewToggleState('pills');
  assert.equal(pills.target, 'list');
  assert.equal(pills.label, 'Switch to list view');
  assert.match(pills.title, /pills/);
  assert.match(pills.title, /list/);

  const listed = viewToggleState('list');
  assert.equal(listed.target, 'pills');
  assert.equal(listed.label, 'Switch to pills view');
  assert.equal(listed.title, pills.title);
});
