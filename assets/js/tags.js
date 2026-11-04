/* Tags page: pick tags from my diary, get the list of films logged with them.
 *
 * Static consumer of data/viewing_history.json (the full diary, already
 * published for the stats pipeline) and data/tag_categories.json (a
 * hand-maintained grouping). Tags are matched lowercased, so "MoviePass" and
 * "moviepass" are one tag. A tag the categories file doesn't list shows under
 * Other, so a new tag never disappears.
 *
 * "Untagged" is a pseudo-tag for diary entries with no tags at all, which
 * would otherwise never show up. Its key, UNTAGGED, has parentheses so it
 * can't collide with a real tag named "untagged".
 *
 * Selection lives in the URL hash (#tags=imax,moviepass&match=all) so a
 * filtered list can be linked.
 */

(function () {
  'use strict';

  const { escapeHtml, ratingToStars, formatShortDate, safeUrl } = window.LBV;

  const OTHER = { id: 'other', label: 'Other', icon: 'fa-tags', tags: [] };
  const UNTAGGED = '(untagged)';
  const UNTAGGED_CATEGORY = { id: 'untagged', label: 'No tags', icon: 'fa-minus-circle', tags: [UNTAGGED] };

  const label = (t) => (t === UNTAGGED ? 'untagged' : t);
  const hasTag = (e, t) => (t === UNTAGGED ? e.tagSet.size === 0 : e.tagSet.has(t));

  const state = { selected: new Set(), match: 'any', sort: 'newest', query: '' };
  let entries = [];
  let categories = [];
  let tagCounts = new Map();

  const $ = (id) => document.getElementById(id);
  const norm = (t) => String(t || '').trim().toLowerCase();

  // ---- URL hash ------------------------------------------------------------

  function readHash() {
    const params = new URLSearchParams(location.hash.slice(1));
    // get() decodes, and also turns + into a space, so both forms of a link work.
    const tags = (params.get('tags') || '').split(',').map(norm).filter((t) => tagCounts.has(t));
    state.selected = new Set(tags);
    state.match = params.get('match') === 'all' ? 'all' : 'any';
  }

  function writeHash() {
    // Built by hand so commas stay literal and links read
    // #tags=in%20theaters,imax; URLSearchParams would write in+theaters%2Cimax.
    const parts = [];
    if (state.selected.size) parts.push(`tags=${[...state.selected].map(encodeURIComponent).join(',')}`);
    if (state.match === 'all') parts.push('match=all');
    const hash = parts.join('&');
    history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
  }

  // ---- data ----------------------------------------------------------------

  function prepare(history, config) {
    entries = history.map((e) => ({ ...e, tagSet: new Set((e.tags || []).map(norm).filter(Boolean)) }));

    tagCounts = new Map();
    for (const e of entries) for (const t of e.tagSet) tagCounts.set(t, (tagCounts.get(t) || 0) + 1);

    const claimed = new Set();
    categories = (config.categories || []).map((c) => {
      const tags = [...new Set(c.tags.map(norm))].filter((t) => tagCounts.has(t) && !claimed.has(t));
      tags.forEach((t) => claimed.add(t));
      return { ...c, tags };
    });
    const rest = [...tagCounts.keys()].filter((t) => !claimed.has(t));
    categories.push({ ...OTHER, tags: rest });

    // Most-used first inside each category.
    for (const c of categories) {
      c.tags.sort((a, b) => tagCounts.get(b) - tagCounts.get(a) || a.localeCompare(b));
    }
    // Last, after Other: it holds the films no tag chip can reach.
    const untagged = entries.filter((e) => !e.tagSet.size).length;
    if (untagged) {
      tagCounts.set(UNTAGGED, untagged);
      categories.push({ ...UNTAGGED_CATEGORY });
    }
    categories = categories.filter((c) => c.tags.length);
  }

  function matching() {
    if (!state.selected.size) return [];
    const sel = [...state.selected];
    return entries.filter((e) => (state.match === 'all'
      ? sel.every((t) => hasTag(e, t))
      : sel.some((t) => hasTag(e, t))));
  }

  // ---- tag picker ----------------------------------------------------------

  function chip(t) {
    const on = state.selected.has(t);
    return `<button type="button" class="tag-chip${on ? ' is-on' : ''}${t === UNTAGGED ? ' is-untagged' : ''}" data-tag="${escapeHtml(t)}" aria-pressed="${on}">` +
      `${escapeHtml(label(t))} <span class="tag-chip-count">${tagCounts.get(t)}</span></button>`;
  }

  function renderPicker() {
    const q = norm(state.query);
    $('tag-categories').innerHTML = categories.map((c) => {
      const tags = q ? c.tags.filter((t) => label(t).includes(q)) : c.tags;
      if (!tags.length) return '';
      const picked = c.tags.filter((t) => state.selected.has(t)).length;
      // Other is long and mostly noise, so it starts closed unless searching
      // or holding a selected tag.
      const open = c.id !== 'other' || q || picked;
      return `
        <details class="tag-category" data-category="${c.id}"${open ? ' open' : ''}>
          <summary>
            <i class="fas ${escapeHtml(c.icon || 'fa-tag')}" aria-hidden="true"></i>
            <span class="tag-category-label">${escapeHtml(c.label)}</span>
            <span class="tag-category-count">${picked ? `${picked} of ` : ''}${c.tags.length}</span>
          </summary>
          <div class="tag-chips">${tags.map(chip).join('')}</div>
        </details>`;
    }).join('') || '<p class="tags-empty">No tags match that search.</p>';
  }

  function renderSelection() {
    const sel = [...state.selected];
    $('tag-selected').innerHTML = sel.length
      ? sel.map((t) => `<button type="button" class="tag-chip is-on" data-tag="${escapeHtml(t)}" aria-label="Remove ${escapeHtml(label(t))}">` +
          `${escapeHtml(label(t))} <i class="fas fa-times" aria-hidden="true"></i></button>`).join('') +
        '<button type="button" class="tag-clear" id="tag-clear">Clear</button>'
      : '<span class="tags-hint">Pick one or more tags.</span>';
    $('tag-match').hidden = sel.length < 2;
    document.querySelectorAll('#tag-match [data-match]').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.match === state.match));
    });
  }

  // ---- results -------------------------------------------------------------

  const SORTS = {
    newest: (a, b) => b.watchedDate.localeCompare(a.watchedDate),
    oldest: (a, b) => a.watchedDate.localeCompare(b.watchedDate),
    rating: (a, b) => (b.memberRating ?? -1) - (a.memberRating ?? -1) || b.watchedDate.localeCompare(a.watchedDate),
    title: (a, b) => a.filmTitle.localeCompare(b.filmTitle, undefined, { sensitivity: 'base' }) || a.watchedDate.localeCompare(b.watchedDate),
  };

  function row(e) {
    const url = safeUrl(e.link);
    const title = escapeHtml(e.filmTitle);
    const date = formatShortDate(e.watchedDate, { month: 'short', day: 'numeric', year: 'numeric' });
    const tags = e.tagSet.size
      ? [...e.tagSet].map((t) =>
          `<span class="tag-pill${state.selected.has(t) ? ' is-on' : ''}">${escapeHtml(t)}</span>`).join('')
      : `<span class="tag-pill is-untagged${state.selected.has(UNTAGGED) ? ' is-on' : ''}">untagged</span>`;
    return `
      <li class="tag-row">
        <time class="tag-row-date" datetime="${escapeHtml(e.watchedDate)}">${escapeHtml(date)}</time>
        <div class="tag-row-film">
          ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener">${title}</a>` : title}
          ${e.filmYear ? `<span class="tag-row-year">${escapeHtml(String(e.filmYear))}</span>` : ''}
          ${e.rewatch ? '<i class="fas fa-redo-alt tag-row-rewatch" title="Rewatch" aria-label="Rewatch"></i>' : ''}
          <div class="tag-row-tags">${tags}</div>
        </div>
        <span class="tag-row-rating">${e.memberRating ? ratingToStars(e.memberRating) : ''}</span>
      </li>`;
  }

  function renderResults() {
    const list = matching().sort(SORTS[state.sort]);
    const films = new Set(list.map((e) => `${e.filmTitle}|${e.filmYear}`)).size;
    const rated = list.filter((e) => e.memberRating);
    const avg = rated.length ? rated.reduce((s, e) => s + e.memberRating, 0) / rated.length : null;
    const dates = list.map((e) => e.watchedDate).sort();

    $('tag-results-count').textContent = state.selected.size ? String(list.length) : '';
    $('tag-summary').innerHTML = list.length
      ? [
          `<strong>${list.length}</strong> ${list.length === 1 ? 'log' : 'logs'}`,
          `<strong>${films}</strong> ${films === 1 ? 'film' : 'films'}`,
          avg != null ? `<strong>${avg.toFixed(2)}</strong> avg rating` : null,
          `${escapeHtml(formatShortDate(dates[0], { month: 'short', year: 'numeric' }))} – ${escapeHtml(formatShortDate(dates[dates.length - 1], { month: 'short', year: 'numeric' }))}`,
        ].filter(Boolean).join('<span aria-hidden="true"> · </span>')
      : state.selected.size
        ? (state.selected.has(UNTAGGED)
          ? 'An untagged entry has no other tags, so All matches nothing here. Switch to Any.'
          : 'No diary entries have all of those tags.')
        : '';
    $('tag-results').innerHTML = list.map(row).join('');
  }

  function render() {
    renderPicker();
    renderSelection();
    renderResults();
  }

  // ---- events --------------------------------------------------------------

  function toggle(tag) {
    if (state.selected.has(tag)) state.selected.delete(tag);
    else state.selected.add(tag);
    writeHash();
    render();
  }

  function bind() {
    for (const id of ['tag-categories', 'tag-selected']) {
      $(id).addEventListener('click', (e) => {
        if (e.target.closest('#tag-clear')) {
          state.selected.clear();
          writeHash();
          render();
          return;
        }
        const btn = e.target.closest('[data-tag]');
        if (btn) toggle(btn.dataset.tag);
      });
    }
    $('tag-match').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-match]');
      if (!btn) return;
      state.match = btn.dataset.match;
      writeHash();
      renderSelection();
      renderResults();
    });
    $('tag-search').addEventListener('input', (e) => { state.query = e.target.value; renderPicker(); });
    $('tag-sort').addEventListener('change', (e) => { state.sort = e.target.value; renderResults(); });
    window.addEventListener('hashchange', () => { readHash(); render(); });
  }

  async function init() {
    try {
      const [h, c] = await Promise.all([
        fetch('data/viewing_history.json', { cache: 'no-cache' }),
        fetch('data/tag_categories.json', { cache: 'no-cache' }),
      ]);
      if (!h.ok || !c.ok) throw new Error(`HTTP ${h.status}/${c.status}`);
      prepare(await h.json(), await c.json());
    } catch (err) {
      $('tag-categories').innerHTML = '<p class="tags-empty">Could not load the diary data.</p>';
      console.error('[tags]', err);
      return;
    }
    const tagged = entries.filter((e) => e.tagSet.size).length;
    const untagged = entries.length - tagged;
    $('tags-intro-count').textContent = `${tagCounts.size - (untagged ? 1 : 0)} tags across ${tagged.toLocaleString('en-US')} diary entries` +
      (untagged ? `, plus ${untagged.toLocaleString('en-US')} untagged` : '');
    readHash();
    bind();
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
