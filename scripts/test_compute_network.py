"""Tests for scripts/compute_network.py. Run: python -m pytest scripts/"""

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import compute_network as cn  # noqa: E402


def person(handle):
    # A schema /1 row, with every field the old export captured, so the leak
    # test can check that none of it survives.
    return {'handle': handle, 'displayName': f'Name of {handle}',
            'avatar': f'https://a.ltrbxd.com/avatar/{handle}.jpg',
            'followers': 12345, 'following': 678, 'filmsWatched': 9012}


def export(owner, lst, handles, exported='2026-11-03T10:00:00Z', complete=True,
           schema='letterboxd-network-export/1'):
    return {'schema': schema, 'owner': owner, 'list': lst, 'exportedAt': exported,
            'complete': complete, 'people': [person(h) for h in handles]}


class NoShuffle:
    """Keeps nodes in sorted-handle order so a test can name them."""
    def shuffle(self, seq):
        pass


def build(exports, jxn):
    """build() with nodes in sorted-handle order, keyed back to handles."""
    out = cn.build(exports, jxn, rng=NoShuffle())
    handles = sorted({cn.norm(p['handle']) for (o, _), e in exports.items() if o == cn.OWNER
                      for p in e['people']} - {cn.OWNER})
    return out, handles


def write(dir_, name, obj):
    (dir_ / name).write_text(json.dumps(obj))


def test_relations_and_counts():
    out, handles = build({
        ('michaellamb', 'followers'): export('michaellamb', 'followers', ['a', 'b', 'c']),
        ('michaellamb', 'following'): export('michaellamb', 'following', ['b', 'c', 'd']),
    }, {'c', 'd', 'zzz'})
    rel = {h: n['relation'] for h, n in zip(handles, out['nodes'])}
    assert rel == {'a': 'follower', 'b': 'mutual', 'c': 'mutual', 'd': 'following'}
    c = out['counts']
    assert (c['followers'], c['following'], c['mutual']) == (3, 3, 2)
    assert (c['followerOnly'], c['followingOnly']) == (1, 1)
    # zzz is a club member outside the network: not counted, not emitted.
    assert (c['jxn'], c['jxnMutual']) == (2, 1)
    assert {h for h, n in zip(handles, out['nodes']) if n['jxn']} == {'c', 'd'}


def test_handles_match_case_insensitively_and_owner_is_dropped():
    out = cn.build({
        ('michaellamb', 'followers'): export('michaellamb', 'followers', ['SomeOne', 'michaellamb']),
        ('michaellamb', 'following'): export('michaellamb', 'following', ['someone']),
    }, jxn_handles={'someone'})
    assert out['nodes'] == [{'relation': 'mutual', 'jxn': True}]


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


def test_output_names_nobody_but_me():
    out = cn.build({
        ('michaellamb', 'followers'): export('michaellamb', 'followers', ['alice', 'bob']),
        ('michaellamb', 'following'): export('michaellamb', 'following', ['bob', 'carol'],
                                            schema='letterboxd-network-export/2'),
        ('bob', 'followers-you-know'): export('bob', 'followers-you-know', ['alice', 'carol']),
    }, {'carol'})
    blob = json.dumps(out)
    for leak in ('alice', 'bob', 'carol', 'Name of', 'ltrbxd', '12345', '678', '9012'):
        assert leak not in blob, leak
    assert set(out) == {'owner', 'generatedAt', 'exportedAt', 'counts', 'nodes', 'edges'}
    assert all(set(n) == {'relation', 'jxn'} for n in out['nodes'])
    assert out['counts']['edges'] == 2


def test_node_order_is_shuffled():
    exports = {
        ('michaellamb', 'followers'): export('michaellamb', 'followers', [f'p{i:02}' for i in range(30)]),
        ('michaellamb', 'following'): export('michaellamb', 'following', [f'p{i:02}' for i in range(15)]),
    }
    # Sorted order would put all 15 mutuals (p00-p14) first.
    import random
    out = cn.build(exports, set(), rng=random.Random(1))
    assert [n['relation'] for n in out['nodes']] != ['mutual'] * 15 + ['follower'] * 15


def test_newest_export_wins_and_foreign_schema_ignored(tmp_path):
    write(tmp_path, 'old.json', export('michaellamb', 'followers', ['old'], exported='2026-01-01T00:00:00Z'))
    write(tmp_path, 'new.json', export('michaellamb', 'followers', ['new'], exported='2026-11-03T00:00:00Z'))
    write(tmp_path, 'other.json', {'schema': 'something-else', 'owner': 'michaellamb', 'list': 'followers'})
    (tmp_path / 'broken.json').write_text('{not json')
    exports = cn.load_exports(tmp_path)
    assert [p['handle'] for p in exports[('michaellamb', 'followers')]['people']] == ['new']


def test_followers_you_know_become_edges():
    out, h = build({
        ('michaellamb', 'followers'): export('michaellamb', 'followers', ['a', 'b']),
        ('michaellamb', 'following'): export('michaellamb', 'following', ['a', 'b', 'c']),
        # On b's profile: people I follow who follow b. 'outsider' isn't in my
        # network and 'b' itself must not self-loop.
        ('b', 'followers-you-know'): export('b', 'followers-you-know', ['A', 'c', 'outsider', 'b']),
        # An export for someone outside the network contributes nothing.
        ('stranger', 'followers-you-know'): export('stranger', 'followers-you-know', ['a']),
    }, set())
    i = h.index
    assert out['edges'] == sorted([[i('a'), i('b')], [i('c'), i('b')]])
    assert out['counts']['edges'] == 2


def test_someone_elses_following_list_points_outward():
    out, h = build({
        ('michaellamb', 'followers'): export('michaellamb', 'followers', ['a', 'b']),
        ('michaellamb', 'following'): export('michaellamb', 'following', ['a', 'b']),
        ('a', 'following'): export('a', 'following', ['b']),
    }, set())
    assert out['edges'] == [[h.index('a'), h.index('b')]]  # a follows b, not the reverse


def test_missing_list_is_an_error():
    with pytest.raises(SystemExit):
        cn.build({('michaellamb', 'followers'): export('michaellamb', 'followers', ['a'])}, set())
