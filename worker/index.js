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
 *   rolodex:v1          ordered array of curated entries — one key, so reorder
 *                       is atomic and GET /rolodex is a single read
 *   snapshot:<user>     last successful last-four payload, no TTL (serve-stale)
 *   avatar:<user>       resolved og:image URL, 24h TTL ('' = known to have none)
 *
 * Auth: unlike the sibling `now-store` Worker — where Cloudflare Access gates
 * the entire hostname — this host is deliberately MIXED. `/rolodex` must stay
 * public for site visitors, so the Access application is path-scoped to
 * `/admin`. Because a misconfigured or removed Access app would otherwise
 * silently expose the write API, this Worker independently verifies the
 * `Cf-Access-Jwt-Assertion` signature rather than trusting the edge.
 *
 * Endpoints:
 *   GET    /rolodex                              public
 *   GET    /health                               public
 *   GET    /admin                                Access — CRUD UI
 *   GET    /admin/api/profiles                   Access
 *   POST   /admin/api/profiles                   Access — { username, displayName?, note?, tags? }
 *   PUT    /admin/api/profiles/{username}        Access
 *   DELETE /admin/api/profiles/{username}        Access
 *   POST   /admin/api/profiles/{username}/move   Access — { direction: "up"|"down" }
 *   POST   /admin/api/preview                    Access — { username } uncached probe
 */

const ROLODEX_KEY = 'rolodex:v1';

const LAST_N = 4; // "Last Four Watched"
const RSS_TTL = 900; // 15min per-profile feed cache
const AGGREGATE_TTL = 300; // 5min on the public /rolodex response
const AVATAR_TTL = 86400; // 24h — avatars change rarely
const CONCURRENCY = 6; // never fan 30 requests at Letterboxd at once
const MAX_PROFILES = 200;

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

async function readProfiles(env) {
  const raw = await env.ROLODEX.get(ROLODEX_KEY, 'json');
  return Array.isArray(raw) ? raw : [];
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
 * Workers have no DOMParser, so parse the (machine-generated, stable) feed with
 * targeted regexes — the same fields scripts/extract_history.py reads via
 * ElementTree.
 */
function parseFeed(xml) {
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

    films.push({
      title: decodeEntities(tagText(block, 'letterboxd:filmTitle')) || 'Untitled',
      year: year ? Number(year) : null,
      rating: rating ? Number(rating) : null,
      rewatch: tagText(block, 'letterboxd:rewatch') === 'Yes',
      watchedDate,
      link: decodeEntities(tagText(block, 'link')),
      poster: posterMatch ? decodeEntities(posterMatch[1]) : null,
      tmdbId: tagText(block, 'tmdb:movieId') || tagText(block, 'tmdb:tvId') || null,
    });

    if (films.length >= LAST_N) break;
  }

  return films;
}

async function fetchWatches(username) {
  const res = await fetch(`https://letterboxd.com/${username}/rss/`, {
    headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/xml' },
  });
  if (!res.ok) throw new Error(`RSS ${res.status} for ${username}`);
  const xml = await res.text();
  return { films: parseFeed(xml), fetchedAt: new Date().toISOString() };
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

async function enrich(profile, env, ctx) {
  const [watches, avatar] = await Promise.all([
    loadWatches(profile.username, env, ctx),
    loadAvatar(profile.username, env, ctx),
  ]);
  return {
    username: profile.username,
    displayName: profile.displayName || profile.username,
    note: profile.note || '',
    tags: profile.tags || [],
    profileUrl: `https://letterboxd.com/${profile.username}/`,
    avatar,
    films: watches.films || [],
    fetchedAt: watches.fetchedAt || null,
    stale: Boolean(watches.stale),
  };
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

async function moveProfile(username, request, env) {
  let payload;
  try {
    payload = await request.json();
  } catch {
    return json({ error: 'invalid JSON body' }, 400);
  }

  const delta = payload.direction === 'up' ? -1 : payload.direction === 'down' ? 1 : null;
  if (delta === null) return json({ error: 'direction must be "up" or "down"' }, 400);

  const profiles = await readProfiles(env);
  const index = profiles.findIndex((p) => p.username === username);
  if (index === -1) return json({ error: 'not found' }, 404);

  const target = index + delta;
  if (target < 0 || target >= profiles.length) return json(profiles); // already at the edge

  [profiles[index], profiles[target]] = [profiles[target], profiles[index]];
  await writeProfiles(env, profiles);
  return json(profiles);
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

    if (segments[1] === 'move') {
      if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405);
      return moveProfile(username, request, env);
    }
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

  if (pathname === '/rolodex') {
    if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405);
    return getRolodex(request, env, ctx);
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
  <p class="sub">Curated Letterboxd profiles for the public rolodex page.</p>

  <fieldset>
    <legend id="form-legend">Add a profile</legend>
    <label for="f-username">Letterboxd username or profile URL</label>
    <input type="text" id="f-username" placeholder="michaellamb" autocomplete="off" />
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
    el('list').innerHTML = profiles.map(function (p, i) {
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
          '<button class="icon" data-move="up" data-user="' + escapeHtml(p.username) + '"' +
            (i === 0 ? ' disabled' : '') + ' title="Move up">&uarr;</button>' +
          '<button class="icon" data-move="down" data-user="' + escapeHtml(p.username) + '"' +
            (i === profiles.length - 1 ? ' disabled' : '') + ' title="Move down">&darr;</button>' +
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
      if (button.dataset.move) {
        var moved = await api('/profiles/' + button.dataset.user + '/move', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ direction: button.dataset.move })
        });
        render(moved);
      } else if (button.dataset.delete) {
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

  load();
})();
</script>
</body>
</html>`;
}

export { parseFeed, decodeEntities, normalizeUsername, mapWithLimit, corsHeaders };
