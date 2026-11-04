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
- `network.html` + `assets/js/network.js` — the Network page (see **Network** below), reads `data/network.json`
- `tags.html` + `assets/js/tags.js` — the Tags page (see **Tags** below), reads `data/viewing_history.json` + `data/tag_categories.json`
- `assets/js/util.js` — shared helpers (`escapeHtml`, `ratingToStars`, `formatShortDate`, `safeUrl`) on `window.LBV`; **loaded before** each page's own script on every page
- `assets/js/nav.js` — the hamburger menu, rendered into `<div data-site-nav>` on every page so the markup lives in one file. Hrefs are **extension-less and relative** (`./`, `rolodex`): GitHub Pages resolves `/rolodex` to `rolodex.html`, and staying relative keeps them working under the `/letterboxd-viewer/` base path. `currentPage()` strips any `.html` before matching `LINKS[].page`, so the active link is right whether you arrive at `/`, `/rolodex`, or `/rolodex.html`. **`python3 -m http.server` does not resolve extension-less paths** — use `npx serve` for local preview or the nav links 404
- `assets/css/dashboard.css` — all styling for every page
- No jQuery, no Handlebars, no Poptrox, no build step
- **Link previews:** each page's `<head>` carries Open Graph + `twitter:card` tags pointing at `assets/images/og/<page>.png` (absolute `https://letterboxd.michaellamb.dev/...` URLs). The cards are rendered by `ruby scripts/generate_og_cards.rb`, which loads the **blog's** renderer (`../michaellambgelo.github.io/scripts/generate_seo_image.rb`, needs ImageMagick) so they match the blog's SEO cards. Run by hand; scrapers cache by image URL, so a changed card needs a new filename

**Pipeline (Python):**
- `scripts/load_archive.py` — CSV loader for the export. `load_diary()` returns rows shaped like the RSS parser; also provides `load_watchlist`, `load_likes`, `load_lists`, `load_profile`, `load_ratings`, `get_export_date`.
- `scripts/download_rss.py` — fetches `https://letterboxd.com/michaellamb/rss/`, writes raw `data/rss.xml` and `data/cleaned_rss.xml` (HTML-cleaned descriptions)
- `scripts/extract_history.py` — merges archive baseline + working-tree `data/rss.xml` deltas **+ RSS-sourced entries carried forward from the previous `viewing_history.json`**, writes `data/viewing_history.json` (sorted by `watchedDate` desc). The carry-forward is load-bearing: RSS is a ~50-entry sliding window, so without it everything between the export date and the oldest item still in the feed silently vanishes (this happened — Jul 9 to Sep 3 2026 went missing). `--backfill-from-git` replays every committed `data/rss.xml` to recover entries that already scrolled out (needs `git fetch --unshallow` in a shallow clone).
- `scripts/compute_network.py` — **run by hand**, not by cron; builds `data/network.json` (see **Network**)
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
| `watchlist` | `{ count, oldestAdded, newestAdded, recentlyAdded[], removedSinceExport, snapshotDate, snapshotSource }` — newest watchlist snapshot minus films with RSS diary entries watched on/after its export date | Watchlist card + section ("As of …") |
| `favoriteFilms` | `[{ link, name, year }, ...]` | Favorites strip (4 films from `profile.csv`) |
| `likedFilms` | `[{ name, year, link, likedDate }, ...]` | (currently unused on frontend) |
| `lists` | `[{ name, slug, url, filmCount, tags, description }, ...]` | Lists section |
| `tagCloud` | `{ tag: count, ... }` | Tag cloud |
| `profile` | `{ username, givenName, location, website, bio, dateJoined }` | Profile header (name + location + joined year; avatar comes from `/stats/live`) |
| `orphanedFilms` | `[{ filmTitle, filmYear, watchedDate, memberRating, reviewText, tags, logCount }, ...]` | "Logged Films Removed from Letterboxd" section |
| `archiveExportDate` | `"YYYY-MM-DD"` | Disclaimer text |

`data/watchlist.json` (also from `compute_stats.py`, not read by the site): `{ snapshotDate, snapshotSource, count, films: [[name, year], …] }`, the current watchlist for the review-stack userscript.

## Development Notes

- **The username is hard-coded** to `michaellamb` in the `url` assignment near the top of `scripts/download_rss.py`. To fork this for another account, edit that line, drop a fresh export under `data/archive/`, and re-run the pipeline.
- **Running the pipeline locally:**
  ```bash
  pip install requests beautifulsoup4  # csv module is stdlib
  python3 scripts/download_rss.py
  python3 scripts/extract_history.py
  python3 scripts/compute_stats.py
  ```
- **Serving locally:** `npx serve -l 8000 .` from the repo root. Not `python3 -m http.server`: it doesn't resolve extension-less paths, so the nav links (`rolodex`, `network`, `tags`) 404. Port 8000 is the one the Worker's `ALLOWED_ORIGINS` permits for the live layer.
- **Heatmap end-date anchor:** `dashboard.js` renders a 52-week window ending on the later of `dateRange.latest` or today. This means even if the cron falls behind, the grid still extends to the current week (with empty cells for missing data) rather than truncating at the last data point.
- **Heatmap dates are local-time strings** (`formatLocalDate()`), never `toISOString()`: the UTC conversion shifted cells by a day for anyone east of Greenwich (fixed in 49453cf).
- **Cron health matters:** if the workflow stops successfully committing updated `data/stats.json` and `data/viewing_history.json`, the site goes stale silently. When investigating "missing recent data", first check `gh run list --workflow=download-data-and-assets.yml` — the data is almost always the problem, not the frontend.
- **Refreshing the archive:** export from Letterboxd, drop the new `letterboxd-michaellamb-YYYY-MM-DD-HH-MM-utc/` folder under `data/archive/`, optionally delete the older one, and re-run `extract_history.py` + `compute_stats.py`. The loader picks the lexicographically newest folder.
- **Watchlist-only exports:** Letterboxd can export just the watchlist as `watchlist-<user>-YYYY-MM-DD-HH-MM-utc.csv`. Drop it straight into `data/archive/` (not inside a folder). `load_archive.load_watchlist_snapshot()` uses whichever is newer by the timestamp in the name, this file or the full archive's `watchlist.csv`, so a quick watchlist refresh doesn't need a full re-export. Like the archive, the cron doesn't commit it, so commit the CSV by hand.
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

## Network (`network.html` + `scripts/compute_network.py`)

A third page: the shape of my Letterboxd network (who I follow, who follows me,
who is in JXN Film Club, and who among them follow each other), **anonymized**:
nobody is named on the page or in the published data. Static, like the stats
page: no Worker and no Letterboxd requests.

**Why anonymous:** Letterboxd's terms bar exporting other members' content
and automated extraction. So the export keeps handles only, the handles never
leave my machine, and what's published is an unlabelled graph. Don't add
names, avatars, counts or profile links back.

**Where the data comes from:** Letterboxd has no API for this, the data export
has no followers/following file, and logged out only page 1 of a follow list
loads (`/page/2/` onward and every `/by/…` sort hit the Cloudflare challenge).
So the graph comes from a **one-time export in my logged-in browser**:
`scripts/userscripts/letterboxd-network-export.user.js` (Tampermonkey). On any
people table it adds a button that follows the page's own "Next" link 2–4 s
apart (it never builds URLs), adds each page's rows to the live table, and
downloads `letterboxd-<owner>-<list>-<date>.json` (schema
`letterboxd-network-export/2`: `people` is `[{ handle }]` only; `/1` files from
before 2026-11-03 also carried names, avatars and counts and are still read,
handles only). If a page fails it exports what it has, marked
`complete: false`. **Don't crawl Letterboxd from scripts or CI for this.**

**Refreshing (no cron, on purpose; the inputs only change when you re-export):**
1. Run the userscript on `/michaellamb/followers/` and `/michaellamb/following/`.
2. Drop the JSON files into `data/network/`. The newest file per (owner, list)
   wins, so old ones can stay. **`data/network/` is gitignored**: those files
   hold real handles and must never be committed (they were until 2026-11-03,
   so older commits still contain them).
3. `python3 scripts/compute_network.py`, then commit `data/network.json` only.
   Re-run it on its own to pick up new club members.

**JXN tags** come from `../jxnfilmclub/data/members.json` (`--members` to
override), matched case-insensitively on the Letterboxd handle. **Only the
handle is read**, and only to set a node's `jxn` flag: no handle, member
name, id or pronoun reaches `network.json` (tests enforce this). This page sits outside the club's privacy policy:
it's my own public Letterboxd graph plus a tag for people I know from the club.

**Mutuals = followers ∩ following.** The export has no follow-state field on
purpose: Letterboxd's client JS toggles the Follow/Unfollow buttons, so only
rows on the first (hydrated) page are right. The first export had 129 wrong
values.

**Edges between people (optional):** run the userscript on another member's
"followers you know" view (`/<handle>/followers-you-know/`, list kind
`followers-you-know`; `letterboxd-jxn-club.user.js` walks you through the club
members). Every person listed is someone I follow who follows
that member, so `compute_network.py` turns any export whose owner isn't me
into edges `person -> owner`. Someone's plain followers page works the same
way, and their **following** page gives `owner -> person` (the userscript
button shows up on every people table, so this is handled rather than
silently reversed). Edges only count when both ends are in my
network. `network.js` draws them as chords and the legend gains a row; with
no such exports `edges` is `[]` and nothing is drawn.

**`network.json`:** `{ owner, generatedAt, exportedAt, counts: { followers,
following, mutual, followerOnly, followingOnly, jxn, jxnMutual, edges },
nodes: [{ relation: "mutual"|"follower"|"following", jxn }], edges: [[from,
to]] }`, where edges are indices into `nodes`. `nodes` is **shuffled on every
run** (`random.SystemRandom`), because alphabetical order could be matched
against my public follow lists. Residual risk, accepted: JXN nodes plus their
edges could be partly re-identified by someone matching the public club roster
against public follow lists.

**Page:** stat tiles and a fixed radial SVG (me at the centre; rings from
inner to outer are mutual, followers only, following only; club members drawn
larger with a white outline, spread in file order rather than grouped, since
grouping overlapped them). Everyone/Followers/Following/Mutual tabs (Followers
and Following include mutuals, like Letterboxd's tabs) and a "JXN only" toggle
dim the dots outside the selection. Dots have a relationship tooltip and no
link. There is no people list. Tests: `scripts/test_compute_network.py`.

## Tags (`tags.html` + `assets/js/tags.js`)

Pick diary tags, get every entry logged with them. Fully static: it reads the
already-published `data/viewing_history.json` directly, so there's no pipeline
step and nothing to regenerate. New tags show up as soon as the cron updates
the history.

- **Categories** come from `data/tag_categories.json`, **hand-maintained**:
  ordered `categories[]` of `{ id, label, icon, tags[] }` (Streaming service,
  Person, In theaters, MoviePass, IMAX). Any tag no category lists falls into a
  generated **Other** group (collapsed by default), so a new tag never vanishes;
  to file it, add it to a category. A tag listed twice goes to the first.
  `icon` is a Font Awesome **5** name.
- Tags are matched **lowercased** (`MoviePass` = `moviepass`). Within a
  category, chips sort by use count.
- **Untagged:** a last "No tags" group holds one pseudo-tag for entries with
  zero tags, which no real chip can reach. Its key is `(untagged)` (the
  parentheses keep it from colliding with a real tag named "untagged"), so a
  link reads `#tags=(untagged)`. It combines with real tags under Any; under All
  it can't match anything, and the summary line says so.
- **Any / All** toggle (shown with 2+ tags selected). Selection and mode live in
  the hash (`#tags=in%20theaters,imax&match=all`) so a filtered list can be
  linked; `+` for spaces also parses.
- Summary line: logs, distinct films (title + year), average rating, date span.
  Sorts: newest, oldest, highest rated, title.
- The Person tags are my own diary tags, already public on my Letterboxd
  profile; the page adds nothing beyond what `viewing_history.json` already
  publishes.

## Userscripts (`scripts/userscripts/`)

Tampermonkey scripts that run in my logged-in browser on letterboxd.com. They
aren't part of the site and nothing deploys them. They exist because the useful
Letterboxd data (follow lists, the activity feed) sits behind login and the
Cloudflare challenge. Rules for all of them: drive Letterboxd's own controls
(Next links, "Load older activity", the Like button) at a human pace, never
build URLs or call endpoints directly, and never crawl from scripts or CI.

- `letterboxd-network-export.user.js` exports a people list as JSON for the
  Network page (see **Network**).
- `letterboxd-jxn-club.user.js` adds a "JXN" panel on every letterboxd.com page:
  the club members with a linked Letterboxd handle, from the club's public roster
  `https://join.jxnfilm.club/members` (handles only; fetched with
  `GM_xmlhttpRequest` so Letterboxd's CSP can't block it, cached a day),
  each with profile and followers-you-know links, plus Start/Next to work
  through the not-yet-done members. Opening a member's followers-you-know page
  marks them done (untick by hand). The list follows the club roster, so it
  includes members who aren't in my network (their exports add no edges).
- `letterboxd-review-stack.user.js` runs on `/activity/` and turns the feed's
  unliked reviews into a swipe stack (→/swipe right = like via the real Like
  button, ← = dismiss, W = add to watchlist, Z = undo, Esc = close). The
  watchlist button only appears when the poster's watch button says you haven't
  watched the film. It drives the poster's own "⋯" menu, finds the item by its
  text, and reopens the menu to confirm "Remove from watchlist" before showing ✓.
  Watchlist state isn't in the poster markup (and `/ajax/letterboxd-metadata/` is
  only a csrf ping), so "✓ On your watchlist" comes from **`data/watchlist.json`**
  on letterboxd.michaellamb.dev: the newest export minus films logged since,
  written by `compute_stats.py` (and committed by the 6-hourly cron) as `[name,
  year]` pairs, matched to cards on a normalized title + year. The script caches
  it 6 h (a failed load is retried on the next card, at most every 20 s, rather
  than sticking until reload) and unions in films it added itself since that export; films added on
  Letterboxd directly show up after the next export. The menu is only opened to
  *add*. Its icon sits inside the poster's film link, so that click cancels the
  link's default action (v1.3 clicked the link itself and navigated away).
  Spoiler reviews are blurred only when the poster says you haven't watched the
  film (hidden while unknown). Pointer capture starts only once a horizontal
  swipe begins: capturing on pointerdown retargets taps to the card, which broke
  tap-to-reveal and the watchlist button in v1.1. It remembers what you've been
  through as **contiguous activity-id ranges** in Tampermonkey storage. Ids
  only increase and the stack walks the feed newest-first, and a range only
  grows over the fully-decided prefix, so a still-queued review is never marked
  seen. Once the feed's end has been reached (`feedEndId`), entering the bottom
  range means "caught up" with no more paging. The markup it depends on is
  listed in its header comment (read from the live feed 2026-11-03). If
  Letterboxd changes it, that list is where to start.

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
- **Sorting: a `<select>` next to the filter box** (A–Z default, recently
  active, least recently active, highest rated, most rewatched, most active in
  30 days; the last two come from **History** below), persisted in
  `localStorage['rolodex:sort']`. All client-side in `rolodex.js`: `applySort()`
  re-appends the existing card nodes (grid order = DOM order, no re-render).
  Film-derived keys stream in per card, so film-based sorts apply on selection
  with whatever has landed and re-apply once at stream end — never per card,
  which would make cards jump. Profiles with no diary entries sink in every
  direction; ties break on the same first-name collation as the Worker's
  `byFirstName`. Non-A–Z sorts hide the rail *and* collapse its 150px grid
  column (`.rolodex-layout--no-rail`), or cards would auto-place into the empty
  track.
- **Feed cache expiry is synchronized, not rolling.** All per-profile
  `caches.default` entries get filled by whichever request finds them empty, so
  they expire together ~15min later and the next visitor pays the full cold cost
  (~4-6s at 63 profiles). Streaming is what makes that acceptable; if it ever
  stops being so, serve `snapshot:<user>` immediately and refresh under
  `ctx.waitUntil` (stale-while-revalidate) rather than raising `CONCURRENCY`.
- **History (`history:<user>`):** every diary entry the Worker sees in a
  member's RSS, so sorts aren't limited to the last four. `loadWatches` now
  parses the *whole* feed on a cache miss, merges it with `mergeHistory()`
  (dedupe by RSS guid number first, like `extract_history.dedupe_rss`, newest
  copy wins, first-seen day kept), writes **only when something changed**, and
  attaches a small `history: { since, logged, rewatches, last30 }` summary to
  the cached/snapshot payload, so enrichment costs no extra KV read. `since` is
  the oldest watched date in the first merge and never moves earlier: counts
  mean "seen since then", not lifetime. Capped at the newest 1,000 entries per
  member; deleted with the profile. That's indefinite server-side retention of
  public RSS for everyone in the rolodex; the cap and delete-on-removal are the
  bounds. The card shows "N logged · R rewatches · X in 30 days · since <date>"
  so the history sorts explain themselves.
- **Cron (`0 */3 * * *`):** without it history only grows when someone visits,
  and entries silently scroll out of the ~50-item window. Each run refreshes a
  fixed 1/8 of the rolodex (`cronSlice`, by 3-hour slot), so every member is read
  daily and no run makes more than ~1/8 of the feed requests. It goes through
  `loadWatches`, so a member a visitor just loaded is a cache hit. Local test:
  `npx wrangler dev --test-scheduled` then `curl "localhost:8788/__scheduled?cron=0+*/3+*+*+*"`.
- **History's read-merge-write is a race, on purpose.** A page visit and the
  cron (or two colos; `caches.default` is per-colo) can merge the same member at
  once and one write can win. Unlike jxnfilmclub's `members:all` rule, that's
  acceptable here: the merge is an idempotent union over a feed that's re-read
  every fetch, so anything a lost write dropped comes back on the next fetch
  while it's still in the window, which the daily cron guarantees.
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
- `scripts/test_extract_history.py` — `python -m pytest scripts/`. Covers
  `extract_history.py`'s parsing and the archive + RSS + carry-forward merge
  against a tmp data dir. Both suites run in `.github/workflows/tests.yml`.
- **Icons are Font Awesome 5.15.4** (vendored). FA6 names (`fa-xmark`,
  `fa-chart-simple`) render as blank boxes.
