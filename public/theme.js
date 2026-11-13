/**
 * Apply the saved theme before the first paint.
 *
 * This lives in its own file rather than in an inline script because the page's CSP is
 * `script-src 'self'`: an inline snippet would simply not run. A classic script in <head>
 * blocks the parser, which is what makes it run before the stylesheet paints.
 *
 * The key and the theme names match `js/theme-switcher.js` in the site repository, with one
 * difference: this page never follows the system into a light theme. A bookmark list is read in
 * the dark, and an operating system that says "light" is not asking on the reader's behalf — a
 * saved choice is honoured, but "light" is not one of the choices, and a device that has it saved
 * from an older build opens in the default dark theme.
 */
(function () {
  'use strict';

  var THEMES = [
    'current', 'amber', 'teal', 'charcoal',
    'greenish', 'colorful', 'sunset', 'nord', 'cyberpunk'
  ];

  try {
    var saved = localStorage.getItem('site-theme');
    if (saved === 'light') {
      /* Left over from a build that offered it: forget it rather than paint white. */
      localStorage.removeItem('site-theme');
      saved = null;
    }
    document.documentElement.setAttribute(
      'data-theme',
      saved && THEMES.indexOf(saved) !== -1 ? saved : 'current'
    );
  } catch (error) {
    /* Storage is unavailable; the default theme is fine. */
    document.documentElement.setAttribute('data-theme', 'current');
  }
})();
