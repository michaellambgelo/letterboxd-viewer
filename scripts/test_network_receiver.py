"""Tests for scripts/network_receiver.py. Run: python -m pytest scripts/

Synthetic handles only: this repo is public.
"""

import json
import subprocess
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import network_receiver as nr  # noqa: E402

PORT = 8791
OK_HEADERS = {'Host': f'127.0.0.1:{PORT}', 'X-LB-Network': '1'}


def export(owner='michaellamb', lst='followers', handles=('user_a', 'user_b'), **over):
    data = {
        'schema': 'letterboxd-network-export/2',
        'owner': owner,
        'list': lst,
        'sourceUrl': f'https://letterboxd.com/{owner}/{lst}/',
        'exportedAt': '2026-11-22T10:00:00.000Z',
        'pages': 1,
        'count': len(handles),
        'complete': True,
        'stopReason': None,
        'people': [{'handle': h} for h in handles],
    }
    data.update(over)
    return data


# ---- request checks --------------------------------------------------------

def test_get_needs_only_a_loopback_host():
    assert nr.check_request('GET', {'Host': f'127.0.0.1:{PORT}'}, PORT) is None
    assert nr.check_request('GET', {'Host': f'localhost:{PORT}'}, PORT) is None


@pytest.mark.parametrize('host', ['evil.example', f'evil.example:{PORT}', '127.0.0.1', '127.0.0.1:9999', ''])
def test_any_other_host_is_refused(host):
    # DNS rebinding: the attacker's name resolves to 127.0.0.1 but the Host
    # header still carries the attacker's name.
    assert nr.check_request('GET', {'Host': host}, PORT) == (403, 'bad Host')
    assert nr.check_request('POST', {**OK_HEADERS, 'Host': host}, PORT) == (403, 'bad Host')


def test_post_needs_the_custom_header():
    assert nr.check_request('POST', OK_HEADERS, PORT) is None
    assert nr.check_request('POST', {'Host': OK_HEADERS['Host']}, PORT)[0] == 403
    assert nr.check_request('POST', {**OK_HEADERS, 'X-LB-Network': 'yes'}, PORT)[0] == 403


@pytest.mark.parametrize('origin,allowed', [
    (f'http://127.0.0.1:{PORT}', True),
    (f'http://localhost:{PORT}', True),
    ('chrome-extension://abcdefghijklmnop', True),   # GM_xmlhttpRequest in Chrome
    ('moz-extension://0f0f0f0f-aaaa-bbbb-cccc-121212121212', True),
    ('https://letterboxd.com', False),               # the page itself may not post
    ('https://evil.example', False),
    ('http://127.0.0.1:9999', False),
    ('null', False),
])
def test_origin_must_be_own_or_an_extension(origin, allowed):
    result = nr.check_request('POST', {**OK_HEADERS, 'Origin': origin}, PORT)
    assert (result is None) is allowed


def test_other_methods_are_refused():
    assert nr.check_request('PUT', OK_HEADERS, PORT)[0] == 403


# ---- export validation -----------------------------------------------------

def test_sanitize_keeps_only_handles_and_known_fields():
    data = export(handles=())
    data['people'] = [
        {'handle': 'User_A', 'displayName': 'Someone Real', 'avatar': 'https://a.ltrbxd.com/x.jpg', 'followers': 9},
        {'handle': 'user_a'},  # same person, different case
        {'handle': 'user_b', 'following': True},
    ]
    data['extra'] = {'anything': 'else'}
    clean = nr.sanitize_export(data)
    assert clean['people'] == [{'handle': 'User_A'}, {'handle': 'user_b'}]
    assert clean['count'] == 2
    assert 'extra' not in clean
    assert 'Someone Real' not in json.dumps(clean)
    assert set(clean) == {'schema', 'owner', 'list', 'sourceUrl', 'exportedAt', 'pages',
                          'count', 'complete', 'stopReason', 'people'}


def test_sanitize_normalises_the_edges():
    clean = nr.sanitize_export(export(owner='MichaelLamb', sourceUrl='https://evil.example/x',
                                      complete='yes', stopReason='x' * 500, pages='3'))
    assert clean['owner'] == 'michaellamb'
    assert clean['sourceUrl'] is None
    assert clean['complete'] is False, 'only a real true counts as complete'
    assert len(clean['stopReason']) == 200
    assert clean['pages'] is None


@pytest.mark.parametrize('bad', [
    [],
    export(schema='letterboxd-network-export/1'),
    export(owner='../etc'),
    export(owner=''),
    export(lst='followers/../../x'),
    export(lst='Followers'),
    export(exportedAt='yesterday'),
    export(people='user_a'),
    export(people=[{'handle': 'ok_one'}, {'name': 'no handle'}]),
    export(people=[{'handle': 'has space'}]),
    export(people=[{'handle': 'u'}] * (nr.MAX_PEOPLE + 1)),
])
def test_sanitize_rejects(bad):
    with pytest.raises(ValueError) as e:
        nr.sanitize_export(bad)
    assert 'ok_one' not in str(e.value), 'error messages never name a handle'


def test_filename_matches_the_userscript_download_shape():
    assert nr.export_filename(nr.sanitize_export(export())) == \
        'letterboxd-michaellamb-followers-2026-11-22.json'
    you_know = nr.sanitize_export(export(owner='user_c', lst='followers-you-know'))
    assert nr.export_filename(you_know) == 'letterboxd-user_c-followers-you-know-2026-11-22.json'
    nested = nr.sanitize_export(export(lst='following/by/name'))
    assert '/' not in nr.export_filename(nested)


def test_assert_anonymous_refuses_anything_beyond_the_graph():
    good = {'owner': 'michaellamb', 'generatedAt': 'x', 'exportedAt': 'x', 'counts': {},
            'nodes': [{'relation': 'mutual', 'jxn': False}], 'edges': [[0, 0]]}
    nr.assert_anonymous(good)
    for bad in (
        {**good, 'handles': ['user_a']},
        {**good, 'nodes': [{'relation': 'mutual', 'jxn': False, 'handle': 'user_a'}]},
        {**good, 'edges': [['user_a', 'user_b']]},
        {**good, 'owner': 'user_a'},
    ):
        with pytest.raises(ValueError):
            nr.assert_anonymous(bad)


# ---- against a throwaway repo ----------------------------------------------

def git(repo, *args):
    return subprocess.run(['git', '-C', str(repo), *args], capture_output=True, text=True, check=True)


@pytest.fixture
def receiver(tmp_path):
    repo = tmp_path / 'repo'
    (repo / 'data').mkdir(parents=True)
    git(tmp_path, 'init', '-q', '-b', 'main', str(repo))
    git(repo, 'config', 'user.email', 'test@example.invalid')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'commit.gpgsign', 'false')
    (repo / '.gitignore').write_text('data/network/\n')
    (repo / 'README.md').write_text('x\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')
    members = tmp_path / 'members.json'
    members.write_text(json.dumps([{'handle': 'user_b'}, {'handle': 'not_in_network'}]))
    return nr.Receiver(repo, members, PORT)


def test_incomplete_export_never_replaces_a_complete_one(receiver):
    receiver.save_export(export(lst='followers', handles=('user_a', 'user_b', 'user_c')))
    partial = export(lst='followers', handles=('user_a',), complete=False,
                     exportedAt='2026-11-23T10:00:00.000Z')
    with pytest.raises(ValueError, match='incomplete'):
        receiver.save_export(partial)
    assert len(list(receiver.exports_dir.iterdir())) == 1, 'nothing new was written'
    # With no complete list to protect, a partial one is still better than nothing.
    receiver.save_export(export(lst='following', handles=('user_b',), complete=False))
    assert len(list(receiver.exports_dir.iterdir())) == 2


def test_recompute_needs_both_of_my_lists(receiver):
    receiver.save_export(export(lst='followers'))
    result = receiver.recompute()
    assert result['ok'] is False
    assert not receiver.out.exists()


def test_save_recompute_commit_touches_only_network_json(receiver):
    receiver.save_export(export(lst='followers', handles=('user_a', 'user_b')))
    receiver.save_export(export(lst='following', handles=('user_b', 'user_c')))
    saved = sorted(p.name for p in receiver.exports_dir.iterdir())
    assert saved == ['letterboxd-michaellamb-followers-2026-11-22.json',
                     'letterboxd-michaellamb-following-2026-11-22.json']

    result = receiver.recompute()
    assert result['ok'] is True
    assert result['counts']['followers'] == 2 and result['counts']['mutual'] == 1
    assert result['counts']['jxn'] == 1
    assert result['head'] is None, 'nothing published yet'
    published = receiver.out.read_text()
    for handle in ('user_a', 'user_b', 'user_c'):
        assert handle not in published

    # Something unrelated is staged and something else is dirty: neither may
    # ride along.
    (receiver.repo / 'staged.txt').write_text('staged\n')
    git(receiver.repo, 'add', 'staged.txt')
    (receiver.repo / 'README.md').write_text('dirty\n')

    done = receiver.commit()
    assert done['ok'] is True
    assert 'user_' not in done['message']
    files = git(receiver.repo, 'show', '--name-only', '--format=', 'HEAD').stdout.split()
    assert files == ['data/network.json']
    status = git(receiver.repo, 'status', '--porcelain').stdout
    assert 'A  staged.txt' in status and ' M README.md' in status
    assert 'network' not in status, 'exports are ignored, the graph is committed'

    assert receiver.commit()['ok'] is False, 'nothing left to commit'
    state = receiver.state()
    assert state['modified'] is False
    assert state['headCounts'] == state['workingCounts']
    assert state['branch'] == 'main'
    assert [(x['list'], x['count'], x['mine']) for x in state['exports']] == \
        [('followers', 2, True), ('following', 2, True)]


def test_commit_refuses_a_graph_that_names_someone(receiver):
    receiver.out.write_text(json.dumps({
        'owner': 'michaellamb', 'generatedAt': 'x', 'exportedAt': 'x', 'counts': {},
        'nodes': [{'relation': 'mutual', 'jxn': False, 'handle': 'user_a'}], 'edges': [],
    }))
    done = receiver.commit()
    assert done['ok'] is False
    assert git(receiver.repo, 'log', '--oneline').stdout.count('\n') == 1


# ---- over HTTP -------------------------------------------------------------

@pytest.fixture
def server(receiver):
    receiver.port = 0
    httpd = nr.serve(receiver)
    receiver.port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield receiver
    httpd.shutdown()
    httpd.server_close()


def request(server, method, path, body=None, headers=None):
    req = urllib.request.Request(
        f'http://127.0.0.1:{server.port}{path}', method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers=headers or {},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as res:
            return res.status, dict(res.headers), res.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode()


JSON_POST = {'Content-Type': 'application/json', 'X-LB-Network': '1'}


def test_http_round_trip_and_refusals(server):
    status, headers, page = request(server, 'GET', '/')
    assert status == 200 and 'Network receiver' in page
    assert 'confirm(' not in page

    status, headers, body = request(server, 'POST', '/export', export(lst='followers'), JSON_POST)
    assert status == 200
    assert not any(h.lower().startswith('access-control-') for h in headers)
    first = json.loads(body)
    assert first['ok'] is True and first['recomputed']['ok'] is False

    status, _, body = request(server, 'POST', '/export',
                              export(lst='following', handles=('user_b', 'user_c')), JSON_POST)
    second = json.loads(body)
    assert second['recomputed']['ok'] is True
    assert second['recomputed']['counts']['mutual'] == 1
    assert 'user_' not in json.dumps(second), 'the reply names nobody'

    before = sorted(p.name for p in server.exports_dir.iterdir())
    refusals = [
        ({'Content-Type': 'application/json'}, 403),                                   # no custom header
        ({**JSON_POST, 'Origin': 'https://evil.example'}, 403),
        ({**JSON_POST, 'Host': 'evil.example'}, 403),
        ({'X-LB-Network': '1', 'Content-Type': 'text/plain'}, 415),
    ]
    for hdrs, expected in refusals:
        status, _, _ = request(server, 'POST', '/export', export(owner='user_z'), hdrs)
        assert status == expected, hdrs
    status, _, _ = request(server, 'POST', '/export', export(owner='../x'), JSON_POST)
    assert status == 400
    assert sorted(p.name for p in server.exports_dir.iterdir()) == before, 'refused posts write nothing'

    status, headers, _ = request(server, 'OPTIONS', '/export', headers={
        'Origin': 'https://evil.example', 'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'x-lb-network'})
    assert status == 403
    assert not any(h.lower().startswith('access-control-') for h in headers)

    assert request(server, 'GET', '/api/state', headers={'Host': 'evil.example'})[0] == 403
    assert request(server, 'GET', '/nope')[0] == 404
    assert request(server, 'POST', '/api/commit', {}, {'Content-Type': 'application/json'})[0] == 403

    status, _, body = request(server, 'POST', '/api/commit', {}, JSON_POST)
    assert json.loads(body)['ok'] is True
    files = git(server.repo, 'show', '--name-only', '--format=', 'HEAD').stdout.split()
    assert files == ['data/network.json']
