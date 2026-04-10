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
    setText('stat-avg-rating', stats.averageRating.toFixed(1));
  }

  function setText(id, value) {
    const el = document.getElementById(id);
    if (el) el.textContent = value;
  }

  // Heatmap
  function renderHeatmap(heatmapData, dateRange) {
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

    // Determine date range: last 52 weeks from the latest date
    const dataLatest = dateRange.latest ? new Date(dateRange.latest + 'T00:00:00') : new Date();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const latest = dataLatest > today ? dataLatest : today;
    const end = new Date(latest);
    // Move end to the upcoming Saturday (end of week)
    end.setDate(end.getDate() + (6 - end.getDay()));

    const start = new Date(end);
    start.setDate(start.getDate() - 52 * 7 + 1);
    // Move start to Sunday
    start.setDate(start.getDate() - start.getDay());

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
      monthLabels.style.display = 'grid';
      monthLabels.style.gridTemplateColumns = `repeat(${weeks.length}, 14px)`;
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
  function renderRatingChart(ratingDistribution) {
    const ctx = document.getElementById('ratingsChart');
    if (!ctx || typeof Chart === 'undefined') return;

    const labels = ['0.5', '1', '1.5', '2', '2.5', '3', '3.5', '4', '4.5', '5'];
    const data = labels.map(l => {
      const key = l.includes('.') ? l : l + '.0';
      return ratingDistribution[key] || 0;
    });

    new Chart(ctx, {
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

    new Chart(ctx, {
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

  // Init
  async function init() {
    const stats = await loadStats();
    if (!stats) {
      document.getElementById('loading')?.remove();
      return;
    }

    renderStatCards(stats);
    renderHeatmap(stats.heatmapData, stats.dateRange);
    renderRatingChart(stats.ratingDistribution);
    renderDecadeChart(stats.filmYearDistribution);
    renderRewatched(stats.mostRewatched);
    renderActivity(stats.recentActivity);
    renderHighestRated(stats.highestRated);
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
