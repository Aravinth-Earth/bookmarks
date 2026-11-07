/**
 * Apply the saved site theme before the first paint.
 *
 * This lives in its own file rather than in an inline script because the page's CSP is
 * `script-src 'self'`: an inline snippet would simply not run. A classic script in <head>
 * blocks the parser, which is what makes it run before the stylesheet paints.
 *
 * The key and the theme names match `js/theme-switcher.js` in the site repository, so a theme
 * chosen on the homepage is the theme this page opens with.
 */
(function () {
  'use strict';

  var THEMES = [
    'current', 'light', 'amber', 'teal', 'charcoal',
    'greenish', 'colorful', 'sunset', 'nord', 'cyberpunk'
  ];

  try {
    var saved = localStorage.getItem('site-theme');
    if (saved && THEMES.indexOf(saved) !== -1) {
      document.documentElement.setAttribute('data-theme', saved);
    } else if (
      window.matchMedia &&
      window.matchMedia('(prefers-color-scheme: light)').matches
    ) {
      document.documentElement.setAttribute('data-theme', 'light');
    } else {
      document.documentElement.setAttribute('data-theme', 'current');
    }
  } catch (error) {
    /* Storage is unavailable; the default theme is fine. */
  }
})();
