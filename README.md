# Letterboxd Gallery Viewer [![built with Codeium](https://codeium.com/badges/main)](https://codeium.com) [![Deploy to GitHub Pages](https://github.com/michaellambgelo/letterboxd-viewer/actions/workflows/deploy.yml/badge.svg)](https://github.com/michaellambgelo/letterboxd-viewer/actions/workflows/deploy.yml) [![RSS Feed Update](https://github.com/michaellambgelo/letterboxd-viewer/actions/workflows/download-data-and-assets.yml/badge.svg?event=schedule)](https://github.com/michaellambgelo/letterboxd-viewer/actions/workflows/download-data-and-assets.yml)

A web-based gallery viewer that displays Letterboxd movie entries in a beautiful grid layout. Any visitor can enter their Letterboxd username to generate a **"Last Four Watched"** shareable image card.

This project is designed to be easy to customize and does not require anything to be downloaded locally. Once configured, GitHub Actions handle data fetching and deployment to GitHub Pages automatically.

## Architecture

Review this [sequence diagram](/sequence-diagram.md) to understand how Letterboxd Gallery Viewer works.

## Features

- **Last Four Watched** — any visitor enters a Letterboxd username to generate a shareable 1080×480px card showing their 4 most recently watched films
- Canvas-based image export: copy to clipboard or download as PNG
- Responsive gallery layout with movie posters
- Lightbox view for full review content
- Contact form with webhook integration
- Mobile-friendly design

## How "Last Four Watched" Works

1. Visitor enters a Letterboxd username and clicks **Generate**
2. The browser calls the Cloudflare Worker, which securely dispatches the GitHub Actions `RSS Feed Update` workflow with the provided username
3. The workflow fetches the user's Letterboxd RSS feed, downloads poster images, and commits the data to `data/users/{username}/` and `assets/images/{username}/`
4. The frontend polls the GitHub Actions API until the run completes, then fetches the generated XML via the GitHub Contents API
5. A Canvas composite card is rendered with 4 poster thumbnails, film titles, years, and star ratings
6. The visitor can copy the card to their clipboard or download it as a PNG

## Setup

### 1. GitHub — Fine-Grained Personal Access Token (PAT)

The Cloudflare Worker needs a GitHub PAT to trigger `workflow_dispatch` on your fork. Create one with the minimum required scope:

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens**
2. Click **Generate new token**
3. Set **Repository access** to only this repository (`letterboxd-viewer`)
4. Under **Permissions → Repository permissions**, grant **Actions: Read and write**
5. Copy the generated token — you will need it in the next step

### 2. Cloudflare Worker — Deploy the Trigger Proxy

The `worker/` directory contains a Cloudflare Worker that holds your GitHub PAT as a secret and proxies `workflow_dispatch` requests so the token never appears in client-side code.

**Prerequisites:** [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed and logged in (`wrangler login`).

```bash
# From the repo root
cd worker

# Deploy the Worker to your Cloudflare account
wrangler deploy

# Store the GitHub PAT as an encrypted secret (paste the token when prompted)
wrangler secret put GITHUB_TOKEN
```

`REPO_OWNER` and `REPO_NAME` are already set as plain-text vars in `worker/wrangler.toml`. If you have forked the repository under a different owner or name, update those values before deploying:

```toml
[vars]
REPO_OWNER = "your-github-username"
REPO_NAME  = "letterboxd-viewer"
```

After `wrangler deploy` completes, copy the Worker URL printed in the output (e.g. `https://letterboxd-viewer-trigger.<your-subdomain>.workers.dev`).

### 3. Configure the Frontend with the Worker URL

Open `index.html` and set the `WORKER_URL` constant near the top of the `<script>` block (around line 276):

```js
const WORKER_URL = 'https://letterboxd-viewer-trigger.<your-subdomain>.workers.dev/trigger';
```

Commit and push this change to trigger a deployment.

### 4. Fork & Deploy to GitHub Pages

1. Fork this repository
2. Go to your repository **Settings → Secrets and variables → Actions** and add:
   - `DISCORD_WEBHOOK_URL` — your Discord webhook URL (used by the contact form)
3. Enable **GitHub Pages** in repository settings (source: `main` branch / `/ (root)`)
4. Push any change to `main` to trigger the initial deployment

The site will be available at `https://[your-github-username].github.io/letterboxd-viewer/`

## Automated RSS Feed Updates

The `.github/workflows/download-data-and-assets.yml` workflow runs every 6 hours to keep the default user's data current. It can also be triggered on-demand in two ways:

- **Via the frontend** — the "Last Four Watched" generator triggers it with a custom username through the Cloudflare Worker
- **Manually** — from the **Actions** tab in your repository, select *RSS Feed Update* and provide a username input

Output is written to per-user directories:

```
data/users/{username}/cleaned_rss.xml
assets/images/{username}/thumbs/
assets/images/{username}/fulls/
```

When new data is committed, the workflow automatically triggers the deploy workflow to publish the updated site.

## Data Pipeline

```
Letterboxd RSS → scripts/download_rss.py --username {username}
                        ↓
          data/users/{username}/cleaned_rss.xml
          assets/images/{username}/thumbs/ + fulls/
                        ↓
              index.html (Canvas composite)
                        ↓
            Shareable 1080×480px PNG card
```

`download_rss.py` accepts a `--username` argument (defaults to `michaellamb` for the scheduled cron run). It fetches the RSS feed, downloads poster images, and writes a `cleaned_rss.xml` that includes an `<imageUrl>` element for each entry so the browser can load posters onto the canvas.

## Contact

The gallery includes a contact form that sends messages through a Discord webhook. The webhook URL is configured through GitHub Actions environment variables for security.

Learn more about Discord Webhooks from [this support article](https://support.discord.com/hc/en-us/articles/228383668-Intro-to-Webhooks).

---

## Template Attribution

Multiverse by HTML5 UP
html5up.net | @ajlkn
Free for personal and commercial use under the CCA 3.0 license (html5up.net/license)

Credits:

    Demo Images:
        Unsplash (unsplash.com)

    Icons:
        Font Awesome (fontawesome.io)

    Other:
        jQuery (jquery.com)
        Poptrox (github.com/ajlkn/jquery.poptrox)
        Responsive Tools (github.com/ajlkn/responsive-tools)
