/* Letterboxd Stats Dashboard */

(function () {
  'use strict';

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

  // Helpers
  function ratingToStars(rating) {
    const full = Math.floor(rating);
    const half = rating % 1 >= 0.5;
    return '\u2605'.repeat(full) + (half ? '\u00BD' : '');
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
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
    const summary = document.getElementById('year-summary');
    if (!select) return;

    const years = Object.keys(stats.byYear || {}).sort().reverse();
    const opts = ['<option value="lifetime">Lifetime</option>']
      .concat(years.map(y => `<option value="${y}">${y}</option>`));
    select.innerHTML = opts.join('');

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
      // Keep watchlist count card stable across slices — it's a lifetime count
      setText('stat-watchlist', stats.watchlist?.count ?? '--');
      if (summary) {
        summary.textContent = isLifetime
          ? `${stats.dateRange.earliest} – ${stats.dateRange.latest}`
          : `${slice.totalWatched} films logged in ${value}`;
      }
    }

    select.addEventListener('change', e => activate(e.target.value));
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

  function renderLists(lists) {
    const section = document.getElementById('lists-section');
    const list = document.getElementById('lists-list');
    if (!section || !list || !lists?.length) return;
    list.innerHTML = lists.map(l => `
      <li class="lists-item">
        <a href="${escapeHtml(l.url || '#')}" target="_blank" rel="noopener">${escapeHtml(l.name)}</a>
        <span class="lists-count">${l.filmCount} films</span>
      </li>
    `).join('');
    section.removeAttribute('hidden');
  }

  function renderWatchlist(watchlist) {
    const section = document.getElementById('watchlist-section');
    const meta = document.getElementById('watchlist-meta');
    const recent = document.getElementById('watchlist-recent');
    if (!section || !watchlist) return;
    if (meta) {
      meta.textContent = watchlist.count
        ? `${watchlist.count} films queued — oldest entry added ${watchlist.oldestAdded}.`
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

  // Init
  async function init() {
    const stats = await loadStats();
    if (!stats) {
      document.getElementById('loading')?.remove();
      return;
    }

    if (stats.archiveExportDate) setText('export-date', stats.archiveExportDate);

    // Lifetime / per-year switching block
    initYearSelector(stats);

    // Sections that aren't year-scoped
    renderActivity(stats.recentActivity);
    renderFavorites(stats.favoriteFilms);
    renderTagCloud(stats.tagCloud);
    renderLists(stats.lists);
    renderWatchlist(stats.watchlist);

    initContactForm();

    document.getElementById('loading')?.remove();
    document.getElementById('dashboard')?.removeAttribute('hidden');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
