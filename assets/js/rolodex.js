/* Rolodex — curated Letterboxd profiles with each person's Last Four Watched.
 *
 * Data comes from the letterboxd-rolodex Worker (see worker/index.js) rather
 * than from data/stats.json: letterboxd.com serves RSS with no CORS headers, so
 * the feeds have to be fetched and merged server-side.
 */

(function () {
  'use strict';

  const { escapeHtml, ratingToStars, formatShortDate, safeUrl } = window.LBV;

  const DEFAULT_API = 'https://rolodex.michaellamb.dev';
  const SKELETON_COUNT = 3;

  /**
   * The `?api=` override exists for `wrangler dev`, and is honored only on
   * localhost — on the deployed site it would let a crafted link point the page
   * at an attacker-controlled JSON source.
   */
  function apiBase() {
    const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    const override = isLocal && new URLSearchParams(window.location.search).get('api');
    return (override || DEFAULT_API).replace(/\/+$/, '');
  }

  function renderSkeleton() {
    const list = document.getElementById('rolodex-list');
    if (!list) return;
    list.innerHTML = Array.from({ length: SKELETON_COUNT }, () => `
      <article class="rolodex-card is-loading" aria-hidden="true">
        <div class="rolodex-head">
          <div class="rolodex-avatar"></div>
          <div class="rolodex-ident">
            <div class="skeleton-line" style="width: 40%"></div>
            <div class="skeleton-line" style="width: 25%"></div>
          </div>
        </div>
        <div class="rolodex-films">
          ${'<div class="rolodex-film"><div class="rolodex-poster"></div></div>'.repeat(4)}
        </div>
      </article>
    `).join('');
  }

  function renderFilm(film) {
    const link = safeUrl(film.link);
    const poster = safeUrl(film.poster);
    const title = escapeHtml(film.title || 'Untitled');
    const stars = film.rating ? ratingToStars(film.rating) : '';
    const watched = formatShortDate(film.watchedDate);

    const art = poster
      ? `<img class="rolodex-poster" src="${poster}" alt="" loading="lazy"
              onerror="this.classList.add('is-missing');this.removeAttribute('src')" />`
      : '<div class="rolodex-poster is-missing" aria-hidden="true"></div>';

    const body = `
      ${art}
      <div class="rolodex-film-meta">
        <span class="rolodex-film-title">${title}${
          film.year ? ` <span class="rolodex-film-year">(${escapeHtml(film.year)})</span>` : ''
        }</span>
        <span class="rolodex-film-sub">
          ${stars ? `<span class="rolodex-stars">${stars}</span>` : ''}
          ${watched ? `<span class="rolodex-watched">${escapeHtml(watched)}</span>` : ''}
          ${film.rewatch ? '<span class="rolodex-rewatch" title="Rewatch">↻</span>' : ''}
        </span>
      </div>
    `;

    return link
      ? `<a class="rolodex-film" href="${link}" target="_blank" rel="noopener"
            title="${title}">${body}</a>`
      : `<div class="rolodex-film">${body}</div>`;
  }

  function renderCard(profile) {
    const name = escapeHtml(profile.displayName || profile.username);
    const handle = escapeHtml(profile.username);
    const profileUrl = safeUrl(profile.profileUrl);
    const avatar = safeUrl(profile.avatar);

    // The initial sits behind the image, so a poster that 404s (the ?v= hashes
    // on a.ltrbxd.com URLs do rotate) degrades to a lettered circle rather than
    // a broken-image glyph.
    const initial = escapeHtml((profile.username || '?').charAt(0).toUpperCase());
    const avatarEl = `
      <div class="rolodex-avatar" aria-hidden="true">
        <span class="rolodex-avatar-initial">${initial}</span>
        ${avatar ? `<img src="${avatar}" alt="" loading="lazy" onerror="this.remove()" />` : ''}
      </div>`;

    const films = profile.films && profile.films.length
      ? `<div class="rolodex-films">${profile.films.map(renderFilm).join('')}</div>`
      : `<p class="rolodex-empty-films">${
          profile.stale ? 'Feed unavailable right now.' : 'No diary entries yet.'
        }</p>`;

    return `
      <article class="rolodex-card">
        <div class="rolodex-head">
          ${avatarEl}
          <div class="rolodex-ident">
            <h2 class="rolodex-name">${name}</h2>
            ${profileUrl
              ? `<a class="rolodex-handle" href="${profileUrl}" target="_blank" rel="noopener">@${handle}</a>`
              : `<span class="rolodex-handle">@${handle}</span>`}
          </div>
          ${profile.stale && profile.films && profile.films.length
            ? '<span class="rolodex-stale" title="Letterboxd was unreachable — showing the last known entries">cached</span>'
            : ''}
        </div>
        ${profile.note ? `<p class="rolodex-note">${escapeHtml(profile.note)}</p>` : ''}
        ${profile.tags && profile.tags.length
          ? `<div class="rolodex-tags">${profile.tags
              .map((tag) => `<span class="rolodex-tag">${escapeHtml(tag)}</span>`)
              .join('')}</div>`
          : ''}
        ${films}
      </article>
    `;
  }

  function renderMessage(message) {
    const list = document.getElementById('rolodex-list');
    if (list) list.innerHTML = `<p class="rolodex-message">${escapeHtml(message)}</p>`;
  }

  async function init() {
    renderSkeleton();

    let payload;
    try {
      const res = await fetch(`${apiBase()}/rolodex`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      payload = await res.json();
    } catch (err) {
      console.error('Failed to load rolodex:', err);
      renderMessage('Could not reach the rolodex service. Try again in a moment.');
      return;
    }

    const profiles = Array.isArray(payload.profiles) ? payload.profiles : [];
    if (!profiles.length) {
      renderMessage('No profiles in the rolodex yet.');
      return;
    }

    document.getElementById('rolodex-list').innerHTML = profiles.map(renderCard).join('');

    const count = document.getElementById('rolodex-count');
    if (count) {
      count.textContent = `${profiles.length} ${profiles.length === 1 ? 'profile' : 'profiles'}`;
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
