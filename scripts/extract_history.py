#!/usr/bin/env python3
"""Extract cumulative viewing history from git commits of data/rss.xml.

Walks the git history for data/rss.xml, parses each snapshot, and deduplicates
diary entries by guid to produce a single cumulative JSON file.
"""

import json
import subprocess
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
import re
from html import unescape

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
    """Remove HTML tags and return plain text."""
    if not html_text:
        return ''
    # Remove CDATA wrapper
    text = html_text.strip()
    if text.startswith('<![CDATA[') and text.endswith(']]>'):
        text = text[9:-3]
    # Decode HTML entities
    if '&lt;' in text or '&amp;' in text:
        text = unescape(text)
    # Remove img tags entirely
    text = re.sub(r'<img[^>]*/?>', '', text)
    # Replace <br> and </p> with newlines
    text = re.sub(r'<br\s*/?>', '\n', text)
    text = re.sub(r'</p>\s*<p>', '\n\n', text)
    # Strip remaining tags
    text = re.sub(r'<[^>]+>', '', text)
    # Clean up whitespace
    text = re.sub(r'\n{3,}', '\n\n', text).strip()
    return text


def parse_item(item):
    """Parse an RSS <item> element into a diary entry dict."""
    guid_elem = item.find('guid')
    if guid_elem is None or guid_elem.text is None:
        return None

    guid = guid_elem.text.strip()

    # Skip list entries
    if guid.startswith('letterboxd-list-'):
        return None

    # Only process review/watch entries
    if not (guid.startswith('letterboxd-review-') or guid.startswith('letterboxd-watch-')):
        return None

    # Normalize guid to avoid duplicates when the same entry appears as both
    # letterboxd-review-XXXXX and letterboxd-watch-XXXXX
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
    }


def get_commit_hashes():
    """Get all commit hashes that modified data/rss.xml, oldest first."""
    result = subprocess.run(
        ['git', 'log', '--format=%H', '--reverse', '--', 'data/rss.xml'],
        capture_output=True, text=True, cwd=str(base_dir)
    )
    if result.returncode != 0:
        print(f'Error getting git log: {result.stderr}', file=sys.stderr)
        return []
    return [h.strip() for h in result.stdout.strip().split('\n') if h.strip()]


def get_file_at_commit(commit_hash, filepath):
    """Get file contents at a specific commit."""
    result = subprocess.run(
        ['git', 'show', f'{commit_hash}:{filepath}'],
        capture_output=True, text=True, cwd=str(base_dir),
        encoding='utf-8', errors='replace'
    )
    if result.returncode != 0:
        return None
    return result.stdout


def main():
    data_dir.mkdir(parents=True, exist_ok=True)

    print('Getting commit hashes...')
    hashes = get_commit_hashes()
    print(f'Found {len(hashes)} commits that modified data/rss.xml')

    if not hashes:
        print('No commits found. Nothing to extract.')
        return

    # Deduplicate by guid — process oldest first so newest version wins
    entries = {}
    processed = 0
    errors = 0

    for i, commit_hash in enumerate(hashes):
        xml_content = get_file_at_commit(commit_hash, 'data/rss.xml')
        if xml_content is None:
            errors += 1
            continue

        try:
            root = ET.fromstring(xml_content)
            for item in root.findall('.//item'):
                entry = parse_item(item)
                if entry:
                    entries[entry['guid']] = entry
            processed += 1
        except ET.ParseError as e:
            errors += 1
            if i < 5 or i % 100 == 0:
                print(f'  XML parse error at commit {commit_hash[:8]}: {e}')

        if (i + 1) % 100 == 0:
            print(f'  Processed {i + 1}/{len(hashes)} commits, {len(entries)} unique entries so far')

    # Also incorporate the current working-tree rss.xml so a fresh download
    # on this run is reflected immediately (otherwise there is a 1-run lag
    # between download_rss.py writing the file and stats.json updating).
    working_tree_rss = data_dir / 'rss.xml'
    if working_tree_rss.exists():
        try:
            xml_content = working_tree_rss.read_text(encoding='utf-8', errors='replace')
            root = ET.fromstring(xml_content)
            for item in root.findall('.//item'):
                entry = parse_item(item)
                if entry:
                    entries[entry['guid']] = entry
            print('Merged working-tree data/rss.xml')
        except ET.ParseError as e:
            print(f'  XML parse error in working-tree rss.xml: {e}', file=sys.stderr)

    print(f'Processed {processed} commits ({errors} errors)')
    print(f'Extracted {len(entries)} unique diary entries')

    # Sort by watchedDate descending (newest first), with None dates at the end
    sorted_entries = sorted(
        entries.values(),
        key=lambda e: e.get('watchedDate') or '0000-00-00',
        reverse=True,
    )

    output_path = data_dir / 'viewing_history.json'
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(sorted_entries, f, ensure_ascii=False, indent=2)

    print(f'Saved {len(sorted_entries)} entries to {output_path}')


if __name__ == '__main__':
    main()
