# Prompt for a new session: "movies that feel like September"

Paste the block below into a fresh chat. Edit the **What September means to me**
line first — that sentence is the entire brief, and it should be yours, not a
guess. Everything else is scaffolding that worked for the August run.

---

I have a Letterboxd stats repo at `michaellambgelo/letterboxd-viewer`. Scan my
full viewing history — the export archive under
`data/archive/letterboxd-<user>-<date>/` (`diary.csv`, `ratings.csv`,
`reviews.csv`, `watched.csv`) plus the RSS deltas in `data/rss.xml` and the
merged `data/viewing_history.json` — and find me 5–10 movies that feel like
**September**.

**What September means to me:** autumn actually arriving, school in full swing
rather than just starting, routine and structure closing back in, the first cool
evenings, and a turn inward after summer's openness — the year starting to look
backward.

**Rules:**

- Only films I've already logged. Nothing from my watchlist.
- Weight mood over literal setting, but count literal setting as a bonus.
- Justify every pick from my own data: current rating, how many times I've
  logged it, and quote my own review text wherever I wrote one. I want the
  evidence, not vibes.
- Cross-reference which films I've actually watched in September — my own
  seasonal behavior is evidence, and say so when a pick is behavioral rather
  than thematic.
- Do not repeat the eight I already picked for August: Call Me by Your Name,
  Aftersun, Luca, Everybody Wants Some!!, Before Sunset, Lady Bird, 20th Century
  Women, Past Lives.
- Interview me if something is genuinely ambiguous. Otherwise just deliver.

**Data gotchas that cost time last run:**

- `ratings.csv` holds my *current* rating. The per-entry ratings in `diary.csv`
  are historical snapshots and will disagree with it. Trust `ratings.csv`.
- Don't parse these CSVs with `awk`/`cut` — film titles contain commas. Use
  Python's `csv` module.
- `viewing_history.json` carries `tmdbId` only for recent RSS entries, never for
  the archive baseline.
- The archive also ships an `orphaned/` folder — films later removed from
  Letterboxd. Those are deliberately excluded from the main diary; ignore them
  unless I ask.

Give me the list in chat first. Don't build a graphic unless I ask for one.

---

## If you go on to ask for a graphic

Two constraints that blocked the August attempt, worth pasting in at that point:

- A published Artifact's CSP allows **no external hosts except Google Fonts**.
  TMDB posters cannot be hotlinked — they must be downloaded and embedded as
  **bare base64 with no `data:` prefix** (the runtime adds the wrapper; a stored
  data-URI double-wraps into a broken image). Budget ~70 KB per image; `w342`
  plus `sips -Z 600` gets there.
- Run that session **locally with a `TMDB_API_KEY`**. The web sandbox's egress
  policy returns 403 on CONNECT to `api.themoviedb.org`, `image.tmdb.org`,
  `letterboxd.com` and `a.ltrbxd.com`.

Settle the aesthetic direction and the output format (square vs. 4:5 vs. tall
poster) before any design work starts — that was the unresolved question when
the August build stopped.
