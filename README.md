# Letterboxd Viewer

[![Status](https://status.michaellamb.dev/api/badge/11/status)](https://status.michaellamb.dev)
[![Uptime 30d](https://status.michaellamb.dev/api/badge/11/uptime/720?style=flat)](https://status.michaellamb.dev)
[![Deploy to GitHub Pages](https://github.com/michaellambgelo/letterboxd-viewer/actions/workflows/deploy.yml/badge.svg)](https://github.com/michaellambgelo/letterboxd-viewer/actions/workflows/deploy.yml)
[![RSS Feed Update](https://github.com/michaellambgelo/letterboxd-viewer/actions/workflows/download-data-and-assets.yml/badge.svg?event=schedule)](https://github.com/michaellambgelo/letterboxd-viewer/actions/workflows/download-data-and-assets.yml)

A personal Letterboxd stats dashboard rendered as a static site on GitHub Pages. A Python pipeline runs on a cron schedule, merges a Letterboxd export archive (historical baseline) with the public RSS feed (delta for new entries), and pre-computes every field the frontend displays into `data/stats.json`.

Live site: **https://letterboxd.michaellamb.dev/** (the GitHub Pages default, `michaellambgelo.github.io/letterboxd-viewer/`, redirects to it)

## What the dashboard shows

- **Stat cards** — total films watched, unique titles, rewatches, average rating
- **Year selector** — swap any chart/list between lifetime totals and a single diary year
- **Watching activity heatmap** — 52-week grid of daily film counts (GitHub-contributions style)
- **Rating distribution** — bar chart of ratings from 0.5 to 5.0 plus unrated
- **Films by decade** — bar chart grouping watched films by release decade
- **Most rewatched** — top films by watch count
- **Five-star films** — all entries rated 5.0
- **Recent activity** — latest diary entries
- **Watchlist** — count, oldest/newest add dates, recently added strip (export snapshot minus films logged since the export)
- **Favorite films** — the four favorites pulled from `profile.csv`
- **Lists** — every Letterboxd list with film count, tags, and description
- **Tag cloud** — diary tags weighted by use
- **Guestbook** — contact form that posts to a Discord webhook (in the footer of every page)

When the rolodex Worker is reachable, the dashboard also layers live data from its `GET /stats/live` over the static render: avatar, posters and like hearts in Recent activity, a Latest Reviews section, and a "+N since last update" note. Without the Worker the static render is complete on its own.

## Other pages

- **Rolodex** (`rolodex.html`) — a curated shortlist of Letterboxd members, each card showing their last four watched. Served by the Cloudflare Worker in `worker/` (KV-backed, with an admin UI behind Cloudflare Access); see `worker/SETUP.md`.
- **Network** (`network.html`, from `data/network.json`) — an anonymized graph of followers, following and mutuals. Built by hand with `scripts/compute_network.py` from browser exports that are never committed.
- **Tags** (`tags.html`) — pick diary tags and get every entry logged with them, read straight from `data/viewing_history.json` and grouped by `data/tag_categories.json`.
- **Rewatches** — see below.

The **Rewatches** page (`rewatches.html`, from `data/rewatches.json`) lists every film logged more than once, the films first seen before the diary, and the films marked watched with no diary entry, with each number's definition spelled out so you can compute your own from a Letterboxd export.

## Architecture

```
data/archive/letterboxd-<user>-<date>/  ──►  scripts/load_archive.py   (CSV reader)
                                                       │
Letterboxd RSS  ──►  scripts/download_rss.py  ──►  data/rss.xml
                                                       │
                                                       ▼
                     scripts/extract_history.py  ──►  data/viewing_history.json
                     (archive baseline + RSS deltas       (full diary, deduped by
                      newer than archive export date       (name, year, watchedDate))
                      + RSS entries carried forward  ◄──────────┘
                      from the previous history)       │
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

The Letterboxd export under `data/archive/letterboxd-<user>-YYYY-MM-DD-HH-MM-utc/` is the historical baseline (full diary, watchlist, ratings, reviews, lists, likes, favorites). RSS only exposes the 50 most recent entries and is layered on top to capture activity logged **after** the export date. Because RSS is a sliding window, `extract_history.py` also carries forward every RSS-sourced entry from the previous `viewing_history.json`; without that, entries logged after the export date vanish once they scroll out of the feed. The export folder name encodes the export date — `load_archive.get_export_date()` parses it.

Merge key: `(filmTitle, filmYear, watchedDate)`. RSS guids and archive `boxd.it` URIs cannot be matched directly without a network redirect; the composite key is unique because Letterboxd allows at most one diary entry per `(film, watchedDate)`.

## Data pipeline scripts

| Script | Input | Output |
|---|---|---|
| `scripts/download_rss.py` | `https://letterboxd.com/michaellamb/rss/` | `data/rss.xml`, `data/cleaned_rss.xml` |
| `scripts/load_archive.py` | `data/archive/letterboxd-<user>-<date>/*.csv` | (library — used by the two scripts below) |
| `scripts/extract_history.py` | archive baseline + `data/rss.xml` deltas + RSS-sourced entries carried forward from the previous `data/viewing_history.json` | `data/viewing_history.json` |
| `scripts/compute_stats.py` | `viewing_history.json` + archive sidecars | `data/stats.json`, `data/rewatches.json`, `data/watchlist.json` |

`stats.json` contains every field the dashboard consumes — lifetime stat totals, rating distribution, heatmap series, decade buckets, most-rewatched/highest-rated lists, recent activity, watchlist summary, favorite films, lists, tag cloud, profile, archive export date, and a `byYear` block with per-diary-year slices for the year selector. The frontend is a static-file consumer of it — no runtime computation beyond Chart.js rendering, the heatmap grid layout, and the year-selector swap — plus the optional live layer described above.

## Automated updates

`.github/workflows/download-data-and-assets.yml` runs on a cron schedule (every 6 hours) and can also be triggered manually from the Actions tab. Each run:

1. Fetches the latest RSS feed
2. Runs `extract_history.py` to merge the archive baseline with RSS deltas newer than the archive export date
3. Runs `compute_stats.py` to regenerate `data/stats.json`, `data/rewatches.json` and `data/watchlist.json`
4. Commits `data/rss.xml`, `data/cleaned_rss.xml`, `data/viewing_history.json`, `data/stats.json`, `data/watchlist.json`, and `data/rewatches.json` if anything changed
5. Triggers `deploy.yml` to republish GitHub Pages

## Running the pipeline locally

```bash
python3 -m venv scripts/venv
source scripts/venv/bin/activate
pip install requests beautifulsoup4   # csv is stdlib

python3 scripts/download_rss.py
python3 scripts/extract_history.py
python3 scripts/compute_stats.py
```

`extract_history.py` and `compute_stats.py` both expect at least one export folder under `data/archive/` — the loader picks the lexicographically newest one.

Then serve the site:

```bash
npx serve -l 8000 .
# open http://localhost:8000
```

Not `python3 -m http.server`: the nav links are extension-less (`rolodex`, `tags`), which it doesn't resolve, so they 404.

## Refreshing the archive

Export from Letterboxd, drop the new `letterboxd-<user>-YYYY-MM-DD-HH-MM-utc/` folder under `data/archive/` (older folders can be left in place — the loader picks the most recent by name), and re-run `extract_history.py` + `compute_stats.py`.

## Changing the tracked user

The Letterboxd username is hard-coded in `scripts/download_rss.py`. To point the dashboard at a different account, edit the `url` assignment near the top of that file, drop a fresh export under `data/archive/`, and re-run the pipeline.

## Contact form

The guestbook posts through a Discord webhook. The webhook URL is injected at deploy time via a GitHub Actions secret (`DISCORD_WEBHOOK_URL`) so the URL never lives in the repo. `deploy.yml` writes it into all five pages. See the [Discord webhook intro](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks) for setup.

## Related projects

- **[boxd-card](https://github.com/michaellambgelo/boxd-card)** — Chrome extension that generates shareable image cards directly from any Letterboxd profile page (client-side DOM scrape, no backend)
