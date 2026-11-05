"""Tests for compute_stats.compute_rewatches (the Rewatches page data).
Run: python -m pytest scripts/"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import compute_stats as cs  # noqa: E402


def log(title, year, date, rewatch=False, tmdb=None, link=None, rating=None, review=''):
    return {'filmTitle': title, 'filmYear': year, 'watchedDate': date, 'rewatch': rewatch,
            'tmdbId': tmdb, 'link': link or f'https://boxd.it/{title[:2]}{date}',
            'memberRating': rating, 'reviewText': review}


WATCHED = [
    {'name': 'Midsommar', 'year': 2019, 'link': 'https://boxd.it/film-mid'},
    {'name': 'Pig', 'year': 2021, 'link': 'https://boxd.it/film-pig'},
    {'name': 'Jaws', 'year': 1975, 'link': 'https://boxd.it/film-jaws'},
    {'name': 'Alien', 'year': 1979, 'link': 'https://boxd.it/film-alien'},
    {'name': 'Heat', 'year': 1995, 'link': 'https://boxd.it/film-heat'},
]


def entries():
    return [
        log('Midsommar', 2019, '2021-01-01'),
        log('Midsommar', 2019, '2022-06-01', rewatch=True),
        # An RSS log carries a tmdbId the archive rows don't; it must still merge.
        log('midsommar ', 2019, '2026-11-02', rewatch=True, tmdb='530385'),
        log('Pig', 2021, '2024-03-01'),
        log('Pig', 2021, '2024-05-01', rewatch=True),
        log('Jaws', 1975, '2023-07-04', rewatch=True),  # first seen before the diary
        log('Heat', 1995, '2020-02-02'),                 # watched once, not a rewatch
    ]


def test_groups_by_name_and_year_across_sources():
    r = cs.compute_rewatches(entries(), WATCHED)
    mid = r['films'][0]
    assert (mid['filmTitle'], mid['count'], mid['rewatchLogs']) == ('Midsommar', 3, 2)
    assert [w['date'] for w in mid['watches']] == ['2021-01-01', '2022-06-01', '2026-11-02']
    assert mid['link'] == 'https://boxd.it/film-mid'  # the film page, not one diary entry


def test_ranked_most_logs_then_most_recent_and_includes_seen_before_diary():
    r = cs.compute_rewatches(entries(), WATCHED)
    assert [(f['filmTitle'], f['count']) for f in r['films']] == [('Midsommar', 3), ('Pig', 2), ('Jaws', 1)]


def test_totals_identity_and_definitions():
    t = cs.compute_rewatches(entries(), WATCHED)['totals']
    assert t['logs'] == 7
    assert t['rewatchLogs'] == 4
    assert t['filmsRewatched'] == 3
    assert t['filmsLoggedTwice'] == 2
    assert t['loggedOnceAsRewatch'] == 1
    assert t['filmsRewatched'] == t['filmsLoggedTwice'] + t['loggedOnceAsRewatch']
    assert t['seenBeforeDiary'] == 1  # Jaws; Midsommar's and Pig's first logs aren't rewatches
    assert t['filmsLogged'] == 4
    assert t['filmsWatched'] == 5
    assert t['undiaried'] == 1


def test_undiaried_is_watched_minus_diary():
    r = cs.compute_rewatches(entries(), WATCHED)
    assert r['undiaried'] == [{'name': 'Alien', 'year': 1979, 'link': 'https://boxd.it/film-alien'}]


def test_by_year_counts_logs_rewatches_and_distinct_films():
    by = cs.compute_rewatches(entries(), WATCHED)['byYear']
    assert by['2024'] == {'logs': 2, 'rewatchLogs': 1, 'filmsRewatched': 1}
    assert by['2021'] == {'logs': 1, 'rewatchLogs': 0, 'filmsRewatched': 0}
    assert list(by) == sorted(by)


def test_film_watched_twice_without_rewatch_flag_still_listed():
    r = cs.compute_rewatches([log('Heat', 1995, '2020-01-01'), log('Heat', 1995, '2021-01-01')], WATCHED)
    assert r['films'][0]['count'] == 2 and r['films'][0]['rewatchLogs'] == 0
    assert r['totals']['filmsLoggedTwice'] == 1 and r['totals']['filmsRewatched'] == 0


def test_seen_before_diary_counts_multi_log_films_whose_first_log_is_a_rewatch():
    t = cs.compute_rewatches([log('Heat', 1995, '2020-01-01', rewatch=True),
                              log('Heat', 1995, '2021-01-01', rewatch=True)], WATCHED)['totals']
    assert (t['seenBeforeDiary'], t['loggedOnceAsRewatch'], t['filmsLoggedTwice']) == (1, 0, 1)


def test_each_watch_keeps_its_own_diary_entry_link_rating_and_review_flag():
    r = cs.compute_rewatches([log('Pig', 2021, '2024-05-01', rewatch=True, link='https://boxd.it/b', rating=5.0, review='so good'),
                              log('Pig', 2021, '2024-03-01', link='https://boxd.it/a', review='  ')], WATCHED)
    assert r['films'][0]['watches'] == [
        {'date': '2024-03-01', 'rewatch': False, 'link': 'https://boxd.it/a', 'rating': None, 'review': False},
        {'date': '2024-05-01', 'rewatch': True, 'link': 'https://boxd.it/b', 'rating': 5.0, 'review': True},
    ]
