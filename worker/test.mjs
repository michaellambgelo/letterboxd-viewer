/**
 * Unit tests for the pure parts of the rolodex Worker — feed parsing, entity
 * decoding, username normalization, concurrency capping. Run with `npm test`
 * (node:test, no dependencies).
 *
 * The XML parsing here is regex-based because Workers have no DOMParser, so it
 * is the part most worth pinning down against a real-shaped feed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
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
} from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = readFileSync(join(here, 'fixtures', 'feed.xml'), 'utf8');

test('parseFeed skips list items and returns at most four films', () => {
  const films = parseFeed(fixture);
  assert.equal(films.length, 4);
  assert.ok(
    !films.some((f) => f.title.includes('Westerns')),
    'a published list must never be treated as a film'
  );
  assert.ok(
    !films.some((f) => f.title === 'Jaws'),
    'the fifth diary entry is beyond the last-four cap'
  );
});

test('parseFeed maps every field a card renders', () => {
  const [first] = parseFeed(fixture);
  assert.deepEqual(first, {
    guid: 'letterboxd-watch-1387430941',
    title: 'The Great Muppet Caper',
    year: 1981,
    rating: 4,
    rewatch: false,
    watchedDate: '2026-07-08',
    link: 'https://letterboxd.com/testmember/film/the-great-muppet-caper/',
    poster:
      'https://a.ltrbxd.com/resized/film-poster/4/2/7/2/6/42726-the-great-muppet-caper-0-600-0-900-crop.jpg?v=fb1d4c7fa9',
    tmdbId: '14900',
  });
});

test('parseFeed decodes entities in titles and flags rewatches', () => {
  const mummy = parseFeed(fixture)[1];
  assert.equal(mummy.title, "Lee Cronin's The Mummy");
  assert.equal(mummy.rewatch, true);
});

test('parseFeed tolerates unrated entries, tv ids and missing posters', () => {
  const films = parseFeed(fixture);
  const murder = films[2];
  assert.equal(murder.rating, null);
  assert.equal(murder.tmdbId, '134095', 'falls back to tmdb:tvId');

  const short = films[3];
  assert.equal(short.poster, null);
  assert.equal(short.rating, 2);
});

test('parseFeed returns nothing for a feed with no diary entries', () => {
  assert.deepEqual(parseFeed('<rss><channel></channel></rss>'), []);
});

// /stats/live parses the same feed uncapped and with the extended fields.
const extendedItem = (guid, description, like = 'Yes') => `
  <item>
    <title>Some Film, 2020 - ★★★★</title>
    <link>https://letterboxd.com/testmember/film/some-film/</link>
    <guid isPermaLink="false">${guid}</guid>
    <letterboxd:watchedDate>2026-07-20</letterboxd:watchedDate>
    <letterboxd:rewatch>No</letterboxd:rewatch>
    <letterboxd:filmTitle>Some Film</letterboxd:filmTitle>
    <letterboxd:filmYear>2020</letterboxd:filmYear>
    <letterboxd:memberRating>4.0</letterboxd:memberRating>
    <letterboxd:memberLike>${like}</letterboxd:memberLike>
    <tmdb:movieId>111</tmdb:movieId>
    <description><![CDATA[ ${description} ]]></description>
  </item>`;

test('extended parse lifts the last-four cap', () => {
  const films = parseFeed(fixture, { limit: Infinity, extended: true });
  assert.ok(films.length > 4, 'the fifth diary entry must survive without the cap');
  assert.ok(films.some((f) => f.title === 'Jaws'));
});

test('extended parse extracts review text from review guids only', () => {
  const review = extendedItem(
    'letterboxd-review-1',
    '<p><img src="https://a.ltrbxd.com/resized/p.jpg"/></p> <p>insanely good</p><p>watched with Jeana &amp; Micah</p>'
  );
  const watch = extendedItem(
    'letterboxd-watch-2',
    '<p><img src="https://a.ltrbxd.com/resized/p.jpg"/></p> <p>Watched on Monday July 20, 2026.</p>'
  );
  const [reviewed, watched] = parseFeed(`<rss>${review}${watch}</rss>`, {
    limit: Infinity,
    extended: true,
  });
  assert.equal(reviewed.review, 'insanely good\nwatched with Jeana & Micah');
  assert.equal(reviewed.liked, true);
  assert.equal(watched.review, null, 'a plain watch has no review, only "Watched on …"');
});

test('extended parse maps memberLike to a boolean', () => {
  const [film] = parseFeed(`<rss>${extendedItem('letterboxd-watch-3', '<p>x</p>', 'No')}</rss>`, {
    extended: true,
  });
  assert.equal(film.liked, false);
});

test('default parse carries no extended fields', () => {
  const [film] = parseFeed(fixture);
  assert.ok(!('review' in film));
  assert.ok(!('liked' in film));
});

test('extractReview flattens markup to newline-separated plain text', () => {
  const body =
    '<p><img src="https://a.ltrbxd.com/resized/p.jpg"/></p> ' +
    '<blockquote><p>"Quoted line"</p></blockquote>' +
    '<p>first<br />second</p><p>with a <a href="https://example.com">link</a> and <em>emphasis</em></p>';
  assert.equal(
    extractReview(body),
    '"Quoted line"\n\nfirst\nsecond\nwith a link and emphasis'
  );
  assert.equal(extractReview('<p><img src="https://a.ltrbxd.com/p.jpg"/></p>'), null);
});

test('decodeEntities handles named, decimal and hex references', () => {
  assert.equal(decodeEntities('a &amp; b'), 'a & b');
  assert.equal(decodeEntities('Cronin&#039;s'), "Cronin's");
  assert.equal(decodeEntities('&#x27;quoted&#x27;'), "'quoted'");
  // &amp; is unescaped last so an encoded entity survives one round trip.
  assert.equal(decodeEntities('&amp;lt;'), '&lt;');
});

test('normalizeUsername accepts handles, @handles and pasted profile URLs', () => {
  assert.equal(normalizeUsername('michaellamb'), 'michaellamb');
  assert.equal(normalizeUsername('  @MichaelLamb '), 'michaellamb');
  assert.equal(normalizeUsername('https://letterboxd.com/michaellamb/'), 'michaellamb');
  assert.equal(normalizeUsername('https://www.letterboxd.com/michaellamb'), 'michaellamb');
  assert.equal(normalizeUsername('letterboxd.com/michaellamb/films/'), 'michaellamb');
  assert.equal(normalizeUsername('some_user_1'), 'some_user_1');
});

test('normalizeUsername rejects anything that is not a handle', () => {
  assert.equal(normalizeUsername(''), null);
  assert.equal(normalizeUsername('has spaces'), null);
  assert.equal(normalizeUsername('bad/../path'), null);
  assert.equal(normalizeUsername('a'.repeat(33)), null);
  assert.equal(normalizeUsername(null), null);
});

test('mapWithLimit preserves order and respects the ceiling', async () => {
  const items = [10, 20, 30, 40, 50, 60, 70];
  let inFlight = 0;
  let peak = 0;

  const results = await mapWithLimit(items, 3, async (value) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, value % 30));
    inFlight -= 1;
    return value * 2;
  });

  assert.deepEqual(results, [20, 40, 60, 80, 100, 120, 140]);
  assert.ok(peak <= 3, `peak concurrency was ${peak}, expected <= 3`);
});

test('mapWithLimit handles an empty list without hanging', async () => {
  assert.deepEqual(await mapWithLimit([], 6, async () => 1), []);
});

const withOrigin = (origin) =>
  corsHeaders(new Request('https://rolodex.michaellamb.dev/rolodex', { headers: { Origin: origin } }));

// Regression: the allowlist originally held only the GitHub Pages default
// origin, but that 301s to the custom domain — so every real browser request
// arrived from letterboxd.michaellamb.dev and was refused.
test('corsHeaders allows the canonical site origin', () => {
  assert.equal(
    withOrigin('https://letterboxd.michaellamb.dev')['Access-Control-Allow-Origin'],
    'https://letterboxd.michaellamb.dev'
  );
});

test('corsHeaders allows the Pages fallback and local dev origins', () => {
  for (const origin of [
    'https://michaellambgelo.github.io',
    'http://localhost:8000',
    'http://127.0.0.1:8000',
  ]) {
    assert.equal(withOrigin(origin)['Access-Control-Allow-Origin'], origin, origin);
  }
});

test('corsHeaders refuses unknown origins and same-origin requests', () => {
  const refused = { Vary: 'Origin' };
  assert.deepEqual(withOrigin('https://evil.example'), refused);
  // Near-misses that must not pass: a suffix match would wrongly allow these.
  assert.deepEqual(withOrigin('https://letterboxd.michaellamb.dev.evil.example'), refused);
  assert.deepEqual(withOrigin('http://letterboxd.michaellamb.dev'), refused, 'scheme must match');
  assert.deepEqual(
    corsHeaders(new Request('https://rolodex.michaellamb.dev/rolodex')),
    refused,
    'no Origin header -> no ACAO'
  );
});

// Regression: emitting Vary only on allowed responses let a shared cache store
// the header-free copy from an origin-less request and replay it to browsers.
test('corsHeaders always sets Vary: Origin, allowed or not', () => {
  for (const headers of [
    withOrigin('https://letterboxd.michaellamb.dev'),
    withOrigin('https://evil.example'),
    corsHeaders(new Request('https://rolodex.michaellamb.dev/rolodex')),
  ]) {
    assert.equal(headers.Vary, 'Origin');
  }
});

const sorted = (profiles) => [...profiles].sort(byFirstName).map((p) => p.displayName || p.username);

test('firstName takes the leading token, or the handle when unnamed', () => {
  assert.equal(firstName({ displayName: 'Michael Lamb', username: 'michaellamb' }), 'Michael');
  assert.equal(firstName({ displayName: '', username: 'claymerc' }), 'claymerc');
  assert.equal(firstName({ displayName: 'Cher', username: 'cher' }), 'Cher');
  assert.equal(firstName({ displayName: '  Ada   Lovelace ', username: 'ada' }), 'Ada');
});

test('byFirstName orders alphabetically by first name', () => {
  assert.deepEqual(
    sorted([
      { displayName: 'Zoe', username: 'z' },
      { displayName: 'Adam Smith', username: 'a' },
      { displayName: 'michael lamb', username: 'm' },
      { displayName: 'Brenda', username: 'b' },
    ]),
    ['Adam Smith', 'Brenda', 'michael lamb', 'Zoe']
  );
});

test('byFirstName is case- and accent-insensitive, not ASCII-ordered', () => {
  // A naive `<` comparison would put every capitalized name before "aaron".
  assert.deepEqual(
    sorted([
      { displayName: 'Zach', username: 'z' },
      { displayName: 'aaron', username: 'a' },
      { displayName: 'Émile', username: 'e' },
      { displayName: 'Bob', username: 'b' },
    ]),
    ['aaron', 'Bob', 'Émile', 'Zach']
  );
});

test('byFirstName tie-breaks on surname, then handle', () => {
  assert.deepEqual(
    sorted([
      { displayName: 'Michael Lamb', username: 'mlamb' },
      { displayName: 'Michael Adams', username: 'madams' },
      { displayName: 'Michael', username: 'zzz' },
      { displayName: 'Michael', username: 'aaa' },
    ]),
    ['Michael', 'Michael', 'Michael Adams', 'Michael Lamb']
  );
  // The two bare "Michael"s break the tie on handle, so the order is stable.
  const bare = [...[
    { displayName: 'Michael', username: 'zzz' },
    { displayName: 'Michael', username: 'aaa' },
  ]].sort(byFirstName);
  assert.deepEqual(bare.map((p) => p.username), ['aaa', 'zzz']);
});

test('byFirstName falls back to the handle for unnamed entries', () => {
  assert.deepEqual(
    sorted([
      { displayName: 'Bob', username: 'bob' },
      { displayName: '', username: 'claymerc' },
      { displayName: 'Alice', username: 'alice' },
    ]),
    ['Alice', 'Bob', 'claymerc']
  );
});

// Smoke test against the checked-in production feed, when present: proves the
// parser still matches the real shape Letterboxd serves today.
test('parseFeed reads the committed production feed', { skip: !existsSync(join(here, '..', 'data', 'rss.xml')) }, () => {
  const live = readFileSync(join(here, '..', 'data', 'rss.xml'), 'utf8');
  const films = parseFeed(live);
  assert.ok(films.length > 0, 'expected diary entries in data/rss.xml');
  assert.ok(films.length <= 4);
  for (const film of films) {
    assert.ok(film.title, 'every film needs a title');
    assert.match(film.watchedDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(film.link, /^https:\/\/letterboxd\.com\//);
  }
});


// --- history -----------------------------------------------------------------

const film = (n, title, watchedDate, extra = {}) => ({
  guid: `letterboxd-review-${n}`, title, year: 2020, rating: 3, rewatch: false, watchedDate, ...extra,
});

test('parseFeed keeps every diary entry with limit Infinity, each with a guid', () => {
  const films = parseFeed(fixture, { limit: Infinity });
  assert.ok(films.length > 4, 'the whole feed, not just the last four');
  assert.ok(films.every((f) => f.guid), 'every entry carries its RSS guid');
});

test('entryId uses the guid number, so review and watch guids for one entry agree', () => {
  assert.equal(entryId({ guid: 'letterboxd-review-42' }), 'e42');
  assert.equal(entryId({ guid: 'letterboxd-watch-42' }), 'e42');
  assert.equal(entryId({ title: 'Heat', year: 1995, watchedDate: '2026-10-01' }), 'k:heat|1995|2026-10-01');
});

test('first merge seeds history and sets since to the oldest watched date', () => {
  const { history, changed, summary } = mergeHistory(null, [
    film(2, 'Heat', '2026-10-05', { rewatch: true }),
    film(1, 'Alien', '2026-09-01'),
  ], '2026-11-03');
  assert.equal(changed, true);
  assert.deepEqual(history.entries.map((e) => e.t), ['Heat', 'Alien']);
  assert.equal(history.since, '2026-09-01');
  assert.deepEqual(summary, { since: '2026-09-01', logged: 2, rewatches: 1, last30: 1 });
});

test('a re-read of the same feed changes nothing (so nothing is written)', () => {
  const feed = [film(1, 'Alien', '2026-09-01')];
  const first = mergeHistory(null, feed, '2026-11-03').history;
  const again = mergeHistory(first, feed, '2026-11-04');
  assert.equal(again.changed, false);
  assert.deepEqual(again.history, first);
});

test('entries that scroll out of the feed are kept; new ones are added', () => {
  const first = mergeHistory(null, [film(1, 'Alien', '2026-09-01')], '2026-11-03').history;
  const { history, changed } = mergeHistory(first, [film(2, 'Heat', '2026-11-02')], '2026-11-04');
  assert.equal(changed, true);
  assert.deepEqual(history.entries.map((e) => [e.t, e.s]), [['Heat', '2026-11-04'], ['Alien', '2026-11-03']]);
  assert.equal(history.since, '2026-09-01', 'since never moves');
});

test('a re-titled or re-dated entry replaces its old copy and keeps its first-seen day', () => {
  const first = mergeHistory(null, [film(7, 'IT: Welcome to Derry - A Story of Derry', '2026-10-31')], '2026-11-01').history;
  const { history } = mergeHistory(first, [film(7, 'A Story of Derry', '2026-10-30', { rating: 4.5 })], '2026-11-03');
  assert.equal(history.entries.length, 1);
  assert.deepEqual([history.entries[0].t, history.entries[0].d, history.entries[0].r, history.entries[0].s],
    ['A Story of Derry', '2026-10-30', 4.5, '2026-11-01']);
});

test('history is capped at the newest 1000 entries', () => {
  const feed = Array.from({ length: 1005 }, (_, i) =>
    film(i + 1, `F${i}`, `2026-01-01`.replace('01-01', `${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`)));
  const { history } = mergeHistory(null, feed, '2026-11-03');
  assert.equal(history.entries.length, 1000);
});

test('summarizeHistory counts the last 30 days from today', () => {
  const s = summarizeHistory({ since: '2026-01-01', entries: [
    { d: '2026-11-03', rw: false }, { d: '2026-10-04', rw: true }, { d: '2026-10-03', rw: true },
  ] }, '2026-11-03');
  assert.deepEqual(s, { since: '2026-01-01', logged: 3, rewatches: 2, last30: 2 });
});

test('cronSlice covers every profile exactly once across the eight 3-hour slots', () => {
  const profiles = Array.from({ length: 70 }, (_, i) => ({ username: `u${i}` }));
  const day = Date.UTC(2026, 10, 3);
  const seen = [];
  for (let h = 0; h < 24; h += 3) {
    const slice = cronSlice(profiles, day + h * 3600 * 1000);
    assert.ok(slice.length <= 9, 'no run fetches more than ~1/8 of the rolodex');
    seen.push(...slice.map((p) => p.username));
  }
  assert.equal(seen.length, 70);
  assert.equal(new Set(seen).size, 70);
});
