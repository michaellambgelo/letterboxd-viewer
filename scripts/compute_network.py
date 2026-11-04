#!/usr/bin/env python3
"""Build data/network.json for the Network page.

Run by hand. It is not part of the cron pipeline, because the inputs only
change when you re-export:

    python3 scripts/compute_network.py
    python3 scripts/compute_network.py --members ../jxnfilmclub/data/members.json

Inputs
------
data/network/*.json
    Exports from letterboxd-network-export.user.js (private repo
    michaellamb-userscripts)
    (schema "letterboxd-network-export/2", or /1 from before 2026-11-03;
    only each person's `handle` is read either way). For each (owner, list)
    pair the newest export by `exportedAt` is used. These files hold real
    handles, so they stay local: data/network/ is gitignored.

    - owner = OWNER, list = "followers" / "following": your own network.
    - owner = someone else: edges between people in your network. A
      "followers you know" (or plain followers) export gives person -> owner;
      a following export gives owner -> person. Only people already in your
      network count. That is the only way to see
      connections *between* people in your network without crawling everyone's
      follow lists.

members.json (jxnfilmclub)
    Only the `handle` field is read, to set each node's `jxn` flag.

Output
------
data/network.json, which network.js reads (shape documented in CLAUDE.md).
It is anonymous: nodes carry only a relationship and a JXN flag, and their
order is shuffled on every run, so a node's index can't be matched against
the alphabetical order of a public follow list. No handle, name, avatar or
count for anyone but me is written.
"""

import argparse
import json
import random
import sys
from datetime import datetime, timezone
from pathlib import Path

OWNER = 'michaellamb'
SCHEMAS = {'letterboxd-network-export/1', 'letterboxd-network-export/2'}

REPO = Path(__file__).resolve().parent.parent
DEFAULT_EXPORT_DIR = REPO / 'data' / 'network'
DEFAULT_MEMBERS = REPO.parent / 'jxnfilmclub' / 'data' / 'members.json'
DEFAULT_OUT = REPO / 'data' / 'network.json'

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
        if data.get('schema') not in SCHEMAS:
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


def build(exports, jxn_handles, owner=OWNER, rng=None):
    followers = exports.get((owner, 'followers'))
    following = exports.get((owner, 'following'))
    if not followers or not following:
        raise SystemExit(f'need both {owner}/followers and {owner}/following exports')

    for name, exp in (('followers', followers), ('following', following)):
        if not exp.get('complete'):
            print(f'warning: {name} export is marked incomplete '
                  f'({exp.get("stopReason")})', file=sys.stderr)

    fo = set()
    fg = set()
    for exp, bucket in ((followers, fo), (following, fg)):
        for p in exp['people']:
            h = norm(p.get('handle'))
            if h and h != owner:
                bucket.add(h)
    handles = fo | fg

    # Edges between people in the network, from "followers you know" exports.
    edges = set()
    for (exp_owner, lst), exp in exports.items():
        if exp_owner == owner or exp_owner not in handles:
            continue
        # A following list points the other way: the owner follows each
        # person. Every other kind (followers, "followers you know") lists
        # people who follow the owner.
        owner_follows = (lst or '').split('/')[0] == 'following'
        for p in exp['people']:
            h = norm(p.get('handle'))
            if h in handles and h != exp_owner:
                edges.add((exp_owner, h) if owner_follows else (h, exp_owner))

    # Shuffle, then forget the handles: from here on a person is an index.
    order = sorted(handles)
    (rng or random.SystemRandom()).shuffle(order)
    index = {h: i for i, h in enumerate(order)}
    nodes = [{
        'relation': 'mutual' if h in fo and h in fg else ('follower' if h in fo else 'following'),
        'jxn': h in jxn_handles,
    } for h in order]
    rel = [n['relation'] for n in nodes]
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
            'jxn': sum(n['jxn'] for n in nodes),
            'jxnMutual': sum(n['jxn'] and n['relation'] == 'mutual' for n in nodes),
            'edges': len(edges),
        },
        'nodes': nodes,
        'edges': sorted([index[a], index[b]] for a, b in edges),
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
