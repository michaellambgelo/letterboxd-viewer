/**
 * letterboxd-rolodex — the curated "rolodex" of Letterboxd profiles behind the
 * /rolodex page of https://michaellambgelo.github.io/letterboxd-viewer/.
 *
 * Cloudflare KV is the source of truth for the curation itself; this Worker is
 * also a live read-through proxy for each profile's Last Four Watched, because
 * letterboxd.com serves RSS with **no CORS headers** and the browser therefore
 * cannot fetch a friend's feed directly.
 *
 * KV (binding ROLODEX):
 *   rolodex:v1          array of curated entries in one key, so GET /rolodex is
 *                       a single read. Display order is not stored — it is
 *                       derived on read, alphabetically by first name.
 *   snapshot:<user>     last successful last-four payload, no TTL (serve-stale)
 *   avatar:<user>       resolved og:image URL, 24h TTL ('' = known to have none)
 *   stats:live:v1       last successful /stats/live payload, no TTL (serve-stale)
 *   history:<user>      { since, entries[] } every diary entry seen in that
 *                       member's RSS since tracking began (see mergeHistory)
 *   rolodex:prev        { savedAt, profiles } the curated list as it was before
 *                       the last admin import — a one-step undo. Holds the list
 *                       only: histories deleted by an import or an undo are gone.
 *
 * Auth: unlike the sibling `now-store` Worker — where Cloudflare Access gates
 * the entire hostname — this host is deliberately MIXED. `/rolodex` must stay
 * public for site visitors, so the Access application is path-scoped to
 * `/admin`. Because a misconfigured or removed Access app would otherwise
 * silently expose the write API, this Worker independently verifies the
 * `Cf-Access-Jwt-Assertion` signature rather than trusting the edge.
 *
 * Endpoints:
 *   GET    /rolodex/stream                       public — NDJSON, progressive
 *   GET    /rolodex                              public — whole payload at once
 *   GET    /stats/live                           public — the dashboard owner's
 *                                                whole recent feed + avatar
 *   GET    /health                               public
 *   GET    /admin                                Access — CRUD UI
 *   GET    /admin/api/profiles                   Access
 *   POST   /admin/api/profiles                   Access — { username, displayName?, note?, tags? }
 *   PUT    /admin/api/profiles/{username}        Access
 *   DELETE /admin/api/profiles/{username}        Access
 *   POST   /admin/api/preview                    Access — { username } uncached probe
 *   GET    /admin/api/health                     Access — per-member feed health
 *   GET    /admin/api/export                     Access — curated list as a backup file
 *   POST   /admin/api/import                     Access — { mode, profiles, dryRun? }
 *   GET    /admin/api/import/prev                Access — what the undo would restore
 *   POST   /admin/api/import/undo                Access — swap rolodex:v1 and rolodex:prev
 *   POST   /admin/api/profiles/{username}/refresh  Access — bypass the feed cache
 *   POST   /admin/api/profiles/{username}/clear    Access — { what?: [cache|snapshot|avatar] }
 *   GET    /admin/api/profiles/{username}/history  Access — stored history (?download=1)
 *   DELETE /admin/api/profiles/{username}/history  Access — reset, then reseed from the feed
 *   POST   /admin/api/cron/run                   Access — { slot?, force? } run a cron slice now
 *   POST   /admin/api/stats-live/purge           Access — drop the /stats/live cache entry
 *   GET    /admin/api/tags                       Access — [{ tag, count }]
 *   POST   /admin/api/tags                       Access — { from, to, dryRun? } rename/merge/remove
 *   GET    /admin/api/pipeline                   Access — data cron, deploy and freshness report
 *   POST   /admin/api/pipeline/run               Access — dispatch the data workflow
 *   POST   /admin/api/pipeline/watchlist         Access — { filename, content, dryRun?, run? }
 *   GET    /admin/api/tag-categories             Access — data/tag_categories.json + diary tag counts
 *   PUT    /admin/api/tag-categories             Access — { sha, categories } commit new assignments
 *
 * The pipeline and tag-category routes are the Worker's only path into git.
 * They talk to the GitHub API for GITHUB_REPO with the GITHUB_TOKEN secret (a
 * fine-grained token: this one repo, Contents + Actions read/write). Reads work
 * without it (the repo is public); every write refuses with 503 until it is set.
 *
 * Mutating /admin requests are refused when the browser reports them as
 * cross-site (Sec-Fetch-Site), on top of Access. Requests without the header
 * (curl, service tokens) are unaffected.
 *
 * Cron (every 3h): refreshes one eighth of the rolodex per run, so every
 * member's feed is read at least daily even when nobody visits. That keeps
 * history:<user> from missing entries that scroll out of the ~50-item RSS
 * window between visits.
 */

import { renderAdminPage } from './admin-page.js';

const ROLODEX_KEY = 'rolodex:v1';
const PREV_KEY = 'rolodex:prev';
const BACKUP_SCHEMA = 'letterboxd-rolodex-backup/1';

const GITHUB_API = 'https://api.github.com';
const DEFAULT_REPO = 'michaellambgelo/letterboxd-viewer';
const DATA_WORKFLOW = 'download-data-and-assets.yml';
const DEPLOY_WORKFLOW = 'deploy.yml';
const CATEGORIES_PATH = 'data/tag_categories.json';
// The data cron runs every 6h and GitHub starts scheduled runs late under
// load. One failed run is also normal (an API commit landing mid-run makes its
// push fail, and the next run recovers), so health is judged on how long ago
// the last *success* was, with a full missed run of slack.
const PIPELINE_LATE_MS = 13 * 3600 * 1000;
const MAX_WATCHLIST_BYTES = 2 * 1024 * 1024;
const WATCHLIST_HEADER = 'Date,Name,Year,Letterboxd URI';
const MAX_DIARY_TAG_LEN = 80;
const CATEGORY_WRAP = 100;

const LAST_N = 4; // "Last Four Watched"
const RSS_TTL = 900; // 15min per-profile feed cache
const AGGREGATE_TTL = 300; // 5min on the public /rolodex response
const AVATAR_TTL = 86400; // 24h — avatars change rarely
const CONCURRENCY = 6; // never fan 30 requests at Letterboxd at once
const MAX_PROFILES = 200;
const HISTORY_MAX = 1000; // entries kept per member (newest by watchedDate)
const CRON_SLOTS = 8; // the rolodex is refreshed 1/8 per cron run (every 3h -> daily)
const CRON_PERIOD_MS = 3 * 3600 * 1000;

// Admin health panel. A member is normally read daily, but the cron slot is
// "index in the sorted list mod 8", so adding, removing or renaming anyone
// shifts slots and a member can legitimately go past 24h unread. 48h is the
// point where a quiet snapshot means the feed is actually failing.
const STALE_AFTER_MS = 48 * 3600 * 1000;
const HISTORY_WARN_AT = Math.floor(HISTORY_MAX * 0.9);

// /stats/live serves the dashboard owner's own feed — the live enrichment
// layer on index.html. Same hard-coded single-user stance as the Python
// pipeline (scripts/download_rss.py).
const STATS_USERNAME = 'michaellamb';
const STATS_SNAPSHOT_KEY = 'stats:live:v1';

const MAX_DISPLAY_NAME = 60;
const MAX_NOTE = 280;
const MAX_TAGS = 8;
const MAX_TAG_LEN = 24;

// Letterboxd usernames are alphanumeric + underscore; URLs are case-insensitive
// so we normalize to lowercase and use that as the KV identity.
const USERNAME_RE = /^[a-z0-9_]{1,32}$/;

const UA =
  'letterboxd-viewer-rolodex/1.0 (+https://github.com/michaellambgelo/letterboxd-viewer)';

// letterboxd.michaellamb.dev is the canonical site origin — the GitHub Pages
// default (michaellambgelo.github.io/letterboxd-viewer/) 301s to it, so that
// entry is only a fallback in case the custom domain is ever removed.
const ALLOWED_ORIGINS = [
  'https://letterboxd.michaellamb.dev',
  'https://michaellambgelo.github.io',
  'http://localhost:8000',
  'http://127.0.0.1:8000',
];

/* -------------------------------------------------------------------------- */
/* HTTP helpers                                                               */
/* -------------------------------------------------------------------------- */

function corsHeaders(request) {
  const origin = request.headers.get('Origin');

  // `Vary: Origin` goes on EVERY response, including refused and origin-less
  // ones. Emitting it only on allowed responses is a cache-poisoning bug: a
  // shared cache stores the header-free copy from an origin-less request (a
  // curl, a crawler) under an unvaried key and then replays it to real browser
  // requests, which see a 200 with no Access-Control-Allow-Origin.
  const base = { Vary: 'Origin' };
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return base;

  return {
    ...base,
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...extraHeaders },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Cloudflare Access — JWT verification                                       */
/* -------------------------------------------------------------------------- */

// Per-isolate JWKS cache. Access rotates keys infrequently; an hour is plenty.
let jwksCache = { fetchedAt: 0, keys: null, teamDomain: null };
const JWKS_TTL_MS = 3600_000;

function b64urlToBytes(str) {
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function b64urlToJSON(str) {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(str)));
}

async function getJWKS(teamDomain) {
  const now = Date.now();
  if (
    jwksCache.keys &&
    jwksCache.teamDomain === teamDomain &&
    now - jwksCache.fetchedAt < JWKS_TTL_MS
  ) {
    return jwksCache.keys;
  }
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
  const body = await res.json();
  jwksCache = { fetchedAt: now, keys: body.keys || [], teamDomain };
  return jwksCache.keys;
}

/**
 * Returns the verified Access identity, or null when the request is not
 * authenticated. Never throws — callers treat null as "deny".
 */
async function verifyAccess(request, env) {
  const token =
    request.headers.get('Cf-Access-Jwt-Assertion') ||
    (request.headers.get('Cookie') || '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1];
  if (!token) return null;

  const teamDomain = env.ACCESS_TEAM_DOMAIN;
  const aud = env.ACCESS_AUD;
  if (!teamDomain || !aud) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  try {
    const header = b64urlToJSON(parts[0]);
    const payload = b64urlToJSON(parts[1]);

    const keys = await getJWKS(teamDomain);
    const jwk = keys.find((k) => k.kid === header.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify']
    );
    const ok = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlToBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!ok) return null;

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp !== 'number' || payload.exp <= now) return null;
    if (typeof payload.nbf === 'number' && payload.nbf > now + 60) return null;
    if (payload.iss !== `https://${teamDomain}`) return null;

    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!audiences.includes(aud)) return null;

    return { email: payload.email || null, sub: payload.sub || null };
  } catch (err) {
    console.error('access: verification error', err);
    return null;
  }
}

/**
 * `wrangler dev` has no Access in front of it and no signed JWT to present, so
 * local work needs an explicit bypass.
 *
 * This deliberately does NOT sniff the request hostname: because wrangler.toml
 * declares a custom_domain route, `wrangler dev` rewrites request.url to
 * rolodex.michaellamb.dev, so a "is this localhost?" check silently fails
 * locally and would be meaningless anyway. Instead the bypass must be passed in
 * explicitly and is never committed as a var:
 *
 *   npm run dev   ->  wrangler dev --var ADMIN_DEV_BYPASS:true
 *
 * `wrangler deploy` passes no such var, so production is fail-closed.
 */
function devBypassEnabled(env) {
  return env.ADMIN_DEV_BYPASS === 'true';
}

async function requireAdmin(request, env) {
  if (devBypassEnabled(env)) {
    console.warn('admin: ADMIN_DEV_BYPASS is on — auth skipped. Never set this in production.');
    return { ok: true, identity: { email: 'dev-bypass' } };
  }
  const identity = await verifyAccess(request, env);
  if (!identity) {
    return {
      ok: false,
      response: json({ error: 'unauthorized' }, 403),
    };
  }
  return { ok: true, identity };
}

/* -------------------------------------------------------------------------- */
/* Curated list (KV)                                                          */
/* -------------------------------------------------------------------------- */

const COLLATOR = new Intl.Collator('en', { sensitivity: 'base', numeric: true });

/** The label a card shows: display name if set, otherwise the handle. */
function displayLabel(profile) {
  return (profile.displayName || profile.username || '').trim();
}

/** "Michael Lamb" -> "Michael"; a bare handle is its own first name. */
function firstName(profile) {
  const label = displayLabel(profile);
  return label.split(/\s+/)[0] || label;
}

/**
 * Rolodex order is alphabetical by first name, with the full label and then the
 * handle as tie-breakers so two people named Michael sort by surname and the
 * result is stable rather than dependent on insertion order.
 */
function byFirstName(a, b) {
  return (
    COLLATOR.compare(firstName(a), firstName(b)) ||
    COLLATOR.compare(displayLabel(a), displayLabel(b)) ||
    COLLATOR.compare(a.username || '', b.username || '')
  );
}

/**
 * Order is derived on read, never stored. Sorting here rather than on write
 * means entries already in KV — and anything written by an older deploy — are
 * normalized with no migration, and every consumer (public endpoint and admin
 * list alike) sees the same order.
 */
async function readProfiles(env) {
  const raw = await env.ROLODEX.get(ROLODEX_KEY, 'json');
  const profiles = Array.isArray(raw) ? raw : [];
  return profiles.sort(byFirstName);
}

async function writeProfiles(env, profiles) {
  await env.ROLODEX.put(ROLODEX_KEY, JSON.stringify(profiles));
}

function normalizeUsername(value) {
  let username = String(value || '').trim();

  // Accept a pasted profile URL as well as a bare handle. Path segments are
  // only stripped when the input really was a URL — otherwise "bad/../path"
  // would quietly resolve to the unrelated (and possibly real) user "bad".
  const url = username.match(/^(?:https?:\/\/)?(?:www\.)?letterboxd\.com\/([^/?#]+)/i);
  username = url ? url[1] : username.replace(/^@/, '');

  username = username.toLowerCase();
  return USERNAME_RE.test(username) ? username : null;
}

/** Validate + clamp the user-editable fields shared by create and update. */
function sanitizeFields(payload) {
  const displayName = String(payload.displayName || '').trim().slice(0, MAX_DISPLAY_NAME);
  const note = String(payload.note || '').trim().slice(0, MAX_NOTE);
  const tags = (Array.isArray(payload.tags) ? payload.tags : [])
    .map((t) => String(t).trim().slice(0, MAX_TAG_LEN))
    .filter(Boolean)
    .slice(0, MAX_TAGS);
  return { displayName, note, tags };
}

/* -------------------------------------------------------------------------- */
/* Letterboxd RSS                                                             */
/* -------------------------------------------------------------------------- */

function decodeEntities(str) {
  if (!str) return str;
  return str
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Pull the text of a single child tag out of one <item> block. */
function tagText(block, name) {
  const match = block.match(
    new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`)
  );
  return match ? match[1].trim() : null;
}

/**
 * The review body is the description minus the poster paragraph, flattened to
 * plain text — paragraph/blockquote/br boundaries become newlines so the
 * client can render it with `white-space: pre-line` and never touch HTML.
 */
function extractReview(description) {
  const text = description
    .replace(/^\s*<!\[CDATA\[/, '')
    .replace(/\]\]>\s*$/, '')
    .replace(/<p>\s*<img[^>]*\/?>\s*<\/p>/i, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  const cleaned = decodeEntities(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n\n')
    .trim();
  return cleaned || null;
}

/**
 * Workers have no DOMParser, so parse the (machine-generated, stable) feed with
 * targeted regexes — the same fields scripts/extract_history.py reads via
 * ElementTree.
 *
 * The default shape is what a rolodex card renders (capped at LAST_N). The
 * `extended` option is for /stats/live: no cap, plus `liked` and — for
 * `letterboxd-review-*` items only — the plain-text `review` body.
 */
function parseFeed(xml, { limit = LAST_N, extended = false } = {}) {
  const blocks = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]);
  const films = [];

  for (const block of blocks) {
    // A member's feed also carries `letterboxd-list-*` items for published
    // lists. Only diary entries have a watchedDate — everything else would
    // render as a bogus "film" on a card.
    const watchedDate = tagText(block, 'letterboxd:watchedDate');
    if (!watchedDate) continue;

    const description = tagText(block, 'description') || '';
    const posterMatch = description.match(/<img\s+src="(https:\/\/a\.ltrbxd\.com\/[^"]+)"/i);
    const rating = tagText(block, 'letterboxd:memberRating');
    const year = tagText(block, 'letterboxd:filmYear');

    const film = {
      guid: tagText(block, 'guid') || null,
      title: decodeEntities(tagText(block, 'letterboxd:filmTitle')) || 'Untitled',
      year: year ? Number(year) : null,
      rating: rating ? Number(rating) : null,
      rewatch: tagText(block, 'letterboxd:rewatch') === 'Yes',
      watchedDate,
      link: decodeEntities(tagText(block, 'link')),
      poster: posterMatch ? decodeEntities(posterMatch[1]) : null,
      tmdbId: tagText(block, 'tmdb:movieId') || tagText(block, 'tmdb:tvId') || null,
    };

    if (extended) {
      // Plain `letterboxd-watch-*` items also carry a description, but it is
      // just "Watched on <date>." — only review guids hold an actual review.
      const guid = tagText(block, 'guid') || '';
      film.liked = tagText(block, 'letterboxd:memberLike') === 'Yes';
      film.review = guid.startsWith('letterboxd-review-') ? extractReview(description) : null;
    }

    films.push(film);
    if (films.length >= limit) break;
  }

  return films;
}

async function fetchWatches(username, parseOptions) {
  const res = await fetch(`https://letterboxd.com/${username}/rss/`, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml' },
  });
  if (!res.ok) throw new Error(`RSS ${res.status} for ${username}`);
  const xml = await res.text();
  return { films: parseFeed(xml, parseOptions), fetchedAt: new Date().toISOString() };
}

/* -------------------------------------------------------------------------- */
/* History                                                                    */
/* -------------------------------------------------------------------------- */

/** Stable id for a diary entry. The RSS guid (`letterboxd-review-N` /
 *  `letterboxd-watch-N`) keeps its number when Letterboxd re-titles a film or
 *  the watched date is edited, so it beats (title, year, date), the same lesson
 *  as extract_history.dedupe_rss. Falls back to that key without a guid. */
function entryId(film) {
  const n = /(\d+)$/.exec(film.guid || '');
  return n ? `e${n[1]}` : `k:${(film.title || '').toLowerCase()}|${film.year || ''}|${film.watchedDate}`;
}

/**
 * Pure merge of a freshly parsed feed into a member's stored history.
 *
 * Entries are compact: { id, t (title), y (year), d (watchedDate), r (rating),
 * rw (rewatch), s (first seen, YYYY-MM-DD) }. A feed copy replaces the stored
 * one (ratings and dates get edited) but keeps its first-seen day. `since` is
 * the oldest watchedDate in the *first* merge and never moves earlier, so
 * "since" honestly means "what we've been able to see", not "joined".
 *
 * Returns { history, changed, summary }; callers write only when `changed`.
 */
function mergeHistory(existing, feedFilms, today) {
  const prev = existing && Array.isArray(existing.entries) ? existing : null;
  const byId = new Map((prev ? prev.entries : []).map((e) => [e.id, e]));
  let changed = !prev;

  for (const f of feedFilms) {
    if (!f.watchedDate) continue;
    const id = entryId(f);
    const old = byId.get(id);
    const next = {
      id,
      t: f.title,
      y: f.year ?? null,
      d: f.watchedDate,
      r: f.rating ?? null,
      rw: Boolean(f.rewatch),
      s: old ? old.s : today,
    };
    if (!old || old.t !== next.t || old.y !== next.y || old.d !== next.d || old.r !== next.r || old.rw !== next.rw) {
      byId.set(id, next);
      changed = true;
    }
  }

  let entries = [...byId.values()].sort((a, b) => (b.d > a.d ? 1 : b.d < a.d ? -1 : 0));
  if (entries.length > HISTORY_MAX) {
    entries = entries.slice(0, HISTORY_MAX);
    changed = true;
  }
  const oldest = entries.length ? entries[entries.length - 1].d : today;
  const since = prev && prev.since ? (prev.since < oldest ? prev.since : oldest) : oldest;
  if (prev && since !== prev.since) changed = true;

  const history = { since, entries };
  return { history, changed, summary: summarizeHistory(history, today) };
}

/** What a card and the sorts need, small enough to ride along on every
 *  payload: total logged, rewatches, and logs in the last 30 days. */
function summarizeHistory(history, today) {
  const entries = history.entries || [];
  const cutoff = new Date(`${today}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() - 30);
  const since30 = cutoff.toISOString().slice(0, 10);
  return {
    since: history.since,
    logged: entries.length,
    rewatches: entries.filter((e) => e.rw).length,
    last30: entries.filter((e) => e.d >= since30).length,
  };
}

/**
 * Read-merge-write of history:<user>. This *is* a race when a page visit and
 * the cron fetch the same member at once (or two colos do: caches.default is
 * per-colo). Unlike the members:all aggregate in jxnfilmclub, that's acceptable
 * here: the merge is an idempotent union and the feed is re-read on every
 * fetch, so an entry a lost write dropped comes back on the next fetch while
 * it's still in the ~50-item window, which the daily cron guarantees.
 */
async function updateHistory(username, films, env, ctx, { reset = false } = {}) {
  const key = `history:${username}`;
  const today = new Date().toISOString().slice(0, 10);
  try {
    // `reset` (admin only) seeds from this feed alone. It skips the read rather
    // than deleting first and reading back: KV is eventually consistent, so a
    // read straight after a delete can still return the old history and the
    // merge would quietly write it back.
    const existing = reset ? null : await env.ROLODEX.get(key, 'json');
    const { history, changed, summary } = mergeHistory(existing, films, today);
    if (changed) ctx.waitUntil(env.ROLODEX.put(key, JSON.stringify(history)));
    return summary;
  } catch (err) {
    console.error(`rolodex: history update failed for ${username}`, err);
    return null;
  }
}

/** Which profiles a cron run refreshes: a fixed 1/CRON_SLOTS of the list,
 *  rotating with the run's 3-hour slot, so each member is read daily and no
 *  single run fetches more than ~1/8 of the rolodex. */
function cronSlot(time) {
  return Math.floor(time / CRON_PERIOD_MS) % CRON_SLOTS;
}

function cronSlice(profiles, scheduledTime, slot = cronSlot(scheduledTime)) {
  return profiles.filter((_, i) => i % CRON_SLOTS === slot);
}

/** When the cron will next reach `slot`: the first 3-hour boundary after `now`
 *  whose slot matches. */
function nextCronRun(slot, now) {
  const period = Math.floor(now / CRON_PERIOD_MS) + 1;
  const ahead = (slot - (period % CRON_SLOTS) + CRON_SLOTS) % CRON_SLOTS;
  return (period + ahead) * CRON_PERIOD_MS;
}

function rssCacheKey(username) {
  return new Request(`https://rolodex.internal/rss/${username}`);
}

function statsCacheKey() {
  return new Request('https://rolodex.internal/stats-live');
}

/**
 * Read-through cache in front of a profile's feed, with a KV snapshot as the
 * floor: if Letterboxd is unreachable or the feed stops parsing, the card keeps
 * showing the last known-good four and is flagged `stale` instead of vanishing.
 */
/** Fetch a member's feed and store everything derived from it: history, the
 *  per-colo cache entry and the KV snapshot. Throws when the feed can't be read. */
async function fetchAndStore(username, env, ctx, { resetHistory = false } = {}) {
  // The whole feed, not just four: every diary entry goes into history, and
  // the card still gets only the newest LAST_N.
  const { films: all, fetchedAt } = await fetchWatches(username, { limit: Infinity });
  const summary = await updateHistory(username, all, env, ctx, { reset: resetHistory });
  const payload = { films: all.slice(0, LAST_N), fetchedAt, history: summary };
  ctx.waitUntil(
    caches.default.put(
      rssCacheKey(username),
      new Response(JSON.stringify(payload), {
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': `max-age=${RSS_TTL}`,
        },
      })
    )
  );
  ctx.waitUntil(env.ROLODEX.put(`snapshot:${username}`, JSON.stringify(payload)));
  return payload;
}

async function loadWatches(username, env, ctx) {
  const hit = await caches.default.match(rssCacheKey(username));
  if (hit) {
    const payload = await hit.json();
    return { ...payload, stale: false };
  }

  try {
    const payload = await fetchAndStore(username, env, ctx);
    return { ...payload, stale: false };
  } catch (err) {
    console.error(`rolodex: feed failed for ${username}`, err);
    const snapshot = await env.ROLODEX.get(`snapshot:${username}`, 'json');
    if (snapshot) return { ...snapshot, stale: true };
    return { films: [], fetchedAt: null, stale: true };
  }
}

/** Avatar lives in the profile page's og:image; HTMLRewriter streams it out. */
async function loadAvatar(username, env, ctx) {
  const key = `avatar:${username}`;
  const cached = await env.ROLODEX.get(key);
  if (cached !== null) return cached || null; // '' = looked up, none found

  try {
    const res = await fetch(`https://letterboxd.com/${username}/`, {
      headers: { 'User-Agent': UA, Accept: 'text/html' },
    });
    if (!res.ok) throw new Error(`profile ${res.status}`);

    let found = null;
    await new HTMLRewriter()
      .on('meta[property="og:image"]', {
        element(el) {
          if (!found) found = el.getAttribute('content');
        },
      })
      .transform(res)
      .arrayBuffer();

    ctx.waitUntil(env.ROLODEX.put(key, found || '', { expirationTtl: AVATAR_TTL }));
    return found;
  } catch (err) {
    console.error(`rolodex: avatar failed for ${username}`, err);
    return null;
  }
}

/** Promise.all with a ceiling on in-flight requests. */
async function mapWithLimit(items, limit, fn) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * The curated half of a card: everything already in KV, so it costs one read
 * and no network. Streamed up front so the page can draw every card before a
 * single feed has resolved.
 */
function baseProfile(profile) {
  return {
    username: profile.username,
    displayName: profile.displayName || profile.username,
    note: profile.note || '',
    tags: profile.tags || [],
    profileUrl: `https://letterboxd.com/${profile.username}/`,
  };
}

/** The fetched half: what the feed and profile page supply. */
async function enrichmentFor(profile, env, ctx) {
  const [watches, avatar] = await Promise.all([
    loadWatches(profile.username, env, ctx),
    loadAvatar(profile.username, env, ctx),
  ]);
  return {
    username: profile.username,
    avatar,
    films: watches.films || [],
    history: watches.history || null,
    fetchedAt: watches.fetchedAt || null,
    stale: Boolean(watches.stale),
  };
}

async function enrich(profile, env, ctx) {
  return { ...baseProfile(profile), ...(await enrichmentFor(profile, env, ctx)) };
}

/* -------------------------------------------------------------------------- */
/* Public endpoint                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `private` is deliberate. On a custom domain, Cloudflare's CDN *will* cache a
 * Worker response marked `public` — and since this response varies by Origin,
 * a shared cache is a liability here (see corsHeaders). Browsers still get the
 * 5-minute cache; shared caches are kept out of it entirely.
 *
 * Nothing is lost by that: what actually shields letterboxd.com from a traffic
 * spike is the per-profile `caches.default` entry in loadWatches(), where each
 * feed is fetched at most once per RSS_TTL regardless of visitor count.
 */
/**
 * NDJSON stream: one JSON object per line.
 *
 *   {"type":"meta","count":N,"profiles":[…]}   the curated list, from KV alone
 *   {"type":"profile","username":…,"films":…}  one per profile, as it resolves
 *
 * Profiles are emitted in completion order, not display order — the client
 * matches them to the cards it already drew from the meta line by username, so
 * a slow feed delays only its own card rather than the whole page.
 *
 * The Response is returned immediately with an open stream; the work runs
 * detached under waitUntil so nothing is buffered up front.
 */
function streamRolodex(request, env, ctx) {
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const write = (obj) => writer.write(encoder.encode(JSON.stringify(obj) + '\n'));

  ctx.waitUntil(
    (async () => {
      try {
        const profiles = await readProfiles(env);
        await write({
          type: 'meta',
          updatedAt: new Date().toISOString(),
          count: profiles.length,
          profiles: profiles.map(baseProfile),
        });

        await mapWithLimit(profiles, CONCURRENCY, async (profile) => {
          try {
            await write({ type: 'profile', ...(await enrichmentFor(profile, env, ctx)) });
          } catch (err) {
            // One bad profile must not abort the stream — emit an empty, stale
            // entry so the client stops waiting on that card.
            console.error(`rolodex: stream entry failed for ${profile.username}`, err);
            await write({
              type: 'profile',
              username: profile.username,
              avatar: null,
              films: [],
              fetchedAt: null,
              stale: true,
            }).catch(() => {});
          }
        });
      } catch (err) {
        console.error('rolodex: stream failed', err);
        await write({ type: 'error', message: 'stream failed' }).catch(() => {});
      } finally {
        await writer.close().catch(() => {});
      }
    })()
  );

  return new Response(readable, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      // A progressive response must not be stored or buffered by anything in
      // front of it, or the whole point is lost.
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(request),
    },
  });
}

/**
 * The dashboard owner's whole recent feed + avatar — the live enrichment layer
 * on index.html. The static data/stats.json stays canonical; this only adds
 * what the 6-hour cron can't: freshness, posters, review text, like flags.
 *
 * Same read-through-then-snapshot shape as loadWatches, but cached under its
 * own key: the rolodex cache for this same username stores only the parsed
 * last four, without the extended fields.
 */
async function getStatsLive(request, env, ctx) {
  const cacheKey = statsCacheKey();
  const cache = caches.default;

  let payload;
  const hit = await cache.match(cacheKey);
  if (hit) {
    payload = { ...(await hit.json()), stale: false };
  } else {
    try {
      const [watches, avatar] = await Promise.all([
        fetchWatches(STATS_USERNAME, { limit: Infinity, extended: true }),
        loadAvatar(STATS_USERNAME, env, ctx),
      ]);
      payload = {
        username: STATS_USERNAME,
        profileUrl: `https://letterboxd.com/${STATS_USERNAME}/`,
        avatar,
        films: watches.films,
        fetchedAt: watches.fetchedAt,
        stale: false,
      };
      ctx.waitUntil(
        cache.put(
          cacheKey,
          new Response(JSON.stringify(payload), {
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': `max-age=${RSS_TTL}`,
            },
          })
        )
      );
      ctx.waitUntil(env.ROLODEX.put(STATS_SNAPSHOT_KEY, JSON.stringify(payload)));
    } catch (err) {
      console.error('stats: live feed failed', err);
      const snapshot = await env.ROLODEX.get(STATS_SNAPSHOT_KEY, 'json');
      payload = snapshot
        ? { ...snapshot, stale: true }
        : {
            username: STATS_USERNAME,
            profileUrl: `https://letterboxd.com/${STATS_USERNAME}/`,
            avatar: null,
            films: [],
            fetchedAt: null,
            stale: true,
          };
    }
  }

  return json(payload, 200, {
    'Cache-Control': `private, max-age=${AGGREGATE_TTL}`,
    ...corsHeaders(request),
  });
}

async function getRolodex(request, env, ctx) {
  const profiles = await readProfiles(env);
  const enriched = await mapWithLimit(profiles, CONCURRENCY, (p) => enrich(p, env, ctx));
  return json(
    { updatedAt: new Date().toISOString(), count: enriched.length, profiles: enriched },
    200,
    {
      'Cache-Control': `private, max-age=${AGGREGATE_TTL}`,
      ...corsHeaders(request),
    }
  );
}

/* -------------------------------------------------------------------------- */
/* Admin API                                                                  */
/* -------------------------------------------------------------------------- */

async function createProfile(request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const username = normalizeUsername(payload.username);
  if (!username) return json({ error: 'invalid username' }, 400);

  const profiles = await readProfiles(env);
  if (profiles.length >= MAX_PROFILES) {
    return json({ error: `rolodex is full (${MAX_PROFILES})` }, 409);
  }
  if (profiles.some((p) => p.username === username)) {
    return json({ error: `${username} is already in the rolodex` }, 409);
  }

  const now = new Date().toISOString();
  const entry = { username, ...sanitizeFields(payload), addedAt: now, updatedAt: now };
  profiles.push(entry);
  await writeProfiles(env, profiles);
  return json(entry, 201);
}

async function updateProfile(username, request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const profiles = await readProfiles(env);
  const index = profiles.findIndex((p) => p.username === username);
  if (index === -1) return json({ error: 'not found' }, 404);

  profiles[index] = {
    ...profiles[index],
    ...sanitizeFields(payload),
    updatedAt: new Date().toISOString(),
  };
  await writeProfiles(env, profiles);
  return json(profiles[index]);
}

async function deleteProfile(username, env) {
  const profiles = await readProfiles(env);
  const remaining = profiles.filter((p) => p.username !== username);
  if (remaining.length === profiles.length) return json({ error: 'not found' }, 404);

  await writeProfiles(env, remaining);
  // Drop the derived keys too, so re-adding someone starts clean.
  await dropDerived(username, env);
  return new Response(null, { status: 204 });
}

/** Uncached probe so the admin can confirm a handle exists before saving it. */
async function previewProfile(request, env, ctx) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const username = normalizeUsername(payload.username);
  if (!username) return json({ error: 'invalid username' }, 400);

  try {
    const [watches, avatar] = await Promise.all([
      fetchWatches(username),
      loadAvatar(username, env, ctx),
    ]);
    return json({ username, avatar, films: watches.films });
  } catch (err) {
    return json({ error: `could not read letterboxd.com/${username}/rss/` }, 404);
  }
}

/* -------------------------------------------------------------------------- */
/* Admin API — health, backup, cache controls, history, tags                  */
/* -------------------------------------------------------------------------- */

async function readBody(request) {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/** Everything derived from a member's feed. `caches.default` is per data
 *  centre, so the cache half only clears the colo that handled this request. */
async function dropDerived(username, env, { history = true } = {}) {
  await Promise.all([
    env.ROLODEX.delete(`snapshot:${username}`),
    env.ROLODEX.delete(`avatar:${username}`),
    history ? env.ROLODEX.delete(`history:${username}`) : null,
    caches.default.delete(rssCacheKey(username)),
  ]);
}

/**
 * One row of the health panel, from the curated entry and its KV snapshot
 * alone. The snapshot is only written by a successful fetch, so its fetchedAt
 * *is* "last time this feed worked", and it already carries the history
 * summary — no second read per member.
 */
function healthRow(profile, index, snapshot, now) {
  const fetchedAt = snapshot && typeof snapshot.fetchedAt === 'string' ? snapshot.fetchedAt : null;
  const parsed = fetchedAt ? Date.parse(fetchedAt) : NaN;
  const ageMs = Number.isNaN(parsed) ? null : Math.max(0, now - parsed);

  let status = 'ok';
  if (ageMs === null) status = 'never';
  else if (ageMs > STALE_AFTER_MS) status = 'stale';

  const films = snapshot && Array.isArray(snapshot.films) ? snapshot.films : [];
  // Snapshots written before history existed have no summary.
  const history = snapshot && snapshot.history ? snapshot.history : null;
  const slot = index % CRON_SLOTS;

  return {
    username: profile.username,
    displayName: displayLabel(profile),
    status,
    fetchedAt,
    ageHours: ageMs === null ? null : Math.round(ageMs / 360000) / 10,
    films: films.length,
    latestWatched: films.length ? films[0].watchedDate || null : null,
    history,
    nearCap: Boolean(history && history.logged >= HISTORY_WARN_AT),
    slot,
    nextRefreshAt: new Date(nextCronRun(slot, now)).toISOString(),
  };
}

async function getHealth(env) {
  const now = Date.now();
  const profiles = await readProfiles(env);
  const rows = await mapWithLimit(profiles, 20, async (profile, index) => {
    const snapshot = await env.ROLODEX.get(`snapshot:${profile.username}`, 'json').catch(() => null);
    return healthRow(profile, index, snapshot, now);
  });
  const counts = { ok: 0, stale: 0, never: 0, nearCap: 0 };
  for (const row of rows) {
    counts[row.status] += 1;
    if (row.nearCap) counts.nearCap += 1;
  }
  return json({
    now: new Date(now).toISOString(),
    staleAfterHours: STALE_AFTER_MS / 3600000,
    historyCap: HISTORY_MAX,
    currentSlot: cronSlot(now),
    counts,
    profiles: rows,
  });
}

/** Shared by the cron and the admin "run now" button, so they can't drift. */
async function refreshSlice(env, ctx, time, { slot, force = false } = {}) {
  const profiles = await readProfiles(env);
  const useSlot = slot === undefined || slot === null ? cronSlot(time) : slot;
  const slice = cronSlice(profiles, time, useSlot);
  const results = await mapWithLimit(slice, CONCURRENCY, async (p) => {
    if (force) await caches.default.delete(rssCacheKey(p.username));
    const watches = await loadWatches(p.username, env, ctx);
    return { username: p.username, stale: Boolean(watches.stale) };
  });
  return {
    slot: useSlot,
    total: profiles.length,
    refreshed: results.length,
    failed: results.filter((r) => r.stale).map((r) => r.username),
  };
}

async function runCronNow(request, env, ctx) {
  const body = (await readBody(request)) || {};
  let slot;
  if (body.slot !== undefined && body.slot !== null) {
    slot = Number(body.slot);
    if (!Number.isInteger(slot) || slot < 0 || slot >= CRON_SLOTS) {
      return json({ error: `slot must be 0-${CRON_SLOTS - 1}` }, 400);
    }
  }
  return json(await refreshSlice(env, ctx, Date.now(), { slot, force: Boolean(body.force) }));
}

async function purgeStatsLive() {
  const purged = await caches.default.delete(statsCacheKey());
  return json({ purged });
}

async function findProfile(username, env) {
  const profiles = await readProfiles(env);
  const index = profiles.findIndex((p) => p.username === username);
  return index === -1 ? null : { profile: profiles[index], index };
}

/** Bypass the feed cache for one member. `ok: false` means Letterboxd couldn't
 *  be read just now — the public card keeps serving the snapshot. */
async function refreshProfile(username, env, ctx) {
  const found = await findProfile(username, env);
  if (!found) return json({ error: 'not found' }, 404);
  try {
    const payload = await fetchAndStore(username, env, ctx);
    return json({ ok: true, row: healthRow(found.profile, found.index, payload, Date.now()) });
  } catch (err) {
    console.error(`admin: refresh failed for ${username}`, err);
    return json({ ok: false, error: `could not read letterboxd.com/${username}/rss/` });
  }
}

const CLEARABLE = ['cache', 'snapshot', 'avatar'];

async function clearProfile(username, request, env) {
  if (!(await findProfile(username, env))) return json({ error: 'not found' }, 404);
  const body = (await readBody(request)) || {};
  const what = Array.isArray(body.what) && body.what.length ? body.what : CLEARABLE;
  if (what.some((w) => !CLEARABLE.includes(w))) {
    return json({ error: `what must be any of ${CLEARABLE.join(', ')}` }, 400);
  }
  await Promise.all([
    what.includes('cache') ? caches.default.delete(rssCacheKey(username)) : null,
    what.includes('snapshot') ? env.ROLODEX.delete(`snapshot:${username}`) : null,
    what.includes('avatar') ? env.ROLODEX.delete(`avatar:${username}`) : null,
  ]);
  return json({ cleared: what });
}

async function getHistory(username, request, env) {
  if (!(await findProfile(username, env))) return json({ error: 'not found' }, 404);
  const stored = await env.ROLODEX.get(`history:${username}`, 'json');
  const entries = stored && Array.isArray(stored.entries) ? stored.entries : [];
  const body = {
    username,
    since: stored ? stored.since || null : null,
    count: entries.length,
    cap: HISTORY_MAX,
    entries,
  };
  const download = new URL(request.url).searchParams.get('download');
  return json(
    body,
    200,
    download
      ? { 'Content-Disposition': `attachment; filename="history-${username}.json"`, 'Cache-Control': 'no-store' }
      : { 'Cache-Control': 'no-store' }
  );
}

/** Throw a member's stored history away and start again from what the feed
 *  shows now. `since` moves forward to the oldest entry still in the feed. */
async function resetHistory(username, env, ctx) {
  const found = await findProfile(username, env);
  if (!found) return json({ error: 'not found' }, 404);
  try {
    const payload = await fetchAndStore(username, env, ctx, { resetHistory: true });
    return json({ reset: true, reseeded: true, history: payload.history });
  } catch (err) {
    // Feed unreachable: still honour the reset. The next successful fetch seeds it.
    console.error(`admin: history reseed failed for ${username}`, err);
    await Promise.all([
      env.ROLODEX.delete(`history:${username}`),
      caches.default.delete(rssCacheKey(username)),
    ]);
    return json({ reset: true, reseeded: false, history: null });
  }
}

function validIso(value, fallback) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback;
}

function sameFields(a, b) {
  return (
    (a.displayName || '') === b.displayName &&
    (a.note || '') === b.note &&
    JSON.stringify(a.tags || []) === JSON.stringify(b.tags)
  );
}

/**
 * Pure plan for an import; the caller writes it (or just shows it, on a dry
 * run). `incoming` items are profile objects or bare handles.
 *
 *   add      only handles not already present are added; nothing else changes
 *   merge    adds new handles and overwrites the fields of ones already present
 *   replace  the file becomes the whole list; everyone else is removed
 *
 * Every item goes through the same normalizeUsername/sanitizeFields as the
 * single-profile form, so a hand-edited backup can't smuggle in anything the
 * form would refuse.
 */
function planImport(existing, incoming, mode, now) {
  const byUser = new Map(existing.map((p) => [p.username, p]));
  const next = new Map(mode === 'replace' ? [] : byUser);
  const seen = new Set();
  const added = [];
  const updated = [];
  const invalid = [];

  incoming.forEach((raw, index) => {
    const item = typeof raw === 'string' ? { username: raw } : raw;
    const username =
      item && typeof item === 'object' && !Array.isArray(item)
        ? normalizeUsername(item.username)
        : null;
    if (!username) {
      const shown = item && typeof item === 'object' ? item.username : raw;
      invalid.push({ index, value: String(shown ?? '').slice(0, 60), reason: 'invalid username' });
      return;
    }
    if (seen.has(username)) {
      invalid.push({ index, value: username, reason: 'duplicate in file' });
      return;
    }
    seen.add(username);

    const old = byUser.get(username);
    const fields = sanitizeFields(item);
    if (!old) {
      next.set(username, {
        username,
        ...fields,
        addedAt: validIso(item.addedAt, now),
        updatedAt: validIso(item.updatedAt, now),
      });
      added.push(username);
    } else if (mode === 'add' || sameFields(old, fields)) {
      next.set(username, old);
    } else {
      next.set(username, { ...old, ...fields, updatedAt: now });
      updated.push(username);
    }
  });

  const removed =
    mode === 'replace' ? existing.filter((p) => !seen.has(p.username)).map((p) => p.username) : [];
  const profiles = [...next.values()];

  return {
    profiles,
    summary: {
      mode,
      before: existing.length,
      count: profiles.length,
      added,
      updated,
      removed,
      invalid,
    },
  };
}

async function exportProfiles(env) {
  const profiles = await readProfiles(env);
  const exportedAt = new Date().toISOString();
  return json({ schema: BACKUP_SCHEMA, exportedAt, count: profiles.length, profiles }, 200, {
    'Content-Disposition': `attachment; filename="rolodex-backup-${exportedAt.slice(0, 10)}.json"`,
    'Cache-Control': 'no-store',
  });
}

async function importProfiles(request, env) {
  const body = await readBody(request);
  if (!body) return json({ error: 'invalid JSON body' }, 400);

  const mode = body.mode;
  if (!['add', 'merge', 'replace'].includes(mode)) {
    return json({ error: 'mode must be add, merge or replace' }, 400);
  }
  if (!Array.isArray(body.profiles)) return json({ error: 'profiles must be an array' }, 400);
  if (body.profiles.length > MAX_PROFILES * 5) return json({ error: 'too many entries' }, 400);

  const existing = await readProfiles(env);
  const now = new Date().toISOString();
  const { profiles, summary } = planImport(existing, body.profiles, mode, now);
  const dryRun = body.dryRun !== false; // writing must be asked for explicitly

  if (profiles.length > MAX_PROFILES) {
    return json({ error: `that would make ${profiles.length} profiles; the limit is ${MAX_PROFILES}`, ...summary }, 409);
  }
  // A replace with nothing valid in it would empty the rolodex. That is never
  // what a restore means; delete profiles one by one if it really is.
  if (mode === 'replace' && profiles.length === 0) {
    return json({ error: 'replace would leave the rolodex empty; refusing', ...summary }, 409);
  }

  const changes = summary.added.length + summary.updated.length + summary.removed.length;
  if (dryRun || changes === 0) return json({ dryRun, applied: false, ...summary });

  await env.ROLODEX.put(PREV_KEY, JSON.stringify({ savedAt: now, profiles: existing }));
  await writeProfiles(env, profiles);
  // Same rule as deleting one profile: removal deletes the stored history too.
  await mapWithLimit(summary.removed, CONCURRENCY, (username) => dropDerived(username, env));
  return json({ dryRun: false, applied: true, ...summary });
}

async function getPrevious(env) {
  const prev = await env.ROLODEX.get(PREV_KEY, 'json');
  if (!prev || !Array.isArray(prev.profiles)) return json({ available: false });
  return json({ available: true, savedAt: prev.savedAt || null, count: prev.profiles.length });
}

/**
 * Swap the list with the one saved before the last import; running it twice
 * puts the imported list back. Anyone the swap takes off the list loses their
 * derived keys, history included, exactly as if they had been removed by hand
 * — otherwise their history would sit in KV with no admin route able to reach
 * it. So the lists round-trip, but histories never come back.
 */
async function undoImport(env) {
  const prev = await env.ROLODEX.get(PREV_KEY, 'json');
  if (!prev || !Array.isArray(prev.profiles)) return json({ error: 'nothing to undo' }, 404);
  const current = await readProfiles(env);
  const kept = new Set(prev.profiles.map((p) => p.username));
  const removed = current.filter((p) => !kept.has(p.username)).map((p) => p.username);
  await env.ROLODEX.put(PREV_KEY, JSON.stringify({ savedAt: new Date().toISOString(), profiles: current }));
  await writeProfiles(env, prev.profiles);
  await mapWithLimit(removed, CONCURRENCY, (username) => dropDerived(username, env));
  return json({ restored: prev.profiles.length, replaced: current.length, removed });
}

function tagCounts(profiles) {
  const counts = new Map();
  for (const p of profiles) {
    for (const tag of p.tags || []) counts.set(tag, (counts.get(tag) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || COLLATOR.compare(a.tag, b.tag));
}

/**
 * Rename `from` on every profile that has it. Renaming onto a tag a profile
 * already carries is a merge (the duplicate collapses, case-insensitively); an
 * empty `to` removes the tag. `from` matches exactly, so two spellings of one
 * tag can be merged into either.
 */
function renameTag(profiles, from, to, now) {
  const target = String(to || '').trim().slice(0, MAX_TAG_LEN);
  const changed = [];
  const next = profiles.map((p) => {
    const tags = p.tags || [];
    if (!tags.includes(from)) return p;
    const out = [];
    for (const tag of tags) {
      const value = tag === from ? target : tag;
      if (value && !out.some((o) => o.toLowerCase() === value.toLowerCase())) out.push(value);
    }
    changed.push(p.username);
    return { ...p, tags: out, updatedAt: now };
  });
  return { profiles: next, changed, to: target };
}

async function renameTagRequest(request, env) {
  const body = await readBody(request);
  if (!body) return json({ error: 'invalid JSON body' }, 400);
  const from = typeof body.from === 'string' ? body.from : '';
  if (!from) return json({ error: 'from is required' }, 400);

  const existing = await readProfiles(env);
  const { profiles, changed, to } = renameTag(existing, from, body.to, new Date().toISOString());
  if (!changed.length) return json({ error: `no profile has the tag "${from}"` }, 404);
  if (from === to) return json({ error: 'that is the same tag' }, 400);

  const dryRun = Boolean(body.dryRun);
  if (!dryRun) await writeProfiles(env, profiles);
  return json({ dryRun, from, to, changed });
}

/* -------------------------------------------------------------------------- */
/* GitHub — the Worker's only path into the repo                              */
/* -------------------------------------------------------------------------- */

class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const repoOf = (env) => env.GITHUB_REPO || DEFAULT_REPO;
const branchOf = (env) => env.GITHUB_BRANCH || 'main';

async function gh(env, path, { method = 'GET', body, raw = false } = {}) {
  if (method !== 'GET' && !env.GITHUB_TOKEN) {
    throw new GitHubError(503, 'GITHUB_TOKEN is not configured on the Worker, so it cannot write to GitHub');
  }
  const headers = {
    Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
    'User-Agent': UA,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (env.GITHUB_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${GITHUB_API}/repos/${repoOf(env)}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const detail = await res.json();
      if (detail && detail.message) message = detail.message;
    } catch {
      // non-JSON error body
    }
    throw new GitHubError(res.status, message);
  }
  if (res.status === 204) return null;
  return raw ? res.text() : res.json();
}

/** A file's text at the tip of the branch. The raw media type has no 1 MB
 *  ceiling, which data/viewing_history.json is already past. */
const ghFile = (env, path) => gh(env, `/contents/${path}?ref=${branchOf(env)}`, { raw: true });

/** Upstream failures must never look like this Worker's own auth errors: a
 *  GitHub 401/403 becomes a 502 that says what GitHub said. */
function githubFailure(err) {
  if (!(err instanceof GitHubError)) throw err;
  if (err.status === 503) return json({ error: err.message }, 503);
  if (err.status === 409 || err.status === 422) {
    return json({ error: `GitHub refused the write: ${err.message}` }, 409);
  }
  return json({ error: `GitHub API ${err.status}: ${err.message}` }, 502);
}

// btoa/atob are Latin-1 only; film titles and tags are not.
function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* -------------------------------------------------------------------------- */
/* Admin API — pipeline                                                       */
/* -------------------------------------------------------------------------- */

function runBrief(run) {
  if (!run) return null;
  return {
    status: run.status,
    conclusion: run.conclusion || null,
    event: run.event || null,
    createdAt: run.created_at,
    url: run.html_url,
  };
}

/**
 * Pure summary of the data pipeline's state. `runs` are the data workflow's
 * newest runs first, as the GitHub API returns them.
 */
function pipelineReport({ runs, deployRuns, stats, rewatches, rssOnly, dataCommit }, now) {
  const list = Array.isArray(runs) ? runs : [];
  const success = list.find((r) => r.conclusion === 'success');
  const successAt = success ? Date.parse(success.created_at) : null;
  const ageMs = successAt === null ? null : Math.max(0, now - successAt);

  let cronStatus = 'ok';
  if (successAt === null) cronStatus = 'never';
  else if (ageMs > PIPELINE_LATE_MS) cronStatus = 'late';

  const exportDate = (stats && stats.archiveExportDate) || null;
  const exportAt = exportDate ? Date.parse(`${exportDate}T00:00:00Z`) : NaN;
  const watchlist = (stats && stats.watchlist) || {};
  const rewatchTotals = (rewatches && rewatches.totals) || {};

  return {
    cron: {
      status: cronStatus,
      lateAfterHours: PIPELINE_LATE_MS / 3600000,
      lastSuccessAt: success ? success.created_at : null,
      hoursSinceSuccess: ageMs === null ? null : Math.round(ageMs / 360000) / 10,
      failedSinceSuccess: list.filter(
        (r) => r.conclusion === 'failure' && (successAt === null || Date.parse(r.created_at) > successAt)
      ).length,
      running: list.some((r) => r.status === 'in_progress' || r.status === 'queued'),
      checked: list.length,
      lastRun: runBrief(list[0]),
    },
    deploy: runBrief(Array.isArray(deployRuns) ? deployRuns[0] : null),
    data: {
      lastCommitAt: dataCommit ? dataCommit.date : null,
      lastCommitUrl: dataCommit ? dataCommit.url : null,
      totalWatched: stats ? stats.totalWatched ?? null : null,
      latestWatched: stats && stats.dateRange ? stats.dateRange.latest || null : null,
    },
    archive: {
      exportDate,
      ageDays: Number.isNaN(exportAt) ? null : Math.max(0, Math.floor((now - exportAt) / 86400000)),
      // Diary entries known only from RSS: no tags, and gone from the feed
      // eventually. This is what the next full export will pick up.
      rssOnly,
    },
    watchlist: {
      count: watchlist.count ?? null,
      snapshotDate: watchlist.snapshotDate || null,
      snapshotSource: watchlist.snapshotSource || null,
    },
    // rewatches.json is written by the same run as stats.json. If the workflow
    // ever stops committing it, its log total falls behind — the page would be
    // stale with nothing else to show for it.
    rewatches: {
      inSync:
        Boolean(stats && rewatches) &&
        rewatchTotals.logs === stats.totalWatched &&
        rewatches.archiveExportDate === stats.archiveExportDate,
      logs: rewatchTotals.logs ?? null,
      exportDate: (rewatches && rewatches.archiveExportDate) || null,
    },
  };
}

async function readStats(env) {
  return JSON.parse(await ghFile(env, 'data/stats.json'));
}

async function getPipeline(env) {
  const branch = branchOf(env);
  const [dataRuns, deployRuns, stats, rewatchesText, historyText, commits] = await Promise.all([
    gh(env, `/actions/workflows/${DATA_WORKFLOW}/runs?per_page=10&branch=${branch}`),
    gh(env, `/actions/workflows/${DEPLOY_WORKFLOW}/runs?per_page=1&branch=${branch}`),
    readStats(env),
    ghFile(env, 'data/rewatches.json'),
    ghFile(env, 'data/viewing_history.json'),
    gh(env, `/commits?path=data/stats.json&per_page=1&sha=${branch}`),
  ]);
  const commit = Array.isArray(commits) && commits[0];
  const report = pipelineReport(
    {
      runs: dataRuns.workflow_runs,
      deployRuns: deployRuns.workflow_runs,
      stats,
      rewatches: JSON.parse(rewatchesText),
      // Counted on the text: no need to parse 1.3 MB to count one field.
      rssOnly: (historyText.match(/"source":\s*"rss"/g) || []).length,
      dataCommit: commit ? { date: commit.commit.committer.date, url: commit.html_url } : null,
    },
    Date.now()
  );
  return json({ repo: repoOf(env), canWrite: Boolean(env.GITHUB_TOKEN), ...report }, 200, {
    'Cache-Control': 'no-store',
  });
}

async function dispatchPipeline(env) {
  await gh(env, `/actions/workflows/${DATA_WORKFLOW}/dispatches`, {
    method: 'POST',
    body: { ref: branchOf(env) },
  });
}

async function runPipeline(env) {
  await dispatchPipeline(env);
  return json({ dispatched: true });
}

const EXPORT_STAMP_RE = /(\d{4}-\d{2}-\d{2})-(\d{2})-(\d{2})-utc/;

/** "2026-11-21-05-45" from either kind of export name; sorts as text. */
function exportStamp(name) {
  const m = EXPORT_STAMP_RE.exec(String(name || ''));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
}

/**
 * Pure check of a watchlist-only export before it is committed. The pipeline
 * uses whichever snapshot carries the newest timestamp in its name — a full
 * archive or a watchlist file — so an upload older than the current snapshot
 * would commit and then change nothing; `supersedes` says which this is.
 */
function checkWatchlist(filename, content, currentSource) {
  const name = String(filename || '');
  const expected = new RegExp(`^watchlist-${STATS_USERNAME}-\\d{4}-\\d{2}-\\d{2}-\\d{2}-\\d{2}-utc\\.csv$`);
  if (!expected.test(name)) {
    return { ok: false, error: `the file must be named watchlist-${STATS_USERNAME}-YYYY-MM-DD-HH-MM-utc.csv, as Letterboxd exports it` };
  }
  if (typeof content !== 'string' || !content.trim()) return { ok: false, error: 'the file is empty' };
  if (new TextEncoder().encode(content).length > MAX_WATCHLIST_BYTES) {
    return { ok: false, error: 'the file is larger than 2 MB' };
  }

  const lines = content.replace(/^﻿/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines[0] !== WATCHLIST_HEADER) {
    return { ok: false, error: `not a Letterboxd watchlist export: the first line must be "${WATCHLIST_HEADER}"` };
  }
  const rows = lines.slice(1);
  if (!rows.length) return { ok: false, error: 'the watchlist has no films in it' };
  const bad = rows.findIndex((row) => !/^\d{4}-\d{2}-\d{2},.+,https:\/\/boxd\.it\/\w+$/.test(row));
  if (bad !== -1) return { ok: false, error: `line ${bad + 2} is not a watchlist row` };

  const dates = rows.map((row) => row.slice(0, 10)).sort();
  const stamp = exportStamp(name);
  const currentStamp = exportStamp(currentSource);
  return {
    ok: true,
    filename: name,
    rows: rows.length,
    oldestAdded: dates[0],
    newestAdded: dates[dates.length - 1],
    stamp,
    currentStamp,
    currentSource: currentSource || null,
    supersedes: !currentStamp || stamp > currentStamp,
  };
}

async function uploadWatchlist(request, env) {
  const body = await readBody(request);
  if (!body) return json({ error: 'invalid JSON body' }, 400);

  const stats = await readStats(env);
  const current = stats.watchlist || {};
  const check = checkWatchlist(body.filename, body.content, current.snapshotSource);
  if (!check.ok) return json({ error: check.error }, 400);
  const report = { ...check, currentCount: current.count ?? null };

  if (body.dryRun !== false) return json({ dryRun: true, committed: false, ...report });
  if (!check.supersedes) {
    return json(
      { error: `the current snapshot (${check.currentSource}) is newer, so this file would change nothing`, ...report },
      409
    );
  }

  let commit;
  try {
    commit = await gh(env, `/contents/data/archive/${check.filename}`, {
      method: 'PUT',
      body: {
        message: `Add watchlist export ${check.stamp}`,
        content: toBase64(body.content),
        branch: branchOf(env),
      },
    });
  } catch (err) {
    // No sha was sent, so GitHub answers 422 when the path already exists.
    if (err instanceof GitHubError && err.status === 422) {
      return json({ error: `${check.filename} is already in the repo`, ...report }, 409);
    }
    throw err;
  }

  // The commit alone redeploys the site but recomputes nothing: stats.json is
  // only rebuilt by the data workflow.
  let dispatched = false;
  if (body.run !== false) {
    await dispatchPipeline(env);
    dispatched = true;
  }
  return json({
    dryRun: false,
    committed: true,
    commitUrl: commit && commit.commit ? commit.commit.html_url : null,
    dispatched,
    ...report,
  });
}

/* -------------------------------------------------------------------------- */
/* Admin API — diary tag categories (data/tag_categories.json)                */
/* -------------------------------------------------------------------------- */

const normTag = (tag) => String(tag ?? '').trim().toLowerCase();

/** Use counts for every diary tag, lowercased like tags.js matches them. */
function diaryTagCounts(history) {
  const counts = {};
  for (const entry of Array.isArray(history) ? history : []) {
    for (const tag of entry.tags || []) {
      const key = normTag(tag);
      if (key) counts[key] = (counts[key] || 0) + 1;
    }
  }
  return counts;
}

/**
 * The editor only moves tags between the categories the file already has.
 * Ids, labels, icons and order come from `existing`; `incoming` supplies each
 * category's tags. A tag listed twice stays in the first category that has it,
 * which is how tags.js would resolve it anyway.
 */
function applyCategoryTags(existing, incoming) {
  const current = Array.isArray(existing.categories) ? existing.categories : [];
  if (!Array.isArray(incoming) || incoming.length !== current.length) {
    return { error: 'categories must list every existing category, in order' };
  }
  const seen = new Set();
  const categories = [];
  for (let i = 0; i < current.length; i++) {
    const given = incoming[i];
    if (!given || given.id !== current[i].id) {
      return { error: `category ${i + 1} must be "${current[i].id}"; categories can't be added, removed or reordered here` };
    }
    if (!Array.isArray(given.tags)) return { error: `"${current[i].id}" needs a tags list` };
    const tags = [];
    for (const raw of given.tags) {
      if (typeof raw !== 'string') return { error: `"${current[i].id}" has a tag that is not text` };
      const tag = normTag(raw);
      if (!tag || tag.length > MAX_DIARY_TAG_LEN) return { error: `"${current[i].id}" has an empty or over-long tag` };
      if (seen.has(tag)) continue;
      seen.add(tag);
      tags.push(tag);
    }
    categories.push({ ...current[i], tags });
  }
  return { categories };
}

/**
 * Serialize in the file's hand-kept layout: two-space JSON, with each `tags`
 * array on one line when it fits and wrapped at 100 columns when it doesn't,
 * so a commit's diff is the tags that moved rather than a reformat.
 */
function formatCategories(doc) {
  const lines = ['{'];
  const top = Object.keys(doc).filter((key) => key !== 'categories');
  for (const key of top) lines.push(`  ${JSON.stringify(key)}: ${JSON.stringify(doc[key])},`);
  lines.push('  "categories": [');

  doc.categories.forEach((category, index) => {
    lines.push('    {');
    const keys = Object.keys(category).filter((key) => key !== 'tags');
    for (const key of keys) lines.push(`      ${JSON.stringify(key)}: ${JSON.stringify(category[key])},`);

    const items = category.tags.map((tag) => JSON.stringify(tag));
    const inline = `      "tags": [${items.join(', ')}]`;
    if (inline.length <= CATEGORY_WRAP) {
      lines.push(inline);
    } else {
      lines.push('      "tags": [');
      let row = '';
      items.forEach((item, i) => {
        const piece = item + (i < items.length - 1 ? ',' : '');
        const next = row ? `${row} ${piece}` : `        ${piece}`;
        if (row && next.length > CATEGORY_WRAP) {
          lines.push(row);
          row = `        ${piece}`;
        } else {
          row = next;
        }
      });
      if (row) lines.push(row);
      lines.push('      ]');
    }
    lines.push(index < doc.categories.length - 1 ? '    },' : '    }');
  });

  lines.push('  ]', '}');
  return lines.join('\n') + '\n';
}

async function readCategories(env) {
  const file = await gh(env, `/contents/${CATEGORIES_PATH}?ref=${branchOf(env)}`);
  const text = fromBase64(file.content);
  return { sha: file.sha, text, doc: JSON.parse(text) };
}

async function getTagCategories(env) {
  const [file, historyText] = await Promise.all([
    readCategories(env),
    ghFile(env, 'data/viewing_history.json'),
  ]);
  return json(
    {
      sha: file.sha,
      canWrite: Boolean(env.GITHUB_TOKEN),
      categories: (file.doc.categories || []).map((c) => ({
        id: c.id,
        label: c.label,
        icon: c.icon,
        tags: (c.tags || []).map(normTag),
      })),
      counts: diaryTagCounts(JSON.parse(historyText)),
    },
    200,
    { 'Cache-Control': 'no-store' }
  );
}

async function putTagCategories(request, env) {
  const body = await readBody(request);
  if (!body) return json({ error: 'invalid JSON body' }, 400);

  const file = await readCategories(env);
  // The editor's copy must be the one on the branch, or its save would undo
  // whoever committed in between.
  if (body.sha !== file.sha) {
    return json({ error: 'tag_categories.json changed on GitHub since this page loaded; reload and reapply' }, 409);
  }
  const result = applyCategoryTags(file.doc, body.categories);
  if (result.error) return json({ error: result.error }, 400);

  const before = new Map();
  for (const c of file.doc.categories) for (const tag of c.tags || []) before.set(normTag(tag), c.id);
  const after = new Map();
  for (const c of result.categories) for (const tag of c.tags) after.set(tag, c.id);
  const moved = [...new Set([...before.keys(), ...after.keys()])].filter((tag) => before.get(tag) !== after.get(tag));

  const text = formatCategories({ ...file.doc, categories: result.categories });
  if (!moved.length || text === file.text) return json({ committed: false, moved: [] });

  const commit = await gh(env, `/contents/${CATEGORIES_PATH}`, {
    method: 'PUT',
    body: {
      message: `Recategorise ${moved.length} diary tag${moved.length === 1 ? '' : 's'}`,
      content: toBase64(text),
      sha: file.sha,
      branch: branchOf(env),
    },
  });
  return json({
    committed: true,
    moved,
    sha: commit && commit.content ? commit.content.sha : null,
    commitUrl: commit && commit.commit ? commit.commit.html_url : null,
  });
}

async function routeAdminApi(request, env, ctx, pathname) {
  const rest = pathname.slice('/admin/api/'.length);
  const only = (method) =>
    request.method === method ? null : json({ error: 'method not allowed' }, 405);

  if (rest === 'preview') {
    if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
    return previewProfile(request, env, ctx);
  }

  if (rest === 'profiles') {
    if (request.method === 'GET') return json(await readProfiles(env));
    if (request.method === 'POST') return createProfile(request, env);
    return json({ error: 'method not allowed' }, 405);
  }

  if (rest.startsWith('profiles/')) {
    const segments = rest.slice('profiles/'.length).split('/');
    let username = null;
    try {
      username = normalizeUsername(decodeURIComponent(segments[0]));
    } catch {
      // malformed percent-encoding
    }
    if (!username) return json({ error: 'invalid username' }, 400);
    if (segments.length > 2) return json({ error: 'not found' }, 404);

    if (segments.length === 2) {
      const action = segments[1];
      if (action === 'refresh') return only('POST') || refreshProfile(username, env, ctx);
      if (action === 'clear') return only('POST') || clearProfile(username, request, env);
      if (action === 'history') {
        if (request.method === 'GET') return getHistory(username, request, env);
        if (request.method === 'DELETE') return resetHistory(username, env, ctx);
        return json({ error: 'method not allowed' }, 405);
      }
      return json({ error: 'not found' }, 404);
    }

    if (request.method === 'PUT') return updateProfile(username, request, env);
    if (request.method === 'DELETE') return deleteProfile(username, env);
    return json({ error: 'method not allowed' }, 405);
  }

  if (rest === 'health') return only('GET') || getHealth(env);
  if (rest === 'export') return only('GET') || exportProfiles(env);
  if (rest === 'import') return only('POST') || importProfiles(request, env);
  if (rest === 'import/prev') return only('GET') || getPrevious(env);
  if (rest === 'import/undo') return only('POST') || undoImport(env);
  if (rest === 'cron/run') return only('POST') || runCronNow(request, env, ctx);
  if (rest === 'stats-live/purge') return only('POST') || purgeStatsLive();
  if (rest === 'pipeline') return only('GET') || getPipeline(env).catch(githubFailure);
  if (rest === 'pipeline/run') return only('POST') || runPipeline(env).catch(githubFailure);
  if (rest === 'pipeline/watchlist') {
    return only('POST') || uploadWatchlist(request, env).catch(githubFailure);
  }
  if (rest === 'tag-categories') {
    if (request.method === 'GET') return getTagCategories(env).catch(githubFailure);
    if (request.method === 'PUT') return putTagCategories(request, env).catch(githubFailure);
    return json({ error: 'method not allowed' }, 405);
  }
  if (rest === 'tags') {
    if (request.method === 'GET') return json(tagCounts(await readProfiles(env)));
    if (request.method === 'POST') return renameTagRequest(request, env);
    return json({ error: 'method not allowed' }, 405);
  }

  return json({ error: 'not found' }, 404);
}

/* -------------------------------------------------------------------------- */
/* Router                                                                     */
/* -------------------------------------------------------------------------- */

async function route(request, env, ctx) {
  const { pathname } = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders(request) });
  }

  if (pathname === '/health') {
    try {
      await env.ROLODEX.list({ limit: 1 });
      return json({ ok: true });
    } catch (err) {
      console.error('health: KV check failed', err);
      return json({ ok: false, kv: 'error' }, 503);
    }
  }

  if (pathname === '/rolodex/stream') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    return streamRolodex(request, env, ctx);
  }

  if (pathname === '/rolodex') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    return getRolodex(request, env, ctx);
  }

  if (pathname === '/stats/live') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    return getStatsLive(request, env, ctx);
  }

  if (pathname === '/admin' || pathname.startsWith('/admin/')) {
    const auth = await requireAdmin(request, env);
    if (!auth.ok) return auth.response;

    // Defence in depth on top of Access: a browser labels every request with
    // where it came from, so a write that another site triggered is refused
    // even if the Access cookie rode along. Absent header = not a browser.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      const site = request.headers.get('Sec-Fetch-Site');
      if (site && site !== 'same-origin' && site !== 'none') {
        return json({ error: 'cross-site request refused' }, 403);
      }
    }

    if (pathname === '/admin' || pathname === '/admin/') {
      return html(renderAdminPage());
    }
    if (pathname.startsWith('/admin/api/')) {
      return routeAdminApi(request, env, ctx, pathname);
    }
    return json({ error: 'not found' }, 404);
  }

  return json({ error: 'not found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env, ctx);
    } catch (err) {
      console.error('rolodex error:', err);
      return json({ error: 'internal error' }, 500);
    }
  },

  /** Keeps history accruing when nobody visits; see cronSlice. Goes through
   *  loadWatches, so a member a visitor just loaded is a cache hit, not a
   *  second Letterboxd request. */
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      refreshSlice(env, ctx, event.scheduledTime).then((r) =>
        console.log(
          `rolodex cron: slot ${r.slot}, refreshed ${r.refreshed} of ${r.total}` +
            (r.failed.length ? `, serving snapshots for ${r.failed.join(', ')}` : '')
        )
      )
    );
  },
};

export {
  mergeHistory,
  summarizeHistory,
  cronSlice,
  entryId,
  parseFeed,
  extractReview,
  decodeEntities,
  normalizeUsername,
  mapWithLimit,
  corsHeaders,
  byFirstName,
  firstName,
  cronSlot,
  nextCronRun,
  healthRow,
  planImport,
  renameTag,
  tagCounts,
  pipelineReport,
  checkWatchlist,
  exportStamp,
  diaryTagCounts,
  applyCategoryTags,
  formatCategories,
  toBase64,
  fromBase64,
};
