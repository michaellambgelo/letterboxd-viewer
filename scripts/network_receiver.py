#!/usr/bin/env python3
"""Loopback receiver for Network exports. Run by hand, on this machine only.

    python3 scripts/network_receiver.py            # http://127.0.0.1:8791/

letterboxd-network-export.user.js (private repo michaellamb-userscripts) walks
a follow list in my logged-in browser and POSTs the export here instead of
downloading a file. This script writes it into data/network/, re-runs
compute_network.build() in-process, and serves a page showing the published
counts next to the recomputed ones, with a button that commits
data/network.json (that path only). It never pushes, pulls or rebases.

Why local: the exports hold real handles, which must not leave this machine
(see **Network** in CLAUDE.md). Nothing here talks to Letterboxd or to any
other host.

Hardening. A server on 127.0.0.1 is reachable by any web page the browser has
open, so every request is checked:

- `Host` must be 127.0.0.1:<port> or localhost:<port>, which defeats DNS
  rebinding.
- Every POST must carry `X-LB-Network: 1`. A web page can't add a custom
  header to a cross-origin request without a CORS preflight, and preflights
  are refused: no Access-Control-* header is ever sent.
- `Origin`, when present, must be this server's own or a browser-extension
  origin (Chrome stamps extension requests with chrome-extension://<id>, and a
  page can't forge it). The userscript gets here through GM_xmlhttpRequest,
  which is exactly that path.

Handles are never written to the log.
"""

import argparse
import contextlib
import io
import json
import re
import subprocess
import sys
import threading
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import compute_network as cn  # noqa: E402

DEFAULT_PORT = 8791
SCHEMA = 'letterboxd-network-export/2'
REQUIRED_HEADER = 'X-LB-Network'
MAX_BODY = 2 * 1024 * 1024
MAX_PEOPLE = 5000  # the userscript's own ceiling: 200 pages of 25
HANDLE_RE = re.compile(r'^[A-Za-z0-9_]{1,32}$')
LIST_RE = re.compile(r'^[a-z0-9-]{1,32}(/[a-z0-9-]{1,32}){0,3}$')
EXTENSION_ORIGIN_RE = re.compile(r'^(chrome|moz|safari-web)-extension://[A-Za-z0-9._-]+$')
OUT_REL = 'data/network.json'
NODE_KEYS = {'relation', 'jxn'}
TOP_KEYS = {'owner', 'generatedAt', 'exportedAt', 'counts', 'nodes', 'edges'}


# ---- validation (pure) -----------------------------------------------------

def check_request(method, headers, port):
    """None when the request may proceed, else (status, message).

    `headers` is any mapping with a case-insensitive .get (the handler's
    message object, or a plain dict with canonical names in tests).
    """
    allowed_hosts = {f'127.0.0.1:{port}', f'localhost:{port}'}
    if (headers.get('Host') or '').strip().lower() not in allowed_hosts:
        return 403, 'bad Host'
    if method == 'GET':
        return None
    if method != 'POST':
        return 403, 'refused'
    if (headers.get(REQUIRED_HEADER) or '').strip() != '1':
        return 403, f'missing {REQUIRED_HEADER} header'
    origin = (headers.get('Origin') or '').strip()
    if origin:
        own = {f'http://{h}' for h in allowed_hosts}
        if origin not in own and not EXTENSION_ORIGIN_RE.match(origin):
            return 403, 'foreign Origin'
    return None


def sanitize_export(data):
    """Validate an export and rebuild it from known fields only.

    Each person keeps `handle` and nothing else, whatever the sender included.
    Raises ValueError with a message that names no handle.
    """
    if not isinstance(data, dict):
        raise ValueError('export must be a JSON object')
    if data.get('schema') != SCHEMA:
        raise ValueError(f'schema must be {SCHEMA}')

    owner = data.get('owner')
    if not isinstance(owner, str) or not HANDLE_RE.match(owner):
        raise ValueError('owner is not a Letterboxd handle')
    lst = data.get('list')
    if not isinstance(lst, str) or not LIST_RE.match(lst):
        raise ValueError('list is not a recognised list kind')

    exported = data.get('exportedAt')
    try:
        datetime.fromisoformat(str(exported).replace('Z', '+00:00'))
    except ValueError:
        raise ValueError('exportedAt is not an ISO timestamp') from None

    people = data.get('people')
    if not isinstance(people, list):
        raise ValueError('people must be a list')
    if len(people) > MAX_PEOPLE:
        raise ValueError(f'more than {MAX_PEOPLE} people')

    seen = set()
    clean = []
    for p in people:
        handle = p.get('handle') if isinstance(p, dict) else None
        if not isinstance(handle, str) or not HANDLE_RE.match(handle):
            raise ValueError('a person has no valid handle')
        key = handle.lower()
        if key not in seen:
            seen.add(key)
            clean.append({'handle': handle})

    source = data.get('sourceUrl')
    pages = data.get('pages')
    reason = data.get('stopReason')
    return {
        'schema': SCHEMA,
        'owner': owner.lower(),
        'list': lst,
        'sourceUrl': source if isinstance(source, str) and source.startswith('https://letterboxd.com/') else None,
        'exportedAt': exported,
        'pages': pages if isinstance(pages, int) and not isinstance(pages, bool) else None,
        'count': len(clean),
        'complete': data.get('complete') is True,
        'stopReason': reason[:200] if isinstance(reason, str) else None,
        'people': clean,
    }


def export_filename(export):
    """Same shape the userscript's download uses, dated by the export itself."""
    return (f"letterboxd-{export['owner']}-{export['list'].replace('/', '-')}"
            f"-{export['exportedAt'][:10]}.json")


def assert_anonymous(graph):
    """Last check before a commit: the file carries nothing but the graph."""
    if not isinstance(graph, dict) or set(graph) - TOP_KEYS:
        raise ValueError('network.json has unexpected top-level keys')
    if graph.get('owner') != cn.OWNER:
        raise ValueError('network.json owner is not me')
    for node in graph.get('nodes', []):
        if set(node) - NODE_KEYS:
            raise ValueError('a node carries more than relation + jxn')
    for edge in graph.get('edges', []):
        if not (isinstance(edge, list) and len(edge) == 2 and all(isinstance(i, int) for i in edge)):
            raise ValueError('an edge is not a pair of indices')


# ---- repo operations -------------------------------------------------------

class Receiver:
    def __init__(self, repo, members=None, port=DEFAULT_PORT):
        self.repo = Path(repo).resolve()
        self.exports_dir = self.repo / 'data' / 'network'
        self.out = self.repo / OUT_REL
        self.members = Path(members) if members else self.repo.parent / 'jxnfilmclub' / 'data' / 'members.json'
        self.port = port
        self.lock = threading.Lock()
        self.last = None  # result of the last recompute this session

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *args],
                              capture_output=True, text=True)

    def head_counts(self):
        r = self.git('show', f'HEAD:{OUT_REL}')
        if r.returncode != 0:
            return None
        try:
            return json.loads(r.stdout).get('counts')
        except ValueError:
            return None

    def working_counts(self):
        try:
            return json.loads(self.out.read_text()).get('counts')
        except (OSError, ValueError):
            return None

    def exports(self):
        """What the page lists. Local only: this does include handles."""
        with contextlib.redirect_stderr(io.StringIO()):
            newest = cn.load_exports(self.exports_dir) if self.exports_dir.exists() else {}
        rows = [{
            'owner': owner,
            'list': lst,
            'exportedAt': exp.get('exportedAt'),
            'count': len(exp.get('people') or []),
            'complete': exp.get('complete') is True,
            'mine': owner == cn.OWNER,
        } for (owner, lst), exp in newest.items()]
        return sorted(rows, key=lambda r: (not r['mine'], r['owner'], r['list'] or ''))

    def state(self):
        branch = self.git('rev-parse', '--abbrev-ref', 'HEAD').stdout.strip() or None
        status = self.git('status', '--porcelain', '--', OUT_REL).stdout.strip()
        return {
            'owner': cn.OWNER,
            'branch': branch,
            'modified': bool(status),
            'headCounts': self.head_counts(),
            'workingCounts': self.working_counts(),
            'lastRecompute': self.last,
            'exports': self.exports(),
            'membersFound': self.members.exists(),
        }

    def save_export(self, data):
        export = sanitize_export(data)
        self.exports_dir.mkdir(parents=True, exist_ok=True)
        # A walk that stopped early (challenge page, network blip) must not
        # displace a full list: the newest export per (owner, list) wins, so
        # accepting it would silently shrink the graph. Refusing makes the
        # userscript fall back to its download, so the partial file isn't lost.
        if not export['complete']:
            key = (cn.norm(export['owner']), export['list'])
            current = cn.load_exports(self.exports_dir).get(key)
            if current and current.get('complete'):
                raise ValueError('this export is incomplete and a complete one is already on disk; not replacing it')
        path = self.exports_dir / export_filename(export)
        path.write_text(json.dumps(export, indent=2) + '\n')
        return export

    def recompute(self):
        """compute_network.build() over every export on disk -> data/network.json.

        compute_network logs file names (which contain handles) on a bad file,
        so its stderr is swallowed and only a line count is kept.
        """
        before = self.working_counts()
        noise = io.StringIO()
        try:
            with contextlib.redirect_stderr(noise):
                exports = cn.load_exports(self.exports_dir) if self.exports_dir.exists() else {}
                graph = cn.build(exports, cn.load_jxn_handles(self.members))
        except SystemExit as e:
            self.last = {'ok': False, 'error': str(e)}
            return self.last
        assert_anonymous(graph)
        self.out.write_text(json.dumps(graph, indent=1, ensure_ascii=False) + '\n')
        self.last = {
            'ok': True,
            'before': before,
            'counts': graph['counts'],
            'head': self.head_counts(),
            'exportedAt': graph['exportedAt'],
            'warnings': len([ln for ln in noise.getvalue().splitlines() if ln.strip()]),
        }
        return self.last

    def commit(self):
        """Commit data/network.json and nothing else. No push."""
        if not self.git('status', '--porcelain', '--', OUT_REL).stdout.strip():
            return {'ok': False, 'error': 'data/network.json has no changes to commit'}
        try:
            graph = json.loads(self.out.read_text())
            assert_anonymous(graph)
        except (OSError, ValueError) as e:
            return {'ok': False, 'error': f'refusing to commit: {e}'}

        c = graph['counts']
        message = (f"Update network graph ({c['followers']} followers, "
                   f"{c['following']} following, {c['edges']} edges)")
        # `add` covers a first-ever commit of the file; the pathspec keeps
        # anything else that happens to be staged out of this commit.
        add = self.git('add', '--', OUT_REL)
        if add.returncode != 0:
            return {'ok': False, 'error': add.stderr.strip()[:300]}
        r = self.git('commit', '-m', message, '--', OUT_REL)
        if r.returncode != 0:
            return {'ok': False, 'error': (r.stderr or r.stdout).strip()[:300]}
        sha = self.git('rev-parse', '--short', 'HEAD').stdout.strip()
        return {'ok': True, 'commit': sha, 'message': message}


# ---- HTTP ------------------------------------------------------------------

PAGE = r"""<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Network receiver</title>
<style>
  :root { --bg: #14181c; --bg2: #1c2228; --bg3: #242c34; --hover: #2c3440;
          --text: #fff; --text2: #99aabb; --muted: #667788; --green: #00e054;
          --border: #2c3440; --danger: #f44336; }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
         background: var(--bg); color: var(--text2); line-height: 1.5; padding: 2rem 1rem 4rem; }
  .wrap { max-width: 820px; margin: 0 auto; }
  h1 { color: var(--text); font-size: 1.5rem; margin-bottom: .25rem; }
  h2 { color: var(--text); font-size: 1rem; margin: 1.75rem 0 .5rem; }
  .sub, .hint { color: var(--muted); font-size: .875rem; }
  .hint { margin: .5rem 0; max-width: 72ch; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin: .875rem 0; }
  button { padding: .5rem .875rem; border-radius: 4px; border: 1px solid var(--border);
           background: var(--bg3); color: var(--text2); font: inherit; font-size: .875rem; cursor: pointer; }
  button:hover:not(:disabled) { background: var(--hover); color: var(--text); }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: var(--green); border-color: var(--green); color: #05140a; font-weight: 600; }
  button.armed, button.armed:hover:not(:disabled) { background: rgba(244,67,54,.16); border-color: var(--danger); color: var(--danger); font-weight: 600; }
  .status { min-height: 1.5rem; font-size: .875rem; }
  .status.ok { color: var(--green); } .status.error { color: var(--danger); }
  .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: .8125rem; }
  th, td { text-align: left; padding: .5rem .625rem; border-bottom: 1px solid var(--border); white-space: nowrap; }
  th { color: var(--muted); text-transform: uppercase; letter-spacing: .04em; font-size: .6875rem; }
  tr:last-child td { border-bottom: 0; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .changed { color: var(--text); font-weight: 600; }
  .muted { color: var(--muted); }
  .pill { display: inline-block; font-size: .6875rem; font-weight: 600; text-transform: uppercase;
          padding: .125rem .5rem; border-radius: 999px; background: var(--bg3); }
  .pill.ok { background: rgba(0,224,84,.14); color: var(--green); }
  .pill.bad { background: rgba(244,67,54,.16); color: var(--danger); }
  code { background: var(--bg3); padding: .0625rem .3125rem; border-radius: 3px; font-size: .8125rem; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Network receiver</h1>
  <p class="sub">Local only. Exports hold real handles and stay on this machine; only the anonymous graph in <code>data/network.json</code> is ever committed.</p>

  <div class="row">
    <button type="button" id="reload">Reload</button>
    <button type="button" id="recompute">Recompute</button>
    <button type="button" class="primary" id="commit" disabled>Commit data/network.json</button>
  </div>
  <div class="status" id="status"></div>
  <p class="hint" id="repo"></p>

  <h2>Counts</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>Count</th><th class="num">Published (HEAD)</th><th class="num">Working tree</th><th class="num">Change</th></tr></thead>
    <tbody id="counts"></tbody>
  </table></div>
  <p class="hint">Node order is reshuffled on every recompute, so the file always differs from HEAD after one. The counts are what tell you whether anything really changed.</p>

  <h2>Exports on disk</h2>
  <div class="table-wrap"><table>
    <thead><tr><th>Owner</th><th>List</th><th>Exported</th><th class="num">People</th><th>Complete</th></tr></thead>
    <tbody id="exports"></tbody>
  </table></div>
  <p class="hint">The newest export per owner and list is used. Run the userscript on a follow list in your browser and it arrives here; this page does not fetch anything from Letterboxd. Commit only; push yourself when you're ready.</p>
</div>
<script>
(function () {
  'use strict';
  var HEADERS = { 'Content-Type': 'application/json', 'X-LB-Network': '1' };
  var LABELS = [
    ['followers', 'Followers'], ['following', 'Following'], ['mutual', 'Mutual'],
    ['followerOnly', 'Followers only'], ['followingOnly', 'Following only'],
    ['jxn', 'JXN'], ['jxnMutual', 'JXN mutual'], ['edges', 'Edges']
  ];
  var el = function (id) { return document.getElementById(id); };
  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function setStatus(message, kind) {
    el('status').textContent = message || '';
    el('status').className = 'status' + (kind ? ' ' + kind : '');
  }
  async function call(method, path) {
    var res = await fetch(path, method === 'POST' ? { method: 'POST', headers: HEADERS, body: '{}' } : {});
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    return body;
  }
  function disarm(button) {
    if (!button.dataset.armed) return;
    clearTimeout(button._t);
    button.textContent = button.dataset.label;
    button.classList.remove('armed');
    delete button.dataset.armed;
  }
  function armed(button, label) {
    if (button.dataset.armed) { disarm(button); return true; }
    button.dataset.armed = '1';
    button.dataset.label = button.textContent;
    button.textContent = label;
    button.classList.add('armed');
    button._t = setTimeout(function () { disarm(button); }, 5000);
    return false;
  }

  function render(state) {
    var head = state.headCounts || {};
    var work = state.workingCounts || {};
    el('counts').innerHTML = LABELS.map(function (pair) {
      var a = head[pair[0]], b = work[pair[0]];
      var diff = (typeof a === 'number' && typeof b === 'number') ? b - a : null;
      return '<tr><td>' + esc(pair[1]) + '</td>' +
        '<td class="num">' + esc(a == null ? '–' : a) + '</td>' +
        '<td class="num">' + esc(b == null ? '–' : b) + '</td>' +
        '<td class="num ' + (diff ? 'changed' : 'muted') + '">' +
          (diff == null ? '–' : (diff > 0 ? '+' : '') + diff) + '</td></tr>';
    }).join('');
    el('exports').innerHTML = state.exports.length
      ? state.exports.map(function (x) {
          return '<tr><td>' + esc(x.owner) + (x.mine ? ' <span class="muted">(me)</span>' : '') + '</td>' +
            '<td>' + esc(x.list) + '</td><td>' + esc(String(x.exportedAt || '').slice(0, 10)) + '</td>' +
            '<td class="num">' + esc(x.count) + '</td>' +
            '<td><span class="pill ' + (x.complete ? 'ok' : 'bad') + '">' + (x.complete ? 'yes' : 'partial') + '</span></td></tr>';
        }).join('')
      : '<tr><td colspan="5" class="muted">No exports yet.</td></tr>';
    el('repo').textContent = 'Branch ' + (state.branch || '?') + ' · data/network.json is ' +
      (state.modified ? 'modified (not committed)' : 'unchanged') +
      (state.membersFound ? '' : ' · JXN roster not found, so no JXN tags');
    disarm(el('commit'));
    el('commit').disabled = !state.modified;
  }

  async function load() {
    try { render(await call('GET', '/api/state')); }
    catch (err) { setStatus(err.message, 'error'); }
  }

  el('reload').addEventListener('click', function () { setStatus(''); load(); });
  el('recompute').addEventListener('click', async function () {
    setStatus('Recomputing…');
    try {
      var r = await call('POST', '/api/recompute');
      setStatus(r.ok ? 'Recomputed from the exports on disk.' + (r.warnings ? ' ' + r.warnings + ' warning(s) — an export may be partial.' : '') : r.error, r.ok ? 'ok' : 'error');
      await load();
    } catch (err) { setStatus(err.message, 'error'); }
  });
  el('commit').addEventListener('click', async function () {
    var button = el('commit');
    if (!armed(button, 'Commit to this branch?')) return;
    button.disabled = true;
    try {
      var r = await call('POST', '/api/commit');
      setStatus(r.ok ? 'Committed ' + r.commit + ': ' + r.message + '. Not pushed.' : r.error, r.ok ? 'ok' : 'error');
      await load();
    } catch (err) { setStatus(err.message, 'error'); button.disabled = false; }
  });

  load();
})();
</script>
</body>
</html>
"""


def make_handler(receiver):
    class Handler(BaseHTTPRequestHandler):
        server_version = 'network-receiver'

        def log_message(self, fmt, *args):  # method, path and status only
            sys.stderr.write(f'{self.command} {self.path.split("?")[0]} -> {args[1] if len(args) > 1 else ""}\n')

        def send_json(self, status, body):
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(payload)))
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(payload)

        def guard(self):
            refusal = check_request(self.command, self.headers, receiver.port)
            if refusal:
                self.send_json(refusal[0], {'ok': False, 'error': refusal[1]})
                return False
            return True

        def do_OPTIONS(self):
            # No preflight is ever approved, so no web page can send the
            # custom header the POST routes require.
            self.send_json(403, {'ok': False, 'error': 'refused'})

        def do_GET(self):
            if not self.guard():
                return
            path = self.path.split('?')[0]
            if path == '/':
                page = PAGE.encode()
                self.send_response(200)
                self.send_header('Content-Type', 'text/html; charset=utf-8')
                self.send_header('Content-Length', str(len(page)))
                self.send_header('Cache-Control', 'no-store')
                self.end_headers()
                self.wfile.write(page)
            elif path == '/api/state':
                self.send_json(200, receiver.state())
            else:
                self.send_json(404, {'ok': False, 'error': 'not found'})

        def read_body(self):
            """(True, parsed) or (False, None) once an error has been sent."""
            try:
                length = int(self.headers.get('Content-Length') or '')
            except ValueError:
                self.send_json(411, {'ok': False, 'error': 'Content-Length required'})
                return False, None
            if length < 0 or length > MAX_BODY:
                self.send_json(413, {'ok': False, 'error': 'body too large'})
                return False, None
            try:
                return True, json.loads(self.rfile.read(length) or b'null')
            except ValueError:
                self.send_json(400, {'ok': False, 'error': 'body is not JSON'})
                return False, None

        def do_POST(self):
            if not self.guard():
                return
            path = self.path.split('?')[0]
            if path not in ('/export', '/api/recompute', '/api/commit'):
                self.send_json(404, {'ok': False, 'error': 'not found'})
                return
            if 'application/json' not in (self.headers.get('Content-Type') or '').lower():
                self.send_json(415, {'ok': False, 'error': 'Content-Type must be application/json'})
                return
            ok, body = self.read_body()
            if not ok:
                return

            with receiver.lock:
                if path == '/export':
                    try:
                        export = receiver.save_export(body)
                    except ValueError as e:
                        self.send_json(400, {'ok': False, 'error': str(e)})
                        return
                    # Both of my own lists are needed before a graph exists;
                    # until then recompute just reports that.
                    self.send_json(200, {
                        'ok': True,
                        'list': export['list'],
                        'count': export['count'],
                        'complete': export['complete'],
                        'recomputed': receiver.recompute(),
                    })
                elif path == '/api/recompute':
                    self.send_json(200, receiver.recompute())
                else:
                    self.send_json(200, receiver.commit())

    return Handler


def serve(receiver):
    return ThreadingHTTPServer(('127.0.0.1', receiver.port), make_handler(receiver))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--port', type=int, default=DEFAULT_PORT)
    ap.add_argument('--repo', type=Path, default=cn.REPO,
                    help='repo to write into (default: this one)')
    ap.add_argument('--members', type=Path, default=None,
                    help='jxnfilmclub members.json (default: ../jxnfilmclub/data/members.json)')
    args = ap.parse_args(argv)

    receiver = Receiver(args.repo, args.members, args.port)
    if receiver.git('rev-parse', '--git-dir').returncode != 0:
        raise SystemExit(f'{receiver.repo} is not a git repository')
    server = serve(receiver)
    print(f'network receiver: http://127.0.0.1:{args.port}/  (repo {receiver.repo}; Ctrl-C to stop)')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
