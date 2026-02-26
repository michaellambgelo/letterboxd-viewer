# Letterboxd Viewer — CLAUDE.md

## Project Goal

This project is evolving from a personal Letterboxd diary viewer into a more **app-like experience** where any user can enter their Letterboxd username to generate a **"Last Four Watched" shareable image** suitable for posting to social media or other platforms.

The `last-four-watched` branch is the primary development branch for this feature.

---

## Current Architecture

**Static site** deployed to GitHub Pages. No server-side runtime. Data pipeline is Python + GitHub Actions.

```
Letterboxd RSS → Python script → data/cleaned_rss.xml + assets/images/*
                                        ↓
                              index.html (jQuery + Handlebars)
                                        ↓
                              Gallery of 4 most recent films
```

Key files:
- `scripts/download_rss.py` — fetches RSS, downloads poster images, produces `cleaned_rss.xml`
- `index.html` — single-file frontend (Handlebars templates, jQuery, Poptrox lightbox)
- `.github/workflows/download-data-and-assets.yml` — cron job (every 6h) that runs the Python script
- `.github/workflows/deploy.yml` — deploys to GitHub Pages on push to main

---

## Data Source: Letterboxd RSS

**All proof-of-concept work should rely on the Letterboxd RSS feed**, not the Letterboxd API.

RSS endpoint (public, no auth required):
```
https://letterboxd.com/{username}/rss/
```

RSS items contain:
- `<letterboxd:filmTitle>` — film title
- `<letterboxd:filmYear>` — release year
- `<letterboxd:memberRating>` — star rating (float, e.g. `4.5`)
- `<letterboxd:watchedDate>` — YYYY-MM-DD
- `<letterboxd:rewatch>` — Yes/No
- `<description>` — review text + poster image URL (inside CDATA)
- `<themoviedb:movieId>` — TMDB ID (useful for supplementing data if needed)

Poster image URL pattern in description HTML:
```
https://a.ltrbxd.com/resized/...poster-{size}.jpg
```
Resolution can be upgraded by replacing the size parameter (e.g. `-0-150-` → `-0-2000-`).

---

## "Last Four Watched" Feature Goals

### Core Goal
Allow a visitor to enter any Letterboxd username and generate a visual card showing their 4 most recently watched films, suitable for copying/sharing.

### Key Behaviors
1. **Username input** — user types a Letterboxd username into a field
2. **RSS fetch** — client-side fetch of `https://letterboxd.com/{username}/rss/` (or proxied)
3. **Parse first 4 film entries** — skip list entries and other non-film items
4. **Display 4 poster images + film titles + ratings** — laid out as a shareable card
5. **Export / copy** — user can copy the card as an image (Canvas API → clipboard or download)

### Open Questions

**CORS**: Letterboxd RSS may not allow direct browser-side `fetch()` due to CORS headers. Options:
- A lightweight CORS proxy (e.g. a small Cloudflare Worker or Vercel Edge Function)
- Server-side fetch triggered by user input
- Check whether `https://letterboxd.com/{username}/rss/` actually allows cross-origin requests before building a proxy

**Image CORS**: Letterboxd CDN images (`a.ltrbxd.com`) must be drawable onto a `<canvas>` without tainting it. This requires either:
- `crossOrigin="anonymous"` on `<img>` elements (only works if the CDN sends CORS headers)
- Proxying images through a backend or Cloudflare Worker

**Letterboxd API**: A formal API exists but requires authentication. We are intentionally deferring API integration. RSS is sufficient for proof-of-concept. We will cross that bridge when the RSS approach hits a wall.

### Image Generation Approach (preferred)
Use the browser **Canvas API** to composite:
- 4 poster thumbnails (2:3 aspect ratio, side by side or 2×2 grid)
- Film titles and star ratings as text overlays
- Optional: username + date watermark

Export via `canvas.toBlob()` → `navigator.clipboard.write()` or `<a download>`.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML/CSS/JS, jQuery, Handlebars |
| Styling | SASS (compiled), responsive breakpoints |
| Data pipeline | Python 3.10 (requests, Pillow, BeautifulSoup, lxml) |
| Automation | GitHub Actions |
| Hosting | GitHub Pages |
| Monitoring | Grafana Faro SDK (removed in last-four-watched branch) |

---

## Development Notes

- The username is currently **hardcoded** to `michaellamb` in `scripts/download_rss.py` line 17. Dynamic username support requires moving RSS fetching client-side (or adding a proxy).
- The 4-entry limit in `last-four-watched` is enforced in both the image download loop and the XML output loop in `download_rss.py`.
- `clean_image_directories()` is called at the start of each run — image dirs are wiped and repopulated fresh every time.
- The frontend reads `data/cleaned_rss.xml` via AJAX. For a dynamic username feature, this static file approach will need to change.
- No npm/node build step required. The `assets/main.tsx.ed6f4f5c.js` is a pre-compiled artifact.
