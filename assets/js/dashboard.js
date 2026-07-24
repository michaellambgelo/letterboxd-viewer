/* Letterboxd Stats Dashboard */

(function () {
  'use strict';

  // Shared with the rolodex page — see assets/js/util.js, loaded before this.
  const { escapeHtml, ratingToStars, formatShortDate, safeUrl } = window.LBV;

  const DATA_BASE = getDataBasePath();

  function getDataBasePath() {
    // When served from GitHub Pages, data is at the site root
    // When served locally, data is relative to index.html
    const path = window.location.pathname;
    if (path.includes('/letterboxd-viewer/')) {
      return '/letterboxd-viewer/data';
    }
    return 'data';
  }

  function formatLocalDate(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  async function loadStats() {
    try {
      const res = await fetch(`${DATA_BASE}/stats.json`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      console.error('Failed to load stats:', err);
      return null;
    }
  }

  /* ------------------------------------------------------ live enrichment */
  // The rolodex Worker's GET /stats/live: the whole recent RSS feed (posters,
  // review text, like flags) plus the profile avatar, ~15min fresh vs the
  // 6-hour cron behind stats.json. Purely additive — stats.json stays
  // canonical and every live render degrades to the static version when the
  // Worker is unreachable.

  const LIVE_API = (function () {
    // Same ?api= override rule as rolodex.js: honored only on localhost, so a
    // crafted link can't point the deployed page at another JSON source.
    const isLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname);
    const override = isLocal && new URLSearchParams(window.location.search).get('api');
    return (override || 'https://rolodex.michaellamb.dev').replace(/\/+$/, '');
  })();

  async function loadLive() {
    try {
      const res = await fetch(`${LIVE_API}/stats/live`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const live = await res.json();
      return Array.isArray(live.films) ? live : null;
    } catch (err) {
      console.warn('Live enrichment unavailable:', err);
      return null;
    }
  }

  // "+N since last update" is only meaningful against the lifetime numbers, so
  // the year-selector reports its scope here and the chip re-evaluates.
  const liveState = { delta: 0, isLifetime: true };

  function applyLiveDelta() {
    const el = document.getElementById('stat-total-delta');
    if (!el) return;
    const show = liveState.isLifetime && liveState.delta > 0;
    el.hidden = !show;
    if (show) el.textContent = `+${liveState.delta} since last update`;
  }

  // Live entries not yet in stats.json. recentActivity holds the 20 newest
  // pre-computed entries, so anything the cron hasn't seen is at or above its
  // newest date and missing from the (filmTitle, watchedDate) set — the same
  // composite key the Python pipeline dedupes on.
  function computeLiveDelta(films, stats) {
    const recent = stats.recentActivity || [];
    if (!recent.length) return 0;
    const seen = new Set(recent.map((e) => `${e.filmTitle}|${e.watchedDate}`));
    const floor = recent[0].watchedDate || '';
    return films.filter(
      (f) => f.watchedDate && f.watchedDate >= floor && !seen.has(`${f.title}|${f.watchedDate}`)
    ).length;
  }

  function renderLiveAvatar(live) {
    const img = document.getElementById('profile-avatar-img');
    const url = safeUrl(live.avatar);
    if (img && url) {
      img.src = url;
      img.alt = `${live.username} on Letterboxd`;
    }
  }

  function renderLiveBadge(live) {
    const badge = document.getElementById('activity-live-badge');
    if (!badge) return;
    let ago = '';
    if (live.fetchedAt) {
      const mins = Math.max(0, Math.round((Date.now() - new Date(live.fetchedAt).getTime()) / 60000));
      ago = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
    }
    badge.textContent = live.stale ? 'cached' : `live${ago ? ' · ' + ago : ''}`;
    badge.classList.toggle('stale', Boolean(live.stale));
    badge.hidden = false;
  }

  // Date strings compare as strings — YYYY-MM-DD never becomes a Date here.
  function renderLiveCounts(films) {
    const el = document.getElementById('live-counts');
    if (!el) return;
    const today = new Date();
    const weekAgo = new Date(today);
    weekAgo.setDate(today.getDate() - 6);
    const weekFloor = formatLocalDate(weekAgo);
    const monthPrefix = formatLocalDate(today).slice(0, 7);
    let week = 0;
    let month = 0;
    for (const f of films) {
      if (!f.watchedDate) continue;
      if (f.watchedDate >= weekFloor) week++;
      if (f.watchedDate.startsWith(monthPrefix)) month++;
    }
    el.textContent = `${week} in the past 7 days · ${month} this month`;
    el.hidden = false;
  }

  // Same rows as renderActivity, but from the live feed: fresher, and with the
  // poster art the RSS description carries.
  function renderLiveActivity(films) {
    const list = document.getElementById('activity-list');
    if (!list) return;

    list.innerHTML = films.slice(0, 20).map((film) => {
      const poster = safeUrl(film.poster);
      const link = safeUrl(film.link);
      const stars = film.rating ? ratingToStars(film.rating) : '';
      const rewatch = film.rewatch ? '<span class="activity-rewatch">rewatched</span>' : '';
      const like = film.liked ? ' <span class="activity-like" title="Liked">♥</span>' : '';

      return `
        <li class="activity-item has-poster">
          <span class="activity-date">${formatShortDate(film.watchedDate)}</span>
          ${poster
            ? `<img class="activity-poster" src="${escapeHtml(poster)}" alt="" loading="lazy" />`
            : '<span class="activity-poster"></span>'}
          <span class="activity-film">
            ${link
              ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(film.title)}</a>`
              : escapeHtml(film.title)}
            ${film.year ? `<span class="activity-year">(${film.year})</span>` : ''}
            ${rewatch}
          </span>
          <span class="activity-rating">${stars}${like}</span>
        </li>
      `;
    }).join('');
  }

  function renderLiveReviews(films) {
    const section = document.getElementById('reviews-section');
    const list = document.getElementById('reviews-list');
    if (!section || !list) return;

    const reviews = films.filter((f) => f.review).slice(0, 4);
    if (!reviews.length) return;

    list.innerHTML = reviews.map((film) => {
      const poster = safeUrl(film.poster);
      const link = safeUrl(film.link);
      const stars = film.rating ? ratingToStars(film.rating) : '';
      const like = film.liked ? ' <span class="activity-like" title="Liked">♥</span>' : '';
      const title = link
        ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(film.title)}</a>`
        : escapeHtml(film.title);

      return `
        <li class="review-item">
          ${poster ? `<img class="review-poster" src="${escapeHtml(poster)}" alt="" loading="lazy" />` : ''}
          <div class="review-body">
            <div class="review-heading">
              ${title}
              ${film.year ? `<span class="activity-year">(${film.year})</span>` : ''}
              <span class="review-rating">${stars}${like}</span>
            </div>
            <div class="review-date">${formatShortDate(film.watchedDate, { month: 'short', day: 'numeric', year: 'numeric' })}${film.rewatch ? ' · rewatch' : ''}</div>
            <p class="review-text">${escapeHtml(film.review)}</p>
            ${link ? `<a class="review-more" href="${escapeHtml(link)}" target="_blank" rel="noopener">Read on Letterboxd</a>` : ''}
          </div>
        </li>
      `;
    }).join('');
    section.removeAttribute('hidden');
  }

  function applyLive(live, stats) {
    if (!live) return;
    renderLiveAvatar(live);
    if (!live.films.length) return;
    renderLiveActivity(live.films);
    renderLiveReviews(live.films);
    renderLiveCounts(live.films);
    renderLiveBadge(live);
    liveState.delta = computeLiveDelta(live.films, stats);
    applyLiveDelta();
  }

  // The static half of the header — stats.json's `profile` block, rendered
  // whether or not the Worker responds.
  function renderProfile(profile) {
    if (!profile) return;
    if (profile.givenName) setText('profile-name', profile.givenName);
    const meta = document.getElementById('profile-meta');
    if (!meta) return;
    const parts = [];
    if (profile.location) parts.push(profile.location);
    if (profile.dateJoined) parts.push(`on Letterboxd since ${String(profile.dateJoined).slice(0, 4)}`);
    if (parts.length) {
      meta.textContent = parts.join(' · ');
      meta.hidden = false;
    }
  }

  /* --------------------------------------------------------- static render */

  function renderStatCards(stats) {
    setText('stat-total', stats.totalWatched);
    setText('stat-unique', stats.uniqueFilms);
    setText('stat-rewatches', stats.totalRewatches);
    setText('stat-avg-rating', (stats.averageRating || 0).toFixed(1));
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  // Heatmap
  function renderHeatmap(heatmapData, dateRange, options) {
    const container = document.getElementById('heatmap-grid');
    const monthLabels = document.getElementById('heatmap-months');
    if (!container) return;

    // Build a lookup of date -> count
    const counts = {};
    let maxCount = 0;
    for (const d of heatmapData) {
      counts[d.date] = d.count;
      if (d.count > maxCount) maxCount = d.count;
    }

    let start;
    let end;
    if (options && options.scope === 'year' && options.year) {
      // Fixed calendar-year window: Jan 1 → Dec 31 of the selected year,
      // padded outward to Sunday/Saturday week boundaries.
      start = new Date(options.year, 0, 1);
      end = new Date(options.year, 11, 31);
      end.setDate(end.getDate() + (6 - end.getDay()));
      start.setDate(start.getDate() - start.getDay());
    } else {
      // Lifetime: trailing 52 weeks, ending at/after today.
      const dataLatest = dateRange.latest ? new Date(dateRange.latest + 'T00:00:00') : new Date();
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const latest = dataLatest > today ? dataLatest : today;
      end = new Date(latest);
      end.setDate(end.getDate() + (6 - end.getDay()));
      start = new Date(end);
      start.setDate(start.getDate() - 52 * 7 + 1);
      start.setDate(start.getDate() - start.getDay());
    }

    const weeks = [];
    const currentDate = new Date(start);
    let currentWeek = [];
    const monthPositions = [];
    let lastMonth = -1;

    while (currentDate <= end) {
      const dayOfWeek = currentDate.getDay();
      if (dayOfWeek === 0 && currentWeek.length > 0) {
        weeks.push(currentWeek);
        currentWeek = [];
      }

      const dateStr = formatLocalDate(currentDate);
      const count = counts[dateStr] || 0;

      // Track month boundaries
      const month = currentDate.getMonth();
      if (month !== lastMonth) {
        monthPositions.push({
          weekIndex: weeks.length,
          label: currentDate.toLocaleDateString('en-US', { month: 'short' }),
        });
        lastMonth = month;
      }

      currentWeek.push({ date: dateStr, count, dayOfWeek });
      currentDate.setDate(currentDate.getDate() + 1);
    }
    if (currentWeek.length > 0) weeks.push(currentWeek);

    // Publish week count to CSS so both grids (.heatmap-grid and
    // .heatmap-month-labels) size themselves to `repeat(N, minmax(10px, 1fr))`.
    container.style.setProperty('--heatmap-weeks', weeks.length);
    if (monthLabels) {
      monthLabels.style.setProperty('--heatmap-weeks', weeks.length);
    }

    // Render month labels
    if (monthLabels) {
      monthLabels.innerHTML = '';
      let prevWeekIdx = -2;
      for (const mp of monthPositions) {
        // Only render if there's space (at least 3 weeks apart)
        if (mp.weekIndex - prevWeekIdx < 3) continue;
        const span = document.createElement('span');
        span.className = 'heatmap-month-label';
        span.textContent = mp.label;
        span.style.gridColumn = mp.weekIndex + 1;
        monthLabels.appendChild(span);
        prevWeekIdx = mp.weekIndex;
      }
    }

    // Render grid
    container.innerHTML = '';
    for (const week of weeks) {
      const col = document.createElement('div');
      col.className = 'heatmap-column';

      // Pad the first week if it doesn't start on Sunday
      if (week === weeks[0]) {
        for (let i = 0; i < week[0].dayOfWeek; i++) {
          const empty = document.createElement('div');
          empty.className = 'heatmap-cell';
          empty.style.visibility = 'hidden';
          col.appendChild(empty);
        }
      }

      for (const day of week) {
        const cell = document.createElement('div');
        cell.className = 'heatmap-cell';
        if (day.count > 0) {
          cell.setAttribute('data-count', Math.min(day.count, 6));
        }

        const tooltip = document.createElement('span');
        tooltip.className = 'tooltip';
        const dateObj = new Date(day.date + 'T00:00:00');
        const dateLabel = dateObj.toLocaleDateString('en-US', {
          month: 'short', day: 'numeric', year: 'numeric',
        });
        tooltip.textContent = day.count > 0
          ? `${day.count} film${day.count > 1 ? 's' : ''} on ${dateLabel}`
          : `No films on ${dateLabel}`;
        cell.appendChild(tooltip);
        col.appendChild(cell);
      }
      container.appendChild(col);
    }
  }

  // Charts
  const chartInstances = {};

  function renderRatingChart(ratingDistribution) {
    const ctx = document.getElementById('ratingsChart');
    if (!ctx || typeof Chart === 'undefined') return;

    const labels = ['0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5', '5'];
    const data = labels.map(l => {
      const key = l.includes('.') ? l : l + '.0';
      return ratingDistribution[key] || 0;
    });

    if (chartInstances.ratings) chartInstances.ratings.destroy();
    chartInstances.ratings = new Chart(ctx, {
      type: 'bar',
      data: {
        labels: labels.map(l => l.length === 1 ? l + '.0' : l),
        datasets: [{
          data,
          backgroundColor: '#00c030',
          borderRadius: 3,
          borderSkipped: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: {
            grid: { display: false },
            ticks: { color: '#667788', font: { size: 11 } },
          },
          y: {
            grid: { color: '#2c3440' },
            ticks: { color: '#667788', font: { size: 11 }, stepSize: 10 },
          },
        },
      },
    });
  }

  function renderDecadeChart(filmYearDistribution) {
    const ctx = document.getElementById('decadesChart');
    if (!ctx || typeof Chart === 'undefined') return;

    const labels = Object.keys(filmYearDistribution);
    const data = Object.values(filmYearDistribution);

    if (chartInstances.decades) chartInstances.decades.destroy();
    chartInstances.decades = new Chart(ctx, {
      type: 'bar',
      data: {
        labels,
        datasets: [{
          data,
          backgroundColor: '#40bcf4',
          borderRadius: 3,
          borderSkipped: false,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        indexAxis: 'y',
        plugins: { legend: { display: false } },
        scales: {
          x: {
            grid: { color: '#2c3440' },
            ticks: { color: '#667788', font: { size: 11 } },
          },
          y: {
            grid: { display: false },
            ticks: { color: '#667788', font: { size: 11 } },
          },
        },
      },
    });
  }

  // Most Rewatched
  function renderRewatched(mostRewatched) {
    const list = document.getElementById('rewatch-list');
    if (!list || !mostRewatched.length) {
      if (list) list.innerHTML = '<li class="rewatch-item" style="color:var(--text-muted)">No rewatches yet</li>';
      return;
    }

    list.innerHTML = mostRewatched.map(film => `
      <li class="rewatch-item">
        <span class="rewatch-count">${film.count}x</span>
        <span>
          <span class="rewatch-title">${escapeHtml(film.filmTitle)}</span>
          ${film.filmYear ? `<span class="rewatch-year">(${film.filmYear})</span>` : ''}
        </span>
      </li>
    `).join('');
  }

  // Activity Feed
  function renderActivity(recentActivity) {
    const list = document.getElementById('activity-list');
    if (!list) return;

    list.innerHTML = recentActivity.map(entry => {
      const date = entry.watchedDate
        ? new Date(entry.watchedDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';
      const stars = entry.memberRating ? ratingToStars(entry.memberRating) : '';
      const rewatch = entry.rewatch ? '<span class="activity-rewatch">rewatched</span>' : '';

      return `
        <li class="activity-item">
          <span class="activity-date">${date}</span>
          <span class="activity-film">
            ${entry.link
              ? `<a href="${escapeHtml(entry.link)}" target="_blank" rel="noopener">${escapeHtml(entry.filmTitle || '')}</a>`
              : escapeHtml(entry.filmTitle || '')}
            ${entry.filmYear ? `<span class="activity-year">(${entry.filmYear})</span>` : ''}
            ${rewatch}
          </span>
          <span class="activity-rating">${stars}</span>
        </li>
      `;
    }).join('');
  }

  // Highest Rated
  function renderHighestRated(highestRated) {
    const grid = document.getElementById('five-star-grid');
    if (!grid) return;

    // Deduplicate by tmdbId, keeping the first (most recent) entry
    const seen = new Set();
    const unique = [];
    for (const film of highestRated) {
      const key = film.tmdbId || film.filmTitle;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(film);
      }
    }

    const items = unique.slice(0, 20);
    grid.innerHTML = items.map(film => `
      <div class="five-star-item">
        ${film.link
          ? `<a href="${escapeHtml(film.link)}" target="_blank" rel="noopener">${escapeHtml(film.filmTitle || '')}</a>`
          : escapeHtml(film.filmTitle || '')}
        ${film.filmYear ? `<span class="five-star-year"> (${film.filmYear})</span>` : ''}
        <div class="five-star-stars">${ratingToStars(5.0)}</div>
      </div>
    `).join('');
  }

  // Contact Form (Discord webhook)
  function initContactForm() {
    const form = document.getElementById('contact-form');
    if (!form) return;

    form.addEventListener('submit', async function (e) {
      e.preventDefault();
      const btn = form.querySelector('.btn-submit');
      const origText = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Sending...';

      const webhookUrl = window.DISCORD_WEBHOOK_URL;
      if (!webhookUrl) {
        showToast('Webhook not configured', 'error');
        btn.disabled = false;
        btn.textContent = origText;
        return;
      }

      const name = form.querySelector('[name="name"]').value;
      const email = form.querySelector('[name="email"]').value;
      const message = form.querySelector('[name="message"]').value;

      try {
        const res = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            embeds: [{
              title: 'New Guestbook Entry',
              color: 5814783,
              fields: [
                { name: 'Name', value: name, inline: true },
                { name: 'Email', value: email, inline: true },
                { name: 'Message', value: message },
              ],
              timestamp: new Date().toISOString(),
            }],
          }),
        });

        if (res.ok || res.status === 204) {
          showToast('Message sent successfully!');
          form.reset();
        } else {
          throw new Error(`HTTP ${res.status}`);
        }
      } catch (err) {
        showToast('Failed to send message. Please try again.', 'error');
        console.error('Webhook error:', err);
      }

      btn.disabled = false;
      btn.textContent = origText;
    });
  }

  function showToast(message, type = 'success') {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = 'toast ' + type;
    // Force reflow
    void toast.offsetWidth;
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 4000);
  }

  // Per-year switching: re-render cards/heatmap/charts/rewatched/highest from a slice
  function renderTimeSlice(slice, dateRange, options) {
    renderStatCards(slice);
    renderHeatmap(slice.heatmapData || [], dateRange, options);
    renderRatingChart(slice.ratingDistribution || {});
    renderDecadeChart(slice.filmYearDistribution || {});
    renderRewatched(slice.mostRewatched || []);
    renderHighestRated(slice.highestRated || []);
  }

  function initYearSelector(stats) {
    const select = document.getElementById('year-select');
    const rail = document.getElementById('scope-rail-list');
    const summary = document.getElementById('year-summary');
    if (!select && !rail) return;

    const years = Object.keys(stats.byYear || {}).sort().reverse();
    const values = ['lifetime', ...years];
    const labelFor = v => v === 'lifetime' ? 'Lifetime' : v;

    if (select) {
      select.innerHTML = values.map(v => `<option value="${v}">${labelFor(v)}</option>`).join('');
    }
    if (rail) {
      rail.innerHTML = values.map(v =>
        `<li><button type="button" data-value="${v}">${labelFor(v)}</button></li>`
      ).join('');
    }

    function activate(value) {
      const isLifetime = value === 'lifetime';
      const slice = isLifetime ? stats : stats.byYear[value];
      const dateRange = isLifetime
        ? stats.dateRange
        : { earliest: `${value}-01-01`, latest: `${value}-12-31` };
      const options = isLifetime
        ? { scope: 'lifetime' }
        : { scope: 'year', year: Number(value) };
      renderTimeSlice(slice, dateRange, options);
      if (summary) {
        summary.textContent = isLifetime
          ? `${stats.dateRange.earliest} – ${stats.dateRange.latest}`
          : `${slice.totalWatched} films logged in ${value}`;
      }
      if (select && select.value !== value) select.value = value;
      if (rail) {
        rail.querySelectorAll('button').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.value === value);
        });
      }
      liveState.isLifetime = isLifetime;
      applyLiveDelta();
    }

    if (select) select.addEventListener('change', e => activate(e.target.value));
    if (rail) {
      rail.addEventListener('click', e => {
        const btn = e.target.closest('button[data-value]');
        if (btn) activate(btn.dataset.value);
      });
    }
    activate('lifetime');
  }

  function renderFavorites(favorites) {
    const section = document.getElementById('favorites-strip');
    const list = document.getElementById('favorites-list');
    if (!section || !list || !favorites?.length) return;
    list.innerHTML = favorites.map(f => `
      <a class="favorite-item" href="${escapeHtml(f.link)}" target="_blank" rel="noopener">
        <span class="favorite-name">${escapeHtml(f.name || 'Untitled')}</span>
        ${f.year ? `<span class="favorite-year">(${f.year})</span>` : ''}
      </a>
    `).join('');
    section.removeAttribute('hidden');
  }

  function renderTagCloud(tags) {
    const section = document.getElementById('tag-cloud-section');
    const cloud = document.getElementById('tag-cloud');
    if (!section || !cloud) return;
    const entries = Object.entries(tags || {});
    if (!entries.length) return;
    const max = Math.max(...entries.map(([, n]) => n));
    cloud.innerHTML = entries.map(([tag, count]) => {
      const weight = 0.75 + (count / max) * 1.5; // 0.75rem .. 2.25rem
      return `<span class="tag-cloud-item" style="font-size:${weight.toFixed(2)}rem" title="${count} entries">${escapeHtml(tag)}</span>`;
    }).join(' ');
    section.removeAttribute('hidden');
  }

  function renderWatchlist(watchlist) {
    const section = document.getElementById('watchlist-section');
    const meta = document.getElementById('watchlist-meta');
    const recent = document.getElementById('watchlist-recent');
    if (!section || !watchlist) return;
    setText('watchlist-count', watchlist.count ?? '--');
    if (meta) {
      meta.textContent = watchlist.count
        ? `Oldest entry added ${watchlist.oldestAdded}.`
        : 'Watchlist is empty.';
    }
    if (recent && watchlist.recentlyAdded?.length) {
      recent.innerHTML = watchlist.recentlyAdded.map(item => `
        <li class="activity-item">
          <span class="activity-date">${escapeHtml(item.addedDate || '')}</span>
          <span class="activity-film">
            ${item.link
              ? `<a href="${escapeHtml(item.link)}" target="_blank" rel="noopener">${escapeHtml(item.name || '')}</a>`
              : escapeHtml(item.name || '')}
            ${item.year ? `<span class="activity-year">(${item.year})</span>` : ''}
          </span>
        </li>
      `).join('');
    }
    section.removeAttribute('hidden');
  }

  // Films the user logged that Letterboxd has since removed (no live page to link to)
  function renderOrphaned(orphanedFilms) {
    const section = document.getElementById('orphaned-section');
    const list = document.getElementById('orphaned-list');
    if (!section || !list || !orphanedFilms?.length) return;

    list.innerHTML = orphanedFilms.map(film => {
      const date = film.watchedDate
        ? new Date(film.watchedDate + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : '';
      const stars = film.memberRating ? ratingToStars(film.memberRating) : '';
      const rewatched = film.logCount > 1 ? `<span class="activity-rewatch">logged ${film.logCount}×</span>` : '';

      return `
        <li class="activity-item">
          <span class="activity-date">${date}</span>
          <span class="activity-film">
            ${escapeHtml(film.filmTitle || '')}
            ${film.filmYear ? `<span class="activity-year">(${film.filmYear})</span>` : ''}
            ${rewatched}
          </span>
          <span class="activity-rating">${stars}</span>
        </li>
      `;
    }).join('');

    section.removeAttribute('hidden');
  }

  // Init
  async function init() {
    const livePromise = loadLive(); // in flight while the static render happens
    const stats = await loadStats();
    if (!stats) {
      document.getElementById('loading')?.remove();
      return;
    }

    if (stats.archiveExportDate) setText('export-date', stats.archiveExportDate);

    renderProfile(stats.profile);

    // Lifetime / per-year switching block
    initYearSelector(stats);

    // Sections that aren't year-scoped
    renderActivity(stats.recentActivity);
    renderFavorites(stats.favoriteFilms);
    renderTagCloud(stats.tagCloud);
    renderWatchlist(stats.watchlist);
    renderOrphaned(stats.orphanedFilms);

    initContactForm();

    document.getElementById('loading')?.remove();
    document.getElementById('dashboard')?.removeAttribute('hidden');

    // Layer the live data over the fully-rendered static page — a slow or
    // failed Worker call never blocks or breaks the dashboard.
    applyLive(await livePromise, stats);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
