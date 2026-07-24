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
 */

const ROLODEX_KEY = 'rolodex:v1';

const LAST_N = 4; // "Last Four Watched"
const RSS_TTL = 900; // 15min per-profile feed cache
const AGGREGATE_TTL = 300; // 5min on the public /rolodex response
const AVATAR_TTL = 86400; // 24h — avatars change rarely
const CONCURRENCY = 6; // never fan 30 requests at Letterboxd at once
const MAX_PROFILES = 200;

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

/**
 * Read-through cache in front of a profile's feed, with a KV snapshot as the
 * floor: if Letterboxd is unreachable or the feed stops parsing, the card keeps
 * showing the last known-good four and is flagged `stale` instead of vanishing.
 */
async function loadWatches(username, env, ctx) {
  const cacheKey = new Request(`https://rolodex.internal/rss/${username}`);
  const cache = caches.default;

  const hit = await cache.match(cacheKey);
  if (hit) {
    const payload = await hit.json();
    return { ...payload, stale: false };
  }

  try {
    const payload = await fetchWatches(username);
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
    ctx.waitUntil(env.ROLODEX.put(`snapshot:${username}`, JSON.stringify(payload)));
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
  const cacheKey = new Request('https://rolodex.internal/stats-live');
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
  await Promise.all([
    env.ROLODEX.delete(`snapshot:${username}`),
    env.ROLODEX.delete(`avatar:${username}`),
  ]);
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

async function routeAdminApi(request, env, ctx, pathname) {
  const rest = pathname.slice('/admin/api/'.length);

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
    const username = normalizeUsername(decodeURIComponent(segments[0]));
    if (!username) return json({ error: 'invalid username' }, 400);
    if (segments.length > 1) return json({ error: 'not found' }, 404);

    if (request.method === 'PUT') return updateProfile(username, request, env);
    if (request.method === 'DELETE') return deleteProfile(username, env);
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
};

/* -------------------------------------------------------------------------- */
/* Admin UI                                                                   */
/* -------------------------------------------------------------------------- */

function renderAdminPage() {
  // Inline, no build step — same spirit as the rest of this repo. Colors mirror
  // assets/css/dashboard.css so the admin feels like part of the site.
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Rolodex admin</title>
<style>
  :root {
    --bg-primary: #14181c; --bg-secondary: #1c2228; --bg-tertiary: #242c34;
    --bg-hover: #2c3440; --text-primary: #fff; --text-secondary: #99aabb;
    --text-muted: #667788; --accent-green: #00e054; --accent-blue: #40bcf4;
    --border: #2c3440; --danger: #f44336;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--bg-primary); color: var(--text-secondary);
    line-height: 1.5; padding: 2rem 1.5rem 4rem;
  }
  .wrap { max-width: 760px; margin: 0 auto; }
  h1 { color: var(--text-primary); font-size: 1.5rem; margin-bottom: .25rem; }
  .sub { color: var(--text-muted); font-size: .875rem; margin-bottom: 2rem; }
  fieldset { border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem; margin-bottom: 2rem; }
  legend { color: var(--text-primary); font-size: .875rem; font-weight: 600; padding: 0 .5rem; }
  label { display: block; font-size: .75rem; text-transform: uppercase;
          letter-spacing: .05em; color: var(--text-muted); margin: .875rem 0 .25rem; }
  input[type=text] {
    width: 100%; padding: .5rem .625rem; background: var(--bg-tertiary);
    border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary);
    font: inherit; font-size: .9375rem;
  }
  input[type=text]:focus { outline: none; border-color: var(--accent-blue); }
  /* The username field is disabled while editing — make that visible at a
     glance rather than only discoverable by clicking into it. */
  input[type=text]:disabled {
    opacity: 0.55; cursor: not-allowed;
    background: var(--bg-secondary); border-style: dashed;
  }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; margin-top: 1.25rem; }
  button {
    padding: .5rem .875rem; border-radius: 4px; border: 1px solid var(--border);
    background: var(--bg-tertiary); color: var(--text-secondary);
    font: inherit; font-size: .875rem; cursor: pointer;
  }
  button:hover:not(:disabled) { background: var(--bg-hover); color: var(--text-primary); }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: var(--accent-green); border-color: var(--accent-green); color: #05140a; font-weight: 600; }
  button.danger:hover { border-color: var(--danger); color: var(--danger); }
  /* Scoped to the edit form so the list's small × buttons keep their
     quieter hover-only treatment. */
  #btn-delete { color: var(--danger); margin-left: auto; }
  #btn-delete:hover:not(:disabled) {
    border-color: var(--danger); background: rgba(244, 67, 54, 0.12); color: var(--danger);
  }
  .field-hint {
    font-size: 0.75rem; color: var(--text-muted);
    margin-top: 0.375rem; max-width: 46ch;
  }
  .field-hint[hidden] { display: none; }
  .icon { padding: .25rem .5rem; font-size: .8125rem; }
  .entry {
    display: flex; align-items: flex-start; gap: .875rem; padding: .875rem;
    background: var(--bg-secondary); border: 1px solid var(--border);
    border-radius: 8px; margin-bottom: .625rem;
  }
  .entry .meta { flex: 1; min-width: 0; }
  .entry .name { color: var(--text-primary); font-weight: 600; }
  .entry .handle { color: var(--text-muted); font-size: .8125rem; }
  .entry .note { font-size: .875rem; margin-top: .25rem; }
  .tags { display: flex; gap: .375rem; flex-wrap: wrap; margin-top: .5rem; }
  .tag { font-size: .6875rem; text-transform: uppercase; letter-spacing: .04em;
         background: var(--bg-tertiary); color: var(--text-muted);
         padding: .125rem .5rem; border-radius: 999px; }
  .controls { display: flex; gap: .25rem; flex-shrink: 0; }
  .status { min-height: 1.5rem; font-size: .875rem; margin-top: .875rem; }
  .status.error { color: var(--danger); }
  .status.ok { color: var(--accent-green); }
  .preview { display: flex; gap: .5rem; margin-top: .875rem; }
  .preview figure { flex: 1; }
  .preview img { width: 100%; border-radius: 4px; display: block; background: var(--bg-tertiary); aspect-ratio: 2/3; }
  .preview figcaption { font-size: .6875rem; color: var(--text-muted); margin-top: .25rem; }
  .empty { color: var(--text-muted); font-style: italic; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Rolodex admin</h1>
  <p class="sub">Curated Letterboxd profiles for the public rolodex page.
     Sorted automatically by first name — display order isn't stored, so
     renaming someone moves their card.</p>

  <fieldset>
    <legend id="form-legend">Add a profile</legend>
    <label for="f-username">Letterboxd username or profile URL</label>
    <input type="text" id="f-username" placeholder="michaellamb" autocomplete="off" />
    <p class="field-hint" id="username-hint" hidden>
      The username is this entry's key, so it can't be edited. To fix a typo,
      delete this entry and add it again.
    </p>
    <label for="f-display">Display name</label>
    <input type="text" id="f-display" placeholder="Michael" autocomplete="off" />
    <label for="f-note">Note</label>
    <input type="text" id="f-note" placeholder="met at JXN Film Club" autocomplete="off" />
    <label for="f-tags">Tags (comma separated)</label>
    <input type="text" id="f-tags" placeholder="jxnfilmclub, horror" autocomplete="off" />
    <div class="row">
      <button type="button" id="btn-preview">Preview feed</button>
      <button type="button" class="primary" id="btn-save">Save</button>
      <button type="button" id="btn-cancel" hidden>Cancel edit</button>
      <button type="button" id="btn-delete" hidden>Delete entry</button>
    </div>
    <div class="status" id="status"></div>
    <div class="preview" id="preview"></div>
  </fieldset>

  <div id="list"><p class="empty">Loading…</p></div>
</div>

<script>
(function () {
  'use strict';

  var API = '/admin/api';
  var editing = null;

  var el = function (id) { return document.getElementById(id); };

  function setStatus(message, kind) {
    var node = el('status');
    node.textContent = message || '';
    node.className = 'status' + (kind ? ' ' + kind : '');
  }

  function escapeHtml(str) {
    var div = document.createElement('div');
    div.textContent = str == null ? '' : str;
    return div.innerHTML;
  }

  function readForm() {
    return {
      username: el('f-username').value,
      displayName: el('f-display').value,
      note: el('f-note').value,
      tags: el('f-tags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean)
    };
  }

  function resetForm() {
    editing = null;
    el('f-username').value = '';
    el('f-display').value = '';
    el('f-note').value = '';
    el('f-tags').value = '';
    el('f-username').disabled = false;
    el('form-legend').textContent = 'Add a profile';
    el('btn-cancel').hidden = true;
    el('btn-delete').hidden = true;
    el('username-hint').hidden = true;
    el('preview').innerHTML = '';
    setStatus('');
  }

  async function api(path, options) {
    var res = await fetch(API + path, options || {});
    if (res.status === 204) return null;
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(body.error || ('HTTP ' + res.status));
    return body;
  }

  async function load() {
    try {
      var profiles = await api('/profiles');
      render(profiles);
    } catch (err) {
      el('list').innerHTML = '<p class="empty">Could not load: ' + escapeHtml(err.message) + '</p>';
    }
  }

  function render(profiles) {
    if (!profiles.length) {
      el('list').innerHTML = '<p class="empty">No profiles yet.</p>';
      return;
    }
    el('list').innerHTML = profiles.map(function (p) {
      return '<div class="entry">' +
        '<div class="meta">' +
          '<div class="name">' + escapeHtml(p.displayName || p.username) + '</div>' +
          '<div class="handle">@' + escapeHtml(p.username) + '</div>' +
          (p.note ? '<div class="note">' + escapeHtml(p.note) + '</div>' : '') +
          (p.tags && p.tags.length
            ? '<div class="tags">' + p.tags.map(function (t) {
                return '<span class="tag">' + escapeHtml(t) + '</span>';
              }).join('') + '</div>'
            : '') +
        '</div>' +
        '<div class="controls">' +
          '<button class="icon" data-edit="' + escapeHtml(p.username) + '" title="Edit">Edit</button>' +
          '<button class="icon danger" data-delete="' + escapeHtml(p.username) + '" title="Remove">&times;</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  el('list').addEventListener('click', async function (event) {
    var button = event.target.closest('button');
    if (!button) return;

    try {
      if (button.dataset.delete) {
        var username = button.dataset.delete;
        if (!confirm('Remove @' + username + ' from the rolodex?')) return;
        await api('/profiles/' + username, { method: 'DELETE' });
        setStatus('Removed @' + username + '.', 'ok');
        load();
      } else if (button.dataset.edit) {
        var profiles = await api('/profiles');
        var profile = profiles.find(function (p) { return p.username === button.dataset.edit; });
        if (!profile) return;
        editing = profile.username;
        el('f-username').value = profile.username;
        el('f-username').disabled = true;
        el('f-display').value = profile.displayName || '';
        el('f-note').value = profile.note || '';
        el('f-tags').value = (profile.tags || []).join(', ');
        el('form-legend').textContent = 'Editing @' + profile.username;
        el('btn-cancel').hidden = false;
        el('btn-delete').hidden = false;
        el('username-hint').hidden = false;
        setStatus('');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    } catch (err) {
      setStatus(err.message, 'error');
    }
  });

  el('btn-preview').addEventListener('click', async function () {
    var username = el('f-username').value.trim();
    if (!username) return setStatus('Enter a username first.', 'error');
    setStatus('Fetching feed…');
    el('preview').innerHTML = '';
    try {
      var result = await api('/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username })
      });
      if (!result.films.length) {
        setStatus('Feed reachable, but no diary entries yet.', 'ok');
        return;
      }
      setStatus('Found @' + result.username + '.', 'ok');
      el('preview').innerHTML = result.films.map(function (film) {
        return '<figure>' +
          (film.poster ? '<img alt="" src="' + escapeHtml(film.poster) + '" />' : '<img alt="" />') +
          '<figcaption>' + escapeHtml(film.title) + '</figcaption>' +
        '</figure>';
      }).join('');
    } catch (err) {
      setStatus(err.message, 'error');
    }
  });

  el('btn-save').addEventListener('click', async function () {
    var payload = readForm();
    if (!payload.username.trim()) return setStatus('Username is required.', 'error');
    el('btn-save').disabled = true;
    try {
      if (editing) {
        await api('/profiles/' + editing, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        setStatus('Saved.', 'ok');
      } else {
        var created = await api('/profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        setStatus('Added @' + created.username + '.', 'ok');
      }
      resetForm();
      load();
    } catch (err) {
      setStatus(err.message, 'error');
    } finally {
      el('btn-save').disabled = false;
    }
  });

  el('btn-cancel').addEventListener('click', resetForm);

  // Delete the entry being edited. The username is the KV key and so can't be
  // changed by an edit — this is the one-step path for fixing a wrong handle
  // without hunting for the row again.
  el('btn-delete').addEventListener('click', async function () {
    if (!editing) return;
    var username = editing;
    if (!confirm('Remove @' + username + ' from the rolodex?')) return;
    el('btn-delete').disabled = true;
    try {
      await api('/profiles/' + username, { method: 'DELETE' });
      resetForm();
      setStatus('Removed @' + username + '. Add it again with the corrected username.', 'ok');
      load();
    } catch (err) {
      setStatus(err.message, 'error');
    } finally {
      el('btn-delete').disabled = false;
    }
  });

  load();
})();
</script>
</body>
</html>`;
}

export {
  parseFeed,
  extractReview,
  decodeEntities,
  normalizeUsername,
  mapWithLimit,
  corsHeaders,
  byFirstName,
  firstName,
};
