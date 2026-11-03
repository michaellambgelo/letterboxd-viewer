#!/usr/bin/env python3
"""Build data/network.json for the Network page.

Run by hand. It is not part of the cron pipeline, because the inputs only
change when you re-export:

    python3 scripts/compute_network.py
    python3 scripts/compute_network.py --members ../jxnfilmclub/data/members.json

Inputs
------
data/network/*.json
    Exports from scripts/userscripts/letterboxd-network-export.user.js
    (schema "letterboxd-network-export/1"). For each (owner, list) pair the
    newest export by `exportedAt` is used.

    - owner = OWNER, list = "followers" / "following": your own network.
    - owner = someone else: edges between people in your network. A
      "followers you know" (or plain followers) export gives person -> owner;
      a following export gives owner -> person. Only people already in your
      network count. That is the only way to see
      connections *between* people in your network without crawling everyone's
      follow lists.

members.json (jxnfilmclub)
    Only the `handle` field is read. Member names, ids and pronouns are never
    copied into the output; the page shows Letterboxd display names only.

Output
------
data/network.json, which network.js reads (shape documented in CLAUDE.md).
"""

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

OWNER = 'michaellamb'
SCHEMA = 'letterboxd-network-export/1'

REPO = Path(__file__).resolve().parent.parent
DEFAULT_EXPORT_DIR = REPO / 'data' / 'network'
DEFAULT_MEMBERS = REPO.parent / 'jxnfilmclub' / 'data' / 'members.json'
DEFAULT_OUT = REPO / 'data' / 'network.json'

PERSON_FIELDS = ('handle', 'displayName', 'avatar', 'followers', 'following', 'filmsWatched')


def norm(handle):
    """Letterboxd handles are case-insensitive in URLs; the slug is canonical."""
    return (handle or '').strip().strip('/').lower()


def load_exports(export_dir):
    """Newest export per (owner, list), keyed by that tuple."""
    newest = {}
    for path in sorted(Path(export_dir).glob('*.json')):
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError) as e:
            print(f'skip {path.name}: {e}', file=sys.stderr)
            continue
        if data.get('schema') != SCHEMA:
            continue
        key = (norm(data.get('owner')), data.get('list'))
        if key not in newest or data.get('exportedAt', '') > newest[key].get('exportedAt', ''):
            newest[key] = data
    return newest


def load_jxn_handles(members_path):
    path = Path(members_path)
    if not path.exists():
        print(f'warning: {path} not found; no JXN tags', file=sys.stderr)
        return set()
    members = json.loads(path.read_text())
    return {norm(m['handle']) for m in members if m.get('handle')} - {OWNER}


def build(exports, jxn_handles, owner=OWNER):
    followers = exports.get((owner, 'followers'))
    following = exports.get((owner, 'following'))
    if not followers or not following:
        raise SystemExit(f'need both {owner}/followers and {owner}/following exports')

    for name, exp in (('followers', followers), ('following', following)):
        if not exp.get('complete'):
            print(f'warning: {name} export is marked incomplete '
                  f'({exp.get("stopReason")})', file=sys.stderr)

    people = {}
    fo = set()
    fg = set()
    for exp, bucket in ((followers, fo), (following, fg)):
        for p in exp['people']:
            h = norm(p.get('handle'))
            if not h or h == owner:
                continue
            bucket.add(h)
            # Same person in both lists: keep the first copy; counts drift by
            # a few between two exports minutes apart and either is fine.
            people.setdefault(h, {k: p.get(k) for k in PERSON_FIELDS} | {'handle': h})

    for h, p in people.items():
        p['relation'] = 'mutual' if h in fo and h in fg else ('follower' if h in fo else 'following')
        p['jxn'] = h in jxn_handles

    # Edges between people in the network, from "followers you know" exports.
    edges = set()
    for (exp_owner, lst), exp in exports.items():
        if exp_owner == owner or exp_owner not in people:
            continue
        # A following list points the other way: the owner follows each
        # person. Every other kind (followers, "followers you know") lists
        # people who follow the owner.
        owner_follows = (lst or '').split('/')[0] == 'following'
        for p in exp['people']:
            h = norm(p.get('handle'))
            if h in people and h != exp_owner:
                edges.add((exp_owner, h) if owner_follows else (h, exp_owner))

    ordered = sorted(people.values(), key=lambda p: ((p['displayName'] or p['handle']).casefold(), p['handle']))
    rel = [p['relation'] for p in ordered]
    return {
        'owner': owner,
        'generatedAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
        'exportedAt': min(followers['exportedAt'], following['exportedAt'])[:10],
        'counts': {
            'followers': len(fo),
            'following': len(fg),
            'mutual': rel.count('mutual'),
            'followerOnly': rel.count('follower'),
            'followingOnly': rel.count('following'),
            'jxn': sum(p['jxn'] for p in ordered),
            'jxnMutual': sum(p['jxn'] and p['relation'] == 'mutual' for p in ordered),
            'edges': len(edges),
        },
        'people': ordered,
        'edges': sorted([a, b] for a, b in edges),
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--exports', default=DEFAULT_EXPORT_DIR, type=Path)
    ap.add_argument('--members', default=DEFAULT_MEMBERS, type=Path)
    ap.add_argument('--out', default=DEFAULT_OUT, type=Path)
    args = ap.parse_args(argv)

    out = build(load_exports(args.exports), load_jxn_handles(args.members))
    args.out.write_text(json.dumps(out, indent=1, ensure_ascii=False) + '\n')
    c = out['counts']
    print(f"wrote {args.out.relative_to(REPO) if args.out.is_relative_to(REPO) else args.out}: "
          f"{c['followers']} followers, {c['following']} following, {c['mutual']} mutual, "
          f"{c['jxn']} JXN, {c['edges']} edges")


if __name__ == '__main__':
    main()
