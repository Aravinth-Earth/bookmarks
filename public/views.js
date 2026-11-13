/**
 * Bookmarks — the two ways the list can look, and the one control that switches between them.
 *
 * Only pills and list exist, so a select would ask for two interactions where one will do. The
 * toggle's accessible name states the view the tap moves to, while its tooltip names both, so a
 * person who has never seen either view knows what the other one is.
 */

export const VIEW_NAMES = Object.freeze(['pills', 'list']);
export const DEFAULT_VIEW = 'pills';
export const VIEWS = new Set(VIEW_NAMES);

/** Whether a stored or received value names a view this app can show. */
export function isView(value) {
  return VIEWS.has(value);
}

/** The view one tap away. An unknown value is treated as the default rather than kept. */
export function nextView(view) {
  return isView(view) && view === 'list' ? 'pills' : 'list';
}

/**
 * Everything the toggle button needs for the view currently on screen: the view a click moves
 * to, the accessible name that states it, and the tooltip that names both.
 */
export function viewToggleState(view) {
  const current = isView(view) ? view : DEFAULT_VIEW;
  const target = nextView(current);
  return {
    current,
    target,
    label: `Switch to ${target} view`,
    title: 'Switch between the pills and list views'
  };
}
