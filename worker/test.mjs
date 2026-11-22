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
} from './index.js';
import worker from './index.js';
import { renderAdminPage, adminScript } from './admin-page.js';

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

/* -------------------------------------------------------------------------- */
/* Admin: pure helpers                                                        */
/* -------------------------------------------------------------------------- */

test('nextCronRun is the first 3-hour boundary after now whose slot matches', () => {
  const now = Date.UTC(2026, 10, 22, 10, 30);
  for (let slot = 0; slot < 8; slot++) {
    const at = nextCronRun(slot, now);
    assert.ok(at > now && at - now <= 24 * 3600 * 1000, 'within the next day');
    assert.equal(at % (3 * 3600 * 1000), 0, 'on a 3-hour boundary');
    assert.equal(cronSlot(at), slot);
  }
});

test('cronSlice with an explicit slot ignores the clock', () => {
  const profiles = Array.from({ length: 16 }, (_, i) => ({ username: `u${i}` }));
  assert.deepEqual(cronSlice(profiles, 0, 3).map((p) => p.username), ['u3', 'u11']);
});

test('healthRow: fresh, stale, never-fetched and pre-history snapshots', () => {
  const now = Date.UTC(2026, 10, 22, 12);
  const profile = { username: 'ada', displayName: 'Ada L' };
  const iso = (hoursAgo) => new Date(now - hoursAgo * 3600 * 1000).toISOString();
  const films = [{ watchedDate: '2026-11-20' }, { watchedDate: '2026-11-18' }];

  const fresh = healthRow(profile, 11, {
    films, fetchedAt: iso(5), history: { since: '2026-01-01', logged: 950, rewatches: 3, last30: 9 },
  }, now);
  assert.equal(fresh.status, 'ok');
  assert.equal(fresh.ageHours, 5);
  assert.equal(fresh.latestWatched, '2026-11-20');
  assert.equal(fresh.nearCap, true, '950 of 1000 is near the cap');
  assert.equal(fresh.slot, 3, 'slot is the index in display order mod 8');
  assert.equal(cronSlot(Date.parse(fresh.nextRefreshAt)), 3);

  // 30h is past a day but inside the slack that slot shifts need.
  assert.equal(healthRow(profile, 0, { films, fetchedAt: iso(30) }, now).status, 'ok');
  assert.equal(healthRow(profile, 0, { films, fetchedAt: iso(49) }, now).status, 'stale');

  const never = healthRow(profile, 0, null, now);
  assert.equal(never.status, 'never');
  assert.equal(never.fetchedAt, null);
  assert.equal(never.films, 0);

  const old = healthRow(profile, 0, { films, fetchedAt: iso(1) }, now);
  assert.equal(old.history, null, 'a snapshot from before history existed has no summary');
  assert.equal(old.nearCap, false);
});

const NOW = '2026-11-22T12:00:00.000Z';
const base = [
  { username: 'ada', displayName: 'Ada', note: '', tags: ['club'], addedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  { username: 'bob', displayName: 'Bob', note: 'n', tags: [], addedAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z' },
];

test('planImport add: only new handles, existing entries untouched', () => {
  const { profiles, summary } = planImport(base, ['Bob', '@cy', 'https://letterboxd.com/Dee/'], 'add', NOW);
  assert.deepEqual(summary.added, ['cy', 'dee']);
  assert.deepEqual(summary.updated, []);
  assert.deepEqual(summary.removed, []);
  assert.equal(profiles.length, 4);
  assert.deepEqual(profiles.find((p) => p.username === 'bob'), base[1], 'existing bob is not rewritten');
  assert.equal(profiles.find((p) => p.username === 'cy').addedAt, NOW);
});

test('planImport merge: overwrites changed fields, keeps addedAt, leaves others alone', () => {
  const { profiles, summary } = planImport(
    base,
    [{ username: 'ada', displayName: 'Ada Lovelace', tags: ['club'] }, { username: 'bob', displayName: 'Bob', note: 'n', tags: [] }],
    'merge',
    NOW
  );
  assert.deepEqual(summary.updated, ['ada'], 'bob is identical, so not an update');
  const ada = profiles.find((p) => p.username === 'ada');
  assert.equal(ada.displayName, 'Ada Lovelace');
  assert.equal(ada.addedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(ada.updatedAt, NOW);
  assert.equal(profiles.length, 2);
});

test('planImport replace: the file becomes the list and reports who is removed', () => {
  const { profiles, summary } = planImport(
    base,
    [{ username: 'bob', displayName: 'Bob', note: 'n', tags: [] }, { username: 'eve', addedAt: '2025-05-05T00:00:00.000Z' }],
    'replace',
    NOW
  );
  assert.deepEqual(summary.removed, ['ada']);
  assert.deepEqual(summary.added, ['eve']);
  assert.deepEqual(profiles.map((p) => p.username).sort(), ['bob', 'eve']);
  assert.equal(profiles.find((p) => p.username === 'eve').addedAt, '2025-05-05T00:00:00.000Z', 'a backup keeps its dates');
});

test('planImport rejects bad handles and duplicates, and clamps fields like the form does', () => {
  const { profiles, summary } = planImport(
    [],
    ['ok_1', 'bad/../path', 42, null, { username: 'OK_1' }, { username: 'long', displayName: 'x'.repeat(200), tags: Array(20).fill('t'), addedAt: 'not a date' }],
    'merge',
    NOW
  );
  assert.deepEqual(summary.added, ['ok_1', 'long']);
  assert.deepEqual(summary.invalid.map((i) => i.reason), ['invalid username', 'invalid username', 'invalid username', 'duplicate in file']);
  const long = profiles.find((p) => p.username === 'long');
  assert.equal(long.displayName.length, 60);
  assert.equal(long.tags.length, 8);
  assert.equal(long.addedAt, NOW, 'an unparseable date falls back to now');
});

test('renameTag renames, merges onto an existing tag, and removes', () => {
  const profiles = [
    { username: 'a', tags: ['horror', 'club'] },
    { username: 'b', tags: ['Horror', 'horror'] },
    { username: 'c', tags: ['club'] },
  ];
  const renamed = renameTag(profiles, 'horror', 'scary', NOW);
  assert.deepEqual(renamed.changed, ['a', 'b']);
  assert.deepEqual(renamed.profiles[0].tags, ['scary', 'club']);
  assert.equal(renamed.profiles[2], profiles[2], 'untouched profiles keep their identity (no updatedAt bump)');

  const merged = renameTag(profiles, 'horror', 'Horror', NOW);
  assert.deepEqual(merged.profiles[1].tags, ['Horror'], 'two spellings collapse into one');

  const removed = renameTag(profiles, 'club', '', NOW);
  assert.deepEqual(removed.profiles[0].tags, ['horror']);
  assert.deepEqual(removed.profiles[2].tags, []);
});

test('tagCounts sorts by use, then alphabetically', () => {
  assert.deepEqual(
    tagCounts([{ tags: ['b', 'a'] }, { tags: ['b'] }, {}]),
    [{ tag: 'b', count: 2 }, { tag: 'a', count: 1 }]
  );
});

test('the admin page ships a script that parses and carries no bundler helpers', () => {
  const script = adminScript();
  assert.doesNotThrow(() => new Function(script), 'client script must be valid JS');
  assert.ok(!script.includes('</script'), 'would end the inline script early');
  const page = renderAdminPage();
  assert.ok(page.startsWith('<!DOCTYPE html>'));
  assert.ok(page.includes(script));
  assert.ok(!script.includes('confirm('), 'destructive actions use the in-page two-step confirm');
});

/* -------------------------------------------------------------------------- */
/* Admin: endpoints against a fake KV. Nothing here may reach the network.    */
/* -------------------------------------------------------------------------- */

function fakeEnv(seed = {}) {
  const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
  return {
    ADMIN_DEV_BYPASS: 'true',
    store,
    ROLODEX: {
      async get(key, type) {
        if (!store.has(key)) return null;
        return type === 'json' ? JSON.parse(store.get(key)) : store.get(key);
      },
      async put(key, value) { store.set(key, value); },
      async delete(key) { store.delete(key); },
      async list() { return { keys: [] }; },
    },
  };
}

const GH = 'https://api.github.com/repos/michaellambgelo/letterboxd-viewer';

/** Runs `fn` with caches + fetch stubbed, then restores both. `feed` is the
 *  XML every Letterboxd request returns; null makes every request fail.
 *  `github` maps "METHOD /path" (no query) to a response body, a Response, or
 *  a function of the parsed request body. Anything not stubbed THROWS, so a
 *  test can never reach the real network or write to the real repo. */
async function withStubs(feed, fn, github = null) {
  const saved = { caches: globalThis.caches, fetch: globalThis.fetch };
  const cache = new Map();
  const requests = [];
  const ghCalls = [];
  globalThis.caches = {
    default: {
      async match(req) { const hit = cache.get(req.url); return hit ? hit.clone() : undefined; },
      async put(req, res) { cache.set(req.url, res); },
      async delete(req) { return cache.delete(req.url); },
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    url = String(url);
    if (url.startsWith(GH)) {
      const key = `${init.method || 'GET'} ${url.slice(GH.length).split('?')[0]}`;
      if (!github || !(key in github)) throw new Error(`unstubbed GitHub request: ${key}`);
      const body = init.body ? JSON.parse(init.body) : undefined;
      ghCalls.push({ key, url, body, headers: init.headers || {} });
      const out = typeof github[key] === 'function' ? github[key](body) : github[key];
      if (out instanceof Response) return out;
      if (out === null) return new Response(null, { status: 204 });
      return new Response(typeof out === 'string' ? out : JSON.stringify(out), { status: 200 });
    }
    if (!url.startsWith('https://letterboxd.com/')) throw new Error(`unexpected fetch: ${url}`);
    requests.push(url);
    if (feed === null) return new Response('nope', { status: 503 });
    return new Response(feed, { status: 200 });
  };
  const pending = [];
  const ctx = { waitUntil: (p) => pending.push(p) };
  const call = async (env, method, path, body, headers = {}) => {
    const res = await worker.fetch(
      new Request(`https://rolodex.test${path}`, {
        method,
        headers: body === undefined ? headers : { 'Content-Type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
      ctx
    );
    await Promise.all(pending.splice(0));
    const text = await res.text();
    return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null };
  };
  try {
    return await fn({ call, cache, requests, ghCalls });
  } finally {
    globalThis.caches = saved.caches;
    globalThis.fetch = saved.fetch;
  }
}

const seeded = () => fakeEnv({
  'rolodex:v1': base,
  'snapshot:ada': { films: [{ watchedDate: '2026-11-20' }], fetchedAt: new Date().toISOString(), history: { since: '2026-01-01', logged: 12, rewatches: 1, last30: 4 } },
  'history:ada': { since: '2026-01-01', entries: [{ id: 'e1', t: 'Old', y: 1999, d: '2026-01-01', r: 4, rw: false, s: '2026-01-01' }] },
  'avatar:ada': 'https://a.ltrbxd.com/x.jpg',
});

test('admin API refuses without Access, and refuses cross-site writes with it', async () => {
  await withStubs(fixture, async ({ call }) => {
    const env = seeded();
    const locked = { ...env, ADMIN_DEV_BYPASS: undefined };
    assert.equal((await call(locked, 'GET', '/admin/api/health')).status, 403);
    assert.equal((await call(locked, 'POST', '/admin/api/import', { mode: 'replace', profiles: ['x'], dryRun: false })).status, 403);

    const cross = await call(env, 'POST', '/admin/api/tags', { from: 'club', to: 'x' }, { 'Sec-Fetch-Site': 'cross-site' });
    assert.equal(cross.status, 403);
    assert.deepEqual(JSON.parse(env.store.get('rolodex:v1'))[0].tags, ['club'], 'nothing was written');

    const same = await call(env, 'POST', '/admin/api/tags', { from: 'club', to: 'x', dryRun: true }, { 'Sec-Fetch-Site': 'same-origin' });
    assert.equal(same.status, 200);
    // No header at all (curl, service token) is allowed through.
    assert.equal((await call(env, 'POST', '/admin/api/tags', { from: 'club', to: 'x', dryRun: true })).status, 200);
  });
});

test('GET /admin/api/health reports each member from its snapshot', async () => {
  await withStubs(fixture, async ({ call, requests }) => {
    const { status, body } = await call(seeded(), 'GET', '/admin/api/health');
    assert.equal(status, 200);
    assert.deepEqual(body.counts, { ok: 1, stale: 0, never: 1, nearCap: 0 });
    assert.deepEqual(body.profiles.map((r) => [r.username, r.status, r.slot]), [['ada', 'ok', 0], ['bob', 'never', 1]]);
    assert.equal(body.profiles[0].history.logged, 12);
    assert.equal(requests.length, 0, 'health never calls Letterboxd');
  });
});

test('export then replace-import: dry run writes nothing, apply removes derived keys and saves an undo', async () => {
  await withStubs(fixture, async ({ call }) => {
    const env = seeded();
    const exported = await call(env, 'GET', '/admin/api/export');
    assert.equal(exported.body.schema, 'letterboxd-rolodex-backup/1');
    assert.equal(exported.body.count, 2);
    assert.match(exported.headers.get('Content-Disposition'), /attachment; filename="rolodex-backup-\d{4}-\d\d-\d\d\.json"/);

    const file = [{ username: 'bob', displayName: 'Bob', note: 'n', tags: [] }, 'cy'];
    // dryRun omitted: the default must be "don't write".
    const dry = await call(env, 'POST', '/admin/api/import', { mode: 'replace', profiles: file });
    assert.equal(dry.body.applied, false);
    assert.deepEqual(dry.body.removed, ['ada']);
    assert.equal(JSON.parse(env.store.get('rolodex:v1')).length, 2);
    assert.ok(env.store.has('history:ada'));
    assert.ok(!env.store.has('rolodex:prev'));

    const applied = await call(env, 'POST', '/admin/api/import', { mode: 'replace', profiles: file, dryRun: false });
    assert.equal(applied.body.applied, true);
    assert.deepEqual(JSON.parse(env.store.get('rolodex:v1')).map((p) => p.username).sort(), ['bob', 'cy']);
    for (const key of ['history:ada', 'snapshot:ada', 'avatar:ada']) {
      assert.ok(!env.store.has(key), `${key} goes with the removed member`);
    }

    assert.deepEqual((await call(env, 'GET', '/admin/api/import/prev')).body.count, 2);
    // cy was fetched between the import and the undo, so it has derived keys.
    env.store.set('history:cy', JSON.stringify({ since: '2026-11-01', entries: [] }));
    env.store.set('snapshot:cy', JSON.stringify({ films: [] }));
    const undo = await call(env, 'POST', '/admin/api/import/undo', {});
    assert.deepEqual(undo.body, { restored: 2, replaced: 2, removed: ['cy'] });
    assert.deepEqual(JSON.parse(env.store.get('rolodex:v1')).map((p) => p.username).sort(), ['ada', 'bob']);
    assert.ok(!env.store.has('history:ada'), 'undo restores the list, not the history');
    assert.ok(!env.store.has('history:cy') && !env.store.has('snapshot:cy'), 'nobody off the list keeps a history');
  });
});

test('import refuses a replace that would empty the rolodex, and bad input', async () => {
  await withStubs(fixture, async ({ call }) => {
    const env = seeded();
    const empty = await call(env, 'POST', '/admin/api/import', { mode: 'replace', profiles: ['not/a/handle'], dryRun: false });
    assert.equal(empty.status, 409);
    assert.equal(JSON.parse(env.store.get('rolodex:v1')).length, 2);
    assert.equal((await call(env, 'POST', '/admin/api/import', { mode: 'wipe', profiles: [] })).status, 400);
    assert.equal((await call(env, 'POST', '/admin/api/import', { mode: 'add', profiles: 'ada' })).status, 400);
    assert.equal((await call(env, 'POST', '/admin/api/import/undo', {})).status, 404);
  });
});

test('tags: list, dry run, rename and the not-found case', async () => {
  await withStubs(fixture, async ({ call }) => {
    const env = seeded();
    assert.deepEqual((await call(env, 'GET', '/admin/api/tags')).body, [{ tag: 'club', count: 1 }]);
    assert.equal((await call(env, 'POST', '/admin/api/tags', { from: 'nope', to: 'x' })).status, 404);
    assert.equal((await call(env, 'POST', '/admin/api/tags', { from: 'club', to: 'club' })).status, 400);
    const done = await call(env, 'POST', '/admin/api/tags', { from: 'club', to: ' jxn ' });
    assert.deepEqual(done.body, { dryRun: false, from: 'club', to: 'jxn', changed: ['ada'] });
    assert.deepEqual(JSON.parse(env.store.get('rolodex:v1')).find((p) => p.username === 'ada').tags, ['jxn']);
  });
});

test('history: read, download header, and reset reseeds from the feed alone', async () => {
  await withStubs(fixture, async ({ call }) => {
    const env = seeded();
    const read = await call(env, 'GET', '/admin/api/profiles/ada/history');
    assert.equal(read.body.count, 1);
    assert.equal(read.body.cap, 1000);
    assert.equal(read.headers.get('Content-Disposition'), null);
    const dl = await call(env, 'GET', '/admin/api/profiles/ada/history?download=1');
    assert.equal(dl.headers.get('Content-Disposition'), 'attachment; filename="history-ada.json"');
    assert.equal((await call(env, 'GET', '/admin/api/profiles/zed/history')).status, 404);

    const reset = await call(env, 'DELETE', '/admin/api/profiles/ada/history');
    assert.equal(reset.body.reseeded, true);
    const stored = JSON.parse(env.store.get('history:ada'));
    assert.ok(stored.entries.length > 0);
    assert.ok(!stored.entries.some((e) => e.id === 'e1'), 'the old entry must not be merged back in');
    assert.equal(reset.body.history.logged, stored.entries.length);
  });
});

test('history reset still clears when Letterboxd is unreachable', async () => {
  await withStubs(null, async ({ call }) => {
    const env = seeded();
    const reset = await call(env, 'DELETE', '/admin/api/profiles/ada/history');
    assert.deepEqual(reset.body, { reset: true, reseeded: false, history: null });
    assert.ok(!env.store.has('history:ada'));
  });
});

test('refresh bypasses the cache; a failing feed leaves the snapshot alone', async () => {
  await withStubs(fixture, async ({ call, cache, requests }) => {
    const env = seeded();
    cache.set('https://rolodex.internal/rss/ada', new Response(JSON.stringify({ films: [], fetchedAt: 'cached' })));
    const ok = await call(env, 'POST', '/admin/api/profiles/ada/refresh', {});
    assert.equal(ok.body.ok, true);
    assert.equal(ok.body.row.status, 'ok');
    assert.equal(ok.body.row.films, 4);
    assert.deepEqual(requests, ['https://letterboxd.com/ada/rss/'], 'fetched despite the cache entry');
    assert.equal(JSON.parse(env.store.get('snapshot:ada')).films.length, 4);
    assert.equal((await call(env, 'POST', '/admin/api/profiles/zed/refresh', {})).status, 404);
    assert.equal((await call(env, 'GET', '/admin/api/profiles/ada/refresh')).status, 405);
  });
  await withStubs(null, async ({ call }) => {
    const env = seeded();
    const before = env.store.get('snapshot:ada');
    const failed = await call(env, 'POST', '/admin/api/profiles/ada/refresh', {});
    assert.equal(failed.body.ok, false);
    assert.equal(env.store.get('snapshot:ada'), before);
  });
});

test('clear drops only what was asked for, and never history', async () => {
  await withStubs(fixture, async ({ call }) => {
    const env = seeded();
    assert.equal((await call(env, 'POST', '/admin/api/profiles/ada/clear', { what: ['history'] })).status, 400);
    await call(env, 'POST', '/admin/api/profiles/ada/clear', { what: ['avatar'] });
    assert.ok(!env.store.has('avatar:ada'));
    assert.ok(env.store.has('snapshot:ada'));
    await call(env, 'POST', '/admin/api/profiles/ada/clear', {});
    assert.ok(!env.store.has('snapshot:ada'));
    assert.ok(env.store.has('history:ada'));
  });
});

test('cron/run reads one slice and reports feeds it could not reach', async () => {
  await withStubs(fixture, async ({ call, requests }) => {
    const env = seeded();
    const run = await call(env, 'POST', '/admin/api/cron/run', { slot: 1 });
    assert.deepEqual(run.body, { slot: 1, total: 2, refreshed: 1, failed: [] });
    assert.deepEqual(requests, ['https://letterboxd.com/bob/rss/']);
    assert.equal((await call(env, 'POST', '/admin/api/cron/run', { slot: 8 })).status, 400);
    assert.deepEqual((await call(env, 'POST', '/admin/api/stats-live/purge', {})).body, { purged: false });
  });
  await withStubs(null, async ({ call }) => {
    const run = await call(seeded(), 'POST', '/admin/api/cron/run', { slot: 0 });
    assert.deepEqual(run.body.failed, ['ada']);
  });
});

test('deleting a profile still drops its derived keys', async () => {
  await withStubs(fixture, async ({ call }) => {
    const env = seeded();
    assert.equal((await call(env, 'DELETE', '/admin/api/profiles/ada')).status, 204);
    for (const key of ['history:ada', 'snapshot:ada', 'avatar:ada']) assert.ok(!env.store.has(key));
  });
});

/* -------------------------------------------------------------------------- */
/* Admin: GitHub-backed tabs (pipeline, diary tag categories)                 */
/* -------------------------------------------------------------------------- */

test('base64 helpers survive non-ASCII text', () => {
  const text = 'Amélie — 千と千尋の神隠し 🎬\n';
  assert.equal(fromBase64(toBase64(text)), text);
  assert.equal(toBase64('abc'), 'YWJj');
  const big = 'é'.repeat(70000); // crosses the chunk boundary
  assert.equal(fromBase64(toBase64(big)), big);
});

const categoriesPath = join(here, '..', 'data', 'tag_categories.json');

test('formatCategories reproduces the committed file byte for byte', { skip: !existsSync(categoriesPath) }, () => {
  const text = readFileSync(categoriesPath, 'utf8');
  assert.equal(formatCategories(JSON.parse(text)), text);
});

test('formatCategories keeps short lists inline and wraps long ones at 100 columns', () => {
  const doc = {
    _comment: 'c',
    categories: [
      { id: 'a', label: 'A', icon: 'fa-a', tags: ['one'] },
      { id: 'b', label: 'B', icon: 'fa-b', tags: Array.from({ length: 30 }, (_, i) => `tag number ${i}`) },
      { id: 'c', label: 'C', icon: 'fa-c', tags: [] },
    ],
  };
  const text = formatCategories(doc);
  assert.deepEqual(JSON.parse(text), doc);
  assert.ok(text.includes('      "tags": ["one"]\n'));
  assert.ok(text.includes('      "tags": []\n'));
  assert.ok(text.split('\n').every((line) => line.length <= 100));
  assert.ok(text.endsWith('}\n'));
});

test('applyCategoryTags only moves tags; categories themselves are fixed', () => {
  const existing = { categories: [
    { id: 'a', label: 'A', icon: 'fa-a', tags: ['x'] },
    { id: 'b', label: 'B', icon: 'fa-b', tags: ['y'] },
  ] };
  const ok = applyCategoryTags(existing, [{ id: 'a', tags: [' X ', 'Zed', 'y'] }, { id: 'b', label: 'Hacked', tags: ['y', 'zed'] }]);
  assert.deepEqual(ok.categories, [
    { id: 'a', label: 'A', icon: 'fa-a', tags: ['x', 'zed', 'y'] },
    { id: 'b', label: 'B', icon: 'fa-b', tags: [] },
  ], 'lowercased, first category wins a duplicate, label/icon come from the file');

  assert.ok(applyCategoryTags(existing, [{ id: 'b', tags: [] }, { id: 'a', tags: [] }]).error, 'no reordering');
  assert.ok(applyCategoryTags(existing, [{ id: 'a', tags: [] }]).error, 'no dropping a category');
  assert.ok(applyCategoryTags(existing, [{ id: 'a', tags: [] }, { id: 'b', tags: [] }, { id: 'c', tags: [] }]).error, 'no adding one');
  assert.ok(applyCategoryTags(existing, [{ id: 'a', tags: [1] }, { id: 'b', tags: [] }]).error);
  assert.ok(applyCategoryTags(existing, [{ id: 'a', tags: ['x'.repeat(81)] }, { id: 'b', tags: [] }]).error);
});

test('diaryTagCounts lowercases like the Tags page', () => {
  assert.deepEqual(
    diaryTagCounts([{ tags: ['MoviePass', 'imax'] }, { tags: ['moviepass', ' '] }, {}, { tags: null }]),
    { moviepass: 2, imax: 1 }
  );
});

const WL_NAME = 'watchlist-michaellamb-2026-11-22-10-00-utc.csv';
const WL_CSV = 'Date,Name,Year,Letterboxd URI\n2020-03-16,Gone Girl,2014,https://boxd.it/6hQu\n2026-11-19,"Amélie, encore",2001,https://boxd.it/abc1\n';
const CURRENT_SOURCE = 'letterboxd-michaellamb-2026-11-21-05-45-utc';

test('exportStamp reads the timestamp from archive folders and watchlist files alike', () => {
  assert.equal(exportStamp(CURRENT_SOURCE), '2026-11-21-05-45');
  assert.equal(exportStamp(WL_NAME), '2026-11-22-10-00');
  assert.equal(exportStamp('nope'), null);
});

test('checkWatchlist accepts a real export and says whether it would take effect', () => {
  const newer = checkWatchlist(WL_NAME, WL_CSV, CURRENT_SOURCE);
  assert.equal(newer.ok, true);
  assert.equal(newer.rows, 2);
  assert.equal(newer.oldestAdded, '2020-03-16');
  assert.equal(newer.newestAdded, '2026-11-19');
  assert.equal(newer.supersedes, true);

  const older = checkWatchlist('watchlist-michaellamb-2026-11-03-17-26-utc.csv', WL_CSV, CURRENT_SOURCE);
  assert.equal(older.ok, true);
  assert.equal(older.supersedes, false, 'an older stamp would commit and change nothing');

  assert.equal(checkWatchlist(WL_NAME, '﻿' + WL_CSV.replace(/\n/g, '\r\n'), null).ok, true, 'BOM and CRLF are fine');
});

test('checkWatchlist refuses the wrong file', () => {
  for (const name of ['watchlist.csv', 'watchlist-someoneelse-2026-11-22-10-00-utc.csv', '../x/' + WL_NAME, WL_NAME + '.txt']) {
    assert.equal(checkWatchlist(name, WL_CSV, null).ok, false, name);
  }
  assert.match(checkWatchlist(WL_NAME, 'Date,Name,Year\n2020-01-01,X,2000\n', null).error, /first line/);
  assert.match(checkWatchlist(WL_NAME, WL_CSV + 'garbage row\n', null).error, /line 4/);
  assert.equal(checkWatchlist(WL_NAME, 'Date,Name,Year,Letterboxd URI\n', null).ok, false);
  assert.equal(checkWatchlist(WL_NAME, '', null).ok, false);
});

const ghRun = (conclusion, hoursAgo, now, status = 'completed') => ({
  status, conclusion, event: 'schedule', html_url: 'https://github.com/x/runs/1',
  created_at: new Date(now - hoursAgo * 3600000).toISOString(),
});

test('pipelineReport judges the cron on its last success, not its last run', () => {
  const now = Date.UTC(2026, 10, 22, 12);
  const stats = { totalWatched: 10, archiveExportDate: '2026-11-21', dateRange: { latest: '2026-11-20' }, watchlist: { count: 5, snapshotDate: '2026-11-21', snapshotSource: CURRENT_SOURCE } };
  const rewatches = { totals: { logs: 10 }, archiveExportDate: '2026-11-21' };
  const inputs = (runs, extra = {}) => ({ runs, deployRuns: [], stats, rewatches, rssOnly: 2, dataCommit: null, ...extra });

  // One failure after a recent success is normal (an API commit mid-run).
  const blip = pipelineReport(inputs([ghRun('failure', 1, now), ghRun('success', 7, now)]), now);
  assert.equal(blip.cron.status, 'ok');
  assert.equal(blip.cron.failedSinceSuccess, 1);
  assert.equal(blip.cron.hoursSinceSuccess, 7);
  assert.equal(blip.cron.lastRun.conclusion, 'failure');

  assert.equal(pipelineReport(inputs([ghRun('failure', 1, now), ghRun('success', 14, now)]), now).cron.status, 'late');
  assert.equal(pipelineReport(inputs([ghRun('failure', 1, now), ghRun('failure', 7, now)]), now).cron.status, 'never');
  assert.equal(pipelineReport(inputs([ghRun(null, 0, now, 'in_progress'), ghRun('success', 6, now)]), now).cron.running, true);

  assert.equal(blip.archive.ageDays, 1);
  assert.equal(blip.archive.rssOnly, 2);
  assert.equal(blip.rewatches.inSync, true);
  const drift = pipelineReport(inputs([ghRun('success', 1, now)], { rewatches: { totals: { logs: 9 }, archiveExportDate: '2026-11-21' } }), now);
  assert.equal(drift.rewatches.inSync, false, 'rewatches.json fell behind stats.json');
  assert.equal(pipelineReport({ runs: [], deployRuns: [], stats: null, rewatches: null, rssOnly: 0, dataCommit: null }, now).cron.status, 'never');
});

const STATS = { totalWatched: 3, archiveExportDate: '2026-11-21', dateRange: { latest: '2026-11-20' }, watchlist: { count: 1595, snapshotDate: '2026-11-21', snapshotSource: CURRENT_SOURCE } };
const HISTORY = [
  { filmTitle: 'A', source: 'archive', tags: ['IMAX', 'garbage'] },
  { filmTitle: 'B', source: 'rss', tags: [] },
  { filmTitle: 'Amélie', source: 'archive', tags: ['garbage'] },
];
const CATEGORIES_TEXT = formatCategories({
  _comment: 'Hand-maintained.',
  categories: [
    { id: 'theaters', label: 'In theaters', icon: 'fa-film', tags: ['in theaters'] },
    { id: 'imax', label: 'IMAX', icon: 'fa-expand', tags: ['imax'] },
  ],
});
const readRoutes = () => ({
  'GET /contents/data/stats.json': STATS,
  'GET /contents/data/rewatches.json': { totals: { logs: 3 }, archiveExportDate: '2026-11-21' },
  'GET /contents/data/viewing_history.json': JSON.stringify(HISTORY, null, 1),
  'GET /contents/data/tag_categories.json': { sha: 'sha-1', content: toBase64(CATEGORIES_TEXT) },
  'GET /actions/workflows/download-data-and-assets.yml/runs': { workflow_runs: [ghRun('success', 2, Date.now())] },
  'GET /actions/workflows/deploy.yml/runs': { workflow_runs: [ghRun('success', 1, Date.now())] },
  'GET /commits': [{ html_url: 'https://github.com/x/commit/1', commit: { committer: { date: '2026-11-22T06:00:00Z' } } }],
});
const withToken = () => ({ ...fakeEnv(), GITHUB_TOKEN: 'test-token' });

test('GET /admin/api/pipeline reads GitHub and reports without a token', async () => {
  await withStubs(fixture, async ({ call, ghCalls }) => {
    const { status, body } = await call(fakeEnv(), 'GET', '/admin/api/pipeline');
    assert.equal(status, 200);
    assert.equal(body.canWrite, false);
    assert.equal(body.cron.status, 'ok');
    assert.equal(body.archive.rssOnly, 1);
    assert.equal(body.rewatches.inSync, true);
    assert.equal(body.watchlist.count, 1595);
    assert.equal(body.data.lastCommitAt, '2026-11-22T06:00:00Z');
    assert.ok(ghCalls.every((c) => c.key.startsWith('GET ')), 'reading never writes');
    assert.ok(ghCalls.every((c) => !('Authorization' in c.headers)), 'no token, no auth header');
  }, readRoutes());
});

test('pipeline/run refuses without a token and dispatches the data workflow with one', async () => {
  const routes = { ...readRoutes(), 'POST /actions/workflows/download-data-and-assets.yml/dispatches': null };
  await withStubs(fixture, async ({ call, ghCalls }) => {
    const refused = await call(fakeEnv(), 'POST', '/admin/api/pipeline/run', {});
    assert.equal(refused.status, 503);
    assert.equal(ghCalls.length, 0, 'nothing was sent to GitHub');

    const ok = await call(withToken(), 'POST', '/admin/api/pipeline/run', {});
    assert.deepEqual(ok.body, { dispatched: true });
    assert.deepEqual(ghCalls[0].body, { ref: 'main' });
    assert.equal(ghCalls[0].headers.Authorization, 'Bearer test-token');
    assert.equal((await call(withToken(), 'GET', '/admin/api/pipeline/run')).status, 405);
  }, routes);
});

test('watchlist upload: dry run by default, then one commit and one dispatch', async () => {
  const routes = {
    ...readRoutes(),
    [`PUT /contents/data/archive/${WL_NAME}`]: { commit: { html_url: 'https://github.com/x/commit/2' } },
    'POST /actions/workflows/download-data-and-assets.yml/dispatches': null,
  };
  await withStubs(fixture, async ({ call, ghCalls }) => {
    const env = withToken();
    const dry = await call(env, 'POST', '/admin/api/pipeline/watchlist', { filename: WL_NAME, content: WL_CSV });
    assert.equal(dry.body.committed, false);
    assert.equal(dry.body.rows, 2);
    assert.equal(dry.body.supersedes, true);
    assert.equal(dry.body.currentCount, 1595);
    assert.ok(ghCalls.every((c) => c.key.startsWith('GET ')), 'a dry run writes nothing');

    const done = await call(env, 'POST', '/admin/api/pipeline/watchlist', { filename: WL_NAME, content: WL_CSV, dryRun: false });
    assert.equal(done.body.committed, true);
    assert.equal(done.body.dispatched, true);
    const put = ghCalls.find((c) => c.key.startsWith('PUT '));
    assert.equal(fromBase64(put.body.content), WL_CSV, 'committed byte for byte, accents included');
    assert.equal(put.body.branch, 'main');
    assert.equal(put.body.sha, undefined, 'never overwrites an existing file');
    assert.equal(ghCalls.filter((c) => c.key.startsWith('POST ')).length, 1);

    ghCalls.length = 0;
    await call(env, 'POST', '/admin/api/pipeline/watchlist', { filename: WL_NAME, content: WL_CSV, dryRun: false, run: false });
    assert.equal(ghCalls.filter((c) => c.key.startsWith('POST ')).length, 0, 'run: false skips the dispatch');
  }, routes);
});

test('watchlist upload refuses a stale file, a duplicate, a bad file and a missing token', async () => {
  const older = 'watchlist-michaellamb-2026-11-03-17-26-utc.csv';
  const routes = {
    ...readRoutes(),
    [`PUT /contents/data/archive/${WL_NAME}`]: new Response(JSON.stringify({ message: 'Invalid request.\n\n"sha" wasn\'t supplied.' }), { status: 422 }),
  };
  await withStubs(fixture, async ({ call, ghCalls }) => {
    const env = withToken();
    const stale = await call(env, 'POST', '/admin/api/pipeline/watchlist', { filename: older, content: WL_CSV, dryRun: false });
    assert.equal(stale.status, 409);
    assert.match(stale.body.error, /would change nothing/);
    assert.ok(!ghCalls.some((c) => c.key.startsWith('PUT ')));

    const dup = await call(env, 'POST', '/admin/api/pipeline/watchlist', { filename: WL_NAME, content: WL_CSV, dryRun: false });
    assert.equal(dup.status, 409);
    assert.match(dup.body.error, /already in the repo/);

    assert.equal((await call(env, 'POST', '/admin/api/pipeline/watchlist', { filename: 'evil.csv', content: WL_CSV, dryRun: false })).status, 400);
    assert.equal((await call(fakeEnv(), 'POST', '/admin/api/pipeline/watchlist', { filename: WL_NAME, content: WL_CSV, dryRun: false })).status, 503);
  }, routes);
});

test('a GitHub permission error surfaces as a 502, never as this Worker\'s own 403', async () => {
  const routes = {
    ...readRoutes(),
    'POST /actions/workflows/download-data-and-assets.yml/dispatches': new Response(JSON.stringify({ message: 'Resource not accessible by personal access token' }), { status: 403 }),
  };
  await withStubs(fixture, async ({ call }) => {
    const res = await call(withToken(), 'POST', '/admin/api/pipeline/run', {});
    assert.equal(res.status, 502);
    assert.match(res.body.error, /GitHub API 403: Resource not accessible/);
  }, routes);
});

test('tag categories: read with counts, then commit only what moved', async () => {
  let committed = null;
  const routes = {
    ...readRoutes(),
    'PUT /contents/data/tag_categories.json': (body) => { committed = body; return { content: { sha: 'sha-2' }, commit: { html_url: 'https://github.com/x/commit/3' } }; },
  };
  await withStubs(fixture, async ({ call, ghCalls }) => {
    const env = withToken();
    const read = await call(env, 'GET', '/admin/api/tag-categories');
    assert.equal(read.body.sha, 'sha-1');
    assert.deepEqual(read.body.counts, { imax: 1, garbage: 2 });
    assert.deepEqual(read.body.categories.map((c) => c.id), ['theaters', 'imax']);

    const same = await call(env, 'PUT', '/admin/api/tag-categories', { sha: 'sha-1', categories: [{ id: 'theaters', tags: ['in theaters'] }, { id: 'imax', tags: ['imax'] }] });
    assert.deepEqual(same.body, { committed: false, moved: [] });
    assert.equal(committed, null, 'no commit when nothing moved');

    const stale = await call(env, 'PUT', '/admin/api/tag-categories', { sha: 'old', categories: [] });
    assert.equal(stale.status, 409);
    const bad = await call(env, 'PUT', '/admin/api/tag-categories', { sha: 'sha-1', categories: [{ id: 'imax', tags: [] }] });
    assert.equal(bad.status, 400);
    assert.equal(committed, null);

    const saved = await call(env, 'PUT', '/admin/api/tag-categories', { sha: 'sha-1', categories: [{ id: 'theaters', tags: ['in theaters', 'Garbage'] }, { id: 'imax', tags: [] }] });
    assert.equal(saved.body.committed, true);
    assert.deepEqual(saved.body.moved.sort(), ['garbage', 'imax']);
    assert.equal(committed.sha, 'sha-1', 'the write is conditional on the sha it read');
    assert.equal(committed.message, 'Recategorise 2 diary tags');
    const written = JSON.parse(fromBase64(committed.content));
    assert.equal(written._comment, 'Hand-maintained.');
    assert.deepEqual(written.categories.map((c) => c.tags), [['in theaters', 'garbage'], []]);
    assert.equal(written.categories[0].icon, 'fa-film');
    assert.equal(ghCalls.filter((c) => c.key.startsWith('PUT ')).length, 1);

    assert.equal((await call(fakeEnv(), 'PUT', '/admin/api/tag-categories', { sha: 'sha-1', categories: [{ id: 'theaters', tags: [] }, { id: 'imax', tags: ['imax'] }] })).status, 503);
  }, routes);
});
