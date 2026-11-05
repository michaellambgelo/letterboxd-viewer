/* Footer Boxd Card callout: renders a small Boxd Card preview of the last four
 * films watched, styled after the hero on boxd-card.com/about.
 *
 * Data comes from the rolodex Worker's GET /stats/live (the same recent RSS
 * feed the dashboard uses: posters, ratings, avatar). If the Worker is down
 * the preview simply isn't drawn and the callout stays text-only; stats.json
 * has no posters and is too heavy to fetch on every page as a fallback.
 *
 * The gradient mirrors boxd-card's drawBrandGradient (src/canvas/renderCard.ts):
 * two distinct Letterboxd brand colours at a random angle under a dark wash,
 * so every page load gets its own card, just like a real render.
 */

(function () {
  'use strict';

  const mount = document.querySelector('[data-boxd-preview]');
  if (!mount) return;

  const LIVE_API = (function () {
    const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    const override = isLocal && new URLSearchParams(window.location.search).get('api');
    return (override || 'https://rolodex.michaellamb.dev').replace(/\/+$/, '');
  })();

  const BRAND = ['#00E054', '#40BCF4', '#FF8000', '#E9A000', '#00C030', '#20A0E0'];

  const esc = (s) => window.LBV.escapeHtml(s);
  const safe = (u) => window.LBV.safeUrl(u);

  function stars(rating) {
    return typeof rating === 'number' && rating > 0 ? window.LBV.ratingToStars(rating) : '';
  }

  function gradient() {
    const i = Math.floor(Math.random() * BRAND.length);
    let j = Math.floor(Math.random() * (BRAND.length - 1));
    if (j >= i) j++;
    const angle = Math.floor(Math.random() * 360);
    return `linear-gradient(${angle}deg, ${BRAND[i]}, ${BRAND[j]})`;
  }

  // Muted per-title tile colour under each poster, so a slow or failed poster
  // load leaves a tinted tile with the title instead of a hole.
  function tileHue(title) {
    let h = 0;
    for (const ch of title) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  function poster(film) {
    const title = film.title || '';
    // The feed carries 600x900 crops; tiles are ~80px wide, so ask for the
    // 230x345 crop Letterboxd serves for its own poster grids (about half the bytes).
    const src = safe((film.poster || '').replace(/-0-600-0-900-crop/, '-0-230-0-345-crop'));
    return `<div class="bc-poster">
      <div class="bc-tile" style="background:hsl(${tileHue(title)},16%,20%)">
        <span class="bc-tname">${esc(title)}</span>
        ${src ? `<img class="bc-art" src="${esc(src)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()" />` : ''}
      </div>
      <div class="bc-ptitle">${esc(title)}</div>
      <div class="bc-prating">${stars(film.rating)}</div>
    </div>`;
  }

  function card(label, films, live, extraClass) {
    const avatar = safe(live.avatar);
    const user = live.username || 'michaellamb';
    return `<div class="bc-card ${extraClass}">
      <div class="bc-grad" style="background:${gradient()}"></div>
      <div class="bc-wash"></div>
      <div class="bc-content">
        <div class="bc-head">
          <img src="assets/images/letterboxd-logo-h-neg-rgb.svg" alt="" class="bc-logo" />
          <span class="bc-label">${esc(label)}</span>
        </div>
        <div class="bc-posters">${films.map(poster).join('')}</div>
        <div class="bc-foot">
          <span class="bc-user">${avatar
            ? `<img class="bc-avatar" src="${esc(avatar)}" alt="" referrerpolicy="no-referrer" />`
            : `<span class="bc-avatar">${esc(user.charAt(0))}</span>`}${esc(user)}</span>
          <span class="bc-domain">boxd-card.com</span>
        </div>
      </div>
    </div>`;
  }

  async function render() {
    let live;
    try {
      const res = await fetch(`${LIVE_API}/stats/live`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      live = await res.json();
    } catch (err) {
      console.warn('Boxd Card preview unavailable:', err);
      return;
    }
    const films = (Array.isArray(live.films) ? live.films : []).filter((f) => f && f.title);
    if (films.length < 4) return;

    // The back card peeks out behind the front one; it shows the next four so
    // the stack reads as two different renders.
    const back = films.length >= 8 ? films.slice(4, 8) : films.slice(0, 4);
    mount.innerHTML =
      card('Diary', back, live, 'bc-back') +
      card('Last Four Watched', films.slice(0, 4), live, 'bc-front');
    mount.hidden = false;
    mount.closest('.boxd-card-callout')?.classList.add('has-preview');
  }

  render();
})();
