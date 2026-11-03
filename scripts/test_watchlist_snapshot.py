"""Tests for the watchlist snapshot: load_archive.load_watchlist_snapshot and
compute_stats.compute_watchlist_stats. Run: python -m pytest scripts/"""

import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import compute_stats as cs  # noqa: E402
import load_archive as la  # noqa: E402

HEADER = 'Date,Name,Year,Letterboxd URI\n'


def write_csv(path, rows):
    path.write_text(HEADER + ''.join(f'{d},{n},{y},https://boxd.it/{n[:3]}\n' for d, n, y in rows))


def archive(root, stamp, rows):
    d = root / f'letterboxd-michaellamb-{stamp}-utc'
    d.mkdir()
    write_csv(d / 'watchlist.csv', rows)


def test_standalone_export_newer_than_archive_wins(tmp_path):
    archive(tmp_path, '2026-07-09-02-44', [('2020-01-01', 'Old', 2000)])
    write_csv(tmp_path / 'watchlist-michaellamb-2026-11-03-17-26-utc.csv',
              [('2020-01-01', 'Old', 2000), ('2026-11-01', 'New', 2026)])
    items, when, source = la.load_watchlist_snapshot(tmp_path)
    assert [i['name'] for i in items] == ['Old', 'New']
    assert when == date(2026, 11, 3)
    assert source == 'watchlist-michaellamb-2026-11-03-17-26-utc.csv'


def test_newer_full_archive_beats_older_standalone_export(tmp_path):
    write_csv(tmp_path / 'watchlist-michaellamb-2026-11-03-17-26-utc.csv', [('2020-01-01', 'Stale', 2000)])
    archive(tmp_path, '2026-12-01-09-00', [('2020-01-01', 'Fresh', 2000)])
    items, when, source = la.load_watchlist_snapshot(tmp_path)
    assert [i['name'] for i in items] == ['Fresh']
    assert when == date(2026, 12, 1)
    assert source.startswith('letterboxd-')


def test_same_day_exports_compare_by_time(tmp_path):
    write_csv(tmp_path / 'watchlist-michaellamb-2026-11-03-09-00-utc.csv', [('2020-01-01', 'Morning', 2000)])
    write_csv(tmp_path / 'watchlist-michaellamb-2026-11-03-17-26-utc.csv', [('2020-01-01', 'Evening', 2000)])
    assert [i['name'] for i in la.load_watchlist_snapshot(tmp_path)[0]] == ['Evening']


def test_no_exports(tmp_path):
    assert la.load_watchlist_snapshot(tmp_path) == ([], None, None)
    assert la.load_watchlist_snapshot(tmp_path / 'missing') == ([], None, None)


def entry(title, year, watched, source='rss'):
    return {'filmTitle': title, 'filmYear': year, 'watchedDate': watched, 'source': source}


def test_only_films_logged_since_the_snapshot_are_dropped():
    snapshot = ([
        {'name': 'Logged After', 'year': 2026, 'link': None, 'addedDate': '2026-10-01'},
        {'name': 'Logged Before', 'year': 2020, 'link': None, 'addedDate': '2026-10-02'},
        {'name': 'Untouched', 'year': 1999, 'link': None, 'addedDate': '2026-10-03'},
    ], date(2026, 11, 3), 'watchlist-x.csv')
    stats = cs.compute_watchlist_stats([
        entry('Logged After', 2026, '2026-11-04'),
        # RSS entry older than the snapshot: the film was re-added after
        # watching, so it really is on the watchlist.
        entry('Logged Before', 2020, '2026-10-15'),
    ], snapshot)
    assert stats['count'] == 2
    assert stats['removedSinceExport'] == 1
    assert [i['name'] for i in stats['recentlyAdded']] == ['Untouched', 'Logged Before']
    assert stats['snapshotDate'] == '2026-11-03'
    assert stats['snapshotSource'] == 'watchlist-x.csv'
