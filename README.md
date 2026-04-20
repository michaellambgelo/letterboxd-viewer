# Letterboxd Viewer [![Deploy to GitHub Pages](https://github.com/michaellambgelo/letterboxd-viewer/actions/workflows/deploy.yml/badge.svg)](https://github.com/michaellambgelo/letterboxd-viewer/actions/workflows/deploy.yml) [![RSS Feed Update](https://github.com/michaellambgelo/letterboxd-viewer/actions/workflows/download-data-and-assets.yml/badge.svg?event=schedule)](https://github.com/michaellambgelo/letterboxd-viewer/actions/workflows/download-data-and-assets.yml)

A personal Letterboxd stats dashboard rendered as a static site on GitHub Pages. A Python pipeline runs on a cron schedule, merges a Letterboxd export archive (historical baseline) with the public RSS feed (delta for new entries), and pre-computes every field the frontend displays into `data/stats.json`.

Live site: **https://michaellambgelo.github.io/letterboxd-viewer/**

## What the dashboard shows

- **Stat cards** — total films watched, unique titles, rewatches, average rating
- **Year selector** — swap any chart/list between lifetime totals and a single diary year
- **Watching activity heatmap** — 52-week grid of daily film counts (GitHub-contributions style)
- **Rating distribution** — bar chart of ratings from 0.5 to 5.0 plus unrated
- **Films by decade** — bar chart grouping watched films by release decade
- **Most rewatched** — top films by watch count
- **Five-star films** — all entries rated 5.0
- **Recent activity** — latest diary entries
- **Watchlist** — count, oldest/newest add dates, recently added strip
- **Favorite films** — the four favorites pulled from `profile.csv`
- **Lists** — every Letterboxd list with film count, tags, and description
- **Tag cloud** — diary tags weighted by use
- **Guestbook** — contact form that posts to a Discord webhook

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

The Letterboxd export under `data/archive/letterboxd-<user>-YYYY-MM-DD-HH-MM-utc/` is the historical baseline (full diary, watchlist, ratings, reviews, lists, likes, favorites). RSS only exposes the 50 most recent entries and is layered on top to capture activity logged **after** the export date. The export folder name encodes the export date — `load_archive.get_export_date()` parses it.

Merge key: `(filmTitle, filmYear, watchedDate)`. RSS guids and archive `boxd.it` URIs cannot be matched directly without a network redirect; the composite key is unique because Letterboxd allows at most one diary entry per `(film, watchedDate)`.

## Data pipeline scripts

| Script | Input | Output |
|---|---|---|
| `scripts/download_rss.py` | `https://letterboxd.com/michaellamb/rss/` | `data/rss.xml`, `data/cleaned_rss.xml` |
| `scripts/load_archive.py` | `data/archive/letterboxd-<user>-<date>/*.csv` | (library — used by the two scripts below) |
| `scripts/extract_history.py` | archive baseline + `data/rss.xml` deltas | `data/viewing_history.json` |
| `scripts/compute_stats.py` | `viewing_history.json` + archive sidecars | `data/stats.json` |

`stats.json` contains every field the dashboard consumes — lifetime stat totals, rating distribution, heatmap series, decade buckets, most-rewatched/highest-rated lists, recent activity, watchlist summary, favorite films, lists, tag cloud, profile, archive export date, and a `byYear` block with per-diary-year slices for the year selector. The frontend is a pure static-file consumer — no runtime computation beyond Chart.js rendering, the heatmap grid layout, and the year-selector swap.

## Automated updates

`.github/workflows/download-data-and-assets.yml` runs on a cron schedule (every 6 hours) and can also be triggered manually from the Actions tab. Each run:

1. Fetches the latest RSS feed
2. Runs `extract_history.py` to merge the archive baseline with RSS deltas newer than the archive export date
3. Runs `compute_stats.py` to regenerate `data/stats.json`
4. Commits `data/rss.xml`, `data/cleaned_rss.xml`, `data/viewing_history.json`, and `data/stats.json` if anything changed
5. Triggers `deploy.yml` to republish GitHub Pages

## Running the pipeline locally

```bash
python3 -m venv scripts/venv
source scripts/venv/bin/activate
pip install requests beautifulsoup4 lxml   # csv is stdlib

python3 scripts/download_rss.py
python3 scripts/extract_history.py
python3 scripts/compute_stats.py
```

`extract_history.py` and `compute_stats.py` both expect at least one export folder under `data/archive/` — the loader picks the lexicographically newest one.

Then serve the site:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Refreshing the archive

Export from Letterboxd, drop the new `letterboxd-<user>-YYYY-MM-DD-HH-MM-utc/` folder under `data/archive/` (older folders can be left in place — the loader picks the most recent by name), and re-run `extract_history.py` + `compute_stats.py`.

## Changing the tracked user

The Letterboxd username is hard-coded in `scripts/download_rss.py`. To point the dashboard at a different account, edit the `url` assignment near the top of that file, drop a fresh export under `data/archive/`, and re-run the pipeline.

## Contact form

The guestbook posts through a Discord webhook. The webhook URL is injected at deploy time via a GitHub Actions secret (`DISCORD_WEBHOOK_URL`) so the URL never lives in the repo. See the [Discord webhook intro](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks) for setup.

## Related projects

- **[boxd-card](https://github.com/michaellambgelo/boxd-card)** — Chrome extension that generates shareable image cards directly from any Letterboxd profile page (client-side DOM scrape, no backend)
