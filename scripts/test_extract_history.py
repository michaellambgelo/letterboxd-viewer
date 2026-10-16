#!/usr/bin/env python3
"""Tests for extract_history.py: RSS parsing, merge key, and the
archive + carry-forward + current-RSS merge in main().

Stdlib only (unittest), so no install is needed; pytest also collects it.

    python3 -m unittest discover -s scripts -p 'test_*.py'
"""

import io
import json
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from contextlib import redirect_stdout
from datetime import date
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))

import extract_history as eh  # noqa: E402

RSS_HEAD = (
    '<?xml version="1.0" encoding="utf-8"?>'
    '<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/" '
    'xmlns:letterboxd="https://letterboxd.com" xmlns:tmdb="https://themoviedb.org">'
    '<channel><title>Letterboxd - Test Member</title>'
)
RSS_TAIL = '</channel></rss>'


def rss_item(guid, title, year, watched, rating=None, rewatch='No', tmdb=None,
             description='<p>Watched.</p>'):
    parts = [
        '<item>',
        f'<title>{title}, {year}</title>',
        f'<link>https://letterboxd.com/testmember/film/{title.lower().replace(" ", "-")}/</link>',
        f'<guid isPermaLink="false">{guid}</guid>',
        f'<letterboxd:watchedDate>{watched}</letterboxd:watchedDate>',
        f'<letterboxd:rewatch>{rewatch}</letterboxd:rewatch>',
        f'<letterboxd:filmTitle>{title}</letterboxd:filmTitle>',
        f'<letterboxd:filmYear>{year}</letterboxd:filmYear>',
    ]
    if rating is not None:
        parts.append(f'<letterboxd:memberRating>{rating}</letterboxd:memberRating>')
    if tmdb is not None:
        parts.append(f'<tmdb:movieId>{tmdb}</tmdb:movieId>')
    parts.append(f'<description><![CDATA[{description}]]></description>')
    parts.append('</item>')
    return ''.join(parts)


def rss_doc(*items):
    return RSS_HEAD + ''.join(items) + RSS_TAIL


LIST_ITEM = (
    '<item><title>My Favourite Westerns</title>'
    '<guid isPermaLink="false">letterboxd-list-12345</guid>'
    '<description><![CDATA[<p>A list.</p>]]></description></item>'
)


def archive_entry(title, year, watched, rating=None):
    return {
        'guid': f'archive-{title}',
        'filmTitle': title,
        'filmYear': year,
        'watchedDate': watched,
        'memberRating': rating,
        'rewatch': False,
        'tmdbId': None,
        'link': None,
        'title': None,
        'reviewText': '',
        'tags': [],
        'source': 'archive',
    }


class ParseRssTests(unittest.TestCase):
    def test_parses_diary_entries_and_skips_lists(self):
        xml = rss_doc(
            LIST_ITEM,
            rss_item('letterboxd-watch-111', 'Jaws', 1975, '2026-05-04',
                     rating='4.5', rewatch='Yes', tmdb=578,
                     description='<p><img src="x.jpg"/></p> <p>Pool party</p>'),
            rss_item('letterboxd-review-222', 'Alien', 1979, '2026-05-05'),
        )
        entries = eh.parse_rss_xml(xml, 'test')
        self.assertEqual([e['filmTitle'] for e in entries], ['Jaws', 'Alien'])

        jaws = entries[0]
        self.assertEqual(jaws['guid'], 'letterboxd-entry-111')
        self.assertEqual(jaws['filmYear'], 1975)
        self.assertEqual(jaws['watchedDate'], '2026-05-04')
        self.assertEqual(jaws['memberRating'], 4.5)
        self.assertIs(jaws['rewatch'], True)
        self.assertEqual(jaws['tmdbId'], 578)
        self.assertEqual(jaws['reviewText'], 'Pool party')
        self.assertEqual(jaws['source'], 'rss')

        alien = entries[1]
        self.assertEqual(alien['guid'], 'letterboxd-entry-222')
        self.assertIsNone(alien['memberRating'])
        self.assertIs(alien['rewatch'], False)
        self.assertIsNone(alien['tmdbId'])

    def test_unknown_guid_prefix_is_ignored(self):
        item = ET.fromstring('<item><guid>something-else-1</guid></item>')
        self.assertIsNone(eh.parse_rss_item(item))

    def test_malformed_xml_returns_empty(self):
        with redirect_stdout(io.StringIO()), mock.patch('sys.stderr', io.StringIO()):
            self.assertEqual(eh.parse_rss_xml('<rss><channel>', 'bad'), [])

    def test_worker_fixture_feed(self):
        fixture = Path(__file__).parent.parent / 'worker' / 'fixtures' / 'feed.xml'
        entries = eh.load_rss_entries(fixture)
        self.assertEqual(len(entries), 5)  # the list item is dropped
        self.assertEqual(entries[0]['filmTitle'], 'The Great Muppet Caper')
        self.assertEqual(entries[1]['filmTitle'], "Lee Cronin's The Mummy")


class MergeKeyTests(unittest.TestCase):
    def test_title_case_and_whitespace_insensitive(self):
        a = {'filmTitle': ' Jaws ', 'filmYear': 1975, 'watchedDate': '2026-05-04'}
        b = {'filmTitle': 'jaws', 'filmYear': 1975, 'watchedDate': '2026-05-04'}
        self.assertEqual(eh.merge_key(a), eh.merge_key(b))

    def test_different_watch_dates_are_distinct(self):
        a = {'filmTitle': 'Jaws', 'filmYear': 1975, 'watchedDate': '2026-05-04'}
        b = {'filmTitle': 'Jaws', 'filmYear': 1975, 'watchedDate': '2026-05-05'}
        self.assertNotEqual(eh.merge_key(a), eh.merge_key(b))


class MainMergeTests(unittest.TestCase):
    """Run main() against a temp data dir with a stubbed archive."""

    EXPORT_DATE = date(2026, 7, 1)

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.data_dir = Path(self._tmp.name)
        self.history_path = self.data_dir / 'viewing_history.json'
        self.archive = [
            archive_entry('Old Film', 2000, '2026-06-20', rating=3.0),
            archive_entry('Jaws', 1975, '2026-06-30', rating=5.0),
        ]

    def tearDown(self):
        self._tmp.cleanup()

    def write_rss(self, *items):
        (self.data_dir / 'rss.xml').write_text(rss_doc(*items), encoding='utf-8')

    def write_previous(self, entries):
        self.history_path.write_text(json.dumps(entries), encoding='utf-8')

    def run_main(self, argv=(), git_entries=None):
        patches = [
            mock.patch.object(eh, 'data_dir', self.data_dir),
            mock.patch.object(eh, 'load_diary', return_value=list(self.archive)),
            mock.patch.object(eh, 'get_export_date', return_value=self.EXPORT_DATE),
            mock.patch.object(sys, 'argv', ['extract_history.py', *argv]),
            mock.patch.object(eh, 'load_git_rss_entries', return_value=git_entries or []),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        with redirect_stdout(io.StringIO()):
            eh.main()
        return json.loads(self.history_path.read_text(encoding='utf-8'))

    def titles(self, history):
        return [e['filmTitle'] for e in history]

    def test_archive_plus_new_rss(self):
        self.write_rss(rss_item('letterboxd-watch-1', 'New Film', 2026, '2026-07-10'))
        history = self.run_main()
        self.assertEqual(self.titles(history), ['New Film', 'Jaws', 'Old Film'])

    def test_archive_wins_over_rss_duplicate(self):
        self.write_rss(rss_item('letterboxd-watch-1', 'JAWS', 1975, '2026-06-30', rating='1.0'))
        history = self.run_main()
        jaws = [e for e in history if e['filmTitle'].lower() == 'jaws']
        self.assertEqual(len(jaws), 1)
        self.assertEqual(jaws[0]['source'], 'archive')
        self.assertEqual(jaws[0]['memberRating'], 5.0)

    def test_carry_forward_keeps_entries_that_scrolled_out_of_rss(self):
        carried = eh.parse_rss_xml(rss_doc(
            rss_item('letterboxd-watch-2', 'Scrolled Out', 2025, '2026-07-05'),
        ), 'prev')
        # Previous history also holds archive rows; only rss rows carry forward.
        self.write_previous(carried + self.archive)
        self.write_rss(rss_item('letterboxd-watch-3', 'Still In Feed', 2026, '2026-07-20'))

        history = self.run_main()
        self.assertEqual(self.titles(history), ['Still In Feed', 'Scrolled Out', 'Jaws', 'Old Film'])

    def test_current_rss_overrides_carried_forward_copy(self):
        carried = eh.parse_rss_xml(rss_doc(
            rss_item('letterboxd-watch-4', 'Edited', 2026, '2026-07-15', rating='2.0'),
        ), 'prev')
        self.write_previous(carried)
        self.write_rss(rss_item('letterboxd-watch-4', 'Edited', 2026, '2026-07-15', rating='4.0'))

        history = self.run_main()
        edited = [e for e in history if e['filmTitle'] == 'Edited']
        self.assertEqual(len(edited), 1)
        self.assertEqual(edited[0]['memberRating'], 4.0)

    def test_rss_entries_before_cutoff_are_dropped(self):
        # cutoff = export_date - 1 day = 2026-06-30; earlier RSS rows are
        # assumed deleted from Letterboxd if the archive doesn't have them.
        self.write_rss(
            rss_item('letterboxd-watch-5', 'Too Old', 2020, '2026-06-29'),
            rss_item('letterboxd-watch-6', 'On Cutoff', 2020, '2026-06-30'),
        )
        history = self.run_main()
        self.assertNotIn('Too Old', self.titles(history))
        self.assertIn('On Cutoff', self.titles(history))

    def test_missing_previous_history_and_rss(self):
        history = self.run_main()
        self.assertEqual(self.titles(history), ['Jaws', 'Old Film'])

    def test_corrupt_previous_history_is_ignored(self):
        self.history_path.write_text('{not json', encoding='utf-8')
        self.write_rss(rss_item('letterboxd-watch-7', 'New Film', 2026, '2026-07-10'))
        with mock.patch('sys.stderr', io.StringIO()):
            history = self.run_main()
        self.assertEqual(self.titles(history), ['New Film', 'Jaws', 'Old Film'])

    def test_backfill_from_git_recovers_lost_entries(self):
        git_entries = eh.parse_rss_xml(rss_doc(
            rss_item('letterboxd-watch-8', 'Lost', 2026, '2026-07-08', rating='3.0'),
            rss_item('letterboxd-watch-9', 'Later Edited', 2026, '2026-07-09', rating='1.0'),
        ), 'git')
        self.write_rss(rss_item('letterboxd-watch-9', 'Later Edited', 2026, '2026-07-09', rating='5.0'))

        without = self.run_main(git_entries=git_entries)
        self.assertNotIn('Lost', self.titles(without))

        history = self.run_main(argv=['--backfill-from-git'], git_entries=git_entries)
        self.assertIn('Lost', self.titles(history))
        edited = [e for e in history if e['filmTitle'] == 'Later Edited']
        self.assertEqual(len(edited), 1)
        self.assertEqual(edited[0]['memberRating'], 5.0)


if __name__ == '__main__':
    unittest.main()
