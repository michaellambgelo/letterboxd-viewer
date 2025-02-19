# Letterboxd Gallery Viewer [![built with Codeium](https://codeium.com/badges/main)](https://codeium.com)

A web-based gallery viewer that displays your Letterboxd movie entries in a beautiful grid layout. This project fetches your Letterboxd RSS feed and renders it as an interactive gallery with movie posters and details.

## Features

- Fetches and displays Letterboxd RSS feed entries
- Responsive gallery layout with movie posters
- Lightbox view for detailed movie information
- Contact form with webhook integration
- Mobile-friendly design

## Usage

1. Update the RSS feed URL in `scripts/download_rss.py` with your Letterboxd username
2. Run the Python script to download your feed
3. Open index.html in a web browser to view your movie gallery

## Deployment

This project is set up for deployment on GitHub Pages. To deploy:

1. Fork this repository
2. Go to your repository settings > Secrets and variables > Actions
3. Add a new secret named `DISCORD_WEBHOOK_URL` with your Discord webhook URL
4. Enable GitHub Pages in your repository settings
5. Push changes to the main branch to trigger deployment

The site will be automatically deployed to `https://[your-username].github.io/letterboxd-viewer/`

## Contact

The gallery includes a contact form that sends messages through a Discord webhook. The webhook URL is configured through GitHub Actions environment variables for security.

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