# Letterboxd Viewer Sequence Diagrams

How the two pages load (stats dashboard + rolodex), how the rolodex Worker
enriches profiles, how the admin curates them, and how the cron pipeline
refreshes the stats data.

## Runtime: stats dashboard (`index.html`)

```mermaid
sequenceDiagram
    participant User
    participant Browser
    participant Index as index.html
    participant Shared as util.js + nav.js
    participant Dashboard as dashboard.js
    participant ChartJS as Chart.js (CDN)
    participant Stats as data/stats.json
    participant Discord as Discord Webhook

    %% Initial page load
    User->>Browser: Open Letterboxd Viewer
    Browser->>Index: GET / (GitHub Pages)
    Index->>ChartJS: <script chart.js@4>
    Index->>Shared: <script util.js> then <script nav.js>
    Note over Shared: util.js exposes window.LBV<br/>(escapeHtml, ratingToStars, …)<br/>nav.js renders the hamburger<br/>into <div data-site-nav>
    Index->>Dashboard: <script dashboard.js>
    Dashboard->>Stats: fetch('data/stats.json')
    Stats-->>Dashboard: JSON (pre-computed stats)
    Dashboard->>Browser: renderStatCards, renderHeatmap, renderCharts, renderLists
    Browser-->>User: Show dashboard

    %% Guestbook submission
    User->>Browser: Fill guestbook form, click Send
    Browser->>Dashboard: submit event
    Dashboard->>Discord: POST webhookUrl (embed payload)
    Note over Dashboard,Discord: webhookUrl comes from<br/>window.DISCORD_WEBHOOK_URL,<br/>injected at deploy time
    Discord-->>Dashboard: 204 No Content
    Dashboard->>Browser: showToast('Message sent')
    Browser-->>User: Success toast
```

## Runtime: rolodex (`rolodex.html`, NDJSON streaming)

Letterboxd serves RSS with **no CORS headers**, so friends' feeds can never be
fetched browser-side — everything goes through the Worker at
`rolodex.michaellamb.dev`. The page loads over a stream: cards render from the
curated list before a single feed has resolved, then fill in as profile lines
arrive in **completion order**.

```mermaid
sequenceDiagram
    participant User
    participant Rolodex as rolodex.js
    participant Worker as letterboxd-rolodex Worker
    participant KV as Cloudflare KV

    User->>Rolodex: Open /rolodex
    Rolodex->>Rolodex: renderPlaceholders()
    Rolodex->>Worker: GET /rolodex/stream
    Worker->>KV: get rolodex:v1 (one read)
    KV-->>Worker: curated list (sorted by first name on read)
    Worker-->>Rolodex: line 1: {"type":"meta", profiles:[…]}
    Rolodex->>Rolodex: draw ALL card shells<br/>(name, note, tags, data-search, data-letter)
    Note over Rolodex: Filter box + A-Z rail are live now —<br/>they only read meta-line data,<br/>so they never race the fill

    loop per profile, ≤6 concurrent, completion order
        Worker->>Worker: enrich(profile)  — see next diagram
        Worker-->>Rolodex: {"type":"profile", username, films, avatar, stale}
        Rolodex->>Rolodex: fillCard(matched by username)
    end
    Worker-->>Rolodex: stream closes
    Rolodex->>Rolodex: settlePending()<br/>(anything unresolved → empty, stale)

    alt stream unsupported or fails
        Rolodex->>Worker: GET /rolodex (whole payload)
        Worker-->>Rolodex: JSON, all profiles at once
    end

    %% Navigation
    User->>Rolodex: type in filter / click a letter
    Rolodex->>Rolodex: applyFilter(): hide non-matching cards,<br/>disable letters with no visible card
    Rolodex->>Rolodex: jumpToLetter(): instant scrollIntoView
```

## Worker: enriching one profile

Per-profile caching is what shields letterboxd.com — each feed is fetched at
most once per 15 minutes no matter how many visitors arrive. Snapshots make a
failing feed degrade to "last known good, flagged stale" instead of a blank card.

```mermaid
sequenceDiagram
    participant Worker as enrichmentFor(profile)
    participant Cache as caches.default (15min TTL)
    participant KV as Cloudflare KV
    participant LB as letterboxd.com

    par films
        Worker->>Cache: match rss/<username>
        alt cache hit
            Cache-->>Worker: parsed last-four payload
        else miss
            Worker->>LB: GET /<username>/rss/
            alt 200 OK
                LB-->>Worker: RSS XML
                Worker->>Worker: parseFeed(): keep only items with<br/>letterboxd:watchedDate (skip lists),<br/>decode entities, take first 4
                Worker->>Cache: put (15min)
                Worker->>KV: put snapshot:<username> (no TTL)
            else error / non-200
                Worker->>KV: get snapshot:<username>
                KV-->>Worker: last known-good four → stale: true
            end
        end
    and avatar
        Worker->>KV: get avatar:<username>
        alt miss
            Worker->>LB: GET /<username>/ (profile page)
            Worker->>Worker: HTMLRewriter: og:image content
            Worker->>KV: put avatar:<username> (24h TTL)
        end
    end
```

## Admin: curating the rolodex (`/admin`, Cloudflare Access)

The hostname is mixed: `GET /rolodex*` is public, only `/admin*` sits behind
Access (path-scoped app, One-time PIN). The Worker also verifies the Access JWT
itself, so a missing or misconfigured Access app fails closed.

```mermaid
sequenceDiagram
    participant Admin as Michael's browser
    participant Access as Cloudflare Access
    participant Worker as letterboxd-rolodex Worker
    participant KV as Cloudflare KV
    participant LB as letterboxd.com

    Admin->>Access: GET /admin
    Access-->>Admin: 302 → One-time PIN login
    Admin->>Access: complete PIN
    Access->>Worker: forward request + Cf-Access-Jwt-Assertion
    Worker->>Worker: verify JWT signature against team certs,<br/>check aud / iss / exp
    Worker-->>Admin: admin UI (inline HTML)

    %% Preview before save
    Admin->>Worker: POST /admin/api/preview {username}
    Worker->>LB: GET /<username>/rss/ (uncached probe)
    Worker-->>Admin: films + avatar, or 404 if no such user

    %% CRUD (username is the KV key — immutable; delete + re-add to fix)
    Admin->>Worker: POST | PUT | DELETE /admin/api/profiles[/username]
    Worker->>KV: read-modify-write rolodex:v1
    Note over Worker,KV: DELETE also removes snapshot:<user><br/>and avatar:<user> so re-adding starts clean
    Worker-->>Admin: updated entry / 204
    Note over Admin: Display order is never stored —<br/>readProfiles() sorts by first name,<br/>so renaming someone moves their card
```

## Data pipeline (cron, every 6 hours — stats dashboard only)

The rolodex does not touch this pipeline; it is entirely Worker + KV.

```mermaid
sequenceDiagram
    participant Cron as GitHub Actions cron
    participant Download as download_rss.py
    participant Letterboxd as Letterboxd RSS
    participant Archive as data/archive/<export>/
    participant Extract as extract_history.py
    participant History as viewing_history.json
    participant Compute as compute_stats.py
    participant Stats as stats.json
    participant Deploy as deploy.yml

    Cron->>Download: python3 scripts/download_rss.py
    Download->>Letterboxd: GET letterboxd.com/michaellamb/rss/
    Letterboxd-->>Download: RSS XML (≤50 recent items)
    Download->>Download: Clean HTML descriptions
    Download->>Download: Write data/rss.xml + data/cleaned_rss.xml

    Cron->>Extract: python3 scripts/extract_history.py
    Extract->>Archive: load_diary() — full diary baseline
    Archive-->>Extract: all entries up to export date
    Extract->>Extract: Read current data/rss.xml
    Extract->>Extract: Merge — archive wins on overlap,<br/>RSS adds only entries newer than<br/>export date − 1 day<br/>key = (filmTitle, filmYear, watchedDate)
    Extract->>History: Write data/viewing_history.json

    Cron->>Compute: python3 scripts/compute_stats.py
    Compute->>History: Read viewing_history.json
    Compute->>Archive: watchlist, likes, lists, favorites,<br/>profile, orphaned/
    Compute->>Stats: Write data/stats.json<br/>(lifetime + byYear slices)

    Cron->>Cron: git add data/ && commit && push
    Cron->>Deploy: workflow_dispatch (deploy.yml)
    Deploy->>Deploy: Inject DISCORD_WEBHOOK_URL into index.html
    Deploy->>Deploy: Publish to GitHub Pages
```

## Key ideas

- **Archive + RSS merge.** Letterboxd's RSS only exposes the ~50 most recent
  diary entries. The full history comes from a Letterboxd export archive under
  `data/archive/`; RSS layers on only entries logged **after** the export date.
  The archive wins on overlap, which also lets its deletions stick. (An earlier
  design reconstructed history by walking every git commit of `data/rss.xml`;
  the archive replaced that.)
- **Two data planes.** The stats dashboard is fully static — pre-computed JSON,
  refreshed by cron, no runtime backend. The rolodex is fully live — Worker +
  KV, no cron involvement. Neither depends on the other; they share only the
  static shell (CSS, `util.js`, `nav.js`).
- **Streaming beats caching harder.** All per-profile cache entries are filled
  by whichever request finds them empty, so they expire together ~15min later.
  Rather than making the unlucky cold visitor wait on the slowest of 60+ feeds,
  the stream gives them every card instantly and fills posters as feeds resolve.
