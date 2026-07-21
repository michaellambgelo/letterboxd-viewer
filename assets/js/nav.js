/* Site nav — a subtle hamburger in the top right of the profile header.
 *
 * Rendered from here rather than duplicated into every page's markup: each page
 * only needs an empty `<div data-site-nav></div>` inside the header container.
 * Links are relative so they resolve both locally and under the
 * /letterboxd-viewer/ GitHub Pages base path.
 */

(function () {
  'use strict';

  // Hrefs are extension-less: GitHub Pages resolves /rolodex to rolodex.html.
  // They stay relative rather than root-absolute so they also work under the
  // /letterboxd-viewer/ base path that michaellambgelo.github.io still serves.
  //
  // Icon names are Font Awesome 5.15.4 (the vendored
  // assets/css/fontawesome-all.min.css) — FA6 names like fa-chart-simple or
  // fa-xmark render as blank boxes here.
  const LINKS = [
    { href: './', page: 'index', label: 'Stats', icon: 'fa-chart-bar' },
    { href: 'rolodex', page: 'rolodex', label: 'Rolodex', icon: 'fa-address-book' },
    {
      href: 'https://letterboxd.com/michaellamb/',
      label: 'Letterboxd',
      icon: 'fa-external-link-alt',
      external: true,
    },
  ];

  /**
   * Identity of the page being viewed, matched against LINKS[].page rather than
   * the href — the two no longer look alike. Tolerates every form the same page
   * can be reached by: "/", "/index", "/index.html", "/rolodex", "/rolodex.html",
   * and each of those under a base path.
   */
  function currentPage() {
    const last = window.location.pathname.split('/').pop();
    return last ? last.replace(/\.html$/, '') : 'index';
  }

  function init() {
    const mount = document.querySelector('[data-site-nav]');
    if (!mount) return;

    const here = currentPage();

    mount.className = 'site-nav';
    mount.innerHTML = `
      <button type="button" class="site-nav-toggle" id="site-nav-toggle"
              aria-expanded="false" aria-controls="site-nav-panel" aria-label="Open menu">
        <i class="fas fa-bars" aria-hidden="true"></i>
      </button>
      <nav id="site-nav-panel" class="site-nav-panel" aria-labelledby="site-nav-toggle" hidden>
        <ul>
          ${LINKS.map((link) => {
            const active = !link.external && link.page === here;
            return `
              <li>
                <a href="${link.href}"${link.external ? ' target="_blank" rel="noopener"' : ''}${
                  active ? ' aria-current="page"' : ''
                }>
                  <i class="fas ${link.icon}" aria-hidden="true"></i>
                  <span>${link.label}</span>
                </a>
              </li>`;
          }).join('')}
        </ul>
      </nav>
    `;

    const toggle = mount.querySelector('.site-nav-toggle');
    const panel = mount.querySelector('.site-nav-panel');

    function setOpen(open) {
      panel.hidden = !open;
      toggle.setAttribute('aria-expanded', String(open));
      toggle.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
      toggle.querySelector('i').className = open ? 'fas fa-times' : 'fas fa-bars';
      mount.classList.toggle('open', open);
      if (open) panel.querySelector('a')?.focus();
    }

    toggle.addEventListener('click', () => setOpen(panel.hidden));

    // Close on Escape, returning focus to the toggle so keyboard users aren't
    // stranded at the top of the document.
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !panel.hidden) {
        setOpen(false);
        toggle.focus();
      }
    });

    document.addEventListener('click', (event) => {
      if (!panel.hidden && !mount.contains(event.target)) setOpen(false);
    });

    // A tab that lands outside the menu closes it too.
    document.addEventListener('focusin', (event) => {
      if (!panel.hidden && !mount.contains(event.target)) setOpen(false);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
