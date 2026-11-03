// ==UserScript==
// @name         Letterboxd review stack
// @namespace    https://michaellamb.dev/letterboxd-viewer
// @version      1.4.1
// @description  Swipe through the reviews in your activity feed: right to like, left to dismiss. Remembers what you've already been through.
// @match        https://letterboxd.com/activity/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      letterboxd.michaellamb.dev
// ==/UserScript==

/*
 * Shows every review in the activity feed that you haven't liked, one card at
 * a time, as a stack.
 *
 *   swipe right / →   like the review (clicks Letterboxd's own Like button)
 *   swipe left  / ←   dismiss
 *   W                 add the film to your watchlist (only offered when the
 *                     poster says you haven't watched it)
 *   Z or Backspace    undo the last card (unlikes it if you liked it)
 *   Esc               close the stack
 *
 * Markup it relies on (read from the logged-in feed on 2026-11-03):
 *   review row  section.activity-row.-review.activity-review-from-others[data-activity-id]
 *               (".pw-in-article-ads.-review" is an ad slot and is skipped; your
 *               own reviews lack "activity-review-from-others" and are skipped)
 *   like        p.like-link-target.react-component button[aria-pressed]
 *               ("Like review" / pressed when liked)
 *   paging      <lb-load-more-button> ("Load older activity") appends the next
 *               page into #activity-table-body
 *   watched     .react-component.figure button.watch-link, aria-label
 *               "You watched this film" / "Watch this film"; only rendered
 *               once the lazy poster has loaded (rows are scrolled into view
 *               behind the stack for that reason)
 *   watchlist   not in the markup until the poster's menu (span.menu-link) is
 *               opened; the item is then found by its text, "Add to watchlist"
 *               or "Remove from watchlist", wherever the menu renders. Only
 *               used to *add*. The menu icon sits inside the poster's film
 *               link, so the click is guarded against navigating (v1.3 went
 *               to the film page).
 *
 * Whether a film is already on the watchlist comes from my own data, not
 * Letterboxd: letterboxd.michaellamb.dev/data/watchlist.json (the newest export
 * minus films logged since, rebuilt by compute_stats.py every 6 h), fetched
 * with GM_xmlhttpRequest and cached for 6 h, plus anything added from this
 * stack since that export. The poster markup and /ajax/letterboxd-metadata/
 * (a csrf ping) carry no watchlist state, so this is the only way to know
 * without opening menus. Films added on Letterboxd itself after the export
 * show as not-on-watchlist until the next export.
 *
 * Liking always goes through Letterboxd's own button, so their client code
 * handles CSRF and state. Nothing here calls a Letterboxd endpoint directly,
 * except fetching a review's full text when the feed shows it truncated.
 *
 * Remembering what you've seen: activity ids only ever increase, and the stack
 * walks the feed newest-first without gaps, so each session covers one
 * contiguous id range. Those ranges are stored in Tampermonkey storage
 * (`ranges`). Any review inside one is skipped, so a later run shows only
 * new reviews plus any backlog you hadn't reached. Once the feed's end has been
 * reached (`feedEndId`), running into the bottom range means you're done, with
 * no more paging. The "Reset memory" button in the stack header clears it.
 *
 * Paging is click-paced: the next page only loads when fewer than 3 cards are
 * queued, never more often than every 2.5–4 s, the same as pressing "Load
 * older activity" by hand.
 */

(function () {
  'use strict';

  const ROW_SEL = 'section.activity-row.-review.activity-review-from-others[data-activity-id]';
  const LIKE_SEL = 'p.like-link-target.react-component button[aria-pressed]';
  const LOW_WATER = 3;
  const PAGE_MIN_MS = 2500;
  const PAGE_JITTER_MS = 1500;
  const SWIPE_PX = 110;

  // ---- memory ------------------------------------------------------------

  const store = {
    get ranges() { return GM_getValue('ranges', []); },
    set ranges(v) { GM_setValue('ranges', v); },
    get feedEndId() { return GM_getValue('feedEndId', null); },
    set feedEndId(v) { GM_setValue('feedEndId', v); },
    get stats() { return GM_getValue('stats', { liked: 0, dismissed: 0, sessions: 0 }); },
    set stats(v) { GM_setValue('stats', v); },
  };

  /** Merge overlapping/touching [lo, hi] ranges. */
  function merge(ranges) {
    const sorted = ranges.filter(Boolean).map(([a, b]) => [Math.min(a, b), Math.max(a, b)]).sort((a, b) => a[0] - b[0]);
    const out = [];
    for (const r of sorted) {
      const last = out[out.length - 1];
      if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
      else out.push([...r]);
    }
    return out;
  }

  const covered = (id) => store.ranges.some(([lo, hi]) => id >= lo && id <= hi);

  // Every review row met this session, in feed order (newest first), with
  // whether it's resolved: decided, already liked, or already covered. The
  // session's range only grows over the resolved *prefix*, so a review still
  // waiting on the stack is never marked seen just because an older one was
  // auto-skipped or a newer one decided.
  const walk = [];
  let walkPtr = 0;
  let session = null;
  function advance() {
    let moved = false;
    while (walkPtr < walk.length && walk[walkPtr].resolved) {
      const id = walk[walkPtr++].id;
      session = session ? [Math.min(session[0], id), Math.max(session[1], id)] : [id, id];
      moved = true;
    }
    if (moved) store.ranges = merge([...store.ranges, session]);
  }
  function resolve(id) {
    const entry = walk.find((w) => w.id === id);
    if (entry) entry.resolved = true;
    advance();
  }

  // ---- reading the feed --------------------------------------------------

  const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  function readRow(row) {
    const id = Number(row.dataset.activityId);
    const likeBtn = row.querySelector(LIKE_SEL);
    const filmA = row.querySelector('.primaryname a');
    const body = row.querySelector('.js-review-body');
    const poster = row.querySelector('.react-component.figure img');
    const posterSrc = poster && /a\.ltrbxd\.com/.test(poster.currentSrc || poster.src) ? (poster.currentSrc || poster.src) : null;
    return {
      id,
      row,
      likeBtn,
      liked: likeBtn?.getAttribute('aria-pressed') === 'true',
      name: text(row.querySelector('.attribution-detail .displayname')) || row.querySelector('article')?.dataset.owner || '',
      avatar: row.querySelector('.table-activity-user img')?.getAttribute('src') || null,
      film: text(filmA),
      year: text(row.querySelector('.releasedate')),
      reviewUrl: filmA ? new URL(filmA.getAttribute('href'), location.origin).href : null,
      rating: row.querySelector('.inline-rating svg')?.getAttribute('aria-label') || '',
      paragraphs: body ? [...body.querySelectorAll('p')].map(text).filter(Boolean) : [],
      fullTextUrl: body?.dataset.fullTextUrl || null,
      spoiler: /may contain spoilers/i.test(text(row)) || !!row.querySelector('[class*="spoiler"]'),
      slug: row.querySelector('.react-component.figure')?.dataset.itemSlug || null,
      posterRow: poster,
      posterSrc,
    };
  }

  // Truncated reviews end with an ellipsis or a "more" control.
  function looksTruncated(card) {
    const last = card.paragraphs[card.paragraphs.length - 1] || '';
    return /…$|\.\.\.$/.test(last) || !!card.row.querySelector('.js-review .collapsed-text, .js-review a.more-link, .js-review .reveal');
  }

  async function loadFullText(card) {
    if (!card.fullTextUrl || card.fullLoaded || !looksTruncated(card)) return;
    card.fullLoaded = true;
    try {
      const res = await fetch(card.fullTextUrl, { credentials: 'same-origin' });
      if (!res.ok) return;
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      const paras = [...doc.querySelectorAll('p')].map(text).filter(Boolean);
      if (paras.length) card.paragraphs = paras;
    } catch { /* keep the truncated text */ }
  }

  // ---- watched / watchlist ---------------------------------------------

  /** 'watched' | 'unwatched' | null (poster not rendered yet). */
  function watchState(card) {
    const b = card.row.querySelector('.react-component.figure button.watch-link');
    if (!b) return null;
    return /you watched/i.test(b.getAttribute('aria-label') || b.textContent) ? 'watched' : 'unwatched';
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const WL_TEXT = /^\s*(add to|remove from) watchlist\s*$/i;

  function findWatchlistItem() {
    // The menu's wrappers carry the same text as the item, so take the
    // innermost element whose text matches, then climb to what's clickable.
    // (The stack lives in a shadow root, so document queries never see it.)
    const matches = [...document.querySelectorAll('a, button, li, span, div')].filter((el) => WL_TEXT.test(el.textContent));
    const leaf = matches.find((el) => !matches.some((m) => m !== el && el.contains(m)));
    return leaf ? leaf.closest('a, button, [role="menuitem"]') || leaf : null;
  }

  let suppressKeys = false;
  function closeMenus() {
    // Letterboxd menus close on Escape; don't let our own key handler see it.
    suppressKeys = true;
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    suppressKeys = false;
  }

  /** Opens the poster's own menu and uses its watchlist item. Returns
   *  'added' | 'already' | 'failed'. */
  async function openMenuItem(card) {
    const menu = card.row.querySelector('.react-component.figure .menu-link');
    if (!menu) return null;
    // The icon sits inside the poster's film link. Cancel that link's default
    // action for this one click so Letterboxd's own handler can open the menu
    // without the page navigating to the film (what v1.3 did).
    const link = menu.closest('a[href]');
    const guard = (e) => e.preventDefault();
    link?.addEventListener('click', guard, { capture: true, once: true });
    menu.click();
    setTimeout(() => link?.removeEventListener('click', guard, { capture: true }), 0);
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      const item = findWatchlistItem();
      if (item) return item;
    }
    closeMenus();
    return null;
  }

  // Only one poster menu may be open at a time (findWatchlistItem searches the
  // whole document), so adds (and their confirming re-open) never overlap.
  let menuChain = Promise.resolve();
  function withMenu(fn) {
    const run = menuChain.then(fn, fn);
    menuChain = run.catch(() => {});
    return run;
  }

  function addToWatchlist(card) {
    return withMenu(() => addToWatchlistNow(card)).then((r) => {
      if (r !== 'failed') markAdded(card);
      return r;
    });
  }

  // ---- my watchlist (from letterboxd.michaellamb.dev) -------------------

  const WATCHLIST_URL = 'https://letterboxd.michaellamb.dev/data/watchlist.json';
  const WATCHLIST_TTL = 6 * 60 * 60 * 1000;
  const WATCHLIST_RETRY_MS = 20000; // after a failed load, try again at most this often

  /** Same idea as compute_stats._inventory_key: case-, space- and
   *  quote-insensitive title plus year. */
  const filmKey = (name, year) =>
    `${String(name || '').normalize('NFKC').replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().toLowerCase()}|${year || ''}`;
  const cardKey = (card) => filmKey(card.film, Number(card.year) || '');

  function fetchWatchlist() {
    const c = GM_getValue('watchlistCache', null);
    if (c && Date.now() - c.at < WATCHLIST_TTL) return Promise.resolve(c);
    return new Promise((resolve) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: WATCHLIST_URL,
        timeout: 15000,
        onload: (res) => {
          try {
            if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
            const data = JSON.parse(res.responseText);
            const fresh = { at: Date.now(), snapshotDate: data.snapshotDate, keys: data.films.map(([n, y]) => filmKey(n, y)) };
            GM_setValue('watchlistCache', fresh);
            resolve(fresh);
          } catch (e) {
            watchlistError = e.message || 'bad response';
            resolve(c); // stale beats nothing
          }
        },
        onerror: () => { watchlistError = 'network error'; resolve(c); },
        ontimeout: () => { watchlistError = 'timed out'; resolve(c); },
      });
    });
  }

  let watchlistKeys = null; // Set: last list built (possibly empty/stale)
  let watchlistError = null; // why the last fetch failed, if it did
  let watchlistWarned = false;
  let watchlistOk = false; // a fresh (or in-TTL cached) list is loaded
  let watchlistInflight = null;
  let watchlistLastTry = 0;

  /** The watchlist as a Set of film keys. Only a successful load is kept for
   *  the page's lifetime: after a failure (e.g. the page was opened before
   *  watchlist.json was deployed) the next card that needs it tries again,
   *  at most every WATCHLIST_RETRY_MS, instead of staying empty until reload. */
  function getWatchlist() {
    if (watchlistOk) return Promise.resolve(watchlistKeys);
    if (watchlistInflight) return watchlistInflight;
    if (watchlistKeys && Date.now() - watchlistLastTry < WATCHLIST_RETRY_MS) return Promise.resolve(watchlistKeys);
    watchlistLastTry = Date.now();
    watchlistError = null;
    watchlistInflight = fetchWatchlist().then((data) => {
      const keys = new Set(data ? data.keys : []);
      // Films added from this stack since the export the file was built from.
      const added = GM_getValue('addedHere', {});
      const since = data?.snapshotDate || '';
      for (const [k, day] of Object.entries(added)) if (day >= since) keys.add(k);
      watchlistKeys = keys;
      watchlistOk = !watchlistError;
      if (watchlistOk) watchlistWarned = false;
      watchlistInflight = null;
      return keys;
    });
    return watchlistInflight;
  }
  getWatchlist(); // start loading as soon as the page does

  function markAdded(card) {
    const k = cardKey(card);
    watchlistKeys?.add(k);
    const added = GM_getValue('addedHere', {});
    added[k] = new Date().toISOString().slice(0, 10);
    GM_setValue('addedHere', added);
  }

  async function addToWatchlistNow(card) {
    const item = await openMenuItem(card);
    if (!item) return 'failed';
    if (/remove from/i.test(item.textContent)) { closeMenus(); return 'already'; }
    item.click();
    await sleep(600);
    closeMenus();
    // Don't claim success on the strength of a click: reopen the menu and
    // confirm it now offers "Remove from watchlist".
    await sleep(200);
    const check = await openMenuItem(card);
    closeMenus();
    return check && /remove from/i.test(check.textContent) ? 'added' : 'failed';
  }

  // ---- queue + paging ----------------------------------------------------

  const queue = [];
  const queuedIds = new Set();
  let scanned = new WeakSet();
  let done = false;
  let paging = false;
  let lastPageAt = 0;
  let pagesLoaded = 0;

  let waitTries = 0;

  /** Walk newly-appeared rows in order and queue the ones worth showing. */
  function scan() {
    for (const row of document.querySelectorAll(ROW_SEL)) {
      if (scanned.has(row)) continue;
      const id = Number(row.dataset.activityId);
      if (!id || queuedIds.has(id)) { scanned.add(row); continue; }

      if (covered(id)) {
        scanned.add(row);
        walk.push({ id, resolved: true });
        // Reached the range that runs to the bottom of the feed: nothing older
        // is left unseen.
        const end = store.feedEndId;
        if (end != null && store.ranges.some(([lo, hi]) => lo <= end && id >= lo && id <= hi)) done = true;
        continue;
      }
      const card = readRow(row);
      if (!card.likeBtn && waitTries < 8) {
        // Letterboxd hasn't rendered this row's Like button yet. Stop here
        // rather than skip it, so the walk stays in feed order; retry shortly.
        waitTries += 1;
        setTimeout(() => { scan(); if (open) ui.render(); }, 500);
        break;
      }
      waitTries = 0;
      scanned.add(row);
      if (!card.likeBtn || card.liked) { walk.push({ id, resolved: true }); continue; }
      walk.push({ id, resolved: false });
      queue.push(card);
      queuedIds.add(id);
    }
    advance();
  }

  const loadMoreEl = () => document.querySelector('lb-load-more-button');

  async function maybePage() {
    if (done || paging || queue.length >= LOW_WATER) return;
    const btn = loadMoreEl();
    if (!btn) {
      // End of the feed: remember how deep it goes.
      const ids = [...document.querySelectorAll('section.activity-row[data-activity-id]')].map((r) => Number(r.dataset.activityId)).filter(Boolean);
      if (ids.length) store.feedEndId = Math.min(...ids);
      done = true;
      ui.render();
      return;
    }
    paging = true;
    const wait = lastPageAt + PAGE_MIN_MS + Math.random() * PAGE_JITTER_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));

    const before = document.querySelectorAll('section.activity-row[data-activity-id]').length;
    lastPageAt = Date.now();
    (btn.querySelector('button, a') || btn).click();

    // Wait up to 10 s for rows to arrive.
    const ok = await new Promise((resolve) => {
      const t0 = Date.now();
      (function poll() {
        const now = document.querySelectorAll('section.activity-row[data-activity-id]').length;
        if (now > before) return resolve(true);
        if (Date.now() - t0 > 10000) return resolve(false);
        setTimeout(poll, 250);
      })();
    });
    paging = false;
    if (!ok) { ui.toast('Older activity didn’t load. Try again in a bit.'); ui.render(); return; }
    pagesLoaded += 1;
    // Give LikeComponent a moment to render its buttons in the new rows.
    setTimeout(() => { scan(); ui.render(); maybePage(); }, 600);
  }

  // ---- actions -----------------------------------------------------------

  const history = []; // { card, action }

  async function clickLike(card, wantLiked) {
    const btn = card.row.querySelector(LIKE_SEL) || card.likeBtn;
    if (!btn) return false;
    if ((btn.getAttribute('aria-pressed') === 'true') === wantLiked) return true;
    btn.click();
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 150));
      const b = card.row.querySelector(LIKE_SEL) || btn;
      if ((b.getAttribute('aria-pressed') === 'true') === wantLiked) return true;
    }
    return false;
  }

  let busy = false;
  async function decide(action) {
    if (busy || !queue.length) return;
    busy = true;
    const card = queue[0];
    if (action === 'like') {
      ui.fly('right');
      const ok = await clickLike(card, true);
      if (!ok) {
        ui.toast('Like didn’t register on Letterboxd. Card kept.');
        ui.render();
        busy = false;
        return;
      }
    } else {
      ui.fly('left');
    }
    queue.shift();
    resolve(card.id);
    history.push({ card, action });
    const s = store.stats;
    s[action === 'like' ? 'liked' : 'dismissed'] += 1;
    store.stats = s;
    busy = false;
    ui.render();
    maybePage();
  }

  async function watchlist() {
    const card = queue[0];
    if (busy || !card || card.wl !== 'offer') return;
    busy = true;
    card.wl = 'busy';
    ui.render();
    const result = await addToWatchlist(card);
    card.wl = result === 'failed' ? 'offer' : result;
    if (result === 'failed') ui.toast('Couldn’t open the poster’s menu. Use “Open on Letterboxd” to add it.');
    busy = false;
    ui.render();
  }

  async function undo() {
    if (busy || !history.length) return;
    busy = true;
    const { card, action } = history.pop();
    if (action === 'like' && !(await clickLike(card, false))) ui.toast('Couldn’t unlike that one; check it on Letterboxd.');
    // The card stays inside the covered range; putting it back on the stack is
    // enough to decide it again this session. (If you close without deciding
    // it again, it stays counted as seen.)
    queue.unshift(card);
    const s = store.stats;
    s[action === 'like' ? 'liked' : 'dismissed'] = Math.max(0, s[action === 'like' ? 'liked' : 'dismissed'] - 1);
    store.stats = s;
    busy = false;
    ui.render();
  }

  // ---- UI ----------------------------------------------------------------

  const ui = (() => {
    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483000;display:none';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        * { box-sizing: border-box; }
        .scrim { position: fixed; inset: 0; background: rgba(10,13,16,.94); display: flex; flex-direction: column; align-items: center; font: 15px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: #def; }
        header { width: min(560px, 100% - 32px); display: flex; align-items: center; gap: 12px; padding: 16px 0 8px; color: #9ab; font-size: 13px; }
        header .grow { flex: 1; }
        header button { background: none; border: 1px solid #456; color: #9ab; border-radius: 6px; padding: 4px 10px; font: inherit; cursor: pointer; }
        header button:hover { color: #fff; border-color: #789; }
        .deck { position: relative; flex: 1; width: min(560px, 100% - 32px); margin-bottom: 12px; min-height: 0; }
        .card { position: absolute; inset: 0; background: #1c2228; border: 1px solid #2c3440; border-radius: 14px; box-shadow: 0 10px 40px rgba(0,0,0,.5); display: flex; flex-direction: column; overflow: hidden; touch-action: none; user-select: none; will-change: transform; }
        .card.under { transform: scale(.96) translateY(10px); opacity: .6; pointer-events: none; }
        .card.anim { transition: transform .28s ease, opacity .28s ease; }
        .top { display: flex; gap: 14px; padding: 16px; border-bottom: 1px solid #2c3440; }
        .poster { width: 70px; height: 105px; border-radius: 4px; background: #242c34; flex-shrink: 0; object-fit: cover; }
        .who { display: flex; align-items: center; gap: 8px; color: #9ab; font-size: 13px; }
        .who img { width: 24px; height: 24px; border-radius: 50%; }
        .film { color: #fff; font-size: 20px; font-weight: 700; line-height: 1.2; margin: 6px 0 2px; }
        .film span { color: #789; font-weight: 400; font-size: 16px; }
        .stars { color: #00e054; letter-spacing: 1px; }
        .wl { margin-top: 8px; background: none; border: 1px solid #40bcf4; color: #40bcf4; border-radius: 5px; padding: 3px 10px; font-family: inherit; font-size: 12px; font-weight: 600; line-height: 1.4; cursor: pointer; }
        .wl:hover:not([disabled]) { background: #40bcf4; color: #14181c; }
        .wl[disabled] { border-color: #456; color: #9ab; cursor: default; }
        .wl[hidden] { display: none; }
        .body { flex: 1; overflow-y: auto; padding: 16px; color: #cdd; }
        .body p { margin: 0 0 .8em; }
        .body.spoiler { filter: blur(6px); cursor: pointer; }
        .spoiler-note { color: #ff8000; font-size: 12px; padding: 8px 16px 0; }
        .open { padding: 10px 16px; border-top: 1px solid #2c3440; font-size: 13px; }
        .open a { color: #40bcf4; text-decoration: none; }
        .stamp { position: absolute; top: 20px; padding: 4px 12px; border: 3px solid; border-radius: 6px; font-weight: 800; font-size: 22px; letter-spacing: .1em; opacity: 0; transform: rotate(-12deg); }
        .stamp.like { left: 20px; color: #00e054; }
        .stamp.nope { right: 20px; color: #f44; transform: rotate(12deg); }
        .empty { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; text-align: center; color: #9ab; padding: 24px; }
        .controls { display: flex; gap: 24px; padding: 0 0 20px; }
        .controls button { width: 64px; height: 64px; border-radius: 50%; border: 2px solid; background: #1c2228; font-size: 26px; cursor: pointer; }
        .controls .nope { color: #f44; border-color: #f44; }
        .controls .like { color: #00e054; border-color: #00e054; }
        .controls .undo { width: 48px; height: 48px; margin-top: 8px; color: #9ab; border-color: #456; font-size: 18px; }
        .hint { color: #678; font-size: 12px; padding-bottom: 12px; }
        .toast { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); background: #242c34; color: #fff; padding: 8px 14px; border-radius: 6px; font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
        .toast.on { opacity: 1; }
      </style>
      <div class="scrim">
        <header>
          <span class="status"></span><span class="grow"></span>
          <button type="button" class="reset" title="Forget which reviews you've seen">Reset memory</button>
          <button type="button" class="close" title="Close (Esc)">Close</button>
        </header>
        <div class="deck"></div>
        <div class="controls">
          <button type="button" class="nope" title="Dismiss (←)">✕</button>
          <button type="button" class="undo" title="Undo (Z)">↺</button>
          <button type="button" class="like" title="Like review (→)">♥</button>
        </div>
        <div class="hint">← dismiss · → like · W watchlist · Z undo · Esc close</div>
        <div class="toast"></div>
      </div>`;
    document.documentElement.appendChild(host);

    const $ = (s) => root.querySelector(s);
    const deck = $('.deck');
    let toastTimer;

    function toast(msg) {
      const t = $('.toast');
      t.textContent = msg;
      t.classList.add('on');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
    }

    function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }

    // Blur a spoiler review unless you've watched the film or already revealed
    // it. While the poster hasn't said either way, err on the side of hiding.
    function hideSpoiler(c) {
      return c.spoiler && !c.revealed && (c.watched || watchState(c)) !== 'watched';
    }

    function cardHtml(c, under) {
      return `
        <div class="card${under ? ' under' : ''}" data-id="${c.id}">
          <div class="stamp like">LIKE</div><div class="stamp nope">NOPE</div>
          <div class="top">
            ${c.posterSrc ? `<img class="poster" src="${esc(c.posterSrc)}" alt="">` : '<div class="poster"></div>'}
            <div>
              <div class="who">${c.avatar ? `<img src="${esc(c.avatar)}" alt="">` : ''}${esc(c.name)}</div>
              <div class="film">${esc(c.film)} <span>${esc(c.year)}</span></div>
              <div class="stars">${esc(c.rating)}</div>
              <button type="button" class="wl" ${c.wl ? '' : 'hidden'} ${c.wl === 'offer' ? '' : 'disabled'}>${
                c.wl === 'added' ? '✓ Added to your watchlist'
                  : c.wl === 'already' ? '✓ On your watchlist'
                  : c.wl === 'busy' ? 'Adding…'
                  : c.wl === 'checking' ? 'Checking watchlist…'
                  : '+ Add to watchlist (W)'
              }</button>
            </div>
          </div>
          ${hideSpoiler(c) ? '<div class="spoiler-note">May contain spoilers, and you haven’t logged this film. Tap the text to reveal.</div>' : ''}
          <div class="body${hideSpoiler(c) ? ' spoiler' : ''}">${c.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('') || '<p><em>(no text)</em></p>'}</div>
          ${c.reviewUrl ? `<div class="open"><a href="${esc(c.reviewUrl)}" target="_blank" rel="noopener">Open on Letterboxd ↗</a></div>` : ''}
        </div>`;
    }

    function render() {
      const st = store.stats;
      const more = done ? '' : (paging ? ' · loading older…' : '+');
      $('.status').textContent = `${queue.length}${more} to go · ${st.liked} liked · ${st.dismissed} dismissed`;
      if (!queue.length) {
        deck.innerHTML = `<div class="empty">${done || !loadMoreEl()
          ? 'All caught up. No unliked reviews left in your feed.'
          : `Looking for reviews you haven’t seen…<br><small>${pagesLoaded} older page${pagesLoaded === 1 ? '' : 's'} loaded</small>`}</div>`;
        return;
      }
      const [top, next] = queue;
      deck.innerHTML = (next ? cardHtml(next, true) : '') + cardHtml(top, false);
      // Scroll the real rows into view behind the overlay so Letterboxd's lazy
      // posters load for the next cards.
      next?.row.scrollIntoView({ block: 'center' });
      top.row.scrollIntoView({ block: 'center' });
      bindDrag(deck.querySelector('.card:not(.under)'));
      deck.querySelector('.card:not(.under) .wl')?.addEventListener('click', watchlist);
      loadFullText(top).then(() => {
        const body = deck.querySelector(`.card[data-id="${top.id}"] .body`);
        if (body && top.paragraphs.length) body.innerHTML = top.paragraphs.map((p) => `<p>${esc(p)}</p>`).join('');
      });
      // Offer the watchlist button only once the poster confirms you haven't
      // watched the film. The poster may still be loading, so check again.
      // Watched state also decides whether a spoiler stays blurred.
      const checkWatch = () => {
        if (queue[0] !== top || top.watched) return;
        const state = watchState(top);
        if (!state) return;
        top.watched = state;
        if (state === 'unwatched') {
          if (!top.wl) {
            top.wl = 'checking';
            getWatchlist().then((keys) => {
              if (top.wl !== 'checking') return;
              top.wl = keys.has(cardKey(top)) ? 'already' : 'offer';
              // Say so if the list couldn't be loaded, rather than offering
              // "Add" as if we'd checked.
              if (watchlistError && !watchlistOk && !watchlistWarned) {
                watchlistWarned = true;
                ui.toast(`Couldn’t load your watchlist (${watchlistError}). Retrying on the next card.`);
              }
              if (queue[0] === top) render();
            });
          }
          render();
        } else if (top.spoiler) {
          render(); // watched: un-blur the spoiler
        }
      };
      checkWatch();
      setTimeout(checkWatch, 900);
      if (!top.posterSrc && top.posterRow) {
        // Pick up the poster once the lazy loader swaps it in.
        setTimeout(() => {
          const src = top.posterRow.currentSrc || top.posterRow.src;
          if (/a\.ltrbxd\.com/.test(src)) {
            top.posterSrc = src;
            const ph = deck.querySelector(`.card[data-id="${top.id}"] div.poster`);
            if (ph) ph.outerHTML = `<img class="poster" src="${esc(src)}" alt="">`;
          }
        }, 900);
      }
    }

    function bindDrag(card) {
      if (!card) return;
      const top = queue.find((c) => String(c.id) === card.dataset.id);
      const body = card.querySelector('.body.spoiler');
      // Recorded on the card itself so a later re-render doesn't blur it again.
      body?.addEventListener('click', () => {
        if (top) top.revealed = true;
        body.classList.remove('spoiler');
        card.querySelector('.spoiler-note')?.remove();
      });
      let x0 = null, y0 = 0, dx = 0, dragging = false;
      card.addEventListener('pointerdown', (e) => {
        if (e.target.closest('a, button')) return;
        x0 = e.clientX; y0 = e.clientY; dx = 0; dragging = false;
      });
      card.addEventListener('pointermove', (e) => {
        if (x0 == null) return;
        dx = e.clientX - x0;
        const dy = e.clientY - y0;
        // A mostly-vertical drag scrolls the review instead.
        if (!dragging && Math.abs(dx) < 8) return;
        if (!dragging && Math.abs(dy) > Math.abs(dx)) { x0 = null; return; }
        if (!dragging) {
          // Capture only once it's really a swipe. Capturing on pointerdown
          // retargets the click to the card, so taps on the spoiler text and
          // the watchlist button never reached them.
          dragging = true;
          try { card.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
        }
        card.style.transform = `translateX(${dx}px) rotate(${dx / 20}deg)`;
        card.querySelector('.stamp.like').style.opacity = Math.max(0, Math.min(1, dx / SWIPE_PX));
        card.querySelector('.stamp.nope').style.opacity = Math.max(0, Math.min(1, -dx / SWIPE_PX));
      });
      const end = () => {
        if (x0 == null) return;
        x0 = null;
        if (dx > SWIPE_PX) return decide('like');
        if (dx < -SWIPE_PX) return decide('dismiss');
        card.classList.add('anim');
        card.style.transform = '';
        card.querySelectorAll('.stamp').forEach((s) => { s.style.opacity = 0; });
      };
      card.addEventListener('pointerup', end);
      card.addEventListener('pointercancel', end);
    }

    function fly(dir) {
      const card = deck.querySelector('.card:not(.under)');
      if (!card) return;
      card.classList.add('anim');
      card.style.transform = `translateX(${dir === 'right' ? 140 : -140}%) rotate(${dir === 'right' ? 18 : -18}deg)`;
      card.style.opacity = '0';
      card.querySelector(`.stamp.${dir === 'right' ? 'like' : 'nope'}`).style.opacity = 1;
    }

    $('.nope').addEventListener('click', () => decide('dismiss'));
    $('.like').addEventListener('click', () => decide('like'));
    $('.undo').addEventListener('click', undo);
    $('.close').addEventListener('click', () => close());
    $('.reset').addEventListener('click', () => {
      if (!confirm('Forget which reviews you’ve been through? The next run starts from the top of your feed.')) return;
      store.ranges = [];
      store.feedEndId = null;
      store.stats = { liked: 0, dismissed: 0, sessions: 0 };
      session = null;
      walk.length = 0;
      walkPtr = 0;
      done = false;
      queue.length = 0;
      queuedIds.clear();
      scanned = new WeakSet();
      scan();
      render();
      maybePage();
    });

    return { host, render, toast, fly };
  })();

  // ---- open / close ------------------------------------------------------

  let open = false;

  function onKey(e) {
    if (!open || suppressKeys) return;
    // Capture-phase and stopped, so Letterboxd's own hot keys (e.g. "l" for
    // load more) don't also fire while the stack is up.
    const k = e.key;
    if (k === 'ArrowRight') decide('like');
    else if (k === 'ArrowLeft') decide('dismiss');
    else if (k === 'z' || k === 'Z' || k === 'Backspace') undo();
    else if (k === 'w' || k === 'W') watchlist();
    else if (k === 'Escape') close();
    else return;
    e.preventDefault();
    e.stopPropagation();
  }

  function openStack() {
    open = true;
    ui.host.style.display = 'block';
    document.documentElement.style.overflow = 'hidden';
    const s = store.stats;
    s.sessions += 1;
    store.stats = s;
    scan();
    ui.render();
    maybePage();
  }

  function close() {
    open = false;
    ui.host.style.display = 'none';
    document.documentElement.style.overflow = '';
  }

  window.addEventListener('keydown', onKey, true);

  const launch = document.createElement('button');
  launch.type = 'button';
  launch.textContent = '♥ Review stack';
  Object.assign(launch.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: 2147482000,
    padding: '10px 14px', borderRadius: '6px', border: '0',
    background: '#00c030', color: '#fff', font: '600 13px/1.2 sans-serif',
    boxShadow: '0 2px 8px rgba(0,0,0,.4)', cursor: 'pointer',
  });
  launch.addEventListener('click', openStack);
  document.body.appendChild(launch);
})();
