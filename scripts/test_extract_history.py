"""Tests for scripts/extract_history.py.

Run from the repo root:  python -m pytest scripts/

main() reads module-level `data_dir`, `load_diary` and `get_export_date`, so the
merge tests point those at a tmp dir and an in-memory archive instead of the
real data/ folder. Nothing here touches the network or the real data files.
"""

import json
import sys
import xml.etree.ElementTree as ET
from datetime import date
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import extract_history as eh  # noqa: E402

RSS_HEAD = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" '
    'xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org">'
    '<channel>'
)
RSS_TAIL = '</channel></rss>'


def rss_item(guid, title, year, watched, rating='3.5', rewatch='No', tmdb='123',
             description='<p>Great.</p>'):
    return (
        '<item>'
        f'<title>{title}, {year}</title>'
        f'<link>https://letterboxd.com/u/film/{title.lower().replace(" ", "-")}/</link>'
        f'<guid isPermaLink="false">{guid}</guid>'
        f'<letterboxd:watchedDate>{watched}</letterboxd:watchedDate>'
        f'<letterboxd:rewatch>{rewatch}</letterboxd:rewatch>'
        f'<letterboxd:filmTitle>{title}</letterboxd:filmTitle>'
        f'<letterboxd:filmYear>{year}</letterboxd:filmYear>'
        f'<letterboxd:memberRating>{rating}</letterboxd:memberRating>'
        f'<tmdb:movieId>{tmdb}</tmdb:movieId>'
        f'<description><![CDATA[{description}]]></description>'
        '</item>'
    )


def rss_doc(*items):
    return RSS_HEAD + ''.join(items) + RSS_TAIL


def archive_entry(title, year, watched, rating=4.0):
    return {
        'guid': f'archive-{title}',
        'filmTitle': title,
        'filmYear': year,
        'watchedDate': watched,
        'memberRating': rating,
        'rewatch': False,
        'tags': [],
        'source': 'archive',
    }


def rss_entry(title, year, watched, rating=3.0):
    return {
        'guid': f'letterboxd-entry-{abs(hash((title, watched)))}',
        'filmTitle': title,
        'filmYear': year,
        'watchedDate': watched,
        'memberRating': rating,
        'rewatch': False,
        'tags': [],
        'source': 'rss',
    }


# --- strip_html -------------------------------------------------------------

def test_strip_html_removes_images_and_tags_and_keeps_paragraphs():
    html = '<p><img src="x.jpg"/></p> <p>first</p><p>second<br/>line</p>'
    assert eh.strip_html(html) == 'first\n\nsecond\nline'


def test_strip_html_unwraps_cdata_and_unescapes_entities():
    assert eh.strip_html('<![CDATA[&lt;p&gt;Tom &amp; Jerry&lt;/p&gt;]]>') == 'Tom & Jerry'


def test_strip_html_empty():
    assert eh.strip_html('') == ''
    assert eh.strip_html(None) == ''


# --- parse_rss_item ---------------------------------------------------------

def parse_one(xml_item):
    root = ET.fromstring(rss_doc(xml_item))
    return eh.parse_rss_item(root.find('.//item'))


def test_parse_rss_item_review():
    e = parse_one(rss_item('letterboxd-review-42', 'Heat', 1995, '2026-10-01',
                           rating='4.5', rewatch='Yes', tmdb='949'))
    assert e['guid'] == 'letterboxd-entry-42'
    assert e['filmTitle'] == 'Heat'
    assert e['filmYear'] == 1995
    assert e['watchedDate'] == '2026-10-01'
    assert e['memberRating'] == 4.5
    assert e['rewatch'] is True
    assert e['tmdbId'] == 949
    assert e['reviewText'] == 'Great.'
    assert e['source'] == 'rss'


def test_parse_rss_item_watch_guid_normalized_like_review():
    e = parse_one(rss_item('letterboxd-watch-7', 'Heat', 1995, '2026-10-01'))
    assert e['guid'] == 'letterboxd-entry-7'


@pytest.mark.parametrize('guid', ['letterboxd-list-9', 'something-else-1'])
def test_parse_rss_item_skips_non_diary_items(guid):
    assert parse_one(rss_item(guid, 'Heat', 1995, '2026-10-01')) is None


def test_parse_rss_item_missing_rating_is_none():
    e = parse_one(rss_item('letterboxd-watch-1', 'Heat', 1995, '2026-10-01', rating=''))
    assert e['memberRating'] is None


def test_parse_rss_xml_bad_xml_returns_empty():
    assert eh.parse_rss_xml('<rss><broken', 'test') == []


# --- merge_key --------------------------------------------------------------

def test_merge_key_normalizes_title_case_and_whitespace():
    a = {'filmTitle': '  Heat ', 'filmYear': 1995, 'watchedDate': '2026-10-01'}
    b = {'filmTitle': 'heat', 'filmYear': 1995, 'watchedDate': '2026-10-01'}
    assert eh.merge_key(a) == eh.merge_key(b) == ('heat', 1995, '2026-10-01')


def test_merge_key_distinguishes_watch_dates_and_years():
    base = {'filmTitle': 'Heat', 'filmYear': 1995, 'watchedDate': '2026-10-01'}
    assert eh.merge_key(base) != eh.merge_key({**base, 'watchedDate': '2026-10-02'})
    assert eh.merge_key(base) != eh.merge_key({**base, 'filmYear': 1986})


# --- load_previous_rss_entries ----------------------------------------------

def test_load_previous_rss_entries_keeps_only_rss(tmp_path):
    path = tmp_path / 'viewing_history.json'
    path.write_text(json.dumps([
        archive_entry('Alien', 1979, '2026-01-01'),
        rss_entry('Heat', 1995, '2026-10-01'),
    ]))
    out = eh.load_previous_rss_entries(path)
    assert [e['filmTitle'] for e in out] == ['Heat']


def test_load_previous_rss_entries_missing_or_corrupt(tmp_path):
    assert eh.load_previous_rss_entries(tmp_path / 'nope.json') == []
    bad = tmp_path / 'bad.json'
    bad.write_text('{not json')
    assert eh.load_previous_rss_entries(bad) == []


# --- main(): the archive + RSS + carry-forward merge --------------------------

@pytest.fixture
def pipeline(tmp_path, monkeypatch):
    """Run main() against a tmp data dir with a given archive / rss / previous history."""
    monkeypatch.setattr(eh, 'data_dir', tmp_path)
    monkeypatch.setattr(sys, 'argv', ['extract_history.py'])

    def run(archive=(), export_date=date(2026, 9, 1), rss_items=None, previous=None):
        monkeypatch.setattr(eh, 'load_diary', lambda: list(archive))
        monkeypatch.setattr(eh, 'get_export_date', lambda: export_date)
        if rss_items is not None:
            (tmp_path / 'rss.xml').write_text(rss_doc(*rss_items), encoding='utf-8')
        if previous is not None:
            (tmp_path / 'viewing_history.json').write_text(json.dumps(previous), encoding='utf-8')
        eh.main()
        return json.loads((tmp_path / 'viewing_history.json').read_text(encoding='utf-8'))

    return run


def titles(entries):
    return [e['filmTitle'] for e in entries]


def test_rss_entry_after_export_is_appended(pipeline):
    out = pipeline(
        archive=[archive_entry('Alien', 1979, '2026-08-01')],
        rss_items=[rss_item('letterboxd-watch-1', 'Heat', 1995, '2026-10-01')],
    )
    assert titles(out) == ['Heat', 'Alien']  # sorted watchedDate desc


def test_archive_wins_over_rss_for_same_key(pipeline):
    out = pipeline(
        archive=[archive_entry('Heat', 1995, '2026-10-01', rating=5.0)],
        rss_items=[rss_item('letterboxd-watch-1', 'heat', 1995, '2026-10-01', rating='1.0')],
    )
    assert len(out) == 1
    assert out[0]['source'] == 'archive'
    assert out[0]['memberRating'] == 5.0


def test_rss_entries_older_than_export_cutoff_are_dropped(pipeline):
    # cutoff = export_date - 1 day = 2026-08-31; archive deletes must win.
    out = pipeline(
        export_date=date(2026, 9, 1),
        rss_items=[
            rss_item('letterboxd-watch-1', 'Old', 2000, '2026-08-30'),
            rss_item('letterboxd-watch-2', 'Edge', 2000, '2026-08-31'),
        ],
    )
    assert titles(out) == ['Edge']


def test_previous_rss_entries_are_carried_forward(pipeline):
    # Scrolled out of the current feed but present in last run's history.
    previous = [
        rss_entry('Scrolled Out', 2020, '2026-09-10'),
        archive_entry('Alien', 1979, '2026-08-01'),  # archive rows are NOT carried
    ]
    out = pipeline(
        archive=[],
        rss_items=[rss_item('letterboxd-watch-1', 'Heat', 1995, '2026-10-01')],
        previous=previous,
    )
    assert titles(out) == ['Heat', 'Scrolled Out']


def test_current_feed_copy_overrides_carried_forward_copy(pipeline):
    previous = [rss_entry('Heat', 1995, '2026-10-01', rating=2.0)]
    out = pipeline(
        rss_items=[rss_item('letterboxd-watch-1', 'Heat', 1995, '2026-10-01', rating='4.0')],
        previous=previous,
    )
    assert len(out) == 1
    assert out[0]['memberRating'] == 4.0


def test_carry_forward_is_idempotent_across_runs(pipeline):
    items = [rss_item('letterboxd-watch-1', 'Heat', 1995, '2026-10-01')]
    first = pipeline(archive=[archive_entry('Alien', 1979, '2026-08-01')], rss_items=items)
    second = pipeline(archive=[archive_entry('Alien', 1979, '2026-08-01')], rss_items=items)
    assert first == second


def test_missing_rss_file_keeps_carried_forward_history(pipeline):
    out = pipeline(previous=[rss_entry('Heat', 1995, '2026-10-01')])
    assert titles(out) == ['Heat']


def test_no_export_date_disables_cutoff(pipeline):
    out = pipeline(
        export_date=None,
        rss_items=[rss_item('letterboxd-watch-1', 'Ancient', 1950, '2001-01-01')],
    )
    assert titles(out) == ['Ancient']


def test_backfill_from_git_entries_are_merged_oldest_first(pipeline, monkeypatch):
    monkeypatch.setattr(sys, 'argv', ['extract_history.py', '--backfill-from-git'])
    git_entries = [
        rss_entry('Lost', 2010, '2026-09-05', rating=1.0),
        rss_entry('Heat', 1995, '2026-10-01', rating=1.0),
    ]
    monkeypatch.setattr(eh, 'load_git_rss_entries', lambda: list(git_entries))
    out = pipeline(
        rss_items=[rss_item('letterboxd-watch-1', 'Heat', 1995, '2026-10-01', rating='4.0')],
    )
    assert titles(out) == ['Heat', 'Lost']
    assert out[0]['memberRating'] == 4.0  # current feed beats git history
