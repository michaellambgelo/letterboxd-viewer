#!/usr/bin/env python3
"""Compute stats from the cumulative viewing history JSON.

Reads data/viewing_history.json and produces data/stats.json with
pre-computed statistics for the dashboard.

Also pulls watchlist, likes, lists, favorites, and per-diary-year
breakdowns from the Letterboxd export archive (data/archive/<export>/).
"""

import json
from collections import Counter, defaultdict
from pathlib import Path

from load_archive import (
    _find_archive_dir,
    _read_csv,
    get_export_date,
    load_likes,
    load_lists,
    load_orphaned,
    load_profile,
    load_watched,
    load_watchlist_snapshot,
)

script_dir = Path(__file__).parent
base_dir = script_dir.parent
data_dir = base_dir / 'data'


def _film_key(entry):
    """Dedup key for unique-films / rewatch counting.

    Prefers tmdbId (RSS), then Letterboxd URI (archive — film-level via watched.csv
    isn't available per-entry, so we fall back to the per-watch URI which still
    differs across films), then (name, year).
    """
    if entry.get('tmdbId'):
        return ('tmdb', entry['tmdbId'])
    # Per-watch URI distinguishes by film+watch, not film alone, so don't use
    # link as a unique-film key. Fall back to (name, year).
    name = (entry.get('filmTitle') or '').strip().lower()
    year = entry.get('filmYear')
    return ('nameyear', name, year)


def _inventory_key(name, year):
    """Normalized (name, year) key used to union watched.csv with diary+RSS entries."""
    return ((name or '').strip().lower(), year)


def compute_unique_film_count(entries):
    """Authoritative unique-films count: watched.csv inventory ∪ diary+RSS films.

    watched.csv is a snapshot at archive export time; `entries` (diary+RSS) may
    include films logged after the export that aren't in the snapshot yet. The
    union catches both.
    """
    inventory = {
        _inventory_key(f['name'], f.get('year'))
        for f in load_watched()
        if f.get('name')
    }
    for e in entries:
        if e.get('filmTitle'):
            inventory.add(_inventory_key(e['filmTitle'], e.get('filmYear')))
    return len(inventory)


def compute_stats(entries):
    total_watched = len(entries)
    unique_films = len({_film_key(e) for e in entries if e.get('filmTitle')})
    total_rewatches = sum(1 for e in entries if e.get('rewatch'))

    rated = [e['memberRating'] for e in entries if e.get('memberRating') is not None]
    average_rating = round(sum(rated) / len(rated), 2) if rated else 0

    rating_distribution = {str(s): 0 for s in [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0]}
    rating_distribution['unrated'] = 0
    for e in entries:
        r = e.get('memberRating')
        if r is None:
            rating_distribution['unrated'] += 1
        else:
            rating_distribution[str(r)] = rating_distribution.get(str(r), 0) + 1

    films_by_month = Counter()
    films_by_day = Counter()
    for e in entries:
        d = e.get('watchedDate')
        if d:
            if len(d) >= 7:
                films_by_month[d[:7]] += 1
            films_by_day[d] += 1
    films_by_month = dict(sorted(films_by_month.items()))
    heatmap_data = [{'date': d, 'count': c} for d, c in sorted(films_by_day.items())]

    decade_dist = Counter()
    for e in entries:
        year = e.get('filmYear')
        if year:
            decade_dist[f'{(year // 10) * 10}s'] += 1
    film_year_distribution = dict(sorted(decade_dist.items()))

    # Most rewatched: count per film key
    watch_counts = defaultdict(lambda: {'count': 0, 'filmTitle': '', 'filmYear': None, 'tmdbId': None, 'link': None})
    for e in entries:
        if not e.get('filmTitle'):
            continue
        key = _film_key(e)
        slot = watch_counts[key]
        slot['count'] += 1
        slot['filmTitle'] = e.get('filmTitle', '')
        slot['filmYear'] = e.get('filmYear')
        slot['tmdbId'] = e.get('tmdbId') or slot['tmdbId']
        slot['link'] = e.get('link') or slot['link']
    most_rewatched = sorted(
        [v for v in watch_counts.values() if v['count'] > 1],
        key=lambda x: x['count'],
        reverse=True,
    )[:10]

    recent_activity = entries[:20]

    seen = set()
    highest_rated = []
    for e in entries:
        if e.get('memberRating') == 5.0:
            key = _film_key(e)
            if key in seen:
                continue
            seen.add(key)
            highest_rated.append({
                'filmTitle': e.get('filmTitle'),
                'filmYear': e.get('filmYear'),
                'watchedDate': e.get('watchedDate'),
                'link': e.get('link'),
                'tmdbId': e.get('tmdbId'),
            })

    watched_dates = [e['watchedDate'] for e in entries if e.get('watchedDate')]
    date_range = {
        'earliest': min(watched_dates) if watched_dates else None,
        'latest': max(watched_dates) if watched_dates else None,
    }

    return {
        'totalWatched': total_watched,
        'uniqueFilms': unique_films,
        'totalRewatches': total_rewatches,
        'averageRating': average_rating,
        'ratingDistribution': rating_distribution,
        'filmsByMonth': films_by_month,
        'heatmapData': heatmap_data,
        'filmYearDistribution': film_year_distribution,
        'mostRewatched': most_rewatched,
        'recentActivity': recent_activity,
        'highestRated': highest_rated,
        'dateRange': date_range,
    }


def compute_year_stats(entries):
    """Slim per-year stats — drives the dashboard's year selector."""
    return {
        'totalWatched': len(entries),
        'uniqueFilms': len({_film_key(e) for e in entries if e.get('filmTitle')}),
        'totalRewatches': sum(1 for e in entries if e.get('rewatch')),
        'averageRating': round(
            sum(e['memberRating'] for e in entries if e.get('memberRating') is not None)
            / max(1, sum(1 for e in entries if e.get('memberRating') is not None)),
            2,
        ) if any(e.get('memberRating') for e in entries) else 0,
        'ratingDistribution': _rating_distribution(entries),
        'heatmapData': _heatmap_data(entries),
        'filmYearDistribution': _decade_distribution(entries),
        'mostRewatched': _most_rewatched(entries, limit=5),
        'highestRated': _highest_rated(entries, limit=10),
    }


def _rating_distribution(entries):
    dist = {str(s): 0 for s in [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0]}
    dist['unrated'] = 0
    for e in entries:
        r = e.get('memberRating')
        if r is None:
            dist['unrated'] += 1
        else:
            dist[str(r)] = dist.get(str(r), 0) + 1
    return dist


def _heatmap_data(entries):
    counts = Counter()
    for e in entries:
        d = e.get('watchedDate')
        if d:
            counts[d] += 1
    return [{'date': d, 'count': c} for d, c in sorted(counts.items())]


def _decade_distribution(entries):
    dist = Counter()
    for e in entries:
        y = e.get('filmYear')
        if y:
            dist[f'{(y // 10) * 10}s'] += 1
    return dict(sorted(dist.items()))


def _most_rewatched(entries, limit=5):
    counts = defaultdict(lambda: {'count': 0, 'filmTitle': '', 'filmYear': None, 'tmdbId': None, 'link': None})
    for e in entries:
        if not e.get('filmTitle'):
            continue
        slot = counts[_film_key(e)]
        slot['count'] += 1
        slot['filmTitle'] = e.get('filmTitle', '')
        slot['filmYear'] = e.get('filmYear')
        slot['tmdbId'] = e.get('tmdbId') or slot['tmdbId']
        slot['link'] = e.get('link') or slot['link']
    return sorted(
        [v for v in counts.values() if v['count'] > 1],
        key=lambda x: x['count'],
        reverse=True,
    )[:limit]


def _highest_rated(entries, limit=10):
    seen = set()
    out = []
    for e in entries:
        if e.get('memberRating') == 5.0:
            key = _film_key(e)
            if key in seen:
                continue
            seen.add(key)
            out.append({
                'filmTitle': e.get('filmTitle'),
                'filmYear': e.get('filmYear'),
                'watchedDate': e.get('watchedDate'),
                'link': e.get('link'),
            })
            if len(out) >= limit:
                break
    return out


def compute_by_year(entries):
    by_year = defaultdict(list)
    for e in entries:
        d = e.get('watchedDate')
        if d and len(d) >= 4:
            by_year[d[:4]].append(e)
    return {year: compute_year_stats(rows) for year, rows in sorted(by_year.items())}


def compute_tag_cloud(entries, top=80):
    counts = Counter()
    for e in entries:
        for t in e.get('tags') or []:
            counts[t.lower()] += 1
    return dict(counts.most_common(top))


def current_watchlist(entries, snapshot=None):
    """Newest watchlist snapshot minus films logged since it.

    The snapshot is whichever was exported later: the full archive's
    watchlist.csv or a standalone watchlist export (load_watchlist_snapshot).
    It's frozen at export time and RSS carries no watchlist data, but
    Letterboxd removes a film from the watchlist when it's logged. So drop any
    snapshot item with an RSS diary entry watched on or after the snapshot's
    export date. Earlier watches are left alone: those films were re-added
    after watching and are genuinely on the watchlist per the export.

    Returns (items, snapshot_items, snapshot_date, source).
    """
    items_all, snapshot_date, source = snapshot or load_watchlist_snapshot()
    cutoff = snapshot_date.isoformat() if snapshot_date else ''
    watched_since_export = {
        _inventory_key(e['filmTitle'], e.get('filmYear'))
        for e in entries
        if e.get('source') == 'rss' and e.get('filmTitle')
        and (e.get('watchedDate') or '') >= cutoff
    }
    items = [
        i for i in items_all
        if _inventory_key(i['name'], i.get('year')) not in watched_since_export
    ]
    items.sort(key=lambda x: x.get('addedDate') or '', reverse=True)
    return items, items_all, snapshot_date, source


def compute_watchlist_stats(entries, snapshot=None):
    """Watchlist summary for stats.json (see current_watchlist)."""
    items, items_all, snapshot_date, source = current_watchlist(entries, snapshot)
    dates = [i['addedDate'] for i in items if i.get('addedDate')]
    return {
        'count': len(items),
        'oldestAdded': min(dates) if dates else None,
        'newestAdded': max(dates) if dates else None,
        'recentlyAdded': items[:10],
        'removedSinceExport': len(items_all) - len(items),
        'snapshotDate': snapshot_date.isoformat() if snapshot_date else None,
        'snapshotSource': source,
    }


def compute_watchlist_file(entries, snapshot=None):
    """data/watchlist.json: the whole current watchlist, compact.

    Read by letterboxd-review-stack.user.js (private repo michaellamb-userscripts) to show
    "On your watchlist" on a review card without opening anything on
    Letterboxd. Films are [name, year] pairs; the script matches them to a
    card's title and year the same way _inventory_key does here.
    """
    items, _, snapshot_date, source = current_watchlist(entries, snapshot)
    return {
        'snapshotDate': snapshot_date.isoformat() if snapshot_date else None,
        'snapshotSource': source,
        'count': len(items),
        'films': [[i['name'], i.get('year')] for i in items],
    }


def compute_liked_films(limit=50):
    likes = load_likes()
    likes.sort(key=lambda x: x.get('likedDate') or '', reverse=True)
    return likes[:limit]


def compute_favorite_films():
    profile = load_profile()
    favs = profile.get('favoriteFilms') or []
    if not favs:
        return []

    # Resolve URIs to names via watched.csv (film-level URIs).
    archive_dir = _find_archive_dir()
    by_uri = {}
    if archive_dir:
        for r in _read_csv(archive_dir / 'watched.csv'):
            by_uri[r['Letterboxd URI']] = {'name': r['Name'], 'year': r.get('Year')}

    out = []
    for uri in favs:
        info = by_uri.get(uri, {})
        out.append({
            'link': uri,
            'name': info.get('name'),
            'year': int(info['year']) if info.get('year') else None,
        })
    return out


def compute_orphaned_films():
    """Films the user logged that Letterboxd has since removed (export `orphaned/`).

    Deduped to unique films by (title, year), keeping the most-recent watch's
    metadata plus a `logCount` of how many times it was logged. Sorted by most
    recently watched. These are surfaced in a dedicated dashboard section and are
    intentionally NOT part of the main lifetime stats (the export already keeps
    them out of the main diary/watched CSVs).
    """
    entries = load_orphaned()
    by_film = {}
    for e in entries:
        key = (str(e.get('filmTitle') or '').strip().lower(), e.get('filmYear'))
        existing = by_film.get(key)
        if existing is None:
            by_film[key] = {
                'filmTitle': e.get('filmTitle'),
                'filmYear': e.get('filmYear'),
                'watchedDate': e.get('watchedDate'),
                'memberRating': e.get('memberRating'),
                'reviewText': e.get('reviewText') or '',
                'tags': e.get('tags') or [],
                'logCount': 1,
            }
        else:
            existing['logCount'] += 1
            # Keep the most-recent watch's rating/review/date.
            if (e.get('watchedDate') or '') > (existing['watchedDate'] or ''):
                existing['watchedDate'] = e.get('watchedDate')
                existing['memberRating'] = e.get('memberRating')
                existing['reviewText'] = e.get('reviewText') or ''
                existing['tags'] = e.get('tags') or []

    films = list(by_film.values())
    films.sort(key=lambda f: f.get('watchedDate') or '', reverse=True)
    return films


def compute_lists_summary():
    lists = load_lists()
    lists.sort(key=lambda x: (-(x.get('filmCount') or 0), x.get('name') or ''))
    return [
        {
            'name': l['name'],
            'slug': l['slug'],
            'url': l.get('url'),
            'description': l.get('description'),
            'tags': l.get('tags') or [],
            'filmCount': l.get('filmCount') or 0,
            'createdDate': l.get('createdDate'),
        }
        for l in lists
    ]


def compute_rewatches(entries, watched=None, unique_films=None):
    """Everything the Rewatches page shows, written to data/rewatches.json.

    Films are grouped by normalized (name, year) — `_inventory_key` — and NOT by
    `_film_key`: that one prefers tmdbId, which only RSS entries carry, so a
    film's archive watches and its later RSS watches would land in two groups.

    `watched` is watched.csv (film-level inventory, no dates); tests pass it in.
    Films in it with no diary entry are the ones marked watched before the diary
    existed. They can't be rewatches here, so the page lists them separately.
    """
    watched = load_watched() if watched is None else watched
    film_link = {_inventory_key(f['name'], f.get('year')): f.get('link') for f in watched if f.get('name')}

    groups = {}
    for e in entries:
        if not e.get('filmTitle') or not e.get('watchedDate'):
            continue
        key = _inventory_key(e['filmTitle'], e.get('filmYear'))
        g = groups.setdefault(key, {'filmTitle': e['filmTitle'], 'filmYear': e.get('filmYear'),
                                    'link': film_link.get(key), 'watches': []})
        g['watches'].append({'date': e['watchedDate'], 'rewatch': bool(e.get('rewatch'))})
        if not g['link']:
            g['link'] = e.get('link')

    films = []
    for g in groups.values():
        g['watches'].sort(key=lambda w: w['date'])
        g['count'] = len(g['watches'])
        g['rewatchLogs'] = sum(w['rewatch'] for w in g['watches'])
        if g['count'] >= 2 or g['rewatchLogs']:
            films.append(g)
    # Most logs first; ties broken by most recent watch (two stable sorts).
    films.sort(key=lambda g: g['watches'][-1]['date'], reverse=True)
    films.sort(key=lambda g: g['count'], reverse=True)

    by_year = defaultdict(lambda: {'logs': 0, 'rewatchLogs': 0, 'filmsRewatched': set()})
    for e in entries:
        if not e.get('watchedDate'):
            continue
        y = by_year[e['watchedDate'][:4]]
        y['logs'] += 1
        if e.get('rewatch'):
            y['rewatchLogs'] += 1
            y['filmsRewatched'].add(_inventory_key(e.get('filmTitle'), e.get('filmYear')))

    undiaried = sorted(
        ({'name': f['name'], 'year': f.get('year'), 'link': f.get('link')}
         for f in watched
         if f.get('name') and _inventory_key(f['name'], f.get('year')) not in groups),
        key=lambda f: ((f['name'] or '').lower(), f['year'] or 0),
    )
    rewatched = [f for f in films if f['rewatchLogs']]
    dates = [e['watchedDate'] for e in entries if e.get('watchedDate')]
    return {
        'totals': {
            'logs': sum(1 for e in entries if e.get('watchedDate')),
            'rewatchLogs': sum(1 for e in entries if e.get('rewatch')),
            'filmsRewatched': len(rewatched),
            'filmsLoggedTwice': sum(1 for f in films if f['count'] >= 2),
            # Logged once, flagged rewatch: 378 rewatched = 312 (2+ logs) + these.
            'loggedOnceAsRewatch': sum(1 for f in films if f['count'] == 1),
            # First diary log already flagged rewatch: first seen before the diary.
            'seenBeforeDiary': sum(1 for f in films if f['watches'][0]['rewatch']),
            'filmsLogged': len(groups),
            'filmsWatched': unique_films if unique_films is not None else len(
                set(film_link) | set(groups)),
            'undiaried': len(undiaried),
        },
        'films': films,
        'byYear': {
            y: {'logs': v['logs'], 'rewatchLogs': v['rewatchLogs'], 'filmsRewatched': len(v['filmsRewatched'])}
            for y, v in sorted(by_year.items())
        },
        'undiaried': undiaried,
        'dateRange': {'earliest': min(dates) if dates else None, 'latest': max(dates) if dates else None},
    }


def main():
    history_path = data_dir / 'viewing_history.json'
    if not history_path.exists():
        print(f'Error: {history_path} not found. Run extract_history.py first.')
        return

    with open(history_path, 'r', encoding='utf-8') as f:
        entries = json.load(f)

    print(f'Computing stats from {len(entries)} entries...')
    stats = compute_stats(entries)
    # Lifetime uniqueFilms comes from watched.csv (authoritative film inventory)
    # unioned with post-export RSS. Diary-based unique count undercounts films
    # marked watched without a diary entry. Per-year uniqueFilms stays diary-keyed.
    stats['uniqueFilms'] = compute_unique_film_count(entries)
    stats['byYear'] = compute_by_year(entries)
    stats['tagCloud'] = compute_tag_cloud(entries)
    stats['watchlist'] = compute_watchlist_stats(entries)
    stats['likedFilms'] = compute_liked_films()
    stats['favoriteFilms'] = compute_favorite_films()
    stats['lists'] = compute_lists_summary()
    stats['orphanedFilms'] = compute_orphaned_films()
    stats['profile'] = {
        k: v for k, v in load_profile().items()
        if k in ('username', 'givenName', 'location', 'website', 'bio', 'dateJoined')
    }
    export_date = get_export_date()
    stats['archiveExportDate'] = export_date.isoformat() if export_date else None

    output_path = data_dir / 'stats.json'
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)

    watchlist_path = data_dir / 'watchlist.json'
    with open(watchlist_path, 'w', encoding='utf-8') as f:
        json.dump(compute_watchlist_file(entries), f, ensure_ascii=False, separators=(',', ':'))

    rewatches = compute_rewatches(entries, unique_films=stats['uniqueFilms'])
    rewatches['archiveExportDate'] = stats['archiveExportDate']
    with open(data_dir / 'rewatches.json', 'w', encoding='utf-8') as f:
        json.dump(rewatches, f, ensure_ascii=False, separators=(',', ':'))
    t = rewatches['totals']
    print(f'  Rewatches page: {t["filmsRewatched"]} films rewatched, '
          f'{t["filmsLoggedTwice"]} logged 2+ times, {t["undiaried"]} undiaried')

    print(f'Stats saved to {output_path}')
    print(f'  Total watched: {stats["totalWatched"]}')
    print(f'  Unique films: {stats["uniqueFilms"]}')
    print(f'  Rewatches: {stats["totalRewatches"]}')
    print(f'  Average rating: {stats["averageRating"]}')
    print(f'  Date range: {stats["dateRange"]["earliest"]} to {stats["dateRange"]["latest"]}')
    print(f'  Years covered: {len(stats["byYear"])}')
    print(f'  Watchlist: {stats["watchlist"]["count"]} '
          f'({stats["watchlist"]["removedSinceExport"]} logged since export)')
    print(f'  Liked films: {len(stats["likedFilms"])}')
    print(f'  Favorites: {len(stats["favoriteFilms"])}')
    print(f'  Lists: {len(stats["lists"])}')
    print(f'  Orphaned (removed) films: {len(stats["orphanedFilms"])}')
    print(f'  Tags: {len(stats["tagCloud"])}')


if __name__ == '__main__':
    main()
