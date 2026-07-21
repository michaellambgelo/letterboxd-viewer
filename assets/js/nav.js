/* Site nav — a subtle hamburger in the top right of the profile header.
 *
 * Rendered from here rather than duplicated into every page's markup: each page
 * only needs an empty `<div data-site-nav></div>` inside the header container.
 * Links are relative so they resolve both locally and under the
 * /letterboxd-viewer/ GitHub Pages base path.
 */

(function () {
  'use strict';

  // Icon names are Font Awesome 5.15.4 (the vendored
  // assets/css/fontawesome-all.min.css) — FA6 names like fa-chart-simple or
  // fa-xmark render as blank boxes here.
  const LINKS = [
    { href: 'index.html', label: 'Stats', icon: 'fa-chart-bar' },
    { href: 'rolodex.html', label: 'Rolodex', icon: 'fa-address-book' },
    {
      href: 'https://letterboxd.com/michaellamb/',
      label: 'Letterboxd',
      icon: 'fa-external-link-alt',
      external: true,
    },
  ];

  function currentPage() {
    const file = window.location.pathname.split('/').pop();
    return file === '' ? 'index.html' : file;
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
            const active = !link.external && link.href === here;
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
