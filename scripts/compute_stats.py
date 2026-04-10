#!/usr/bin/env python3
"""Compute stats from the cumulative viewing history JSON.

Reads data/viewing_history.json and produces data/stats.json with
pre-computed statistics for the dashboard.
"""

import json
from collections import Counter, defaultdict
from pathlib import Path

script_dir = Path(__file__).parent
base_dir = script_dir.parent
data_dir = base_dir / 'data'


def compute_stats(entries):
    """Compute all dashboard stats from a list of diary entries."""
    total_watched = len(entries)
    tmdb_ids = [e['tmdbId'] for e in entries if e.get('tmdbId')]
    unique_films = len(set(tmdb_ids))
    total_rewatches = sum(1 for e in entries if e.get('rewatch'))

    # Ratings
    rated_entries = [e for e in entries if e.get('memberRating') is not None]
    ratings = [e['memberRating'] for e in rated_entries]
    average_rating = round(sum(ratings) / len(ratings), 2) if ratings else 0

    # Rating distribution: 0.5 to 5.0 in 0.5 steps + unrated
    rating_dist = Counter()
    unrated = 0
    for e in entries:
        r = e.get('memberRating')
        if r is not None:
            rating_dist[str(r)] += 1
        else:
            unrated += 1
    rating_distribution = {}
    for step in [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0]:
        rating_distribution[str(step)] = rating_dist.get(str(step), 0)
    rating_distribution['unrated'] = unrated

    # Films by month
    films_by_month = Counter()
    for e in entries:
        d = e.get('watchedDate')
        if d and len(d) >= 7:
            films_by_month[d[:7]] += 1
    # Sort by month
    films_by_month = dict(sorted(films_by_month.items()))

    # Heatmap data: count per day
    films_by_day = Counter()
    for e in entries:
        d = e.get('watchedDate')
        if d:
            films_by_day[d] += 1
    heatmap_data = [
        {'date': date, 'count': count}
        for date, count in sorted(films_by_day.items())
    ]

    # Film year distribution by decade
    decade_dist = Counter()
    for e in entries:
        year = e.get('filmYear')
        if year:
            decade = f'{(year // 10) * 10}s'
            decade_dist[decade] += 1
    film_year_distribution = dict(sorted(decade_dist.items()))

    # Most rewatched: group by tmdbId, count watches, top 10
    watch_counts = defaultdict(lambda: {'count': 0, 'filmTitle': '', 'filmYear': None, 'tmdbId': None})
    for e in entries:
        tid = e.get('tmdbId')
        if tid:
            watch_counts[tid]['count'] += 1
            watch_counts[tid]['filmTitle'] = e.get('filmTitle', '')
            watch_counts[tid]['filmYear'] = e.get('filmYear')
            watch_counts[tid]['tmdbId'] = tid
    most_rewatched = sorted(
        [v for v in watch_counts.values() if v['count'] > 1],
        key=lambda x: x['count'],
        reverse=True,
    )[:10]

    # Recent activity: last 20 entries
    recent_activity = entries[:20]

    # Highest rated: 5-star films, deduplicated by tmdbId
    seen_five_star = set()
    highest_rated = []
    for e in entries:
        if e.get('memberRating') == 5.0:
            key = e.get('tmdbId') or e.get('filmTitle')
            if key not in seen_five_star:
                seen_five_star.add(key)
                highest_rated.append({
                    'filmTitle': e.get('filmTitle'),
                    'filmYear': e.get('filmYear'),
                    'watchedDate': e.get('watchedDate'),
                    'link': e.get('link'),
                    'tmdbId': e.get('tmdbId'),
                })

    # Date range
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


def main():
    history_path = data_dir / 'viewing_history.json'
    if not history_path.exists():
        print(f'Error: {history_path} not found. Run extract_history.py first.')
        return

    with open(history_path, 'r', encoding='utf-8') as f:
        entries = json.load(f)

    print(f'Computing stats from {len(entries)} entries...')
    stats = compute_stats(entries)

    output_path = data_dir / 'stats.json'
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump(stats, f, ensure_ascii=False, indent=2)

    print(f'Stats saved to {output_path}')
    print(f'  Total watched: {stats["totalWatched"]}')
    print(f'  Unique films: {stats["uniqueFilms"]}')
    print(f'  Rewatches: {stats["totalRewatches"]}')
    print(f'  Average rating: {stats["averageRating"]}')
    print(f'  Date range: {stats["dateRange"]["earliest"]} to {stats["dateRange"]["latest"]}')


if __name__ == '__main__':
    main()
