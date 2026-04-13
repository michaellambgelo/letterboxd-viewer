# Letterboxd Viewer — CLAUDE.md

## Project Goal

Personal Letterboxd stats dashboard rendered as a static site on GitHub Pages. A Python pipeline runs on cron, merges a Letterboxd export archive (historical baseline) with the public RSS feed (delta for new entries), and pre-computes every field the frontend displays into `data/stats.json`.

Single-user (hard-coded to `michaellamb` in `scripts/download_rss.py`). The frontend is a pure static consumer of `stats.json` — no runtime computation beyond Chart.js rendering, the heatmap grid layout, and the year-selector swap.

> **Historical note:** Earlier iterations of this repo explored a "Last Four Watched" dynamic username feature backed by a Cloudflare Worker + Canvas image export. That direction was superseded by the stats-dashboard rewrite on `main`. The shareable-card idea now lives in a separate project: [`boxd-card`](https://github.com/michaellambgelo/boxd-card) (Chrome extension, client-side DOM scrape).

---

## Architecture

```
data/archive/letterboxd-<user>-<date>/  ──►  scripts/load_archive.py   (CSV reader)
                                                       │
Letterboxd RSS  ──►  scripts/download_rss.py  ──►  data/rss.xml
                                                       │
                                                       ▼
                     scripts/extract_history.py  ──►  data/viewing_history.json
                     (archive baseline + RSS deltas       (full diary, deduped by
                      newer than archive export date)      (name, year, watchedDate))
                                                       │
                                                       ▼
                     scripts/compute_stats.py     ──►  data/stats.json
                     (also pulls watchlist, likes,
                      lists, favorites, tags, and
                      per-diary-year breakdowns)
                                                       │
                                                       ▼
                     index.html + assets/js/dashboard.js
                     (vanilla JS + Chart.js, year selector)
```

**Source of truth:** The Letterboxd export under `data/archive/letterboxd-<user>-YYYY-MM-DD-HH-MM-utc/` is the historical baseline (full diary, watchlist, ratings, reviews, lists, likes, favorites). RSS only exposes the 50 most recent entries and is layered on top to capture activity logged **after** the export date. The export folder name encodes the export date — `load_archive.get_export_date()` parses it.

**Re-importing a fresh export:** drop a new `letterboxd-<user>-...` folder under `data/archive/` and the loader picks up the most recent one by name. No code changes needed unless the schema changes.

**Merge key:** `(filmTitle, filmYear, watchedDate)`. RSS guids (`letterboxd-entry-XXXXX`) and archive URIs (`https://boxd.it/XXXXX`) cannot be matched directly without a network redirect; the composite key is unique because Letterboxd allows at most one diary entry per `(film, watchedDate)`.

## Key Files

**Frontend (static):**
- `index.html` — dashboard shell with stat cards, heatmap, charts, rewatched list, five-star grid, recent activity, guestbook form
- `assets/js/dashboard.js` — all rendering logic (data loading via `fetch('data/stats.json')`, heatmap layout, Chart.js setup, contact form handler)
- `assets/css/dashboard.css` — all styling
- No jQuery, no Handlebars, no Poptrox, no build step

**Pipeline (Python):**
- `scripts/load_archive.py` — CSV loader for the export. `load_diary()` returns rows shaped like the RSS parser; also provides `load_watchlist`, `load_likes`, `load_lists`, `load_profile`, `load_ratings`, `get_export_date`.
- `scripts/download_rss.py` — fetches `https://letterboxd.com/michaellamb/rss/`, writes raw `data/rss.xml` and `data/cleaned_rss.xml` (HTML-cleaned descriptions)
- `scripts/extract_history.py` — merges archive baseline + working-tree `data/rss.xml` deltas, writes `data/viewing_history.json` (sorted by `watchedDate` desc)
- `scripts/compute_stats.py` — reads `viewing_history.json` + archive sidecars, writes `data/stats.json` with pre-computed lifetime stats, `byYear` per-diary-year slices, `watchlist`, `likedFilms`, `favoriteFilms`, `lists`, `tagCloud`, and `archiveExportDate`

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
| `mostRewatched` | `[{ filmTitle, filmYear, count, link, tmdbId }, ...]` | Most rewatched list |
| `highestRated` | `[{ filmTitle, filmYear, link, ... }, ...]` | Five-star grid |
| `recentActivity` | `[{ filmTitle, watchedDate, memberRating, ... }, ...]` | Recent activity list |
| `dateRange` | `{ earliest: "YYYY-MM-DD", latest: "YYYY-MM-DD" }` | Heatmap end-date anchor |
| `byYear` | `{ "2020": { totalWatched, uniqueFilms, ratingDistribution, heatmapData, filmYearDistribution, mostRewatched, highestRated, … }, … }` | Year-selector slice swap |
| `watchlist` | `{ count, oldestAdded, newestAdded, recentlyAdded[] }` | Watchlist card + section |
| `favoriteFilms` | `[{ link, name, year }, ...]` | Favorites strip (4 films from `profile.csv`) |
| `likedFilms` | `[{ name, year, link, likedDate }, ...]` | (currently unused on frontend) |
| `lists` | `[{ name, slug, url, filmCount, tags, description }, ...]` | Lists section |
| `tagCloud` | `{ tag: count, ... }` | Tag cloud |
| `profile` | `{ username, givenName, location, website, bio, dateJoined }` | (header future-use) |
| `archiveExportDate` | `"YYYY-MM-DD"` | Disclaimer text |

## Development Notes

- **The username is hard-coded** to `michaellamb` in the `url` assignment near the top of `scripts/download_rss.py`. To fork this for another account, edit that line, drop a fresh export under `data/archive/`, and re-run the pipeline.
- **Running the pipeline locally:**
  ```bash
  pip install requests beautifulsoup4 lxml  # csv module is stdlib
  python3 scripts/download_rss.py
  python3 scripts/extract_history.py
  python3 scripts/compute_stats.py
  ```
- **Serving locally:** `python3 -m http.server 8000` from the repo root.
- **Heatmap end-date anchor:** `dashboard.js` renders a 52-week window ending on the later of `dateRange.latest` or today. This means even if the cron falls behind, the grid still extends to the current week (with empty cells for missing data) rather than truncating at the last data point.
- **Timezone caveat:** `renderHeatmap()` parses dates as local time but uses `toISOString()` for lookups, which can shift cells by 1 day for users in positive-offset timezones. Not yet fixed.
- **Cron health matters:** if the workflow stops successfully committing updated `data/stats.json` and `data/viewing_history.json`, the site goes stale silently. When investigating "missing recent data", first check `gh run list --workflow=download-data-and-assets.yml` — the data is almost always the problem, not the frontend.
- **Refreshing the archive:** export from Letterboxd, drop the new `letterboxd-michaellamb-YYYY-MM-DD-HH-MM-utc/` folder under `data/archive/`, optionally delete the older one, and re-run `extract_history.py` + `compute_stats.py`. The loader picks the lexicographically newest folder.
- **Stale artifacts to ignore:** `worker/` and `docs/letterboxd-viewer-presentation.md` are leftover from the old Last Four Watched direction and are not part of the deployed site.
