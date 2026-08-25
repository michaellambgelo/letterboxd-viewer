# Handoff: "movies that feel like August" shareable graphic

Working brief for continuing this on a local machine. Started in a Claude Code
web session where TMDB was unreachable (see **Blocked upstream** below).

## The ask

A shareable poster graphic titled exactly:

> **movies that feel like August**

Eight films, listed below in the order the user specified. Posters fetched from
TMDB. Nothing else from the earlier candidate list is included — *The Wise Kids*
was considered and explicitly cut.

## Selection criteria

August as: the end of summer, the beginning of school, and a time for new
connections as well as revisiting old ones. Mood-weighted, with literal
late-summer setting as a bonus. Drawn only from films the user has already
watched — no watchlist picks.

## The eight films

Ratings are the user's current Letterboxd ratings; log counts and dates are from
`data/archive/letterboxd-michaellamb-2026-07-09-02-44-utc/diary.csv`.

| # | Film | Year | Rating | Logs | Note |
|---|------|------|--------|------|------|
| 1 | Call Me by Your Name | 2017 | ★5 | 8 | **First film in the entire diary** — watched 2017-08-05, the only 2017 entry |
| 2 | Aftersun | 2022 | ★5 | 17 | Most-rewatched film in the diary |
| 3 | Luca | 2021 | ★5 | 5 | Ends with one boy on a train to school, one staying behind |
| 4 | Everybody Wants Some!! | 2016 | ★4.5 | 1 | Set across the last three days of August 1980 before classes |
| 5 | Before Sunset | 2004 | ★5 | 1 | Nine years later, one afternoon, a plane to catch |
| 6 | Lady Bird | 2017 | ★4 | 3 | Watched 2021-08-22 — an actual August watch |
| 7 | 20th Century Women | 2016 | ★5 | 1 | A house of people assembling into a family |
| 8 | Past Lives | 2023 | ★4.5 | 1 | In-yun across 24 years |

### The user's own review text (from `reviews.csv`)

Usable as pull quotes on the graphic. Verbatim.

- **Call Me by Your Name** — "this film manages to be gorgeous and joyful and repentant and melancholic"
- **Aftersun** — "I miss... too many people" (2026-06-19, the most recent of 17 logs)
- **Luca** — "ends with a bittersweet goodbye between two friends... A perfect family summer film"
- **Everybody Wants Some!!** — "watched with david & tyler"
- **Before Sunset** — "i wish i was juile delpy" *(sic — user's own typo, keep or fix as they prefer)*
- **Lady Bird** — "this movie makes me feel seen"
- **20th Century Women** — "Watched with Lydia"
- **Past Lives** — "beautiful / watched with mary"

## Blocked upstream (why this moved machines)

The web session's egress policy returned 403 on CONNECT for every host needed:

```
api.themoviedb.org:443    connect_rejected   gateway answered 403 to CONNECT
image.tmdb.org:443        connect_rejected   gateway answered 403 to CONNECT
www.themoviedb.org:443    connect_rejected   gateway answered 403 to CONNECT
letterboxd.com:443        connect_rejected   gateway answered 403 to CONNECT
a.ltrbxd.com:443          connect_rejected   gateway answered 403 to CONNECT
```

There is also no TMDB API key in the environment — one is needed locally.

## Poster constraint — read before designing

A published Artifact runs under a CSP that permits **no external hosts except
Google Fonts**. Hotlinking `image.tmdb.org` will render broken images.

Posters must be **downloaded and embedded as base64**. Two rules that bite:

- Store them as **bare base64 with no `data:` prefix** — the artifact runtime
  adds the wrapper, and a stored data-URI double-wraps into a broken image.
- Keep each image under **~70 KB**. The whole document republishes on every
  save (16 MiB cap), and entries over 2 MiB are silently dropped. Downsample
  with `sips -Z 600 poster.jpg` on macOS.

`w342` is the right TMDB poster size here — roughly 342×513, small enough to
stay under the budget at reasonable JPEG quality.

## Suggested local steps

1. Export a TMDB key: `export TMDB_API_KEY=...`
2. Resolve each title to a TMDB id via `/3/search/movie` with the year above as
   a disambiguator. *Luca* and *Past Lives* both have same-titled collisions —
   verify by year.
3. Pull `poster_path`, fetch `https://image.tmdb.org/t/p/w342<poster_path>`,
   downsample, base64-encode.
4. Build the graphic. The `design` skill is the intended tool — it produces a
   multi-artboard canvas published as an Artifact, and its seeding helper takes
   `--image` arguments that handle the bare-base64 storage correctly.

## Open design questions

Not yet settled with the user — worth asking before building:

- **Aesthetic direction.** Nothing chosen. Candidate axes discussed but not
  decided: Letterboxd-native dark; warm sun-bleached late-summer editorial;
  high-contrast repertory-cinema one-sheet.
- **Format.** Square (1080×1080) vs. 4:5 portrait (1080×1350) vs. a taller
  poster. Eight films with posters needs vertical room; 4:5 is the most
  shareable format that fits comfortably.
- **Whether ratings and log counts appear on the graphic**, or just titles.

## Data sources in this repo

- `data/archive/letterboxd-michaellamb-2026-07-09-02-44-utc/` — diary, ratings,
  reviews CSVs (the historical baseline)
- `data/viewing_history.json` — merged diary, 2,563 entries through 2026-08-23
- `data/rss.xml` — recent feed; carries `tmdb:movieId` for recent entries only
  (none of these eight appear in the current window)
