"""Tests for scripts/compute_network.py. Run: python -m pytest scripts/"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import compute_network as cn  # noqa: E402


def person(handle, name=None, **kw):
    return {'handle': handle, 'displayName': name or handle, 'avatar': None,
            'followers': 1, 'following': 1, 'filmsWatched': 1, **kw}


def export(owner, lst, handles, exported='2026-11-03T10:00:00Z', complete=True):
    return {'schema': cn.SCHEMA, 'owner': owner, 'list': lst, 'exportedAt': exported,
            'complete': complete, 'people': [person(h) for h in handles]}


def write(dir_, name, obj):
    (dir_ / name).write_text(json.dumps(obj))


def test_relations_and_counts():
    out = cn.build({
        ('michaellamb', 'followers'): export('michaellamb', 'followers', ['a', 'b', 'c']),
        ('michaellamb', 'following'): export('michaellamb', 'following', ['b', 'c', 'd']),
    }, jxn_handles={'c', 'd', 'zzz'})
    rel = {p['handle']: p['relation'] for p in out['people']}
    assert rel == {'a': 'follower', 'b': 'mutual', 'c': 'mutual', 'd': 'following'}
    c = out['counts']
    assert (c['followers'], c['following'], c['mutual']) == (3, 3, 2)
    assert (c['followerOnly'], c['followingOnly']) == (1, 1)
    # zzz is a club member outside the network: not counted, not emitted.
    assert (c['jxn'], c['jxnMutual']) == (2, 1)
    assert {p['handle'] for p in out['people'] if p['jxn']} == {'c', 'd'}


def test_handles_match_case_insensitively_and_owner_is_dropped():
    out = cn.build({
        ('michaellamb', 'followers'): export('michaellamb', 'followers', ['IsaFilms', 'michaellamb']),
        ('michaellamb', 'following'): export('michaellamb', 'following', ['isafilms']),
    }, jxn_handles={'isafilms'})
    assert [(p['handle'], p['relation'], p['jxn']) for p in out['people']] == [('isafilms', 'mutual', True)]


def test_member_fields_never_leak(tmp_path):
    members = tmp_path / 'members.json'
    members.write_text(json.dumps([
        {'id': 'x1', 'name': 'Real Name', 'pronouns': 'they/them', 'handle': 'B'},
        {'id': 'x2', 'name': 'No Handle'},
        {'id': 'me', 'name': 'Owner', 'handle': 'michaellamb'},
    ]))
    assert cn.load_jxn_handles(members) == {'b'}
    out = cn.build({
        ('michaellamb', 'followers'): export('michaellamb', 'followers', ['b']),
        ('michaellamb', 'following'): export('michaellamb', 'following', []),
    }, cn.load_jxn_handles(members))
    blob = json.dumps(out)
    assert 'Real Name' not in blob and 'x1' not in blob and 'they/them' not in blob


def test_newest_export_wins_and_foreign_schema_ignored(tmp_path):
    write(tmp_path, 'old.json', export('michaellamb', 'followers', ['old'], exported='2026-01-01T00:00:00Z'))
    write(tmp_path, 'new.json', export('michaellamb', 'followers', ['new'], exported='2026-11-03T00:00:00Z'))
    write(tmp_path, 'other.json', {'schema': 'something-else', 'owner': 'michaellamb', 'list': 'followers'})
    (tmp_path / 'broken.json').write_text('{not json')
    exports = cn.load_exports(tmp_path)
    assert [p['handle'] for p in exports[('michaellamb', 'followers')]['people']] == ['new']


def test_followers_you_know_become_edges():
    out = cn.build({
        ('michaellamb', 'followers'): export('michaellamb', 'followers', ['a', 'b']),
        ('michaellamb', 'following'): export('michaellamb', 'following', ['a', 'b', 'c']),
        # On b's profile: people I follow who follow b. 'outsider' isn't in my
        # network and 'b' itself must not self-loop.
        ('b', 'followers-you-know'): export('b', 'followers-you-know', ['A', 'c', 'outsider', 'b']),
        # An export for someone outside the network contributes nothing.
        ('stranger', 'followers-you-know'): export('stranger', 'followers-you-know', ['a']),
    }, jxn_handles=set())
    assert out['edges'] == [['a', 'b'], ['c', 'b']]
    assert out['counts']['edges'] == 2


def test_someone_elses_following_list_points_outward():
    out = cn.build({
        ('michaellamb', 'followers'): export('michaellamb', 'followers', ['a', 'b']),
        ('michaellamb', 'following'): export('michaellamb', 'following', ['a', 'b']),
        ('a', 'following'): export('a', 'following', ['b']),
    }, jxn_handles=set())
    assert out['edges'] == [['a', 'b']]  # a follows b, not the reverse


def test_missing_list_is_an_error():
    with pytest.raises(SystemExit):
        cn.build({('michaellamb', 'followers'): export('michaellamb', 'followers', ['a'])}, set())
