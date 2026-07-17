/**
 * App shell — navigation chrome and view mounting.
 *
 * Views are plain functions returning a DOM node. Before a view is replaced we fire a
 * `lumen:teardown` event on it, which is how every view detaches its listeners and
 * observers. That one convention is what keeps a framework-free app from leaking.
 */

import { h, fill, icon, logo, $ } from '../util/dom.js';
import { state, on } from '../core/store.js';
import { go } from '../core/router.js';
import { homeView } from './home.js';
import { libraryView } from './library.js';
import { searchView } from './search.js';
import { importView } from './import.js';
import { readerView } from './reader.js';
import { settingsView } from './settings.js';
import { player } from './player.js';
import { sheet } from './kit.js';

const NAV = [
  { id: 'home', label: 'Home', icon: 'home', path: '/' },
  { id: 'library', label: 'Library', icon: 'library', path: '/library' },
  { id: 'import', label: 'Add', icon: 'add', path: '/import' },
  { id: 'search', label: 'Search', icon: 'search', path: '/search' },
];

const VIEWS = {
  home: homeView,
  library: libraryView,
  search: searchView,
  import: importView,
  reader: readerView,
  settings: settingsView,
};

let currentView = null;

export function mountShell() {
  const main = h('main.main', { id: 'main', tabIndex: -1 });

  const rail = h('nav.rail', { 'aria-label': 'Main' },
    h('div.rail__brand', null, logo(34)),
    ...NAV.map((n) => railItem(n)),
    h('div.rail__spacer'),
    h('button.rail__item', { onclick: () => go('/settings'), 'aria-label': 'Settings' },
      icon('settings', 21), h('span', null, 'Settings')));

  const tabbar = h('nav.tabbar.glass', { 'aria-label': 'Main' },
    ...NAV.map((n) => tabItem(n)),
    h('button.tabbar__item', {
      onclick: () => go('/settings'),
      'aria-label': 'Settings',
    }, icon('settings', 20), h('span', null, 'More')));

  const app = h('div.app', null, rail, main);

  document.body.append(
    h('a.skip-link', { href: '#main' }, 'Skip to content'),
    app,
    tabbar,
  );

  const paint = () => {
    const { name } = state.route;

    // Tear down the outgoing view so its listeners and observers go with it.
    if (currentView) {
      currentView.dispatchEvent(new CustomEvent('lumen:teardown'));
      for (const el of currentView.querySelectorAll('*')) {
        el.dispatchEvent(new CustomEvent('lumen:teardown'));
      }
    }

    const view = (VIEWS[name] || homeView)();
    currentView = view;
    fill(main, view);

    // The reader is a full-bleed surface: no rail, no tab bar competing with the text.
    const immersive = name === 'reader';
    rail.style.display = immersive ? 'none' : '';
    tabbar.style.display = immersive ? 'none' : '';
    main.style.paddingBottom = immersive ? '0' : '';

    for (const el of [...rail.children, ...tabbar.children]) {
      const path = el.dataset.path;
      if (!path) continue;
      const active = path === '/' ? name === 'home' : name === path.slice(1);
      el.setAttribute('aria-current', active ? 'page' : 'false');
    }

    // A route change is a page change; put the keyboard and the screen reader at the top.
    if (name !== 'reader') scrollTo({ top: 0, behavior: 'instant' });
    main.focus({ preventScroll: true });

    // The mini player floats above the tab bar; it hides itself in the reader, which
    // has its own controls.
    if (player.el) player.el.classList.toggle('is-hidden', immersive);
  };

  on('route', paint);
  paint();
  bindKeys();
  return { main };
}

function railItem(n) {
  return h('button.rail__item', {
    dataset: { path: n.path },
    onclick: () => go(n.path),
    'aria-label': n.label,
  }, icon(n.icon, 21), h('span', null, n.label));
}

function tabItem(n) {
  return h('button.tabbar__item', {
    dataset: { path: n.path },
    onclick: () => go(n.path),
    'aria-label': n.label,
  }, icon(n.icon, 20), h('span', null, n.label));
}

/* ------------------------------ Keyboard ------------------------------ */

/**
 * Global shortcuts. Ignored while typing, so `/` in a search field is a slash.
 * Two-key sequences (g h, g l) follow the convention people already know from Gmail
 * and GitHub.
 */
function bindKeys() {
  let chord = null;
  let chordTimer = null;

  addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /input|textarea|select/i.test(t.tagName))) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    if (chord === 'g') {
      clearTimeout(chordTimer);
      chord = null;
      const map = { h: '/', l: '/library', s: '/search', i: '/import', c: '/settings' };
      if (map[e.key.toLowerCase()]) {
        e.preventDefault();
        go(map[e.key.toLowerCase()]);
      }
      return;
    }

    switch (e.key) {
      case 'g':
        chord = 'g';
        chordTimer = setTimeout(() => { chord = null; }, 900);
        break;

      case '/':
        e.preventDefault();
        go('/search');
        break;

      case '?':
        e.preventDefault();
        go('/settings/access');
        break;

      case 'n':
      case 'N':
        e.preventDefault();
        go('/import');
        break;

      case ' ':
        if (state.player.docId) {
          e.preventDefault();
          player.toggle();
        }
        break;

      case 'ArrowRight':
        if (state.player.docId) {
          e.preventDefault();
          player.next();
        }
        break;

      case 'ArrowLeft':
        if (state.player.docId) {
          e.preventDefault();
          player.prev();
        }
        break;

      case 'ArrowDown':
        if (state.player.docId) {
          e.preventDefault();
          player.skipPara(1);
        }
        break;

      case 'ArrowUp':
        if (state.player.docId) {
          e.preventDefault();
          player.skipPara(-1);
        }
        break;

      case 'j':
      case 'J':
        if (state.player.docId) player.setRate(Math.max(0.5, Math.round((state.settings.rate - 0.25) * 100) / 100));
        break;

      case 'l':
      case 'L':
        if (state.player.docId) player.setRate(Math.min(4, Math.round((state.settings.rate + 0.25) * 100) / 100));
        break;

      case 'f':
      case 'F':
        if (state.route.name === 'reader') {
          const { setSetting } = state.settings;
          void setSetting;
          import('../core/store.js').then(({ setSetting: s }) => s('focusMode', !state.settings.focusMode));
        }
        break;

      case 'Escape':
        if (state.route.name === 'reader') go('/library');
        break;

      default:
        break;
    }
  });
}

/** Offline / update notices live here so no single view owns them. */
export function bindStatus() {
  on('online', () => {
    if (!state.online) {
      import('./kit.js').then(({ toast }) =>
        toast('You’re offline. Your library still works.', 'info'));
    }
  });

  on('busy', () => {
    let bar = $('#busy');
    if (!state.busy) return bar?.remove();

    if (!bar) {
      bar = h('div#busy', {
        role: 'status',
        'aria-live': 'polite',
        style: {
          position: 'fixed', left: '50%', translate: '-50% 0', top: 'calc(env(safe-area-inset-top) + 12px)',
          zIndex: '95', display: 'flex', alignItems: 'center', gap: 'var(--sp-3)',
          padding: 'var(--sp-3) var(--sp-4)', borderRadius: 'var(--r-full)',
          background: 'var(--surface-solid)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-3)',
          minWidth: '240px', maxWidth: 'calc(100vw - 24px)',
        },
      });
      document.body.append(bar);
    }

    const { label, pct } = state.busy;
    fill(bar,
      h('div.spin', { style: { flex: 'none' } }),
      h('div', { style: { flex: '1', minWidth: '0' } },
        h('div.small', { style: { fontWeight: '600', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' } }, label),
        pct != null && h('div.bar', { style: { marginTop: '4px' } },
          h('div.bar__fill', { style: { width: `${pct}%` } }))),
      pct != null && h('span.small.muted', { style: { fontVariantNumeric: 'tabular-nums' } }, `${pct}%`));
  });
}

void sheet;
