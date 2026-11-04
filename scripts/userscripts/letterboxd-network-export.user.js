// ==UserScript==
// @name         Letterboxd network export
// @namespace    https://michaellamb.dev/letterboxd-viewer
// @version      1.3.0
// @description  Unpaginate a Letterboxd people list (followers / following / followers you know) into one page, then export it as JSON.
// @match        https://letterboxd.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * One-time export of the social graph for letterboxd-viewer's Network tab.
 * There is no API for this, and the Letterboxd data export has no
 * followers/following file.
 *
 * How it works: on any page that shows a people table, a button appears
 * (bottom right). Clicking it follows the page's own "Next" link, one page at
 * a time with a 2–4 s pause in between. That is about the pace of a person
 * clicking Next, which keeps it polite. Each fetched page's rows are added to
 * the table you are looking at, and the data is collected as it goes. When
 * there is no Next link, a JSON file downloads.
 *
 * It never guesses URLs. It only follows the "Next" href Letterboxd renders,
 * so it works the same on /followers/, /following/ and the "followers you
 * know" view, whatever that page's path is.
 *
 * If a page fails (non-200, a challenge page, or a page with no rows), it
 * stops and exports what it has, with "complete": false.
 *
 * The file holds real handles, so it stays on your machine: data/network/ is
 * gitignored, and compute_network.py publishes only an anonymous graph.
 */

(function () {
  'use strict';

  const MIN_DELAY_MS = 2000;
  const JITTER_MS = 2000;
  const MAX_PAGES = 200; // hard ceiling: 5,000 people

  const table = document.querySelector('td.table-person')?.closest('table');
  if (!table) return; // not a people list

  // ---- parsing -----------------------------------------------------------

  /** One <tr> → { handle }. The href slug is canonical (data-username can
   *  differ in case, e.g. "SomeOne" vs /someone/).
   *
   *  Handle only, on purpose. Earlier versions also kept display names,
   *  avatars and follower/film counts; the Network page is anonymous now and
   *  only needs to know who is connected to whom, so nothing else about
   *  anyone is copied out of the page. */
  function parseRow(tr) {
    const nameLink = tr.querySelector('.person-summary a.name');
    if (!nameLink) return null;
    const handle = (nameLink.getAttribute('href') || '').split('/').filter(Boolean)[0];
    if (!handle) return null;

    // No follow-state field either: the Follow/Unfollow buttons are toggled
    // by Letterboxd's client JS, so only rows on the first, hydrated page are
    // accurate. Mutuals come from followers ∩ following instead.
    return { handle };
  }

  const rowsOf = (root) => [...root.querySelectorAll('td.table-person')].map((td) => td.closest('tr'));
  const nextHrefOf = (root) => root.querySelector('.pagination a.next')?.getAttribute('href') || null;

  // ---- context -----------------------------------------------------------

  const pathParts = location.pathname.split('/').filter(Boolean);
  const owner = pathParts[0];
  // Whatever comes after the owner, minus any /page/N, e.g. "followers",
  // "following", or the "you know" path.
  const listKind = pathParts.slice(1).filter((p, i, a) => !(p === 'page' || a[i - 1] === 'page')).join('/') || 'list';

  // ---- UI ----------------------------------------------------------------

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = `Export ${listKind} (all pages)`;
  Object.assign(btn.style, {
    position: 'fixed', right: '16px', bottom: '16px', zIndex: 99999,
    padding: '10px 14px', borderRadius: '6px', border: '0',
    background: '#00c030', color: '#fff', font: '600 13px/1.2 sans-serif',
    boxShadow: '0 2px 8px rgba(0,0,0,.4)', cursor: 'pointer',
  });
  document.body.appendChild(btn);
  const status = (t) => { btn.textContent = t; };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function download(obj) {
    const date = new Date().toISOString().slice(0, 10);
    const name = `letterboxd-${owner}-${listKind.replace(/\//g, '-')}-${date}.json`;
    const url = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // ---- run ---------------------------------------------------------------

  let running = false;

  btn.addEventListener('click', async () => {
    if (running) return;
    running = true;
    btn.style.cursor = 'progress';

    const tbody = table.tBodies[0] || table;
    const people = new Map();
    const add = (tr) => { const p = parseRow(tr); if (p && !people.has(p.handle)) people.set(p.handle, p); };

    rowsOf(document).forEach(add);
    let next = nextHrefOf(document);
    let pages = 1;
    let complete = true;
    let stopReason = null;

    while (next && pages < MAX_PAGES) {
      status(`Page ${pages + 1}… (${people.size} people)`);
      await sleep(MIN_DELAY_MS + Math.random() * JITTER_MS);

      let doc;
      try {
        const res = await fetch(next, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`HTTP ${res.status} on ${next}`);
        doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      } catch (e) {
        complete = false; stopReason = String(e.message || e); break;
      }

      const rows = rowsOf(doc);
      if (!rows.length) { complete = false; stopReason = `no rows on ${next} (challenge page?)`; break; }

      // Unpaginate: move the fetched rows into the live table.
      rows.forEach((tr) => { add(tr); tbody.appendChild(document.importNode(tr, true)); });
      pages += 1;
      next = nextHrefOf(doc);
    }
    if (next && pages >= MAX_PAGES) { complete = false; stopReason = `hit MAX_PAGES (${MAX_PAGES})`; }

    // The original pager is now misleading.
    document.querySelectorAll('.pagination').forEach((el) => { el.style.display = 'none'; });

    const out = {
      schema: 'letterboxd-network-export/2',
      owner,
      list: listKind,
      sourceUrl: location.origin + location.pathname,
      exportedAt: new Date().toISOString(),
      pages,
      count: people.size,
      // Complete means it followed Next until there was none.
      complete,
      stopReason,
      people: [...people.values()],
    };
    download(out);

    status(`${complete ? 'Done' : 'Partial'}: ${people.size} people — saved`);
    btn.style.background = complete ? '#00c030' : '#d4532b';
    btn.style.cursor = 'default';
    if (stopReason) console.warn('[lb-network-export]', stopReason);
  });
})();
