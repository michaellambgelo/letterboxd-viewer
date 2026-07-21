/* Rolodex — curated Letterboxd profiles with each person's Last Four Watched.
 *
 * Data comes from the letterboxd-rolodex Worker (see worker/index.js) rather
 * than from data/stats.json: letterboxd.com serves RSS with no CORS headers, so
 * the feeds have to be fetched and merged server-side.
 *
 * The Worker streams NDJSON: a meta line carrying the whole curated list (a
 * single KV read), then one line per profile as its feed resolves. Every card
 * is drawn from the meta line immediately and fills in as its own data lands,
 * so one slow feed delays one card instead of the page. Falls back to the
 * all-at-once JSON endpoint where streaming isn't available.
 */

(function () {
  'use strict';

  const { escapeHtml, ratingToStars, formatShortDate, safeUrl } = window.LBV;

  const DEFAULT_API = 'https://rolodex.michaellamb.dev';
  const PLACEHOLDER_COUNT = 6; // before the meta line tells us the real count

  // username -> card element, so a streamed profile finds its card without
  // building a selector out of data we got over the wire.
  const cards = new Map();
  const pending = new Set();

  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const OTHER_LETTER = '#'; // anything not starting A-Z
  const letterButtons = new Map();

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

  function listEl() {
    return document.getElementById('rolodex-list');
  }

  /* ---------------------------------------------------------------- render */

  function skeletonFilms() {
    return `<div class="rolodex-films" data-films>${`
      <div class="rolodex-film">
        <div class="rolodex-poster is-skeleton"></div>
        <div class="rolodex-film-meta"><div class="skeleton-line" style="width:85%"></div></div>
      </div>`.repeat(4)}</div>`;
  }

  /** Placeholder cards shown before the meta line arrives. */
  function renderPlaceholders() {
    const list = listEl();
    if (!list) return;
    list.innerHTML = `
      <article class="rolodex-card is-loading" aria-hidden="true">
        <div class="rolodex-head">
          <div class="rolodex-avatar"></div>
          <div class="rolodex-ident">
            <div class="skeleton-line" style="width: 40%"></div>
            <div class="skeleton-line" style="width: 25%"></div>
          </div>
        </div>
        ${skeletonFilms()}
      </article>`.repeat(PLACEHOLDER_COUNT);
  }

  /** Bucket a profile under A-Z, or '#' for anything that doesn't start a-z. */
  function letterFor(profile) {
    const first = (profile.displayName || profile.username || '').trim().charAt(0).toUpperCase();
    return ALPHABET.includes(first) ? first : OTHER_LETTER;
  }

  /** A card with everything the curated list knows, awaiting its feed. */
  function cardShell(profile) {
    const name = escapeHtml(profile.displayName || profile.username);
    const handle = escapeHtml(profile.username);
    const profileUrl = safeUrl(profile.profileUrl);
    const initial = escapeHtml((profile.username || '?').charAt(0).toUpperCase());

    const article = document.createElement('article');
    article.className = 'rolodex-card is-pending';
    article.dataset.letter = letterFor(profile);
    // Everything searchable comes from the meta line, so filtering works before
    // a single feed has resolved — no race with the streamed fill.
    article.dataset.search = [
      profile.displayName || '',
      profile.username || '',
      profile.note || '',
      (profile.tags || []).join(' '),
    ]
      .join(' ')
      .toLowerCase();
    article.innerHTML = `
      <div class="rolodex-head">
        <div class="rolodex-avatar" aria-hidden="true" data-avatar>
          <span class="rolodex-avatar-initial">${initial}</span>
        </div>
        <div class="rolodex-ident">
          <h2 class="rolodex-name">${name}</h2>
          ${profileUrl
            ? `<a class="rolodex-handle" href="${profileUrl}" target="_blank" rel="noopener">@${handle}</a>`
            : `<span class="rolodex-handle">@${handle}</span>`}
        </div>
        <span class="rolodex-stale" data-stale hidden
              title="Letterboxd was unreachable — showing the last known entries">cached</span>
      </div>
      ${profile.note ? `<p class="rolodex-note">${escapeHtml(profile.note)}</p>` : ''}
      ${profile.tags && profile.tags.length
        ? `<div class="rolodex-tags">${profile.tags
            .map((tag) => `<span class="rolodex-tag">${escapeHtml(tag)}</span>`)
            .join('')}</div>`
        : ''}
      ${skeletonFilms()}`;
    return article;
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
      </div>`;

    return link
      ? `<a class="rolodex-film" href="${link}" target="_blank" rel="noopener" title="${title}">${body}</a>`
      : `<div class="rolodex-film">${body}</div>`;
  }

  /** Swap a card's skeleton for its real avatar and films. */
  function fillCard(card, data) {
    if (!card) return;
    card.classList.remove('is-pending');

    const avatar = safeUrl(data.avatar);
    if (avatar) {
      const slot = card.querySelector('[data-avatar]');
      if (slot && !slot.querySelector('img')) {
        const img = document.createElement('img');
        img.src = avatar;
        img.alt = '';
        img.loading = 'lazy';
        // The initial underneath shows through if the avatar 404s.
        img.addEventListener('error', () => img.remove());
        slot.appendChild(img);
      }
    }

    const films = card.querySelector('[data-films]');
    if (films) {
      if (data.films && data.films.length) {
        films.innerHTML = data.films.map(renderFilm).join('');
      } else {
        const message = data.stale ? 'Feed unavailable right now.' : 'No diary entries yet.';
        films.outerHTML = `<p class="rolodex-empty-films">${message}</p>`;
      }
    }

    const staleBadge = card.querySelector('[data-stale]');
    if (staleBadge && data.stale && data.films && data.films.length) {
      staleBadge.hidden = false;
    }
  }

  function renderMessage(message) {
    const list = listEl();
    if (list) list.innerHTML = `<p class="rolodex-message">${escapeHtml(message)}</p>`;
  }

  function setCount(n) {
    const el = document.getElementById('rolodex-count');
    if (el) el.textContent = `${n} ${n === 1 ? 'profile' : 'profiles'}`;
  }

  /* ----------------------------------------------------- filter + alphabet */

  /**
   * The full A-Z is always rendered, even for letters nobody falls under: a
   * fixed set of targets doesn't reflow as profiles are added, and a disabled
   * letter says "nobody here" where a missing one would just look arbitrary.
   * `disabled` is the real attribute, so keyboard and screen-reader users skip
   * them rather than landing on dead buttons.
   */
  function buildAlphabet() {
    const host = document.getElementById('rolodex-alphabet');
    if (!host) return;
    host.innerHTML = '';
    letterButtons.clear();

    for (const letter of ALPHABET.concat(OTHER_LETTER)) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'rolodex-letter';
      button.textContent = letter;
      button.dataset.letter = letter;
      button.disabled = true;
      button.setAttribute('aria-label', `Jump to ${letter === OTHER_LETTER ? 'other' : letter}`);
      // '#' only earns a slot if something actually sorts under it.
      if (letter === OTHER_LETTER) button.hidden = true;
      letterButtons.set(letter, button);
      host.appendChild(button);
    }

    host.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-letter]');
      if (!button || button.disabled) return;
      jumpToLetter(button.dataset.letter);
    });
  }

  function jumpToLetter(letter) {
    for (const card of cards.values()) {
      if (card.dataset.letter === letter && !card.hidden) {
        // Deliberately instant. The page runs to ~12,000px, and a smooth scroll
        // across that took ~1.5s of animation you can't read anything during —
        // index jumps should land immediately, as they do in a contacts list.
        // The rail is sticky, so it stays put and keeps the context.
        card.scrollIntoView({ block: 'start' });
        return;
      }
    }
  }

  /**
   * Single pass over the cards: show/hide by query, and recompute which letters
   * are reachable. Letters are disabled against the *filtered* set, so jumping
   * can never land on a hidden card.
   */
  function applyFilter() {
    const input = document.getElementById('rolodex-filter');
    const query = (input ? input.value : '').trim().toLowerCase();

    const reachable = new Set();
    let visible = 0;

    for (const card of cards.values()) {
      const match = !query || (card.dataset.search || '').includes(query);
      card.hidden = !match;
      if (match) {
        visible += 1;
        reachable.add(card.dataset.letter);
      }
    }

    for (const [letter, button] of letterButtons) {
      button.disabled = !reachable.has(letter);
      if (letter === OTHER_LETTER) button.hidden = !reachable.has(letter);
    }

    const clear = document.getElementById('rolodex-filter-clear');
    if (clear) clear.hidden = !query;

    const status = document.getElementById('rolodex-status');
    if (status) {
      if (!query) status.textContent = '';
      else if (!visible) status.textContent = `No profiles match “${query}”.`;
      else status.textContent = `${visible} of ${cards.size} profiles match “${query}”.`;
    }
  }

  /** Draw every card from the curated list, before any feed has resolved. */
  function applyMeta(meta) {
    const list = listEl();
    if (!list) return;
    const profiles = Array.isArray(meta.profiles) ? meta.profiles : [];

    cards.clear();
    pending.clear();
    list.innerHTML = '';

    if (!profiles.length) {
      renderMessage('No profiles in the rolodex yet.');
      return;
    }

    const frag = document.createDocumentFragment();
    for (const profile of profiles) {
      const card = cardShell(profile);
      cards.set(profile.username, card);
      pending.add(profile.username);
      frag.appendChild(card);
    }
    list.appendChild(frag);
    setCount(profiles.length);
    // Meta can land after someone has already typed, so reconcile rather than
    // assuming the filter is empty.
    applyFilter();
  }

  function applyProfile(data) {
    const card = cards.get(data.username);
    if (!card) return;
    pending.delete(data.username);
    fillCard(card, data);
  }

  /** Anything still unresolved when the stream ends is not coming. */
  function settlePending() {
    for (const username of pending) {
      fillCard(cards.get(username), { films: [], stale: true, avatar: null });
    }
    pending.clear();
  }

  /* ---------------------------------------------------------------- loading */

  function handleLine(line) {
    if (line.type === 'meta') applyMeta(line);
    else if (line.type === 'profile') applyProfile(line);
    else if (line.type === 'error') throw new Error(line.message || 'stream error');
  }

  async function loadStreaming(base) {
    const res = await fetch(`${base}/rolodex/stream`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (!res.body || !res.body.getReader) throw new Error('streaming unsupported');

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let sawMeta = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // A chunk can split mid-line, so only consume up to the last newline.
      let newline;
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const parsed = JSON.parse(line);
        if (parsed.type === 'meta') sawMeta = true;
        handleLine(parsed);
      }
    }

    const tail = buffer.trim();
    if (tail) handleLine(JSON.parse(tail));
    if (!sawMeta) throw new Error('stream ended before any data');

    settlePending();
  }

  /** All-at-once path: older browsers, or if the stream fails outright. */
  async function loadWhole(base) {
    const res = await fetch(`${base}/rolodex`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    const profiles = Array.isArray(payload.profiles) ? payload.profiles : [];

    applyMeta({ profiles });
    for (const profile of profiles) applyProfile(profile);
    settlePending();
  }

  function initControls() {
    buildAlphabet();

    const input = document.getElementById('rolodex-filter');
    const clear = document.getElementById('rolodex-filter-clear');

    // 63 cards is a trivial pass, so filter on every keystroke — a debounce
    // would only add lag.
    if (input) {
      input.addEventListener('input', applyFilter);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && input.value) {
          input.value = '';
          applyFilter();
        }
      });
    }

    if (clear) {
      clear.addEventListener('click', () => {
        if (!input) return;
        input.value = '';
        applyFilter();
        input.focus();
      });
    }
  }

  async function init() {
    initControls();
    renderPlaceholders();
    const base = apiBase();

    try {
      await loadStreaming(base);
    } catch (err) {
      console.warn('Rolodex stream failed, falling back to the whole payload:', err);
      try {
        await loadWhole(base);
      } catch (fallbackErr) {
        console.error('Failed to load rolodex:', fallbackErr);
        renderMessage('Could not reach the rolodex service. Try again in a moment.');
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
