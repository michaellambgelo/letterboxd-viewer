# Letterboxd Gallery Viewer

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

## Contact

The gallery includes a contact form that sends messages through a Discord webhook. Configure the webhook URL in the JavaScript code in index.html to receive messages.

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