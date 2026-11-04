/* Rewatches page: every film logged more than once, the films first seen
 * before the diary, and how each number is computed from an export.
 *
 * Static consumer of data/rewatches.json (compute_stats.compute_rewatches).
 * The year selector lives in the hash (#year=2024) so a view can be linked.
 * Year view: films with at least one rewatch logged that year, ranked by that
 * year's logs. "Films watched", the by-year chart and the undiaried list are
 * lifetime only (watched.csv has no dates) and are labelled so.
 */

(function () {
  'use strict';

  const { escapeHtml, formatShortDate, safeUrl } = window.LBV;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString('en-US');
  const pct = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);
  const monthYear = (d) => formatShortDate(d, { month: 'short', year: 'numeric' });
  const plural = (n, one, many) => `${fmt(n)} ${n === 1 ? one : many || one + 's'}`;

  let data = null;
  let scale = null; // { start, span } in ms for the date strips

  function parseDay(d) {
    const [y, m, day] = d.split('-').map(Number);
    return new Date(y, m - 1, day).getTime();
  }

  function yearFromHash() {
    const m = /(?:^|[#&])year=(\d{4})/.exec(window.location.hash);
    return m && data.byYear[m[1]] ? m[1] : 'lifetime';
  }

  // ---- stat cards -------------------------------------------------------

  function card(value, label, formula, accent) {
    return `<div class="stat-card">
      <div class="stat-value${accent ? ' ' + accent : ''}">${escapeHtml(value)}</div>
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="rw-formula">${formula}</div>
    </div>`;
  }

  function renderCards(year) {
    const t = data.totals;
    let html;
    if (year === 'lifetime') {
      html = [
        card(fmt(t.rewatchLogs), 'Rewatch logs',
          `diary rows with <code>Rewatch</code> = Yes &middot; ${pct(t.rewatchLogs, t.logs)}% of ${fmt(t.logs)} logs`, 'accent-green'),
        card(fmt(t.filmsRewatched), 'Films rewatched',
          `distinct films (title + year) among those rows &middot; ${pct(t.filmsRewatched, t.filmsWatched)}% of ${fmt(t.filmsWatched)} films`),
        card(fmt(t.filmsLoggedTwice), 'Logged 2+ times', 'films with two or more diary rows'),
        card(fmt(t.seenBeforeDiary), 'Seen before the diary', 'films whose first diary row is already a rewatch', 'accent-blue'),
      ];
    } else {
      const y = data.byYear[year];
      const films = filmsForYear(year);
      const twice = films.filter((f) => f.yearCount >= 2).length;
      const firstSeen = data.films.filter((f) => f.watches[0].date.startsWith(year) && f.watches[0].rewatch).length;
      html = [
        card(fmt(y.rewatchLogs), `Rewatch logs in ${year}`,
          `${pct(y.rewatchLogs, y.logs)}% of ${fmt(y.logs)} logs that year`, 'accent-green'),
        card(fmt(y.filmsRewatched), 'Films rewatched', `distinct films with a rewatch row dated ${year}`),
        card(fmt(twice), `Logged 2+ times in ${year}`, `films with two or more diary rows dated ${year}`),
        card(fmt(firstSeen), 'Seen before the diary', `films whose first diary row, dated ${year}, is already a rewatch`, 'accent-blue'),
      ];
    }
    $('rw-cards').innerHTML = html.join('');
  }

  // ---- definitions ------------------------------------------------------

  function renderDefinitions() {
    const t = data.totals;
    const multiFirstRewatch = t.seenBeforeDiary - t.loggedOnceAsRewatch;
    const top = data.films[0] || { filmTitle: 'one film', rewatchLogs: 0 };
    const rows = [
      ['Films watched', fmt(t.filmsWatched),
        `${fmt(t.filmsLogged)} films with at least one diary row + ${fmt(t.undiaried)} marked watched with no diary row. Every film in <code>watched.csv</code>, plus any logged since the export.`],
      ['Logs', fmt(t.logs), 'Rows in <code>diary.csv</code>, plus entries from my RSS feed logged after the export. A film watched three times is three logs.'],
      ['Rewatch logs', fmt(t.rewatchLogs),
        `Logs with <code>Rewatch</code> = Yes. ${pct(t.rewatchLogs, t.logs)}% of logs, but ${escapeHtml(top.filmTitle)} alone adds ${fmt(top.rewatchLogs)} of them, so this counts viewings, not films.`],
      ['Films rewatched', fmt(t.filmsRewatched),
        `${fmt(t.filmsLoggedTwice)} logged two or more times + ${fmt(t.loggedOnceAsRewatch)} logged once, marked as a rewatch. ${pct(t.filmsRewatched, t.filmsWatched)}% of films watched: the honest "share of films" number.`],
      ['Seen before the diary', fmt(t.seenBeforeDiary),
        `Films whose first diary row is already a rewatch: ${fmt(t.loggedOnceAsRewatch)} logged once + ${fmt(multiFirstRewatch)} logged again later. The first viewing happened before I kept a diary.`],
      ['Watched, never logged', fmt(t.undiaried),
        'In <code>watched.csv</code> with no diary row: marked watched before the diary existed. No dates, so they can’t count as rewatches.'],
    ];
    $('rw-defs').innerHTML = rows.map(([term, value, def]) => `
      <div class="rw-def">
        <dt><span class="rw-def-value">${escapeHtml(value)}</span> ${escapeHtml(term)}</dt>
        <dd>${def}</dd>
      </div>`).join('');
  }

  // ---- by year ----------------------------------------------------------

  function renderYears(selected) {
    const years = Object.keys(data.byYear);
    $('rw-years').innerHTML = years.map((year) => {
      const y = data.byYear[year];
      const share = pct(y.rewatchLogs, y.logs);
      const sparse = y.logs < 50;
      return `<li>
        <button type="button" class="rw-year-row${year === selected ? ' active' : ''}${sparse ? ' sparse' : ''}"
          data-year="${year}" aria-pressed="${year === selected}">
          <span class="rw-year-label">${year}</span>
          <span class="rw-bar" aria-hidden="true"><span class="rw-bar-fill" style="width:${share}%"></span></span>
          <span class="rw-year-value">${share}% <span class="rw-year-detail">${fmt(y.rewatchLogs)} of ${fmt(y.logs)}${sparse ? ' &middot; sparse' : ''}</span></span>
        </button>
      </li>`;
    }).join('');
  }

  // ---- film list --------------------------------------------------------

  function filmsForYear(year) {
    return data.films
      .map((f) => {
        const inYear = f.watches.filter((w) => w.date.startsWith(year));
        return { ...f, yearCount: inYear.length, yearRewatches: inYear.filter((w) => w.rewatch).length };
      })
      .filter((f) => f.yearRewatches > 0)
      .sort((a, b) => b.yearCount - a.yearCount || b.count - a.count
        || b.watches[b.watches.length - 1].date.localeCompare(a.watches[a.watches.length - 1].date));
  }

  function strip(film, year) {
    const ticks = film.watches.map((w) => {
      const left = ((parseDay(w.date) - scale.start) / scale.span) * 100;
      const cls = ['rw-tick', w.rewatch ? 'rw' : 'first'];
      if (year !== 'lifetime' && !w.date.startsWith(year)) cls.push('dim');
      return `<span class="${cls.join(' ')}" style="left:${left.toFixed(2)}%"></span>`;
    }).join('');
    const dates = film.watches.map((w) => formatShortDate(w.date, { month: 'short', day: 'numeric', year: 'numeric' })
      + (w.rewatch ? ' (rewatch)' : '')).join(', ');
    return `<span class="rw-strip" role="img" title="${escapeHtml(dates)}" aria-label="${escapeHtml('Watched ' + dates)}">${ticks}</span>`;
  }

  function filmRow(film, year) {
    const shown = year === 'lifetime' ? film.count : film.yearCount;
    const href = safeUrl(film.link);
    const title = escapeHtml(film.filmTitle);
    const first = film.watches[0].date;
    const last = film.watches[film.watches.length - 1].date;
    const meta = [];
    if (year !== 'lifetime') meta.push(`${plural(film.count, 'log')} lifetime`);
    meta.push(first === last ? monthYear(first) : `${monthYear(first)} – ${monthYear(last)}`);
    if (film.watches[0].rewatch) meta.push('seen before the diary');
    return `<li class="rw-film">
      <span class="rewatch-count">${shown}</span>
      <span class="rw-film-main">
        <span class="rw-film-title">${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${title}</a>` : title}
          <span class="rewatch-year">${escapeHtml(film.filmYear ?? '')}</span></span>
        <span class="rw-film-meta">${escapeHtml(meta.join(' · '))}</span>
      </span>
      ${strip(film, year)}
    </li>`;
  }

  function axis() {
    const startYear = new Date(scale.start).getFullYear();
    const endYear = new Date(scale.start + scale.span).getFullYear();
    let marks = '';
    for (let y = startYear + 1; y <= endYear; y++) {
      const left = ((new Date(y, 0, 1).getTime() - scale.start) / scale.span) * 100;
      marks += `<span class="rw-axis-mark" style="left:${left.toFixed(2)}%">${String(y).slice(2)}</span>`;
    }
    return `<div class="rw-axis" aria-hidden="true"><span></span><span></span><span class="rw-strip rw-axis-strip">${marks}</span></div>`;
  }

  function renderFilms(year) {
    const lifetime = year === 'lifetime';
    const films = lifetime ? data.films : filmsForYear(year);
    const countOf = (f) => (lifetime ? f.count : f.yearCount);
    $('rw-films-count').textContent = plural(films.length, 'film');
    $('rw-films-note').innerHTML = lifetime
      ? 'Every film with two or more diary rows, then the films logged once as a rewatch. Grouped by number of logs; ties go to the most recent watch. Each tick is one log: <span class="rw-key first"></span> first watch, <span class="rw-key rw"></span> rewatch.'
      : `Films with at least one rewatch logged in ${year}, grouped by that year's logs. Ticks outside ${year} are dimmed: <span class="rw-key first"></span> first watch, <span class="rw-key rw"></span> rewatch.`;

    const groups = [];
    for (const f of films) {
      const n = countOf(f);
      if (!groups.length || groups[groups.length - 1].n !== n) groups.push({ n, films: [] });
      groups[groups.length - 1].films.push(f);
    }
    $('rw-films').innerHTML = axis() + groups.map((g) => {
      const label = lifetime && g.n === 1 ? 'Logged once, as a rewatch' : plural(g.n, 'log') + (lifetime ? '' : ` in ${year}`);
      return `<h3 class="rw-group">${escapeHtml(label)} <span class="section-count">${plural(g.films.length, 'film')}</span></h3>
        <ol class="rw-film-list">${g.films.map((f) => filmRow(f, year)).join('')}</ol>`;
    }).join('');
  }

  // ---- undiaried --------------------------------------------------------

  function renderUndiaried() {
    const list = data.undiaried;
    $('rw-undiaried-count').textContent = fmt(list.length);
    $('rw-undiaried-note').textContent = `${plural(list.length, 'film')} in watched.csv with no diary entry: mostly films I'd seen before my Letterboxd diary existed. With no dates, they can't be counted as rewatches, but most of them would be the next time I log one.`;
    $('rw-undiaried').innerHTML = list.map((f) => {
      const href = safeUrl(f.link);
      const name = escapeHtml(f.name);
      return `<li>${href ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener">${name}</a>` : name} <span class="rewatch-year">${escapeHtml(f.year ?? '')}</span></li>`;
    }).join('');
  }

  // ---- wiring -----------------------------------------------------------

  function apply(year) {
    $('rw-year').value = year;
    $('rw-scope').textContent = year === 'lifetime'
      ? `${data.dateRange.earliest.slice(0, 4)}–${data.dateRange.latest.slice(0, 4)}`
      : `${fmt(data.byYear[year].logs)} logs in ${year}`;
    renderCards(year);
    renderYears(year);
    renderFilms(year);
  }

  function setYear(year) {
    const hash = year === 'lifetime' ? '' : `#year=${year}`;
    if (window.location.hash !== hash) {
      history.replaceState(null, '', hash || window.location.pathname + window.location.search);
    }
    apply(year);
  }

  async function init() {
    try {
      const res = await fetch('data/rewatches.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      $('rw-films').innerHTML = '<p class="rw-note">Couldn’t load rewatch data.</p>';
      console.error('rewatches.json', err);
      return;
    }
    const start = parseDay(data.dateRange.earliest);
    const end = Math.max(parseDay(data.dateRange.latest), start + 86400000);
    scale = { start, span: end - start };

    const select = $('rw-year');
    select.innerHTML = '<option value="lifetime">Lifetime</option>'
      + Object.keys(data.byYear).reverse().map((y) => `<option value="${y}">${y}</option>`).join('');
    select.addEventListener('change', () => setYear(select.value));
    $('rw-years').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-year]');
      if (!btn) return;
      setYear(btn.dataset.year === select.value ? 'lifetime' : btn.dataset.year);
    });
    window.addEventListener('hashchange', () => apply(yearFromHash()));

    if (data.archiveExportDate) {
      $('rw-asof').textContent = `Export from ${formatShortDate(data.archiveExportDate, { month: 'short', day: 'numeric', year: 'numeric' })}, plus newer RSS logs.`;
    }
    renderDefinitions();
    renderUndiaried();
    apply(yearFromHash());
  }

  init();
})();
