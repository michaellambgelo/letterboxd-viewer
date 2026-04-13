#!/usr/bin/env python3
"""Load a Letterboxd export archive into typed Python dicts.

The archive is shipped under data/archive/<export-folder>/. The export folder
name encodes the export date as `letterboxd-<user>-YYYY-MM-DD-HH-MM-utc`.

Diary entries are normalized to the same shape used by extract_history.py
(`parse_item`) so they can be merged with RSS-derived entries downstream.
"""

import csv
import re
from datetime import date
from pathlib import Path

script_dir = Path(__file__).parent
base_dir = script_dir.parent
archive_root = base_dir / 'data' / 'archive'


def _find_archive_dir():
    """Locate the single export folder under data/archive/.

    Returns the most recent export when multiple exist, picking by the date
    encoded in the folder name.
    """
    if not archive_root.exists():
        return None
    candidates = sorted(
        (p for p in archive_root.iterdir() if p.is_dir() and p.name.startswith('letterboxd-')),
        key=lambda p: p.name,
        reverse=True,
    )
    return candidates[0] if candidates else None


def get_export_date():
    """Parse YYYY-MM-DD from the export folder name."""
    d = _find_archive_dir()
    if not d:
        return None
    m = re.search(r'(\d{4}-\d{2}-\d{2})', d.name)
    return date.fromisoformat(m.group(1)) if m else None


def _read_csv(path):
    if not path.exists():
        return []
    with open(path, 'r', encoding='utf-8', newline='') as f:
        return list(csv.DictReader(f))


def _parse_rating(value):
    if value is None or value == '':
        return None
    try:
        return float(value)
    except ValueError:
        return None


def _parse_year(value):
    if value is None or value == '':
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _split_tags(value):
    if not value:
        return []
    return [t.strip() for t in value.split(',') if t.strip()]


def _boxd_id(uri):
    """Extract the slug from `https://boxd.it/XXXXX`."""
    if not uri:
        return None
    return uri.rstrip('/').rsplit('/', 1)[-1] or None


def load_diary(archive_dir=None):
    """Load diary.csv and return entries shaped like extract_history.parse_item.

    Joins review text and review-level tags from reviews.csv on
    (name, year, watched_date) — review URIs differ from diary URIs but the
    composite key is unique per Letterboxd's one-entry-per-(film, date) rule.
    """
    archive_dir = archive_dir or _find_archive_dir()
    if not archive_dir:
        return []

    reviews_by_key = {}
    for r in _read_csv(archive_dir / 'reviews.csv'):
        key = (r['Name'], r['Year'], r['Watched Date'])
        reviews_by_key[key] = {
            'review': r.get('Review', '').strip(),
            'tags': _split_tags(r.get('Tags', '')),
        }

    entries = []
    for row in _read_csv(archive_dir / 'diary.csv'):
        name = row['Name']
        year_str = row['Year']
        watched_date = row['Watched Date'] or row.get('Date')
        uri = row.get('Letterboxd URI', '')
        boxd = _boxd_id(uri)

        review_match = reviews_by_key.get((name, year_str, watched_date), {})
        tags = _split_tags(row.get('Tags', '')) or review_match.get('tags', [])

        entries.append({
            'guid': f'archive-{boxd}' if boxd else f'archive-{name}-{watched_date}',
            'filmTitle': name,
            'filmYear': _parse_year(year_str),
            'watchedDate': watched_date,
            'memberRating': _parse_rating(row.get('Rating')),
            'rewatch': row.get('Rewatch', '').strip().lower() == 'yes',
            'tmdbId': None,
            'link': uri or None,
            'title': name,
            'reviewText': review_match.get('review', ''),
            'tags': tags,
            'loggedDate': row.get('Date') or None,
            'source': 'archive',
        })
    return entries


def load_watchlist(archive_dir=None):
    archive_dir = archive_dir or _find_archive_dir()
    if not archive_dir:
        return []
    return [
        {
            'name': r['Name'],
            'year': _parse_year(r.get('Year')),
            'link': r.get('Letterboxd URI') or None,
            'addedDate': r.get('Date') or None,
        }
        for r in _read_csv(archive_dir / 'watchlist.csv')
    ]


def load_likes(archive_dir=None):
    archive_dir = archive_dir or _find_archive_dir()
    if not archive_dir:
        return []
    return [
        {
            'name': r['Name'],
            'year': _parse_year(r.get('Year')),
            'link': r.get('Letterboxd URI') or None,
            'likedDate': r.get('Date') or None,
        }
        for r in _read_csv(archive_dir / 'likes' / 'films.csv')
    ]


def load_ratings(archive_dir=None):
    """Per-film ratings (latest snapshot per film).

    Useful as a fallback for films watched once but where the diary row's
    Rating reflects the rating at logging time. For our stats compute_stats
    uses diary ratings, so this exists for completeness.
    """
    archive_dir = archive_dir or _find_archive_dir()
    if not archive_dir:
        return []
    return [
        {
            'name': r['Name'],
            'year': _parse_year(r.get('Year')),
            'link': r.get('Letterboxd URI') or None,
            'rating': _parse_rating(r.get('Rating')),
            'ratedDate': r.get('Date') or None,
        }
        for r in _read_csv(archive_dir / 'ratings.csv')
    ]


def load_profile(archive_dir=None):
    archive_dir = archive_dir or _find_archive_dir()
    if not archive_dir:
        return {}
    rows = _read_csv(archive_dir / 'profile.csv')
    if not rows:
        return {}
    p = rows[0]
    favorites_raw = p.get('Favorite Films') or ''
    favorites = [u.strip() for u in favorites_raw.split(',') if u.strip()]
    return {
        'username': p.get('Username'),
        'givenName': p.get('Given Name'),
        'familyName': p.get('Family Name'),
        'location': p.get('Location'),
        'website': p.get('Website'),
        'bio': p.get('Bio'),
        'pronoun': p.get('Pronoun'),
        'dateJoined': p.get('Date Joined'),
        'favoriteFilms': favorites,
    }


def load_lists(archive_dir=None):
    """Parse each list CSV. Files have a header block then a films table.

    Header block (first 3 lines):
      Letterboxd list export v7
      Date,Name,Tags,URL,Description
      <single row of list metadata>

    Then a blank line, then the films table:
      Position,Name,Year,URL,Description
      <rows>
    """
    archive_dir = archive_dir or _find_archive_dir()
    if not archive_dir:
        return []
    lists_dir = archive_dir / 'lists'
    if not lists_dir.exists():
        return []

    out = []
    for path in sorted(lists_dir.glob('*.csv')):
        with open(path, 'r', encoding='utf-8', newline='') as f:
            text = f.read()

        # Split on the first blank line that separates list-meta from films-table
        parts = re.split(r'\r?\n\r?\n', text, maxsplit=1)
        meta_block = parts[0]
        films_block = parts[1] if len(parts) > 1 else ''

        meta_lines = meta_block.splitlines()
        # Drop the "Letterboxd list export v7" preamble if present
        if meta_lines and meta_lines[0].lower().startswith('letterboxd list export'):
            meta_lines = meta_lines[1:]
        meta_rows = list(csv.DictReader(meta_lines))
        meta = meta_rows[0] if meta_rows else {}

        films = []
        if films_block.strip():
            films = list(csv.DictReader(films_block.splitlines()))

        out.append({
            'slug': path.stem,
            'name': meta.get('Name') or path.stem,
            'url': meta.get('URL'),
            'description': (meta.get('Description') or '').strip(),
            'tags': _split_tags(meta.get('Tags', '')),
            'createdDate': meta.get('Date'),
            'filmCount': len(films),
        })
    return out
