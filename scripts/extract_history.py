#!/usr/bin/env python3
"""Build the cumulative viewing history JSON.

Sources:
  1. Letterboxd export archive (data/archive/<export>/) — historical baseline.
  2. Current data/rss.xml — appends entries logged after the export date.

The archive contains the user's full diary (capped only by the export's age),
while RSS only exposes the 50 most recent entries. The merge prefers the
archive for any entry present in both and lets RSS supply only newer entries.

Merge key: (filmTitle, filmYear, watchedDate). Letterboxd allows at most one
diary entry per (film, watchedDate), so this composite key is unique. RSS
guids and archive boxd.it URIs cannot be matched directly without a network
redirect, so we don't try.
"""

import json
import re
import sys
import xml.etree.ElementTree as ET
from datetime import date, timedelta
from html import unescape
from pathlib import Path

from load_archive import get_export_date, load_diary

# Namespaces used in Letterboxd RSS
NS = {
    'letterboxd': 'https://letterboxd.com',
    'tmdb': 'https://themoviedb.org',
    'dc': 'http://purl.org/dc/elements/1.1/',
}

script_dir = Path(__file__).parent
base_dir = script_dir.parent
data_dir = base_dir / 'data'


def strip_html(html_text):
    if not html_text:
        return ''
    text = html_text.strip()
    if text.startswith('<![CDATA[') and text.endswith(']]>'):
        text = text[9:-3]
    if '&lt;' in text or '&amp;' in text:
        text = unescape(text)
    text = re.sub(r'<img[^>]*/?>', '', text)
    text = re.sub(r'<br\s*/?>', '\n', text)
    text = re.sub(r'</p>\s*<p>', '\n\n', text)
    text = re.sub(r'<[^>]+>', '', text)
    text = re.sub(r'\n{3,}', '\n\n', text).strip()
    return text


def parse_rss_item(item):
    guid_elem = item.find('guid')
    if guid_elem is None or guid_elem.text is None:
        return None
    guid = guid_elem.text.strip()
    if guid.startswith('letterboxd-list-'):
        return None
    if not (guid.startswith('letterboxd-review-') or guid.startswith('letterboxd-watch-')):
        return None

    numeric_id = guid.split('-')[-1]
    guid = f'letterboxd-entry-{numeric_id}'

    def find_ns(tag, ns_prefix):
        ns_uri = NS.get(ns_prefix, '')
        elem = item.find(f'{{{ns_uri}}}{tag}')
        return elem.text.strip() if elem is not None and elem.text else None

    film_title = find_ns('filmTitle', 'letterboxd')
    film_year = find_ns('filmYear', 'letterboxd')
    watched_date = find_ns('watchedDate', 'letterboxd')
    member_rating = find_ns('memberRating', 'letterboxd')
    rewatch = find_ns('rewatch', 'letterboxd')
    tmdb_id = find_ns('movieId', 'tmdb')

    link_elem = item.find('link')
    link = link_elem.text.strip() if link_elem is not None and link_elem.text else None
    title_elem = item.find('title')
    title = title_elem.text.strip() if title_elem is not None and title_elem.text else None
    desc_elem = item.find('description')
    review_text = strip_html(desc_elem.text) if desc_elem is not None and desc_elem.text else ''

    return {
        'guid': guid,
        'filmTitle': film_title,
        'filmYear': int(film_year) if film_year else None,
        'watchedDate': watched_date,
        'memberRating': float(member_rating) if member_rating else None,
        'rewatch': rewatch == 'Yes' if rewatch else False,
        'tmdbId': int(tmdb_id) if tmdb_id else None,
        'link': link,
        'title': title,
        'reviewText': review_text,
        'tags': [],
        'source': 'rss',
    }


def load_rss_entries(rss_path):
    if not rss_path.exists():
        return []
    try:
        xml_content = rss_path.read_text(encoding='utf-8', errors='replace')
        root = ET.fromstring(xml_content)
    except (ET.ParseError, OSError) as e:
        print(f'  Could not parse {rss_path}: {e}', file=sys.stderr)
        return []
    entries = []
    for item in root.findall('.//item'):
        entry = parse_rss_item(item)
        if entry:
            entries.append(entry)
    return entries


def merge_key(entry):
    """Composite key used to dedupe across archive + RSS."""
    title = (entry.get('filmTitle') or '').strip().lower()
    year = entry.get('filmYear')
    watched = entry.get('watchedDate') or ''
    return (title, year, watched)


def main():
    data_dir.mkdir(parents=True, exist_ok=True)

    print('Loading archive...')
    archive_entries = load_diary()
    export_date = get_export_date()
    print(f'  {len(archive_entries)} entries from archive (export date {export_date})')

    print('Loading RSS...')
    rss_entries = load_rss_entries(data_dir / 'rss.xml')
    print(f'  {len(rss_entries)} entries in current rss.xml')

    # RSS-only entries: anything whose key isn't in the archive baseline.
    # (Optionally cap to entries newer than export_date - 1 day to avoid
    # accidentally re-introducing pre-export rows the user has since deleted
    # from Letterboxd. We want the archive's deletes to win.)
    cutoff = (export_date - timedelta(days=1)) if export_date else None

    archive_keys = {merge_key(e) for e in archive_entries}
    merged = list(archive_entries)
    rss_added = 0
    for e in rss_entries:
        if merge_key(e) in archive_keys:
            continue
        if cutoff and e.get('watchedDate'):
            try:
                if date.fromisoformat(e['watchedDate']) < cutoff:
                    continue
            except ValueError:
                pass
        merged.append(e)
        rss_added += 1

    print(f'Merged: {len(archive_entries)} archive + {rss_added} new RSS = {len(merged)} total')

    merged.sort(key=lambda e: e.get('watchedDate') or '0000-00-00', reverse=True)

    output_path = data_dir / 'viewing_history.json'
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(merged, f, ensure_ascii=False, indent=2)

    print(f'Saved {len(merged)} entries to {output_path}')


if __name__ == '__main__':
    main()
