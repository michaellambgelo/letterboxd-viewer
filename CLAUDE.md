# Letterboxd Viewer — CLAUDE.md

## Project Goal

Personal Letterboxd stats dashboard rendered as a static site on GitHub Pages. A Python pipeline runs on cron, walks git history of the RSS feed to build a cumulative viewing log, and pre-computes every field the frontend displays into `data/stats.json`.

Single-user (hard-coded to `michaellamb` in `scripts/download_rss.py`). The frontend is a pure static consumer of `stats.json` — no runtime computation beyond Chart.js rendering and the heatmap grid layout.

> **Historical note:** Earlier iterations of this repo explored a "Last Four Watched" dynamic username feature backed by a Cloudflare Worker + Canvas image export. That direction was superseded by the stats-dashboard rewrite on `main`. The shareable-card idea now lives in a separate project: [`boxd-card`](https://github.com/michaellambgelo/boxd-card) (Chrome extension, client-side DOM scrape).

---

## Architecture

```
Letterboxd RSS  ──►  scripts/download_rss.py       ──►  data/rss.xml
                                                        data/cleaned_rss.xml
                                                             │
                                                             ▼
                     scripts/extract_history.py      ──►  data/viewing_history.json
                     (walks git history of                  (cumulative diary log,
                      data/rss.xml, dedupes by guid)         deduped by numeric ID)
                                                             │
                                                             ▼
                     scripts/compute_stats.py        ──►  data/stats.json
                                                             │
                                                             ▼
                     index.html + assets/js/dashboard.js
                     (vanilla JS + Chart.js)
```

**Key trick:** Letterboxd's RSS feed only exposes the 50 most recent diary entries. `extract_history.py` walks every git commit that touched `data/rss.xml` and deduplicates entries by numeric ID (normalizing `letterboxd-review-XXXXX` and `letterboxd-watch-XXXXX` to the same `letterboxd-entry-XXXXX` guid). The longer the cron has been running, the deeper the history goes. The checkout in the workflow uses `fetch-depth: 0` so all commits are available.

## Key Files

**Frontend (static):**
- `index.html` — dashboard shell with stat cards, heatmap, charts, rewatched list, five-star grid, recent activity, guestbook form
- `assets/js/dashboard.js` — all rendering logic (data loading via `fetch('data/stats.json')`, heatmap layout, Chart.js setup, contact form handler)
- `assets/css/dashboard.css` — all styling
- No jQuery, no Handlebars, no Poptrox, no build step

**Pipeline (Python):**
- `scripts/download_rss.py` — fetches `https://letterboxd.com/michaellamb/rss/`, writes raw `data/rss.xml` and `data/cleaned_rss.xml` (HTML-cleaned descriptions)
- `scripts/extract_history.py` — walks `git log --reverse -- data/rss.xml`, parses each snapshot with `xml.etree.ElementTree`, accumulates unique entries into `data/viewing_history.json` (sorted by `watchedDate` desc)
- `scripts/compute_stats.py` — reads `viewing_history.json`, writes `data/stats.json` with pre-computed `totalWatched`, `uniqueFilms`, `totalRewatches`, `averageRating`, `ratingDistribution`, `heatmapData`, `filmYearDistribution`, `mostRewatched`, `highestRated`, `recentActivity`, and `dateRange`

**Workflows:**
- `.github/workflows/download-data-and-assets.yml` — cron `0 */6 * * *`. Runs the 3-script pipeline, commits any changed files in `data/`, and triggers `deploy.yml` via `actions/github-script`
- `.github/workflows/deploy.yml` — publishes to GitHub Pages on push to `main`; injects `DISCORD_WEBHOOK_URL` into the built HTML

## Data contract: `stats.json`

The frontend reads only these top-level keys (see `compute_stats.py` and `dashboard.js`):

| Key | Shape | Used for |
|---|---|---|
| `totalWatched` | int | Stat card |
| `uniqueFilms` | int | Stat card |
| `totalRewatches` | int | Stat card |
| `averageRating` | float | Stat card |
| `ratingDistribution` | `{ "0.5": n, ..., "5.0": n, "unrated": n }` | Rating chart |
| `heatmapData` | `[{ date: "YYYY-MM-DD", count: n }, ...]` | Watching activity heatmap |
| `filmYearDistribution` | `{ "1970s": n, "1980s": n, ... }` | Decades chart |
| `mostRewatched` | `[{ filmTitle, filmYear, count, tmdbId }, ...]` | Most rewatched list |
| `highestRated` | `[{ filmTitle, filmYear, link, ... }, ...]` | Five-star grid |
| `recentActivity` | `[{ filmTitle, watchedDate, memberRating, ... }, ...]` | Recent activity list |
| `dateRange` | `{ earliest: "YYYY-MM-DD", latest: "YYYY-MM-DD" }` | Heatmap end-date anchor |

## Development Notes

- **The username is hard-coded** to `michaellamb` in the `url` assignment near the top of `scripts/download_rss.py`. To fork this for another account, edit that line and re-run the pipeline.
- **Running the pipeline locally:**
  ```bash
  pip install requests beautifulsoup4 lxml
  python3 scripts/download_rss.py
  python3 scripts/extract_history.py
  python3 scripts/compute_stats.py
  ```
- **Serving locally:** `python3 -m http.server 8000` from the repo root.
- **Heatmap end-date anchor:** `dashboard.js` renders a 52-week window ending on the later of `dateRange.latest` or today. This means even if the cron falls behind, the grid still extends to the current week (with empty cells for missing data) rather than truncating at the last data point.
- **Timezone caveat:** `renderHeatmap()` parses dates as local time but uses `toISOString()` for lookups, which can shift cells by 1 day for users in positive-offset timezones. Not yet fixed.
- **Cron health matters:** if the workflow stops successfully committing updated `data/stats.json` and `data/viewing_history.json`, the site goes stale silently. When investigating "missing recent data", first check `gh run list --workflow=download-data-and-assets.yml` — the data is almost always the problem, not the frontend.
- **Stale artifacts to ignore:** `worker/` and `docs/letterboxd-viewer-presentation.md` are leftover from the old Last Four Watched direction and are not part of the deployed site.
