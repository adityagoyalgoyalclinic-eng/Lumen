/**
 * Global search screen.
 *
 * Results update as you type, debounced to one search per animation frame's worth of
 * typing (120 ms) so a fast typist doesn't queue up eight index scans.
 */

import { h, fill, icon } from '../util/dom.js';
import { go } from '../core/router.js';
import { search, suggestions, build as buildIndex } from '../services/search.js';
import { docRow } from './doc-card.js';
import { empty, KIND_LABEL } from './kit.js';

const SCOPES = [
  { id: 'all', label: 'Everything' },
  { id: 'documents', label: 'Documents' },
  { id: 'books', label: 'Books' },
  { id: 'articles', label: 'Articles' },
  { id: 'websites', label: 'Websites' },
  { id: 'scans', label: 'Scans' },
  { id: 'notes', label: 'Notes' },
  { id: 'highlights', label: 'Highlights' },
  { id: 'ocr', label: 'Scanned text' },
];

export function searchView() {
  let scope = 'all';
  let query = '';
  let token = 0;

  const input = h('input', {
    type: 'search',
    placeholder: 'Search documents, notes, highlights…',
    'aria-label': 'Search',
    autocomplete: 'off',
    spellcheck: false,
    oninput: (e) => {
      query = e.target.value;
      debounce();
    },
    onkeydown: (e) => {
      if (e.key === 'Escape') {
        if (input.value) {
          input.value = '';
          query = '';
          run();
        } else go('/');
      }
      if (e.key === 'Enter') {
        const first = results.querySelector('button');
        first?.click();
      }
    },
  });

  const results = h('div.col', { role: 'region', 'aria-live': 'polite', 'aria-busy': 'false' });
  const count = h('p.small.muted');

  const chips = h('div.chips', { style: { marginBlock: 'var(--sp-4)' } },
    ...SCOPES.map((s) =>
      h('button.chip', {
        'aria-pressed': String(s.id === scope),
        onclick: (e) => {
          scope = s.id;
          [...chips.children].forEach((c) => c.setAttribute('aria-pressed', 'false'));
          e.currentTarget.setAttribute('aria-pressed', 'true');
          run();
        },
      }, s.label)));

  let timer = null;
  const debounce = () => {
    clearTimeout(timer);
    timer = setTimeout(run, 120);
  };

  async function run() {
    const q = query.trim();
    const mine = ++token;
    count.textContent = '';

    if (q.length < 2) {
      const recent = await suggestions(6);
      if (mine !== token) return;
      fill(results,
        recent.length
          ? h('div.col', null,
              h('p.small.muted', null, 'Recent'),
              ...recent.map((d) => docRow(d, { where: KIND_LABEL[d.kind] || d.kind })))
          : empty('search', 'Search your library', 'Find anything by title, content, note, highlight, or scanned text.'));
      return;
    }

    results.setAttribute('aria-busy', 'true');
    const hits = await search(q, { scope });
    if (mine !== token) return;
    results.setAttribute('aria-busy', 'false');

    if (!hits.length) {
      fill(results, empty('search', `No matches for "${q}"`,
        scope === 'all' ? 'Try a different word, or check the spelling.' : 'Try widening the filter to Everything.'));
      return;
    }

    count.textContent = `${hits.length} result${hits.length === 1 ? '' : 's'}`;
    fill(results, ...hits.map((r) => docRow(r, { snippet: r.snippet, where: r.where })));
  }

  const root = h('div.wrap',
    null,
    h('header.topbar', null,
      h('div.topbar__row', null,
        h('button.icon-btn', { onclick: () => go('/'), 'aria-label': 'Back' }, icon('chevL', 20)),
        h('h1.topbar__title', null, 'Search')),
      h('div.search', { style: { marginTop: 'var(--sp-3)' } },
        icon('search', 19),
        input,
        h('button.icon-btn', {
          style: { width: '32px', height: '32px' },
          'aria-label': 'Clear',
          onclick: () => {
            input.value = '';
            query = '';
            input.focus();
            run();
          },
        }, icon('close', 16)))),
    chips,
    count,
    results,
  );

  // Index build is async; kick it off now so the first keystroke isn't the one paying.
  buildIndex().then(run);
  requestAnimationFrame(() => input.focus());

  root.addEventListener('lumen:teardown', () => clearTimeout(timer));
  return root;
}
