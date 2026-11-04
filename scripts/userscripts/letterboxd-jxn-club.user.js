// ==UserScript==
// @name         Letterboxd JXN Film Club navigator
// @namespace    https://michaellamb.dev/letterboxd-viewer
// @version      1.1.0
// @description  A panel of JXN Film Club members on Letterboxd, with one-click links to each member's profile and "followers you know" page, and a Next button to work through them.
// @match        https://letterboxd.com/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @connect      join.jxnfilm.club
// ==/UserScript==

/*
 * Pairs with letterboxd-network-export.user.js to fill the Network page's
 * connection layer:
 *
 *   1. Click "JXN" (bottom left) and pick a member, or press "Start / Next".
 *   2. On their /<handle>/followers-you-know/ page, click the export
 *      script's green button and save the JSON into data/network/.
 *   3. Press "Next ›" in the panel for the next member you haven't done.
 *   4. When finished: python3 scripts/compute_network.py.
 *
 * Members come from the club's own public roster
 * (join.jxnfilm.club/members), which lists each member's linked Letterboxd
 * handle. Only the handle is read; names and pronouns are left alone. The
 * Network page's data/network.json is anonymous and can't supply handles.
 * The roster is fetched with GM_xmlhttpRequest so Letterboxd's CSP doesn't
 * apply, and cached for a day.
 *
 * A member counts as done once you've opened their followers-you-know page
 * (stored in Tampermonkey; tick or untick by hand in the panel). This script
 * makes no Letterboxd requests itself. It only links to pages you then open.
 */

(function () {
  'use strict';

  const DATA_URL = 'https://join.jxnfilm.club/members';
  const OWNER = 'michaellamb';
  const CACHE_MS = 24 * 60 * 60 * 1000;
  const YOU_KNOW = 'followers-you-know';

  const store = {
    get done() { return GM_getValue('done', {}); },
    set done(v) { GM_setValue('done', v); },
    get cache() { return GM_getValue('roster', null); },
    set cache(v) { GM_setValue('roster', v); },
    get open() { return GM_getValue('panelOpen', false); },
    set open(v) { GM_setValue('panelOpen', v); },
  };

  const youKnowUrl = (h) => `https://letterboxd.com/${encodeURIComponent(h)}/${YOU_KNOW}/`;
  const profileUrl = (h) => `https://letterboxd.com/${encodeURIComponent(h)}/`;

  // ---- data ----------------------------------------------------------------

  function fetchMembers(force) {
    const c = store.cache;
    if (!force && c && Date.now() - c.at < CACHE_MS) return Promise.resolve(c.members);
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: DATA_URL,
        timeout: 15000,
        onload: (res) => {
          try {
            if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
            const roster = JSON.parse(res.responseText);
            if (!Array.isArray(roster)) throw new Error('unexpected roster shape');
            const handles = new Set(roster
              .map((m) => String(m.handle || '').trim().toLowerCase())
              .filter((h) => h && h !== OWNER));
            const members = [...handles].sort().map((handle) => ({ handle }));
            store.cache = { at: Date.now(), members };
            resolve(members);
          } catch (e) {
            reject(e);
          }
        },
        onerror: () => reject(new Error('network error')),
        ontimeout: () => reject(new Error('timed out')),
      });
    });
  }

  // ---- where are we? -------------------------------------------------------

  const parts = location.pathname.split('/').filter(Boolean);
  const here = { handle: (parts[0] || '').toLowerCase(), youKnow: parts[1] === YOU_KNOW };

  // ---- UI ------------------------------------------------------------------

  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:2147482500';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <style>
      :host { all: initial; }
      * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      .toggle { padding: 9px 12px; border: 1px solid #fff; border-radius: 6px; background: #14181c; color: #fff; font-weight: 800; font-size: 12px; letter-spacing: .1em; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.4); }
      .panel { position: absolute; left: 0; bottom: 44px; width: min(340px, calc(100vw - 32px)); max-height: min(70vh, 560px); display: flex; flex-direction: column; background: #1c2228; color: #9ab; border: 1px solid #2c3440; border-radius: 10px; box-shadow: 0 10px 30px rgba(0,0,0,.5); font-size: 13px; }
      .panel[hidden] { display: none; }
      header { display: flex; align-items: center; gap: 8px; padding: 10px 12px; border-bottom: 1px solid #2c3440; }
      header strong { color: #fff; flex: 1; }
      .btn { background: #00c030; color: #fff; border: 0; border-radius: 5px; padding: 5px 10px; font-weight: 600; font-size: 12px; cursor: pointer; }
      .btn.ghost { background: none; border: 1px solid #456; color: #9ab; }
      .progress { padding: 8px 12px; border-bottom: 1px solid #2c3440; }
      .bar { height: 4px; background: #2c3440; border-radius: 2px; margin-top: 6px; overflow: hidden; }
      .bar span { display: block; height: 100%; background: #00e054; }
      ul { list-style: none; margin: 0; padding: 4px 0; overflow-y: auto; }
      li { display: flex; align-items: center; gap: 8px; padding: 5px 12px; }
      li.here { background: #242c34; }
      .who { flex: 1; min-width: 0; }
      .who a { color: #fff; text-decoration: none; display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .who a:hover { color: #40bcf4; }
      .yk { color: #40bcf4; text-decoration: none; font-size: 12px; white-space: nowrap; }
      .yk:hover { color: #fff; }
      input[type=checkbox] { accent-color: #00e054; margin: 0; }
      .note { padding: 8px 12px; border-top: 1px solid #2c3440; font-size: 12px; color: #678; }
      .err { color: #f44; padding: 12px; }
    </style>
    <div class="panel" hidden>
      <header><strong>JXN Film Club</strong><button class="btn next" type="button">Start</button><button class="btn ghost refresh" type="button" title="Reload the member list">↻</button></header>
      <div class="progress"></div>
      <ul></ul>
      <div class="note"></div>
    </div>
    <button class="toggle" type="button" title="JXN Film Club members">JXN</button>`;
  document.body.appendChild(host);

  const $ = (s) => root.querySelector(s);
  const panel = $('.panel');
  let members = [];

  function esc(s) { const d = document.createElement('div'); d.textContent = s == null ? '' : s; return d.innerHTML; }

  function nextMember() {
    const done = store.done;
    const i = members.findIndex((m) => m.handle === here.handle);
    // Next not-done member after the current one, wrapping around.
    for (let k = 1; k <= members.length; k++) {
      const m = members[(Math.max(i, -1) + k) % members.length];
      if (!done[m.handle]) return m;
    }
    return null;
  }

  function render() {
    const done = store.done;
    const n = members.filter((m) => done[m.handle]).length;
    $('.progress').innerHTML = `${n} of ${members.length} done<div class="bar"><span style="width:${members.length ? (100 * n) / members.length : 0}%"></span></div>`;
    $('ul').innerHTML = members.map((m) => `
      <li class="${m.handle === here.handle ? 'here' : ''}">
        <input type="checkbox" data-h="${esc(m.handle)}" ${done[m.handle] ? 'checked' : ''} title="Done">
        <div class="who"><a href="${profileUrl(m.handle)}">@${esc(m.handle)}</a></div>
        <a class="yk" href="${youKnowUrl(m.handle)}">you know ›</a>
      </li>`).join('');
    const nx = nextMember();
    const btn = $('.next');
    btn.textContent = here.youKnow ? 'Next ›' : 'Start';
    btn.disabled = !nx;
    btn.style.opacity = nx ? '1' : '.4';
    $('.note').textContent = nx
      ? (here.youKnow ? 'Export this page, then Next.' : 'Start opens the first member you haven’t done.')
      : 'All done. Run scripts/compute_network.py.';
  }

  async function load(force) {
    $('ul').innerHTML = '<li>Loading members…</li>';
    try {
      members = await fetchMembers(force);
      render();
    } catch (e) {
      $('ul').innerHTML = `<li class="err">Couldn’t load ${esc(DATA_URL)}: ${esc(e.message)}</li>`;
    }
  }

  $('.toggle').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    store.open = !panel.hidden;
    if (!panel.hidden && !members.length) load(false);
  });
  $('.refresh').addEventListener('click', () => load(true));
  $('.next').addEventListener('click', () => {
    const m = nextMember();
    if (m) location.href = youKnowUrl(m.handle);
  });
  $('ul').addEventListener('change', (e) => {
    const h = e.target.dataset?.h;
    if (!h) return;
    const done = store.done;
    if (e.target.checked) done[h] = Date.now(); else delete done[h];
    store.done = done;
    render();
  });

  // Opening a member's followers-you-know page marks them done, and keeps the
  // panel open so Next is one click away.
  (async () => {
    if (here.youKnow || store.open) {
      await load(false);
      if (here.youKnow && members.some((m) => m.handle === here.handle)) {
        const done = store.done;
        if (!done[here.handle]) { done[here.handle] = Date.now(); store.done = done; }
        panel.hidden = false;
        store.open = true;
        render();
      } else if (store.open) {
        panel.hidden = false;
      }
    }
  })();
})();
