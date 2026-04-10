# Letterboxd Viewer
A web-based gallery for your Letterboxd movie diary

```python
import requests
from PIL import Image
# A codebase that turns your Letterboxd RSS feed into a beautiful gallery
```

---

## What is Letterboxd Viewer?

* A web gallery that displays Letterboxd movie entries
* Fetches your personal Letterboxd RSS feed
* Renders movies in a responsive grid layout
* Built with HTML5, CSS, JavaScript, and Python

---

# System Architecture

```
digraph {
    rankdir = LR;
    User -> Browser;
    Browser -> "index.html";
    "index.html" -> "RSS XML";
    Python -> "Letterboxd API";
    "Letterboxd API" -> Python;
    Python -> "RSS XML";
    Python -> "Image Storage";
}
```
```
┌──────┐     ┌─────────┐     ┌────────────┐     ┌─────────┐
│ User │ ──▶ │ Browser │ ──▶ │ index.html │ ──▶ │ RSS XML │
└──────┘     └─────────┘     └────────────┘     └─────────┘
                                                     ▲
                                                     │
┌─────────────┐     ┌────────┐                      │
│ Image Store │ ◀── │ Python │ ◀──────────────────────
└─────────────┘     └────────┘     ┌──────────────┐
                         ▲         │ Letterboxd   │
                         └────────▶│ RSS Feed     │
                                   └──────────────┘
```

---

# Key Components

1. Python RSS Downloader
2. Image Processing System
3. Web Frontend Gallery
4. GitHub Actions Automation

---

## RSS Feed Downloader

The heart of the system - fetches your Letterboxd activity

```python
# URL of the RSS feed
url = 'https://letterboxd.com/michaellamb/rss/'

# Function to download RSS feed
def download_rss():
    try:
        response = requests.get(url)
        response.raise_for_status()
        
        # Save the RSS feed
        rss_path = data_dir / 'rss.xml'
        with open(rss_path, 'wb') as f:
            f.write(response.content)
        print(f'Successfully downloaded RSS feed to {rss_path}')
        
        # Process items and download images...
```

---

## Image Processing

Automatically downloads and optimizes movie posters

```python
# Function to download images
def download_image(url, path):
    try:
        response = requests.get(url)
        response.raise_for_status()
        
        # Ensure path is a Path object
        path = Path(path)
        
        # Write the image data
        path.write_bytes(response.content)
        print(f'Successfully downloaded image to {path}')
        return True
    except Exception as e:
        print(f'Failed to download image {url}: {e}')
        return False
```

---

## Thumbnail Generation

Creates optimized thumbnails for the gallery view

```python
# Function to create a thumbnail from a full-size image
def create_thumbnail(full_image_path, thumb_image_path, size=(600, 900)):
    try:
        with Image.open(full_image_path) as img:
            # Convert to RGB if necessary
            if img.mode in ('RGBA', 'P'):
                img = img.convert('RGB')
            
            # Calculate aspect ratio
            aspect = img.width / img.height
            target_aspect = 2/3  # Movie poster ratio
            
            # Crop and resize to maintain aspect ratio
            if aspect > target_aspect:  # Image is too wide
                new_width = int(img.height * target_aspect)
                left = (img.width - new_width) // 2
                crop_box = (left, 0, left + new_width, img.height)
            else:  # Image is too tall
                new_height = int(img.width / target_aspect)
                top = (img.height - new_height) // 2
                crop_box = (0, top, img.width, top + new_height)
            
            img = img.crop(crop_box)
            img = img.resize(size, Image.Resampling.LANCZOS)
            img.save(thumb_image_path, 'JPEG', quality=95)
```

---

## Web Gallery Rendering

Handlebars templating for dynamic content

```html
<!-- Main gallery container -->
<div id="main">
    {{#rss_items}}
    <article class="thumb">
        <a href="{{link}}" class="image">
            <img src="{{image}}" alt="" />
        </a>
        <h2>{{title}}</h2>
        <p>{{description}}</p>
    </article>
    {{/rss_items}}
</div>
```

---

## JavaScript Processing

Transforms RSS data into gallery items

```javascript
$.ajax({
    type: 'GET',
    url: 'data/rss.xml',
    dataType: 'xml',
    success: function(data) {
        var rss_items = [];
        $(data).find('item').each(function() {
            var description = $(this).find('description').text();
            var title = $(this).find('title').text();
            
            // Extract image URL from description
            var imgMatch = description.match(/src="([^"]+)"/);
            var imgUrl = imgMatch ? imgMatch[1] : null;
            
            // Format title for display
            var formattedTitle = formatTitle(title);
            
            // Add to items array
            rss_items.push({
                title: formattedTitle,
                description: description,
                link: $(this).find('link').text(),
                image: 'assets/images/thumbs/' + 
                       sanitizeFilename(title) + '_thumb.jpg'
            });
        });
        
        // Render template with data
        renderGallery(rss_items);
    }
});
```

---

## Sequence Flow

```
sequenceDiagram
    participant User
    participant Browser
    participant IndexHTML
    participant RSS
    participant Python
    participant Letterboxd
    
    User->>Browser: Open Letterboxd Viewer
    Browser->>IndexHTML: Request page
    IndexHTML->>RSS: Fetch RSS data
    RSS-->>IndexHTML: Return data
    IndexHTML->>Browser: Render gallery
    Browser-->>User: Display movies
    
    Note over Python,Letterboxd: Runs on schedule
    Python->>Letterboxd: Request RSS feed
    Letterboxd-->>Python: Return data
    Python->>Python: Process & download images
    Python->>RSS: Save RSS XML file
```

---

## CI/CD Automation

GitHub Actions workflow updates the feed automatically

```yaml
name: RSS Feed Update

on:
  schedule:
    - cron: '0 */6 * * *'  # Runs every 6 hours
  workflow_dispatch:  # Allows manual triggering

# Explicitly set permissions for the workflow
permissions:
  contents: write

jobs:
  update-feed:
    runs-on: ubuntu-latest
    
    steps:
      - name: Checkout repository
        uses: actions/checkout@v3
        with:
          token: ${{ secrets.GITHUB_TOKEN }}
          persist-credentials: true
        
      - name: Set up Python
        uses: actions/setup-python@v4
        with:
          python-version: '3.10'
          
      - name: Install dependencies
        run: |
          python -m pip install --upgrade pip
          pip install requests pillow
```

---

## Directory Structure

```
letterboxd-viewer/
├── .github/workflows/    # CI/CD automation
├── assets/
│   ├── css/              # Styling
│   ├── images/           # Movie posters
│   │   ├── fulls/        # Full-size images
│   │   └── thumbs/       # Thumbnail images
│   └── js/               # JavaScript files
├── data/
│   └── rss.xml           # Letterboxd RSS feed
├── scripts/
│   └── download_rss.py   # Python downloader
└── index.html            # Main gallery page
```

---

## User Experience

1. User visits the gallery website
2. Movies from Letterboxd are displayed in a grid
3. Clicking a movie shows details in a lightbox
4. Contact form allows reaching out to the creator

---

# Thank You!

## Get Started:
1. Fork the repository
2. Update the RSS URL with your username
3. Deploy to GitHub Pages
4. Enjoy your personalized movie gallery!
