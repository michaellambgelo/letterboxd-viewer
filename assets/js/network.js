/* Network page: who I follow, who follows me, and who among them is in
 * JXN Film Club.
 *
 * Static consumer of data/network.json, which scripts/compute_network.py
 * builds by hand from one-time exports (see CLAUDE.md). No Worker and no
 * Letterboxd requests.
 *
 * The data is anonymous: each node is just a relationship and a JXN flag, in
 * shuffled order, and edges are pairs of node indices. Nobody is named, and
 * the dots don't link anywhere.
 *
 * The graph is plain inline SVG with a fixed radial layout: me at the centre,
 * one ring per relationship. Nothing is simulated, so the picture is the same
 * on every load. Edges are drawn only when "followers you know" exports have
 * produced some.
 */

(function () {
  'use strict';

  const RELATIONS = {
    mutual: { label: 'Mutual', long: 'Follow each other', color: 'var(--accent-green)' },
    follower: { label: 'Follows me', long: "Follow me, I don't follow back", color: 'var(--accent-blue)' },
    following: { label: 'I follow', long: "I follow, they don't follow back", color: 'var(--rating-orange)' },
  };
  // Inner ring to outer.
  const RINGS = [
    { relation: 'mutual', r: 120 },
    { relation: 'follower', r: 200 },
    { relation: 'following', r: 270 },
  ];
  const TABS = [
    { id: 'all', label: 'Everyone' },
    { id: 'follower', label: 'Followers' },
    { id: 'following', label: 'Following' },
    { id: 'mutual', label: 'Mutual' },
  ];

  const state = { tab: 'all', jxnOnly: false };
  let data = null;

  const $ = (id) => document.getElementById(id);

  // A person is "in" a tab by their relationship to me. Followers and
  // Following each include the mutuals, like Letterboxd's own tabs.
  function inTab(p, tab) {
    if (tab === 'all') return true;
    if (tab === 'mutual') return p.relation === 'mutual';
    if (tab === 'follower') return p.relation !== 'following';
    if (tab === 'following') return p.relation !== 'follower';
    return false;
  }

  // ---- stats ---------------------------------------------------------------

  function renderStats() {
    const c = data.counts;
    const card = (value, label, cls = '') =>
      `<div class="stat-card"><div class="stat-value ${cls}">${value}</div><div class="stat-label">${label}</div></div>`;
    $('network-stats').innerHTML = [
      card(c.followers, 'Followers', 'accent-blue'),
      card(c.following, 'Following', 'accent-orange'),
      card(c.mutual, 'Mutual', 'accent-green'),
      card(c.jxn, 'In JXN Film Club'),
    ].join('');
    $('network-exported').textContent = window.LBV.formatShortDate(data.exportedAt, {
      month: 'long', day: 'numeric', year: 'numeric',
    }) || 'recently';
  }

  // ---- graph ---------------------------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const VIEW = 600;
  const C = VIEW / 2;

  function layout() {
    const pos = new Map();
    for (const ring of RINGS) {
      // File order (shuffled by compute_network.py), starting at 12 o'clock.
      // Club members aren't grouped: bunching them made their larger dots
      // overlap into one blob.
      const members = data.nodes.map((p, id) => ({ ...p, id })).filter((p) => p.relation === ring.relation);
      const step = (2 * Math.PI) / Math.max(members.length, 1);
      members.forEach((p, i) => {
        const a = -Math.PI / 2 + i * step;
        pos.set(p.id, { x: C + ring.r * Math.cos(a), y: C + ring.r * Math.sin(a), p });
      });
    }
    return pos;
  }

  function el(name, attrs, parent) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, v);
    if (parent) parent.appendChild(node);
    return node;
  }

  function renderGraph() {
    const pos = layout();
    const svg = el('svg', {
      viewBox: `0 0 ${VIEW} ${VIEW}`,
      class: 'network-svg',
      role: 'img',
      'aria-label': `Radial chart: ${data.counts.mutual} mutual follows in the inner ring, ` +
        `${data.counts.followerOnly} followers-only in the middle ring, ` +
        `${data.counts.followingOnly} following-only in the outer ring; ` +
        `${data.counts.jxn} JXN Film Club members highlighted.`,
    });

    for (const ring of RINGS) {
      el('circle', { cx: C, cy: C, r: ring.r, class: 'network-ring' }, svg);
    }

    const edgeLayer = el('g', { class: 'network-edges' }, svg);
    for (const [a, b] of data.edges || []) {
      const pa = pos.get(a);
      const pb = pos.get(b);
      if (!pa || !pb) continue;
      // Bow each edge toward the centre so chords don't stack on the rings.
      const mx = (pa.x + pb.x) / 2;
      const my = (pa.y + pb.y) / 2;
      const qx = mx + (C - mx) * 0.5;
      const qy = my + (C - my) * 0.5;
      el('path', {
        d: `M${pa.x.toFixed(1)},${pa.y.toFixed(1)} Q${qx.toFixed(1)},${qy.toFixed(1)} ${pb.x.toFixed(1)},${pb.y.toFixed(1)}`,
        'data-a': a,
        'data-b': b,
      }, edgeLayer);
    }

    const nodeLayer = el('g', { class: 'network-nodes' }, svg);
    // Club members are drawn last so they sit on top.
    const ordered = [...pos.values()].sort((x, y) => Number(x.p.jxn) - Number(y.p.jxn));
    for (const { x, y, p } of ordered) {
      const link = el('g', { 'data-id': p.id }, nodeLayer);
      el('title', {}, link).textContent = `${RELATIONS[p.relation].long}${p.jxn ? ' · JXN Film Club' : ''}`;
      el('circle', {
        cx: x.toFixed(1),
        cy: y.toFixed(1),
        r: p.jxn ? 7 : 3.5,
        class: `network-node network-node--${p.relation}${p.jxn ? ' is-jxn' : ''}`,
      }, link);
    }

    // Me.
    el('circle', { cx: C, cy: C, r: 34, class: 'network-me-bg' }, svg);
    el('image', {
      href: 'assets/images/letterboxd-decal-dots-rgb.svg',
      x: C - 24, y: C - 24, width: 48, height: 48,
    }, svg);

    $('network-graph').replaceChildren(svg);

    const ringItems = RINGS.map(({ relation }) => {
      const r = RELATIONS[relation];
      const n = data.nodes.filter((p) => p.relation === relation).length;
      return `<li><span class="network-swatch" style="background:${r.color}"></span>${r.long} <strong>${n}</strong></li>`;
    });
    ringItems.push(
      `<li><span class="network-swatch network-swatch--jxn"></span>JXN Film Club <strong>${data.counts.jxn}</strong></li>`
    );
    if (data.counts.edges) {
      ringItems.push(`<li><span class="network-swatch network-swatch--edge"></span>Follows someone else here <strong>${data.counts.edges}</strong></li>`);
    }
    $('network-legend').innerHTML =
      `<ul>${ringItems.join('')}</ul><p>Inner ring to outer: mutual, followers only, following only. Each dot is one person; nobody is named.</p>`;
  }

  // Dim every dot outside the current tab and toggle.
  function syncGraph() {
    const on = (p) => inTab(p, state.tab) && (!state.jxnOnly || p.jxn);
    document.querySelectorAll('#network-graph g[data-id]').forEach((g) => {
      g.classList.toggle('is-dim', !on(data.nodes[g.dataset.id]));
    });
    document.querySelectorAll('#network-graph path[data-a]').forEach((path) => {
      path.classList.toggle('is-dim', !(on(data.nodes[path.dataset.a]) && on(data.nodes[path.dataset.b])));
    });
  }

  function renderTabs() {
    $('network-tabs').innerHTML = TABS.map((t) => {
      const n = data.nodes.filter((p) => inTab(p, t.id)).length;
      const on = t.id === state.tab;
      return `<button type="button" role="tab" data-tab="${t.id}" aria-selected="${on}" tabindex="${on ? 0 : -1}">` +
        `${t.label} <span class="network-tab-count">${n}</span></button>`;
    }).join('');
  }

  function bind() {
    const tabs = $('network-tabs');
    tabs.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-tab]');
      if (!btn) return;
      state.tab = btn.dataset.tab;
      renderTabs();
      syncGraph();
      tabs.querySelector(`[data-tab="${state.tab}"]`).focus();
    });
    // Arrow keys move between tabs (WAI-ARIA tabs pattern).
    tabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const i = TABS.findIndex((t) => t.id === state.tab);
      const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
      tabs.querySelector(`[data-tab="${next.id}"]`).click();
      e.preventDefault();
    });
    $('network-jxn-only').addEventListener('change', (e) => { state.jxnOnly = e.target.checked; syncGraph(); });
  }

  async function init() {
    try {
      const res = await fetch('data/network.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
    } catch (err) {
      $('network-legend').textContent = 'Could not load the network data.';
      console.error('[network]', err);
      return;
    }
    renderStats();
    renderGraph();
    renderTabs();
    bind();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
