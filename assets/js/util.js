/* Shared helpers for the dashboard and rolodex pages.
 *
 * Loaded before dashboard.js / rolodex.js on both pages, which pull what they
 * need off window.LBV rather than each keeping their own copy.
 */

(function (global) {
  'use strict';

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : str;
    return div.innerHTML;
  }

  function ratingToStars(rating) {
    const full = Math.floor(rating);
    const half = rating % 1 >= 0.5;
    return '★'.repeat(full) + (half ? '½' : '');
  }

  /**
   * "2026-07-08" -> "Jul 8".
   *
   * Built from the parts rather than `new Date(str)`, which parses a bare
   * YYYY-MM-DD as UTC midnight and renders as the previous day for anyone west
   * of Greenwich.
   */
  function formatShortDate(dateStr, options) {
    const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr || '');
    if (!parts) return '';
    const date = new Date(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
    return date.toLocaleDateString('en-US', options || { month: 'short', day: 'numeric' });
  }

  /**
   * Returns the URL only if it is http(s), else ''. Guards every href/src that
   * is built from fetched data, so a `javascript:` URL can never reach the DOM.
   */
  function safeUrl(value) {
    if (!value) return '';
    try {
      const url = new URL(value, global.location.href);
      return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
    } catch {
      return '';
    }
  }

  global.LBV = { escapeHtml, ratingToStars, formatShortDate, safeUrl };
})(window);
