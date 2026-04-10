# Letterboxd Viewer Sequence Diagram

How the dashboard loads, how the cron pipeline refreshes data, and how the guestbook form posts to Discord.

## Runtime (page load + user interactions)

```mermaid
sequenceDiagram
    participant User
    participant Browser
    participant Index as index.html
    participant Dashboard as dashboard.js
    participant ChartJS as Chart.js (CDN)
    participant Stats as data/stats.json
    participant Discord as Discord Webhook

    %% Initial page load
    User->>Browser: Open Letterboxd Viewer
    Browser->>Index: GET index.html
    Index->>ChartJS: <script src="cdn.jsdelivr.net/npm/chart.js@4">
    Index->>Dashboard: <script src="assets/js/dashboard.js">
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

## Data pipeline (cron, runs every 6 hours)

```mermaid
sequenceDiagram
    participant Cron as GitHub Actions cron
    participant Download as download_rss.py
    participant Letterboxd as Letterboxd RSS
    participant Git as git history
    participant Extract as extract_history.py
    participant History as viewing_history.json
    participant Compute as compute_stats.py
    participant Stats as stats.json
    participant Deploy as deploy.yml

    Cron->>Download: python3 scripts/download_rss.py
    Download->>Letterboxd: GET letterboxd.com/michaellamb/rss/
    Letterboxd-->>Download: RSS XML (up to 50 recent items)
    Download->>Download: Clean HTML descriptions
    Download->>Git: Write data/rss.xml + data/cleaned_rss.xml

    Cron->>Extract: python3 scripts/extract_history.py
    Extract->>Git: git log --reverse -- data/rss.xml
    Git-->>Extract: All commit hashes touching rss.xml
    loop For each commit
        Extract->>Git: git show <hash>:data/rss.xml
        Git-->>Extract: RSS snapshot
        Extract->>Extract: Parse items, dedupe by numeric ID
    end
    Extract->>History: Write data/viewing_history.json

    Cron->>Compute: python3 scripts/compute_stats.py
    Compute->>History: Read viewing_history.json
    Compute->>Compute: Compute totals, distributions, heatmap, lists
    Compute->>Stats: Write data/stats.json

    Cron->>Git: git add data/ && git commit && git push
    Cron->>Deploy: Trigger workflow_dispatch (deploy.yml)
    Deploy->>Deploy: Inject DISCORD_WEBHOOK_URL secret into HTML
    Deploy->>Deploy: Publish to GitHub Pages
```

## Key idea: cumulative history from git

Letterboxd's RSS only exposes the 50 most recent diary entries. To build a full history, `extract_history.py` walks **every** commit that has ever touched `data/rss.xml` and deduplicates entries by their numeric Letterboxd ID. The longer the cron has been running, the deeper the history goes. This is why the workflow checkout uses `fetch-depth: 0`.
