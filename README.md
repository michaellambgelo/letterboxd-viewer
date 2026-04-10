# Letterboxd Viewer [![Deploy to GitHub Pages](https://github.com/michaellambgelo/letterboxd-viewer/actions/workflows/deploy.yml/badge.svg)](https://github.com/michaellambgelo/letterboxd-viewer/actions/workflows/deploy.yml) [![RSS Feed Update](https://github.com/michaellambgelo/letterboxd-viewer/actions/workflows/download-data-and-assets.yml/badge.svg?event=schedule)](https://github.com/michaellambgelo/letterboxd-viewer/actions/workflows/download-data-and-assets.yml)

A personal Letterboxd stats dashboard rendered as a static site on GitHub Pages. A Python pipeline runs on a cron schedule, walks the git history of the Letterboxd RSS feed to build a cumulative viewing log, and pre-computes all the stats the frontend displays.

Live site: **https://michaellambgelo.github.io/letterboxd-viewer/**

## What the dashboard shows

- **Stat cards** — total films watched, unique titles, rewatches, average rating
- **Watching activity heatmap** — 52-week grid of daily film counts (GitHub-contributions style)
- **Rating distribution** — bar chart of ratings from 0.5 to 5.0 plus unrated
- **Films by decade** — bar chart grouping watched films by release decade
- **Most rewatched** — top films by watch count
- **Five-star films** — all entries rated 5.0
- **Recent activity** — latest diary entries
- **Guestbook** — contact form that posts to a Discord webhook

## Architecture

```
Letterboxd RSS  ──►  scripts/download_rss.py   ──►  data/rss.xml
                                                    data/cleaned_rss.xml
                                                         │
                                                         ▼
                      scripts/extract_history.py  ──►  data/viewing_history.json
                      (walks git history of              (cumulative diary log,
                       data/rss.xml, dedupes              deduped by guid)
                       by guid)
                                                         │
                                                         ▼
                      scripts/compute_stats.py    ──►  data/stats.json
                                                         │
                                                         ▼
                      index.html + assets/js/dashboard.js
                      (Chart.js + vanilla DOM rendering)
```

The key trick: Letterboxd's RSS feed only exposes the 50 most recent diary entries. To build a full history, `extract_history.py` walks every git commit that touched `data/rss.xml` and accumulates unique entries by guid. This means the longer the cron has been running, the deeper the history goes.

## Data pipeline scripts

| Script | Input | Output |
|---|---|---|
| `scripts/download_rss.py` | `https://letterboxd.com/michaellamb/rss/` | `data/rss.xml`, `data/cleaned_rss.xml` |
| `scripts/extract_history.py` | git log of `data/rss.xml` | `data/viewing_history.json` |
| `scripts/compute_stats.py` | `data/viewing_history.json` | `data/stats.json` |

`stats.json` contains every field the dashboard consumes (stat totals, rating distribution, heatmap series, decade buckets, most-rewatched list, highest-rated list, recent activity), so the frontend is a pure static-file consumer — no runtime computation beyond Chart.js rendering and the heatmap grid layout.

## Automated updates

`.github/workflows/download-data-and-assets.yml` runs on a cron schedule (every 6 hours) and can also be triggered manually from the Actions tab. Each run:

1. Fetches the latest RSS feed
2. Runs `extract_history.py` to rebuild the cumulative viewing log from git history (the checkout uses `fetch-depth: 0` so all commits are available)
3. Runs `compute_stats.py` to regenerate `data/stats.json`
4. Commits `data/rss.xml`, `data/cleaned_rss.xml`, `data/viewing_history.json`, and `data/stats.json` if anything changed
5. Triggers `deploy.yml` to republish GitHub Pages

## Running the pipeline locally

```bash
python3 -m venv scripts/venv
source scripts/venv/bin/activate
pip install requests beautifulsoup4 lxml

python3 scripts/download_rss.py
python3 scripts/extract_history.py
python3 scripts/compute_stats.py
```

Then serve the site:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Changing the tracked user

The Letterboxd username is hard-coded in `scripts/download_rss.py`. To point the dashboard at a different account, edit the `url` assignment near the top of that file and re-run the pipeline.

## Contact form

The guestbook posts through a Discord webhook. The webhook URL is injected at deploy time via a GitHub Actions secret (`DISCORD_WEBHOOK_URL`) so the URL never lives in the repo. See the [Discord webhook intro](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks) for setup.

## Related projects

- **[boxd-card](https://github.com/michaellambgelo/boxd-card)** — Chrome extension that generates shareable image cards directly from any Letterboxd profile page (client-side DOM scrape, no backend)
