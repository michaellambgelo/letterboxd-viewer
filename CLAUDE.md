# Letterboxd Viewer — CLAUDE.md

## Project Goal

Personal Letterboxd stats dashboard rendered as a static site on GitHub Pages. A Python pipeline runs on cron, merges a Letterboxd export archive (historical baseline) with the public RSS feed (delta for new entries), and pre-computes every field the frontend displays into `data/stats.json`.

Single-user (hard-coded to `michaellamb` in `scripts/download_rss.py`). The frontend is a static consumer of `stats.json`, plus an optional **live enrichment layer** fetched from the rolodex Worker's `GET /stats/live` (see **Live enrichment** below) — the static render is complete on its own and every live render degrades to it when the Worker is unreachable.

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
- `rolodex.html` — the curated-profiles page (see **Rolodex** below)
- `assets/js/dashboard.js` — all rendering logic (data loading via `fetch('data/stats.json')`, heatmap layout, Chart.js setup, contact form handler)
- `assets/js/rolodex.js` — rolodex card rendering, reads the Worker's `/rolodex`
- `assets/js/util.js` — shared helpers (`escapeHtml`, `ratingToStars`, `formatShortDate`, `safeUrl`) on `window.LBV`; **loaded before** dashboard.js/rolodex.js on both pages
- `assets/js/nav.js` — the hamburger menu, rendered into `<div data-site-nav>` on both pages so the markup lives in one file. Hrefs are **extension-less and relative** (`./`, `rolodex`): GitHub Pages resolves `/rolodex` to `rolodex.html`, and staying relative keeps them working under the `/letterboxd-viewer/` base path. `currentPage()` strips any `.html` before matching `LINKS[].page`, so the active link is right whether you arrive at `/`, `/rolodex`, or `/rolodex.html`. **`python3 -m http.server` does not resolve extension-less paths** — use `npx serve` for local preview or the nav links 404
- `assets/css/dashboard.css` — all styling for both pages
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
| `profile` | `{ username, givenName, location, website, bio, dateJoined }` | Profile header (name + location + joined year; avatar comes from `/stats/live`) |
| `orphanedFilms` | `[{ filmTitle, filmYear, watchedDate, memberRating, reviewText, tags, logCount }, ...]` | "Logged Films Removed from Letterboxd" section |
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
- **Orphaned (removed) films:** a Letterboxd export natively ships an `orphaned/` subfolder (`diary.csv`, `reviews.csv`, `comments.csv`) holding entries whose film was later **removed from Letterboxd's database** — these rows have an empty `Letterboxd URI` and are kept *out* of the main `diary.csv`/`watched.csv`, so they never enter the main stats. `load_archive.load_orphaned()` reads that folder and `compute_stats.compute_orphaned_films()` emits `orphanedFilms` for the "Logged Films Removed from Letterboxd" section (dedicated, not counted in lifetime totals). RSS can't reveal removals (it's a ~50-item recent window), so the export is the only source. The sibling `deleted/` subfolder (entries the user deleted, valid URIs) is intentionally unused. The archive CSVs aren't committed by the cron workflow — commit a re-exported archive folder by hand so the cron's `compute_stats.py` re-reads it.
- **Stale artifacts to ignore:** `docs/letterboxd-viewer-presentation.md` is leftover from the old Last Four Watched direction and is not part of the deployed site. (`worker/` used to be listed here too — it is now live; see **Rolodex**.)

## Live enrichment (`GET /stats/live` on the rolodex Worker)

The dashboard layers live data from the Worker over the static render. The
endpoint returns the owner's **whole** recent RSS feed (~50 items, uncapped)
parsed in extended mode — every rolodex film field plus `liked`
(`letterboxd:memberLike`) and, for `letterboxd-review-*` guids only, `review`:
the description flattened to plain text (paragraph/blockquote/br → newlines,
CDATA and tags stripped) so the client renders it with `white-space: pre-line`
and never touches review HTML. Joined with the profile avatar (same
`avatar:<user>` KV cache the rolodex uses). Cached 15 min in `caches.default`
under its own key (the rolodex cache for the same username holds only the
parsed last four), with a no-TTL KV snapshot (`stats:live:v1`) served
`stale: true` when Letterboxd is unreachable. Username is hard-coded
(`STATS_USERNAME`), mirroring the pipeline.

What the frontend does with it (all in `dashboard.js`, kicked off before the
`stats.json` fetch and applied after the static render — a slow or failed
Worker call never blocks or breaks the page):

- **Profile header**: live avatar swaps in over the decal; name/location/joined
  come from `stats.json`'s `profile` block and render even without the Worker.
- **Recent Activity**: re-rendered from the live feed with posters, like
  hearts, and a "live · Nm ago" badge (`cached` when `stale`), plus a
  past-7-days / this-month count line.
- **Latest Reviews**: a section that only exists when live data arrives —
  poster, stars, plain-text review clamped to 6 lines, "Read on Letterboxd".
- **"+N since last update"** on the Logs stat card: live entries not yet in
  `stats.json`, computed against `recentActivity` on the same
  `(filmTitle, watchedDate)` composite key the pipeline dedupes on. Lifetime
  scope only — the year selector hides it via `liveState`.

Local dev: same `?api=` override as rolodex.js, honored only on localhost
(`http://localhost:8000/index.html?api=http://localhost:8787` against
`npm run dev` in `worker/`).

## Rolodex (`rolodex.html` + `worker/`)

A second page: a curated shortlist of Letterboxd members, each card showing that
person's **Last Four Watched**. Entirely separate from the stats pipeline —
`scripts/*.py`, `stats.json`, and both workflows are untouched by it.

**Why there is a Worker at all:** letterboxd.com serves RSS with **no CORS
headers**, so the browser cannot fetch anyone's feed directly. (Same wall that
made `boxd-card` a Chrome extension.) Everything must be fetched server-side.

- `worker/index.js` — Worker at `rolodex.michaellamb.dev`. KV is the source of
  truth for the curation; the Worker is also a live read-through proxy for each
  profile's feed, so cards are fresh within minutes rather than waiting on cron.
- **The page loads over an NDJSON stream** (`GET /rolodex/stream`). Line 1 is a
  `meta` object carrying the whole curated list — one KV read, no network — so
  every card renders with its name/note/tags before any feed resolves. Then one
  `profile` line per person **in completion order**, matched to its card by
  username; a slow feed delays one card, not the page. `GET /rolodex` still
  returns the whole payload at once and is both the client's fallback and the
  convenient thing to curl. Measured in production at 63 profiles: meta at
  ~0.17s, last profile at ~1.15s warm. Nothing in front of the Worker buffers
  the stream (`Cache-Control: no-store`, `X-Accel-Buffering: no`) — verified,
  since buffering would silently defeat the whole design.
- **Page navigation: a filter box and an A-Z rail.** Both work off `data-search`
  and `data-letter`, stamped onto each card in `cardShell()` from the **meta
  line** — so filtering is live before any feed resolves and never races the
  streamed fill. (Searching film titles *would* race, since those arrive later.)
  The full A-Z always renders; letters with no match are genuinely `disabled`,
  recomputed against the *filtered* set so a jump can't land on a hidden card.
  Layout reuses the dashboard's `.scope-layout` sticky-rail idea; below 900px the
  rail becomes a horizontal strip, which needs `min-width: 0` on the rail — grid
  items default to `min-width: auto` and the nowrap strip would otherwise drag
  the layout past the viewport and defeat its own `overflow-x`. Letter jumps are
  intentionally instant: the page runs to ~12,000px and a smooth scroll took
  ~1.5s of unreadable animation.
- **Feed cache expiry is synchronized, not rolling.** All per-profile
  `caches.default` entries get filled by whichever request finds them empty, so
  they expire together ~15min later and the next visitor pays the full cold cost
  (~4-6s at 63 profiles). Streaming is what makes that acceptable; if it ever
  stops being so, serve `snapshot:<user>` immediately and refresh under
  `ctx.waitUntil` (stale-while-revalidate) rather than raising `CONCURRENCY`.
- **KV keys:** `rolodex:v1` is the whole curated list in a single key, so
  `GET /rolodex` is one read. (Contrast `now-store`, which is key-per-entry only
  because it needs per-key TTLs.) `snapshot:<user>` and `avatar:<user>` are
  derived caches, safe to delete.
- **Display order is derived, never stored.** `readProfiles()` sorts by first
  name (`byFirstName`, `Intl.Collator` — case- and accent-insensitive, tie-broken
  on full label then handle) on every read, so the public page and the admin list
  can't disagree and no migration is needed when the rule changes. There is
  deliberately no manual reorder: renaming someone is what moves their card.
- **Resilience:** every successful feed fetch writes `snapshot:<user>`. If
  Letterboxd is unreachable or a feed stops parsing, that profile serves its last
  known-good four flagged `stale: true` rather than failing the whole response.
- **Parsing gotcha:** a member's RSS also contains `letterboxd-list-*` items for
  published lists. Only diary entries carry `<letterboxd:watchedDate>` — filter on
  that or a list renders as a bogus film. Titles need entity-decoding.
- **Auth:** Cloudflare Access is **path-scoped to `/admin`**, not the whole
  hostname, because `GET /rolodex` must stay public. The Worker independently
  verifies the `Cf-Access-Jwt-Assertion` signature, so a missing Access app fails
  closed. Local dev uses `npm run dev`, which passes `ADMIN_DEV_BYPASS` on the
  command line — never committed as a var.
- `worker/SETUP.md` is the one-time runbook (KV, deploy, Access, verification).
- `worker/test.mjs` — `npm test`, no dependencies. Covers the regex feed parser
  against a fixture plus a smoke test against the committed `data/rss.xml`.
- **Icons are Font Awesome 5.15.4** (vendored). FA6 names (`fa-xmark`,
  `fa-chart-simple`) render as blank boxes.
