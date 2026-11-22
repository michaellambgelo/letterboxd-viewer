/**
 * The /admin page for the rolodex Worker: one self-contained HTML document,
 * no build step — same spirit as the rest of this repo.
 *
 * The browser script is a real function (`adminClient`) that is serialized
 * with toString() into the page, rather than source text inside a template
 * literal. That way it is linted and syntax-checked like any other code, and
 * regexes and string escapes mean what they say. Two consequences:
 *
 *   - it must be self-contained: it cannot close over anything in this module;
 *   - wrangler's bundler (esbuild, keepNames) may wrap inner functions in
 *     `__name(fn, "name")` calls, and that helper does not exist in the
 *     browser — hence the one-line shim emitted ahead of it.
 *
 * Destructive actions use an in-page two-step confirm (`armed`), never
 * window.confirm(): a native dialog can't show a dry-run diff.
 */

const STYLE = `
  :root {
    --bg-primary: #14181c; --bg-secondary: #1c2228; --bg-tertiary: #242c34;
    --bg-hover: #2c3440; --text-primary: #fff; --text-secondary: #99aabb;
    --text-muted: #667788; --accent-green: #00e054; --accent-blue: #40bcf4;
    --accent-orange: #ff8000; --border: #2c3440; --danger: #f44336;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: var(--bg-primary); color: var(--text-secondary);
    line-height: 1.5; padding: 2rem 1rem 4rem;
  }
  .wrap { max-width: 980px; margin: 0 auto; }
  .narrow { max-width: 760px; }
  h1 { color: var(--text-primary); font-size: 1.5rem; margin-bottom: .25rem; }
  h2 { color: var(--text-primary); font-size: 1rem; margin: 0 0 .5rem; }
  .sub { color: var(--text-muted); font-size: .875rem; margin-bottom: 1.25rem; }
  .hint { color: var(--text-muted); font-size: .8125rem; margin: .375rem 0 .75rem; max-width: 72ch; }
  .hint strong { color: var(--text-secondary); }
  a { color: var(--accent-blue); }

  .tabs { display: flex; gap: .25rem; flex-wrap: wrap; border-bottom: 1px solid var(--border); margin-bottom: 1.5rem; }
  .tabs button {
    border: 0; border-bottom: 2px solid transparent; border-radius: 0;
    background: none; padding: .625rem .875rem; color: var(--text-muted);
  }
  .tabs button[aria-selected=true] { color: var(--text-primary); border-bottom-color: var(--accent-green); }
  [data-panel][hidden] { display: none; }

  fieldset, .card { border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem; margin-bottom: 1.5rem; }
  legend { color: var(--text-primary); font-size: .875rem; font-weight: 600; padding: 0 .5rem; }
  label { display: block; font-size: .75rem; text-transform: uppercase;
          letter-spacing: .05em; color: var(--text-muted); margin: .875rem 0 .25rem; }
  label.inline { display: inline-flex; align-items: center; gap: .375rem; margin: 0;
                 text-transform: none; letter-spacing: 0; font-size: .875rem; color: var(--text-secondary); }
  input[type=text], textarea, select {
    width: 100%; padding: .5rem .625rem; background: var(--bg-tertiary);
    border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary);
    font: inherit; font-size: .9375rem;
  }
  textarea { min-height: 7rem; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8125rem; }
  select { width: auto; }
  input[type=file] { font: inherit; font-size: .875rem; color: var(--text-secondary); max-width: 100%; }
  input[type=text]:focus, textarea:focus, select:focus { outline: none; border-color: var(--accent-blue); }
  /* The username field is disabled while editing — make that visible at a
     glance rather than only discoverable by clicking into it. */
  input[type=text]:disabled {
    opacity: 0.55; cursor: not-allowed;
    background: var(--bg-secondary); border-style: dashed;
  }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin-top: 1rem; }
  .row.tight { margin-top: 0; }
  button, .button {
    display: inline-block; padding: .5rem .875rem; border-radius: 4px; border: 1px solid var(--border);
    background: var(--bg-tertiary); color: var(--text-secondary);
    font: inherit; font-size: .875rem; cursor: pointer; text-decoration: none;
  }
  button:hover:not(:disabled), .button:hover { background: var(--bg-hover); color: var(--text-primary); }
  button:disabled { opacity: .5; cursor: default; }
  button.primary { background: var(--accent-green); border-color: var(--accent-green); color: #05140a; font-weight: 600; }
  button.danger:hover:not(:disabled) { border-color: var(--danger); color: var(--danger); }
  /* Second step of a two-step confirm: the button is now live. */
  button.armed, button.armed:hover:not(:disabled) {
    border-color: var(--danger); background: rgba(244, 67, 54, 0.16); color: var(--danger); font-weight: 600;
  }
  #btn-delete { color: var(--danger); margin-left: auto; }
  .field-hint { font-size: 0.75rem; color: var(--text-muted); margin-top: 0.375rem; max-width: 46ch; }
  .field-hint[hidden] { display: none; }
  .icon { padding: .25rem .5rem; font-size: .8125rem; }
  .entry {
    display: flex; align-items: flex-start; gap: .875rem; padding: .875rem;
    background: var(--bg-secondary); border: 1px solid var(--border);
    border-radius: 8px; margin-bottom: .625rem;
  }
  .entry .meta { flex: 1; min-width: 0; }
  .name { color: var(--text-primary); font-weight: 600; }
  .handle { color: var(--text-muted); font-size: .8125rem; }
  .entry .note { font-size: .875rem; margin-top: .25rem; }
  .tags { display: flex; gap: .375rem; flex-wrap: wrap; margin-top: .5rem; }
  .tag { font-size: .6875rem; text-transform: uppercase; letter-spacing: .04em;
         background: var(--bg-tertiary); color: var(--text-muted);
         padding: .125rem .5rem; border-radius: 999px; }
  .controls { display: flex; gap: .25rem; flex-shrink: 0; flex-wrap: wrap; justify-content: flex-end; }
  .status { min-height: 1.5rem; font-size: .875rem; margin-top: .875rem; }
  .status.error { color: var(--danger); }
  .status.ok { color: var(--accent-green); }
  .preview { display: flex; gap: .5rem; margin-top: .875rem; }
  .preview figure { flex: 1; }
  .preview img { width: 100%; border-radius: 4px; display: block; background: var(--bg-tertiary); aspect-ratio: 2/3; }
  .preview figcaption { font-size: .6875rem; color: var(--text-muted); margin-top: .25rem; }
  .empty { color: var(--text-muted); font-style: italic; }

  /* Tables scroll inside their own box so the page never scrolls sideways. */
  .table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: .8125rem; }
  th, td { text-align: left; padding: .5rem .625rem; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--text-muted); font-weight: 600; text-transform: uppercase; letter-spacing: .04em; font-size: .6875rem; white-space: nowrap; }
  tr:last-child td { border-bottom: 0; }
  td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.nowrap { white-space: nowrap; }
  td .controls { justify-content: flex-start; flex-wrap: nowrap; }
  .muted { color: var(--text-muted); }
  .pill { display: inline-block; font-size: .6875rem; font-weight: 600; text-transform: uppercase;
          letter-spacing: .04em; padding: .125rem .5rem; border-radius: 999px; white-space: nowrap; }
  .pill.ok { background: rgba(0, 224, 84, 0.14); color: var(--accent-green); }
  .pill.stale { background: rgba(244, 67, 54, 0.16); color: var(--danger); }
  .pill.never { background: var(--bg-tertiary); color: var(--text-secondary); }
  .pill.warn { background: rgba(255, 128, 0, 0.16); color: var(--accent-orange); }
  .summary { display: flex; gap: 1.25rem; flex-wrap: wrap; font-size: .875rem; margin-bottom: .75rem; }
  .summary b { color: var(--text-primary); font-variant-numeric: tabular-nums; }

  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: .75rem; margin-bottom: 1rem; }
  .grid .card { margin: 0; padding: .875rem 1rem; }
  .grid .card h2 { font-size: .6875rem; text-transform: uppercase; letter-spacing: .05em; color: var(--text-muted); font-weight: 600; }
  .grid .big { color: var(--text-primary); font-size: 1.125rem; font-weight: 600; margin: .25rem 0; overflow-wrap: anywhere; }
  .grid .card div { font-size: .8125rem; overflow-wrap: anywhere; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .8125em; color: var(--text-secondary); }
  .chips { display: flex; gap: .375rem; flex-wrap: wrap; }
  .chip { display: inline-flex; align-items: center; gap: .375rem; font-size: .8125rem;
          background: var(--bg-tertiary); color: var(--text-secondary);
          padding: .125rem .25rem .125rem .625rem; border-radius: 999px; }
  .chip.unused { opacity: .55; }
  .chip.moved { outline: 1px solid var(--accent-green); }
  .chip b { color: var(--text-muted); font-weight: 400; font-variant-numeric: tabular-nums; }
  .chip button { border: 0; background: none; padding: 0 .375rem; font-size: .875rem; line-height: 1.4; border-radius: 999px; }
  .cat-head { display: flex; gap: .75rem; align-items: baseline; justify-content: space-between; margin-bottom: .5rem; }
  .plan { margin-top: .875rem; font-size: .875rem; }
  .plan dt { color: var(--text-primary); font-weight: 600; margin-top: .5rem; }
  .plan dd { color: var(--text-secondary); overflow-wrap: anywhere; }
  .plan dt.removes { color: var(--danger); }

  dialog {
    width: min(860px, calc(100vw - 2rem)); max-height: calc(100vh - 2rem); margin: auto;
    background: var(--bg-primary); color: var(--text-secondary);
    border: 1px solid var(--border); border-radius: 8px; padding: 1.25rem;
  }
  dialog::backdrop { background: rgba(0, 0, 0, 0.6); }
  .dialog-head { display: flex; gap: .75rem; align-items: flex-start; justify-content: space-between; margin-bottom: .5rem; }
  #history-body { max-height: 50vh; overflow: auto; }
`;

const BODY = `
<div class="wrap">
  <h1>Letterboxd admin</h1>
  <p class="sub">The rolodex's curated profiles, plus the data pipeline and diary tag
     categories behind the rest of the site.</p>

  <div class="tabs" role="tablist">
    <button type="button" role="tab" data-tab="profiles" aria-selected="true">Profiles</button>
    <button type="button" role="tab" data-tab="health" aria-selected="false">Feed health</button>
    <button type="button" role="tab" data-tab="backup" aria-selected="false">Backup &amp; bulk</button>
    <button type="button" role="tab" data-tab="tags" aria-selected="false">Rolodex tags</button>
    <button type="button" role="tab" data-tab="pipeline" aria-selected="false">Pipeline</button>
    <button type="button" role="tab" data-tab="diary" aria-selected="false">Diary tags</button>
  </div>

  <section data-panel="profiles" class="narrow">
    <p class="hint">Sorted automatically by first name — display order isn't stored, so
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
  </section>

  <section data-panel="health" hidden>
    <div class="summary" id="health-summary"></div>
    <div class="row tight">
      <button type="button" id="btn-health-reload">Reload</button>
      <button type="button" id="btn-cron-run">Run current cron slice</button>
      <button type="button" id="btn-stats-purge">Purge /stats/live cache</button>
      <label class="inline"><input type="checkbox" id="health-problems" /> Problems only</label>
    </div>
    <p class="hint" id="health-hint"></p>
    <div class="status" id="health-status"></div>
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>Member</th><th>Status</th><th>Last fetched</th><th>Latest watch</th>
          <th class="num">History</th><th>Cron</th><th></th>
        </tr></thead>
        <tbody id="health-rows"><tr><td colspan="7" class="empty">Loading…</td></tr></tbody>
      </table>
    </div>
  </section>

  <section data-panel="backup" class="narrow" hidden>
    <div class="card">
      <h2>Back up</h2>
      <p class="hint">Downloads the curated list (handles, names, notes, tags) as JSON.
         <strong>It does not include anyone's stored history.</strong></p>
      <a class="button" id="btn-export" href="/admin/api/export" download>Download backup</a>
    </div>

    <div class="card">
      <h2>Restore from a backup</h2>
      <p class="hint"><strong>Merge</strong> adds new handles and overwrites the fields of ones
         already here. <strong>Add only</strong> never touches an existing entry.
         <strong>Replace</strong> makes the file the whole list: everyone not in it is removed
         and <strong>their stored history is deleted for good</strong>.</p>
      <div class="row tight">
        <input type="file" id="import-file" accept="application/json,.json" />
        <select id="import-mode" aria-label="Import mode">
          <option value="merge">Merge</option>
          <option value="add">Add only</option>
          <option value="replace">Replace</option>
        </select>
        <button type="button" id="btn-import-preview">Preview changes</button>
      </div>
      <div class="status" id="import-status"></div>
      <dl class="plan" id="import-plan"></dl>
      <div class="row">
        <button type="button" class="primary" id="btn-import-apply" disabled>Apply</button>
        <button type="button" id="btn-import-undo" hidden>Undo last import</button>
      </div>
      <p class="hint" id="undo-hint"></p>
    </div>

    <div class="card">
      <h2>Bulk add</h2>
      <p class="hint">One handle or profile URL per line (commas and spaces work too). Handles
         already in the rolodex are skipped. Feeds aren't checked here — look at Feed health
         afterwards.</p>
      <textarea id="bulk-handles" placeholder="michaellamb&#10;https://letterboxd.com/someone/"></textarea>
      <label for="bulk-tags">Tags for all of them (comma separated, optional)</label>
      <input type="text" id="bulk-tags" autocomplete="off" />
      <div class="row">
        <button type="button" id="btn-bulk-preview">Preview changes</button>
        <button type="button" class="primary" id="btn-bulk-apply" disabled>Add</button>
      </div>
      <div class="status" id="bulk-status"></div>
      <dl class="plan" id="bulk-plan"></dl>
    </div>
  </section>

  <section data-panel="tags" class="narrow" hidden>
    <p class="hint">Rename a tag on every profile that has it. Renaming onto a tag that
       already exists merges the two. Tags match exactly as typed, so two spellings show
       up as two rows.</p>
    <div class="status" id="tags-status"></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Tag</th><th class="num">Profiles</th><th>Rename or merge into</th><th></th></tr></thead>
        <tbody id="tag-rows"><tr><td colspan="4" class="empty">Loading…</td></tr></tbody>
      </table>
    </div>
  </section>

  <section data-panel="pipeline" hidden>
    <p class="hint">The stats, tags and rewatches pages are built by a GitHub workflow every six
       hours. This reads its state from GitHub; nothing here talks to Letterboxd.</p>
    <p class="status error" id="pipeline-token" hidden>No GITHUB_TOKEN is set on the Worker, so this
       tab is read-only: run and upload will be refused.</p>
    <div class="grid" id="pipeline-cards"><p class="empty">Loading…</p></div>
    <div class="row tight">
      <button type="button" id="btn-pipeline-reload">Reload</button>
      <button type="button" id="btn-pipeline-run">Run the pipeline now</button>
    </div>
    <div class="status" id="pipeline-status"></div>

    <div class="card narrow">
      <h2>Upload a watchlist export</h2>
      <p class="hint">Letterboxd's watchlist-only export
         (<code>watchlist-michaellamb-YYYY-MM-DD-HH-MM-utc.csv</code>). It is committed to
         <code>data/archive/</code> as-is; the pipeline then uses whichever snapshot is newest,
         this file or the last full export.</p>
      <div class="row tight">
        <input type="file" id="watchlist-file" accept=".csv,text/csv" />
        <button type="button" id="btn-watchlist-preview">Check file</button>
      </div>
      <dl class="plan" id="watchlist-plan"></dl>
      <div class="row">
        <button type="button" class="primary" id="btn-watchlist-apply" disabled>Commit to GitHub</button>
        <label class="inline"><input type="checkbox" id="watchlist-run" checked /> Run the pipeline afterwards</label>
      </div>
      <div class="status" id="watchlist-status"></div>
    </div>
  </section>

  <section data-panel="diary" hidden>
    <p class="hint">Which category each of your diary tags sits under on the Tags page
       (<code>data/tag_categories.json</code>). Anything not filed shows there under Other.
       Saving commits the file; the site updates when the deploy finishes, about a minute later.</p>
    <div class="row tight">
      <button type="button" class="primary" id="btn-diary-save" disabled>Save to GitHub</button>
      <button type="button" id="btn-diary-discard" disabled>Discard changes</button>
      <span class="muted" id="diary-pending"></span>
    </div>
    <div class="status" id="diary-status"></div>
    <div id="diary-body"><p class="empty">Loading…</p></div>
  </section>
</div>

<dialog id="history-dialog" aria-labelledby="history-title">
  <div class="dialog-head">
    <div>
      <h2 id="history-title">History</h2>
      <div class="muted" id="history-meta"></div>
    </div>
    <button type="button" id="btn-history-close">Close</button>
  </div>
  <div class="row tight">
    <a class="button" id="btn-history-download" href="#" download>Download JSON</a>
    <button type="button" class="danger" id="btn-history-reset">Reset history</button>
  </div>
  <p class="hint">Reset throws the stored entries away and starts again from what the
     feed shows now, so "since" moves forward. It can't be undone.</p>
  <div class="status" id="history-status"></div>
  <div class="table-wrap" id="history-body"></div>
</dialog>
`;

/* eslint-env browser */
function adminClient() {
  'use strict';

  var API = '/admin/api';
  var editing = null;
  var profilesCache = [];
  var healthData = null;
  var historyUser = null;
  var pendingImport = null;
  var pendingBulk = null;
  var pendingWatchlist = null;
  var diary = null;          // { sha, canWrite, categories, counts }
  var diaryOriginal = null;  // tag -> category id, as loaded
  var loaded = {};

  var el = function (id) { return document.getElementById(id); };

  // Safe in both text and attribute contexts.
  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function setStatus(id, message, kind) {
    var node = el(id);
    node.textContent = message || '';
    node.className = 'status' + (kind ? ' ' + kind : '');
  }

  async function api(path, options) {
    var res = await fetch(API + path, options || {});
    if (res.status === 204) return null;
    var body = await res.json().catch(function () { return {}; });
    if (!res.ok) {
      var err = new Error(body.error || ('HTTP ' + res.status));
      err.body = body;
      throw err;
    }
    return body;
  }

  function send(method, path, body) {
    return api(path, {
      method: method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    });
  }

  // Two-step confirm. The first click arms the button and returns false; a
  // second click within five seconds returns true.
  function disarm(button) {
    if (!button.dataset.armed) return;
    clearTimeout(button._armTimer);
    button.textContent = button.dataset.label;
    button.classList.remove('armed');
    delete button.dataset.armed;
  }

  function armed(button, label) {
    if (button.dataset.armed) {
      disarm(button);
      return true;
    }
    button.dataset.armed = '1';
    button.dataset.label = button.textContent;
    button.textContent = label || 'Click again to confirm';
    button.classList.add('armed');
    button._armTimer = setTimeout(function () { disarm(button); }, 5000);
    return false;
  }

  function splitList(text) {
    return String(text || '').split(/[\s,]+/).map(function (t) { return t.trim(); }).filter(Boolean);
  }

  function splitTags(text) {
    return String(text || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
  }

  function ago(iso) {
    if (!iso) return 'never';
    var minutes = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return minutes + 'm ago';
    var hours = Math.round(minutes / 60);
    if (hours < 48) return hours + 'h ago';
    return Math.round(hours / 24) + 'd ago';
  }

  function until(iso) {
    var minutes = Math.round((Date.parse(iso) - Date.now()) / 60000);
    if (minutes < 60) return 'in ' + Math.max(minutes, 0) + 'm';
    return 'in ' + Math.round(minutes / 60) + 'h';
  }

  /* ---------------------------------------------------------------------- */
  /* Tabs                                                                   */
  /* ---------------------------------------------------------------------- */

  var LOADERS = { health: loadHealth, backup: loadUndo, tags: loadTags, pipeline: loadPipeline, diary: loadDiary };

  function showTab(name, force) {
    var known = document.querySelector('[data-panel="' + name + '"]');
    if (!known) name = 'profiles';
    document.querySelectorAll('[data-panel]').forEach(function (panel) {
      panel.hidden = panel.dataset.panel !== name;
    });
    document.querySelectorAll('[data-tab]').forEach(function (tab) {
      tab.setAttribute('aria-selected', tab.dataset.tab === name ? 'true' : 'false');
    });
    if (LOADERS[name] && (force || !loaded[name])) {
      loaded[name] = true;
      LOADERS[name]();
    }
    if (location.hash.slice(1) !== name) history.replaceState(null, '', '#' + name);
  }

  document.querySelector('.tabs').addEventListener('click', function (event) {
    var tab = event.target.closest('[data-tab]');
    if (tab) showTab(tab.dataset.tab, true);
  });

  /* ---------------------------------------------------------------------- */
  /* Profiles                                                               */
  /* ---------------------------------------------------------------------- */

  function readForm() {
    return {
      username: el('f-username').value,
      displayName: el('f-display').value,
      note: el('f-note').value,
      tags: splitTags(el('f-tags').value)
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
    disarm(el('btn-delete'));
    el('username-hint').hidden = true;
    el('preview').innerHTML = '';
    setStatus('status', '');
  }

  async function load() {
    try {
      profilesCache = await api('/profiles');
      render(profilesCache);
    } catch (err) {
      el('list').innerHTML = '<p class="empty">Could not load: ' + esc(err.message) + '</p>';
    }
  }

  // Anything that changes the curated list makes the other tabs stale.
  function listChanged() {
    loaded.health = false;
    loaded.tags = false;
    return load();
  }

  function render(profiles) {
    if (!profiles.length) {
      el('list').innerHTML = '<p class="empty">No profiles yet.</p>';
      return;
    }
    el('list').innerHTML = profiles.map(function (p) {
      return '<div class="entry">' +
        '<div class="meta">' +
          '<div class="name">' + esc(p.displayName || p.username) + '</div>' +
          '<div class="handle">@' + esc(p.username) + '</div>' +
          (p.note ? '<div class="note">' + esc(p.note) + '</div>' : '') +
          (p.tags && p.tags.length
            ? '<div class="tags">' + p.tags.map(function (t) {
                return '<span class="tag">' + esc(t) + '</span>';
              }).join('') + '</div>'
            : '') +
        '</div>' +
        '<div class="controls">' +
          '<button class="icon" data-history="' + esc(p.username) + '">History</button>' +
          '<button class="icon" data-edit="' + esc(p.username) + '">Edit</button>' +
          '<button class="icon danger" data-delete="' + esc(p.username) + '" title="Remove">&times;</button>' +
        '</div>' +
      '</div>';
    }).join('');
  }

  async function removeProfile(username, button, after) {
    if (!armed(button, 'Remove @' + username + '?')) return;
    button.disabled = true;
    try {
      await api('/profiles/' + username, { method: 'DELETE' });
      after();
      await listChanged();
    } catch (err) {
      setStatus('status', err.message, 'error');
    } finally {
      button.disabled = false;
    }
  }

  el('list').addEventListener('click', function (event) {
    var button = event.target.closest('button');
    if (!button) return;

    if (button.dataset.delete) {
      var username = button.dataset.delete;
      removeProfile(username, button, function () {
        if (editing === username) resetForm();
        setStatus('status', 'Removed @' + username + '.', 'ok');
      });
    } else if (button.dataset.history) {
      openHistory(button.dataset.history);
    } else if (button.dataset.edit) {
      var profile = profilesCache.find(function (p) { return p.username === button.dataset.edit; });
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
      setStatus('status', '');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  });

  el('btn-preview').addEventListener('click', async function () {
    var username = el('f-username').value.trim();
    if (!username) return setStatus('status', 'Enter a username first.', 'error');
    setStatus('status', 'Fetching feed…');
    el('preview').innerHTML = '';
    try {
      var result = await send('POST', '/preview', { username: username });
      if (!result.films.length) {
        setStatus('status', 'Feed reachable, but no diary entries yet.', 'ok');
        return;
      }
      setStatus('status', 'Found @' + result.username + '.', 'ok');
      el('preview').innerHTML = result.films.map(function (film) {
        return '<figure>' +
          (film.poster ? '<img alt="" src="' + esc(film.poster) + '" />' : '<img alt="" />') +
          '<figcaption>' + esc(film.title) + '</figcaption>' +
        '</figure>';
      }).join('');
    } catch (err) {
      setStatus('status', err.message, 'error');
    }
  });

  el('btn-save').addEventListener('click', async function () {
    var payload = readForm();
    if (!payload.username.trim()) return setStatus('status', 'Username is required.', 'error');
    el('btn-save').disabled = true;
    try {
      var message;
      if (editing) {
        await send('PUT', '/profiles/' + editing, payload);
        message = 'Saved.';
      } else {
        var created = await send('POST', '/profiles', payload);
        message = 'Added @' + created.username + '.';
      }
      resetForm();
      setStatus('status', message, 'ok');
      await listChanged();
    } catch (err) {
      setStatus('status', err.message, 'error');
    } finally {
      el('btn-save').disabled = false;
    }
  });

  el('btn-cancel').addEventListener('click', resetForm);

  // Delete the entry being edited. The username is the KV key and so can't be
  // changed by an edit — this is the one-step path for fixing a wrong handle
  // without hunting for the row again.
  el('btn-delete').addEventListener('click', function () {
    if (!editing) return;
    var username = editing;
    removeProfile(username, el('btn-delete'), function () {
      resetForm();
      setStatus('status', 'Removed @' + username + '. Add it again with the corrected username.', 'ok');
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Feed health                                                            */
  /* ---------------------------------------------------------------------- */

  var STATUS_LABEL = { ok: 'OK', stale: 'Stale', never: 'Never fetched' };

  function healthRowHtml(row) {
    var h = row.history;
    return '<tr data-user="' + esc(row.username) + '">' +
      '<td><div class="name">' + esc(row.displayName) + '</div>' +
        '<div class="handle">@' + esc(row.username) + '</div></td>' +
      '<td><span class="pill ' + esc(row.status) + '">' + esc(STATUS_LABEL[row.status] || row.status) + '</span></td>' +
      '<td class="nowrap" title="' + esc(row.fetchedAt || '') + '">' + esc(ago(row.fetchedAt)) + '</td>' +
      '<td class="nowrap">' + (row.latestWatched ? esc(row.latestWatched) : '<span class="muted">none</span>') + '</td>' +
      '<td class="num nowrap">' +
        (h
          ? esc(h.logged) + ' <span class="muted">/ ' + esc(healthData.historyCap) + '</span>' +
            (row.nearCap ? ' <span class="pill warn">near cap</span>' : '') +
            '<div class="muted">since ' + esc(h.since) + '</div>'
          : '<span class="muted">none</span>') +
      '</td>' +
      '<td class="nowrap">slot ' + esc(row.slot) +
        '<div class="muted" title="' + esc(row.nextRefreshAt) + '">' + esc(until(row.nextRefreshAt)) + '</div></td>' +
      '<td><div class="controls">' +
        '<button class="icon" data-refresh="' + esc(row.username) + '">Refresh</button>' +
        '<button class="icon" data-clear="' + esc(row.username) + '" title="Delete this member\'s cached feed, snapshot and avatar">Clear</button>' +
        '<button class="icon" data-history="' + esc(row.username) + '">History</button>' +
      '</div></td>' +
    '</tr>';
  }

  function renderHealth() {
    if (!healthData) return;
    var c = healthData.counts;
    el('health-summary').innerHTML =
      '<span><b>' + esc(healthData.profiles.length) + '</b> members</span>' +
      '<span><b>' + esc(c.ok) + '</b> ok</span>' +
      '<span><b>' + esc(c.stale) + '</b> stale</span>' +
      '<span><b>' + esc(c.never) + '</b> never fetched</span>' +
      '<span><b>' + esc(c.nearCap) + '</b> near history cap</span>' +
      '<span>cron is on slot <b>' + esc(healthData.currentSlot) + '</b></span>';
    el('health-hint').textContent =
      'Stale means no successful fetch in ' + healthData.staleAfterHours + ' hours — the public card is ' +
      'showing an old snapshot. Refresh and Clear only reach the cache in the data centre that ' +
      'answers this request; other locations expire on their own within 15 minutes.';

    var problemsOnly = el('health-problems').checked;
    var rows = healthData.profiles.filter(function (row) {
      return !problemsOnly || row.status !== 'ok' || row.nearCap;
    });
    el('health-rows').innerHTML = rows.length
      ? rows.map(healthRowHtml).join('')
      : '<tr><td colspan="7" class="empty">' + (problemsOnly ? 'No problems.' : 'No profiles yet.') + '</td></tr>';
  }

  async function loadHealth() {
    try {
      healthData = await api('/health');
      renderHealth();
    } catch (err) {
      el('health-rows').innerHTML = '<tr><td colspan="7" class="empty">Could not load: ' + esc(err.message) + '</td></tr>';
    }
  }

  el('btn-health-reload').addEventListener('click', function () {
    setStatus('health-status', '');
    loadHealth();
  });
  el('health-problems').addEventListener('change', renderHealth);

  el('btn-cron-run').addEventListener('click', async function () {
    var button = el('btn-cron-run');
    button.disabled = true;
    setStatus('health-status', 'Running the current cron slice…');
    try {
      var r = await send('POST', '/cron/run', {});
      setStatus(
        'health-status',
        'Slot ' + r.slot + ': read ' + r.refreshed + ' of ' + r.total + ' members' +
          (r.failed.length ? '; could not reach ' + r.failed.join(', ') + '.' : '.'),
        r.failed.length ? 'error' : 'ok'
      );
      await loadHealth();
    } catch (err) {
      setStatus('health-status', err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  el('btn-stats-purge').addEventListener('click', async function () {
    try {
      var r = await send('POST', '/stats-live/purge', {});
      setStatus('health-status', r.purged ? 'Purged the /stats/live cache here.' : 'Nothing was cached here for /stats/live.', 'ok');
    } catch (err) {
      setStatus('health-status', err.message, 'error');
    }
  });

  el('health-rows').addEventListener('click', async function (event) {
    var button = event.target.closest('button');
    if (!button) return;
    var username;

    if (button.dataset.history) return openHistory(button.dataset.history);

    if (button.dataset.refresh) {
      username = button.dataset.refresh;
      button.disabled = true;
      setStatus('health-status', 'Fetching @' + username + '…');
      try {
        var r = await send('POST', '/profiles/' + username + '/refresh', {});
        if (r.ok) {
          healthData.profiles = healthData.profiles.map(function (row) {
            return row.username === username ? r.row : row;
          });
          setStatus('health-status', 'Refreshed @' + username + '.', 'ok');
          await loadHealth();
        } else {
          setStatus('health-status', '@' + username + ': ' + r.error + ' The card keeps its last snapshot.', 'error');
          button.disabled = false;
        }
      } catch (err) {
        setStatus('health-status', err.message, 'error');
        button.disabled = false;
      }
    } else if (button.dataset.clear) {
      username = button.dataset.clear;
      if (!armed(button, 'Clear?')) return;
      try {
        await send('POST', '/profiles/' + username + '/clear', {});
        setStatus('health-status', 'Cleared the cache, snapshot and avatar for @' + username + '. History is untouched.', 'ok');
        await loadHealth();
      } catch (err) {
        setStatus('health-status', err.message, 'error');
      }
    }
  });

  /* ---------------------------------------------------------------------- */
  /* History                                                                */
  /* ---------------------------------------------------------------------- */

  function renderHistory(data) {
    el('history-title').textContent = 'History — @' + data.username;
    el('history-meta').textContent = data.count
      ? data.count + ' of ' + data.cap + ' entries kept, since ' + data.since
      : 'Nothing stored yet.';
    el('btn-history-download').href = API + '/profiles/' + data.username + '/history?download=1';
    el('history-body').innerHTML = data.count
      ? '<table><thead><tr><th>Watched</th><th>Film</th><th class="num">Rating</th><th>Rewatch</th><th>First seen</th></tr></thead><tbody>' +
        data.entries.map(function (e) {
          return '<tr><td class="nowrap">' + esc(e.d) + '</td>' +
            '<td>' + esc(e.t) + (e.y ? ' <span class="muted">(' + esc(e.y) + ')</span>' : '') + '</td>' +
            '<td class="num">' + (e.r == null ? '<span class="muted">–</span>' : esc(e.r)) + '</td>' +
            '<td>' + (e.rw ? 'yes' : '') + '</td>' +
            '<td class="nowrap muted">' + esc(e.s) + '</td></tr>';
        }).join('') + '</tbody></table>'
      : '<p class="empty" style="padding:.75rem">No entries.</p>';
  }

  async function openHistory(username) {
    historyUser = username;
    disarm(el('btn-history-reset'));
    setStatus('history-status', '');
    el('history-title').textContent = 'History — @' + username;
    el('history-meta').textContent = 'Loading…';
    el('history-body').innerHTML = '';
    var dialog = el('history-dialog');
    if (!dialog.open) dialog.showModal();
    try {
      renderHistory(await api('/profiles/' + username + '/history'));
    } catch (err) {
      el('history-meta').textContent = '';
      setStatus('history-status', err.message, 'error');
    }
  }

  el('btn-history-close').addEventListener('click', function () { el('history-dialog').close(); });

  el('btn-history-reset').addEventListener('click', async function () {
    var button = el('btn-history-reset');
    if (!historyUser || !armed(button, 'Reset @' + historyUser + '’s history?')) return;
    button.disabled = true;
    try {
      var r = await api('/profiles/' + historyUser + '/history', { method: 'DELETE' });
      setStatus(
        'history-status',
        r.reseeded
          ? 'Reset. Reseeded with ' + r.history.logged + ' entries from the current feed.'
          : 'Reset. The feed could not be read, so it will reseed on the next successful fetch.',
        'ok'
      );
      loaded.health = false;
      renderHistory(await api('/profiles/' + historyUser + '/history'));
    } catch (err) {
      setStatus('history-status', err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Backup, restore, bulk add                                              */
  /* ---------------------------------------------------------------------- */

  function planHtml(plan) {
    function group(label, items, cls) {
      if (!items.length) return '';
      return '<dt' + (cls ? ' class="' + cls + '"' : '') + '>' + esc(label) + ' (' + items.length + ')</dt>' +
        '<dd>' + items.map(esc).join(', ') + '</dd>';
    }
    var invalid = plan.invalid.map(function (i) {
      return (i.value || '(blank)') + ' — ' + i.reason;
    });
    return '<dt>Result</dt><dd>' + esc(plan.before) + ' → ' + esc(plan.count) + ' profiles</dd>' +
      group('Added', plan.added) +
      group('Updated', plan.updated) +
      group('Removed, with their stored history', plan.removed, 'removes') +
      group('Skipped', invalid);
  }

  function changeCount(plan) {
    return plan.added.length + plan.updated.length + plan.removed.length;
  }

  // Shared by restore and bulk add: dry run first, show the diff, and only
  // then enable the button that writes.
  async function previewImport(request, ids) {
    var apply = el(ids.apply);
    disarm(apply);
    apply.disabled = true;
    el(ids.plan).innerHTML = '';
    setStatus(ids.status, 'Checking…');
    try {
      var plan = await send('POST', '/import', {
        mode: request.mode, profiles: request.profiles, dryRun: true
      });
      el(ids.plan).innerHTML = planHtml(plan);
      if (!changeCount(plan)) {
        setStatus(ids.status, 'Nothing would change.', 'ok');
        return null;
      }
      setStatus(ids.status, 'Nothing has been written yet. Review the changes, then apply.');
      apply.disabled = false;
      return { request: request, plan: plan };
    } catch (err) {
      if (err.body && err.body.added) el(ids.plan).innerHTML = planHtml(err.body);
      setStatus(ids.status, err.message, 'error');
      return null;
    }
  }

  async function applyImport(pending, ids) {
    var apply = el(ids.apply);
    if (!pending) return false;
    if (pending.plan.removed.length &&
        !armed(apply, 'Remove ' + pending.plan.removed.length + ' and delete their history?')) {
      return false;
    }
    apply.disabled = true;
    try {
      var result = await send('POST', '/import', {
        mode: pending.request.mode, profiles: pending.request.profiles, dryRun: false
      });
      el(ids.plan).innerHTML = planHtml(result);
      setStatus(
        ids.status,
        'Done: ' + result.added.length + ' added, ' + result.updated.length + ' updated, ' +
          result.removed.length + ' removed.',
        'ok'
      );
      await listChanged();
      await loadUndo();
      return true;
    } catch (err) {
      setStatus(ids.status, err.message, 'error');
      apply.disabled = false;
      return false;
    }
  }

  var IMPORT_IDS = { apply: 'btn-import-apply', plan: 'import-plan', status: 'import-status' };
  var BULK_IDS = { apply: 'btn-bulk-apply', plan: 'bulk-plan', status: 'bulk-status' };

  function invalidateImport() {
    pendingImport = null;
    disarm(el('btn-import-apply'));
    el('btn-import-apply').disabled = true;
  }
  el('import-file').addEventListener('change', invalidateImport);
  el('import-mode').addEventListener('change', invalidateImport);

  el('btn-import-preview').addEventListener('click', async function () {
    pendingImport = null;
    var file = el('import-file').files[0];
    if (!file) return setStatus('import-status', 'Choose a backup file first.', 'error');
    var parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch (err) {
      return setStatus('import-status', 'That file is not valid JSON.', 'error');
    }
    var profiles = Array.isArray(parsed) ? parsed : parsed && parsed.profiles;
    if (!Array.isArray(profiles)) {
      return setStatus('import-status', 'No "profiles" list found in that file.', 'error');
    }
    pendingImport = await previewImport({ mode: el('import-mode').value, profiles: profiles }, IMPORT_IDS);
  });

  el('btn-import-apply').addEventListener('click', async function () {
    if (await applyImport(pendingImport, IMPORT_IDS)) pendingImport = null;
  });

  function invalidateBulk() {
    pendingBulk = null;
    el('btn-bulk-apply').disabled = true;
  }
  el('bulk-handles').addEventListener('input', invalidateBulk);
  el('bulk-tags').addEventListener('input', invalidateBulk);

  el('btn-bulk-preview').addEventListener('click', async function () {
    pendingBulk = null;
    var handles = splitList(el('bulk-handles').value);
    if (!handles.length) return setStatus('bulk-status', 'Paste at least one handle.', 'error');
    var tags = splitTags(el('bulk-tags').value);
    var profiles = handles.map(function (h) { return { username: h, tags: tags }; });
    pendingBulk = await previewImport({ mode: 'add', profiles: profiles }, BULK_IDS);
  });

  el('btn-bulk-apply').addEventListener('click', async function () {
    if (await applyImport(pendingBulk, BULK_IDS)) {
      pendingBulk = null;
      el('bulk-handles').value = '';
    }
  });

  async function loadUndo() {
    var button = el('btn-import-undo');
    try {
      var prev = await api('/import/prev');
      button.hidden = !prev.available;
      el('undo-hint').textContent = prev.available
        ? 'Undo restores the list as it was before the last import (' + prev.count + ' profiles, saved ' +
          ago(prev.savedAt) + '). It brings back the entries, not deleted history — and anyone the ' +
          'undo takes off the list loses their stored history too.'
        : '';
    } catch (err) {
      button.hidden = true;
    }
  }

  el('btn-import-undo').addEventListener('click', async function () {
    var button = el('btn-import-undo');
    if (!armed(button, 'Put the previous list back?')) return;
    try {
      var r = await send('POST', '/import/undo', {});
      setStatus(
        'import-status',
        'Restored the previous list: ' + r.restored + ' profiles (was ' + r.replaced + ')' +
          (r.removed.length ? '. Removed with their history: ' + r.removed.join(', ') + '.' : '.'),
        'ok'
      );
      el('import-plan').innerHTML = '';
      await listChanged();
      await loadUndo();
    } catch (err) {
      setStatus('import-status', err.message, 'error');
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Tags                                                                   */
  /* ---------------------------------------------------------------------- */

  async function loadTags() {
    try {
      var tags = await api('/tags');
      el('tag-rows').innerHTML = tags.length
        ? tags.map(function (t) {
            return '<tr data-tag="' + esc(t.tag) + '">' +
              '<td><span class="tag">' + esc(t.tag) + '</span></td>' +
              '<td class="num">' + esc(t.count) + '</td>' +
              '<td><input type="text" aria-label="New name for ' + esc(t.tag) + '" placeholder="new name" maxlength="24" /></td>' +
              '<td><div class="controls">' +
                '<button class="icon" data-rename>Rename</button>' +
                '<button class="icon danger" data-remove>Remove</button>' +
              '</div></td></tr>';
          }).join('')
        : '<tr><td colspan="4" class="empty">No tags yet.</td></tr>';
    } catch (err) {
      el('tag-rows').innerHTML = '<tr><td colspan="4" class="empty">Could not load: ' + esc(err.message) + '</td></tr>';
    }
  }

  el('tag-rows').addEventListener('click', async function (event) {
    var button = event.target.closest('button');
    if (!button) return;
    var row = button.closest('tr');
    var from = row.dataset.tag;
    var to = '';

    if (button.dataset.rename !== undefined) {
      to = row.querySelector('input').value.trim();
      if (!to) return setStatus('tags-status', 'Type the new name first.', 'error');
    } else if (button.dataset.remove !== undefined) {
      if (!armed(button, 'Remove from all?')) return;
    } else {
      return;
    }

    try {
      var r = await send('POST', '/tags', { from: from, to: to });
      setStatus(
        'tags-status',
        (r.to ? 'Renamed "' + r.from + '" to "' + r.to + '"' : 'Removed "' + r.from + '"') +
          ' on ' + r.changed.length + ' profile' + (r.changed.length === 1 ? '' : 's') + '.',
        'ok'
      );
      await loadTags();
      loaded.health = false;
      await load();
    } catch (err) {
      setStatus('tags-status', err.message, 'error');
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Pipeline                                                               */
  /* ---------------------------------------------------------------------- */

  function link(url, text) {
    return url ? '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(text) + '</a>' : esc(text);
  }

  function card(title, big, lines) {
    return '<div class="card"><h2>' + esc(title) + '</h2><div class="big">' + big + '</div>' +
      lines.filter(Boolean).map(function (l) { return '<div>' + l + '</div>'; }).join('') + '</div>';
  }

  function runLine(label, run) {
    if (!run) return label + ': <span class="muted">none</span>';
    var state = run.status === 'completed' ? (run.conclusion || 'completed') : run.status;
    return label + ': ' + link(run.url, state) + ' <span class="muted">' + esc(ago(run.createdAt)) + '</span>';
  }

  function renderPipeline(p) {
    var cron = p.cron;
    var cronPill = cron.status === 'ok'
      ? '<span class="pill ok">Healthy</span>'
      : cron.status === 'late'
        ? '<span class="pill stale">Late</span>'
        : '<span class="pill stale">No recent success</span>';
    el('pipeline-token').hidden = p.canWrite;
    el('pipeline-cards').innerHTML =
      card('Data cron', cronPill, [
        cron.lastSuccessAt
          ? 'Last success ' + esc(ago(cron.lastSuccessAt))
          : 'No success in the last ' + esc(cron.checked) + ' runs',
        runLine('Last run', cron.lastRun),
        cron.failedSinceSuccess ? esc(cron.failedSinceSuccess) + ' failed since then' : '',
        cron.running ? 'A run is in progress' : '',
        '<span class="muted">Late after ' + esc(cron.lateAfterHours) + 'h without a success</span>'
      ]) +
      card('Site deploy', p.deploy
        ? '<span class="pill ' + (p.deploy.conclusion === 'success' ? 'ok' : p.deploy.status === 'completed' ? 'stale' : 'never') + '">' +
          esc(p.deploy.status === 'completed' ? p.deploy.conclusion : p.deploy.status) + '</span>'
        : '<span class="muted">none</span>', [
        runLine('Last run', p.deploy)
      ]) +
      card('Data', esc(p.data.totalWatched == null ? '?' : p.data.totalWatched) + ' logs', [
        'Latest watch ' + esc(p.data.latestWatched || 'unknown'),
        p.data.lastCommitAt ? link(p.data.lastCommitUrl, 'Last data commit') + ' <span class="muted">' + esc(ago(p.data.lastCommitAt)) + '</span>' : ''
      ]) +
      card('Letterboxd export', esc(p.archive.exportDate || 'none'), [
        p.archive.ageDays == null ? '' : esc(p.archive.ageDays) + (p.archive.ageDays === 1 ? ' day old' : ' days old'),
        esc(p.archive.rssOnly) + ' entr' + (p.archive.rssOnly === 1 ? 'y' : 'ies') + ' logged since, known from RSS only',
        '<span class="muted">Those have no tags until the next full export</span>'
      ]) +
      card('Watchlist', esc(p.watchlist.count == null ? '?' : p.watchlist.count) + ' films', [
        'Snapshot ' + esc(p.watchlist.snapshotDate || 'unknown'),
        '<span class="muted">' + esc(p.watchlist.snapshotSource || '') + '</span>'
      ]) +
      card('Rewatches page', p.rewatches.inSync
        ? '<span class="pill ok">In sync</span>'
        : '<span class="pill stale">Out of date</span>', [
        esc(p.rewatches.logs == null ? '?' : p.rewatches.logs) + ' logs in rewatches.json',
        p.rewatches.inSync ? '' : 'Does not match stats.json: the workflow may have stopped committing it'
      ]);
  }

  async function loadPipeline() {
    try {
      renderPipeline(await api('/pipeline'));
    } catch (err) {
      el('pipeline-cards').innerHTML = '<p class="empty">Could not load: ' + esc(err.message) + '</p>';
    }
  }

  el('btn-pipeline-reload').addEventListener('click', function () {
    setStatus('pipeline-status', '');
    loadPipeline();
  });

  el('btn-pipeline-run').addEventListener('click', async function () {
    var button = el('btn-pipeline-run');
    button.disabled = true;
    try {
      await send('POST', '/pipeline/run', {});
      setStatus('pipeline-status', 'Started. A run takes about a minute; reload to see it.', 'ok');
    } catch (err) {
      setStatus('pipeline-status', err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  function watchlistHtml(r) {
    return '<dt>File</dt><dd>' + esc(r.filename) + '</dd>' +
      '<dt>Films</dt><dd>' + esc(r.rows) + (r.currentCount == null ? '' : ' (the site shows ' + esc(r.currentCount) + ' now)') + '</dd>' +
      '<dt>Added between</dt><dd>' + esc(r.oldestAdded) + ' and ' + esc(r.newestAdded) + '</dd>' +
      (r.supersedes
        ? '<dt>Effect</dt><dd>Newer than the current snapshot (' + esc(r.currentSource || 'none') + '), so it becomes the watchlist.</dd>'
        : '<dt class="removes">No effect</dt><dd>The current snapshot (' + esc(r.currentSource) + ') is newer. Committing this would change nothing, so it is refused.</dd>');
  }

  function invalidateWatchlist() {
    pendingWatchlist = null;
    el('btn-watchlist-apply').disabled = true;
  }
  el('watchlist-file').addEventListener('change', invalidateWatchlist);

  el('btn-watchlist-preview').addEventListener('click', async function () {
    invalidateWatchlist();
    el('watchlist-plan').innerHTML = '';
    var file = el('watchlist-file').files[0];
    if (!file) return setStatus('watchlist-status', 'Choose the CSV first.', 'error');
    setStatus('watchlist-status', 'Checking…');
    try {
      var request = { filename: file.name, content: await file.text() };
      var report = await send('POST', '/pipeline/watchlist', {
        filename: request.filename, content: request.content, dryRun: true
      });
      el('watchlist-plan').innerHTML = watchlistHtml(report);
      if (!report.supersedes) return setStatus('watchlist-status', 'Nothing to commit.', 'error');
      pendingWatchlist = request;
      el('btn-watchlist-apply').disabled = false;
      setStatus('watchlist-status', 'Nothing has been committed yet.');
    } catch (err) {
      setStatus('watchlist-status', err.message, 'error');
    }
  });

  el('btn-watchlist-apply').addEventListener('click', async function () {
    if (!pendingWatchlist) return;
    var button = el('btn-watchlist-apply');
    button.disabled = true;
    try {
      var r = await send('POST', '/pipeline/watchlist', {
        filename: pendingWatchlist.filename,
        content: pendingWatchlist.content,
        dryRun: false,
        run: el('watchlist-run').checked
      });
      pendingWatchlist = null;
      setStatus(
        'watchlist-status',
        'Committed ' + r.filename + '.' + (r.dispatched
          ? ' The pipeline is running; the watchlist updates when it finishes.'
          : ' The watchlist updates on the next pipeline run.'),
        'ok'
      );
    } catch (err) {
      setStatus('watchlist-status', err.message, 'error');
      button.disabled = false;
    }
  });

  /* ---------------------------------------------------------------------- */
  /* Diary tag categories                                                   */
  /* ---------------------------------------------------------------------- */

  function diaryPlacement() {
    var where = {};
    diary.categories.forEach(function (c) {
      c.tags.forEach(function (t) { where[t] = c.id; });
    });
    return where;
  }

  function diaryMoved() {
    var now = diaryPlacement();
    var all = {};
    Object.keys(now).forEach(function (t) { all[t] = true; });
    Object.keys(diaryOriginal).forEach(function (t) { all[t] = true; });
    return Object.keys(all).filter(function (t) { return now[t] !== diaryOriginal[t]; });
  }

  function byCount(a, b) {
    return (diary.counts[b] || 0) - (diary.counts[a] || 0) || a.localeCompare(b);
  }

  function renderDiary() {
    var where = diaryPlacement();
    var moved = {};
    diaryMoved().forEach(function (t) { moved[t] = true; });
    var loose = Object.keys(diary.counts).filter(function (t) { return !where[t]; }).sort(byCount);
    var options = '<option value="">File under…</option>' + diary.categories.map(function (c) {
      return '<option value="' + esc(c.id) + '">' + esc(c.label) + '</option>';
    }).join('');

    var html = '<div class="card"><div class="cat-head"><h2>Other — not filed (' + loose.length + ')</h2></div>' +
      (loose.length
        ? '<div class="table-wrap"><table><thead><tr><th>Tag</th><th class="num">Logs</th><th>Category</th></tr></thead><tbody>' +
          loose.map(function (t) {
            return '<tr><td>' + esc(t) + (moved[t] ? ' <span class="pill warn">unfiled</span>' : '') + '</td>' +
              '<td class="num">' + esc(diary.counts[t]) + '</td>' +
              '<td><select data-file="' + esc(t) + '" aria-label="Category for ' + esc(t) + '">' + options + '</select></td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<p class="empty">Every tag is filed.</p>') +
      '</div>';

    html += diary.categories.map(function (c) {
      var tags = c.tags.slice().sort(byCount);
      var logs = tags.reduce(function (sum, t) { return sum + (diary.counts[t] || 0); }, 0);
      return '<div class="card"><div class="cat-head"><h2>' + esc(c.label) + '</h2>' +
        '<span class="muted">' + tags.length + (tags.length === 1 ? ' tag · ' : ' tags · ') + logs + ' logs</span></div>' +
        (tags.length
          ? '<div class="chips">' + tags.map(function (t) {
              var n = diary.counts[t] || 0;
              return '<span class="chip' + (n ? '' : ' unused') + (moved[t] ? ' moved' : '') + '"' +
                (n ? '' : ' title="No diary entry uses this tag"') + '>' + esc(t) + ' <b>' + n + '</b>' +
                '<button type="button" data-unfile="' + esc(t) + '" aria-label="Move ' + esc(t) + ' back to Other" title="Back to Other">&times;</button></span>';
            }).join('') + '</div>'
          : '<p class="empty">No tags.</p>') +
        '</div>';
    }).join('');

    el('diary-body').innerHTML = html;
    var count = diaryMoved().length;
    el('btn-diary-save').disabled = !count || !diary.canWrite;
    el('btn-diary-discard').disabled = !count;
    el('diary-pending').textContent = count
      ? count + ' tag' + (count === 1 ? '' : 's') + ' moved, not saved yet'
      : '';
  }

  async function loadDiary() {
    try {
      diary = await api('/tag-categories');
      diaryOriginal = diaryPlacement();
      renderDiary();
      if (!diary.canWrite) {
        setStatus('diary-status', 'No GITHUB_TOKEN is set on the Worker, so changes cannot be saved.', 'error');
      }
    } catch (err) {
      el('diary-body').innerHTML = '<p class="empty">Could not load: ' + esc(err.message) + '</p>';
    }
  }

  function unfile(tag) {
    diary.categories.forEach(function (c) {
      c.tags = c.tags.filter(function (t) { return t !== tag; });
    });
  }

  el('diary-body').addEventListener('change', function (event) {
    var select = event.target.closest('select[data-file]');
    if (!select || !select.value) return;
    var tag = select.dataset.file;
    unfile(tag);
    diary.categories.find(function (c) { return c.id === select.value; }).tags.push(tag);
    renderDiary();
  });

  el('diary-body').addEventListener('click', function (event) {
    var button = event.target.closest('button[data-unfile]');
    if (!button) return;
    unfile(button.dataset.unfile);
    renderDiary();
  });

  el('btn-diary-discard').addEventListener('click', function () {
    setStatus('diary-status', '');
    loadDiary();
  });

  el('btn-diary-save').addEventListener('click', async function () {
    var button = el('btn-diary-save');
    button.disabled = true;
    try {
      var r = await send('PUT', '/tag-categories', {
        sha: diary.sha,
        categories: diary.categories.map(function (c) { return { id: c.id, tags: c.tags }; })
      });
      setStatus(
        'diary-status',
        r.committed
          ? 'Committed: ' + r.moved.length + ' tag' + (r.moved.length === 1 ? '' : 's') + ' moved. The Tags page updates after the deploy.'
          : 'Nothing to save.',
        'ok'
      );
      await loadDiary();
    } catch (err) {
      setStatus('diary-status', err.message, 'error');
      button.disabled = false;
    }
  });

  /* ---------------------------------------------------------------------- */

  load();
  showTab(location.hash.slice(1) || 'profiles');
}

/** The script exactly as the page ships it. Exported so a test can parse it. */
function adminScript() {
  return 'var __name = function (fn) { return fn; };\n(' + adminClient.toString() + ')();';
}

function renderAdminPage() {
  // Colors mirror assets/css/dashboard.css so the admin feels like part of the site.
  return (
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
    '<meta charset="utf-8" />\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1" />\n' +
    '<title>Letterboxd admin</title>\n' +
    '<style>' + STYLE + '</style>\n</head>\n<body>' +
    BODY +
    '<script>\n' + adminScript() + '\n</script>\n</body>\n</html>'
  );
}

export { renderAdminPage, adminScript };
