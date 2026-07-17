/**
 * Home.
 *
 * Ordered by what someone actually opens the app to do: resume the thing they were
 * listening to, start something new, then browse. Sections that are empty are omitted
 * entirely rather than rendered as sad placeholders — a new user sees a focused
 * onboarding, not eight empty shelves.
 */

import { h, fill, icon, logo } from '../util/dom.js';
import { state, on, refreshDocs } from '../core/store.js';
import { go } from '../core/router.js';
import * as db from '../core/db.js';
import { docCard, docMenuItems } from './doc-card.js';
import { sheet, empty, ago, toast, confirm as confirmDlg } from './kit.js';
import { readMinutes, listenSeconds } from '../util/text.js';
import { openExport } from './export-sheet.js';
import { invalidate } from '../services/search.js';

export function homeView() {
  const root = h('div.wrap');
  const render = () => fill(root, ...build());
  render();
  const off = on('docs', render);
  root.addEventListener('lumen:teardown', off);
  refreshDocs();
  return root;
}

function build() {
  const docs = state.docs.filter((d) => !d.trashed);
  const name = state.user?.name?.split(' ')[0];

  if (!docs.length) return [hero(), onboarding()];

  const out = [hero(), quickActions()];

  const continueReading = docs
    .filter((d) => d.progress > 0.01 && d.progress < 0.985)
    .sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))
    .slice(0, 8);

  if (continueReading.length) {
    out.push(section('Continue reading', continueReading.length > 3 ? { label: 'Library', fn: () => go('/library') } : null,
      h('div.rail-h', null, ...continueReading.map((d) => continueCard(d)))));
  }

  const pinned = docs.filter((d) => d.pinned);
  if (pinned.length) out.push(grid('Pinned', pinned));

  const listened = docs
    .filter((d) => d.listenedMs > 0)
    .sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))
    .slice(0, 6);
  if (listened.length) out.push(grid('Recently listened', listened));

  const files = docs.filter((d) => !['web', 'clip'].includes(d.kind)).slice(0, 6);
  if (files.length) out.push(grid('Recent files', files, { fn: () => go('/library/documents') }));

  const sites = docs.filter((d) => d.kind === 'web').slice(0, 6);
  if (sites.length) out.push(grid('Recent websites', sites, { fn: () => go('/library/websites') }));

  const favs = docs.filter((d) => d.fav).slice(0, 6);
  if (favs.length) out.push(grid('Favourites', favs, { fn: () => go('/library/favorites') }));

  const collections = [...new Set(docs.flatMap((d) => d.collections || []))];
  if (collections.length) out.push(collectionsRow(collections, docs));

  const rec = recommend(docs);
  if (rec.length) out.push(recommendations(rec));

  void name;
  return out;
}

/* ------------------------------ Pieces ------------------------------ */

function hero() {
  const hour = new Date().getHours();
  const greet = hour < 5 ? 'Still up' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const name = state.user?.name?.split(' ')[0];

  return h(
    'header',
    { style: { paddingTop: 'calc(env(safe-area-inset-top) + var(--sp-5))' } },
    h(
      'div.row',
      { style: { marginBottom: 'var(--sp-4)' } },
      h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
        logo(30),
        h('span', { style: { fontWeight: '750', letterSpacing: '-0.04em', fontSize: 'var(--step-1)' } }, 'Lumen')),
      h('div.spacer'),
      !state.online && h('span.badge.badge--warn', { title: 'You are offline' }, icon('offline', 12), 'Offline'),
      h('button.icon-btn', { onclick: () => go('/settings'), 'aria-label': 'Settings' },
        state.user?.name
          ? h('span', {
              style: {
                display: 'grid', placeItems: 'center', width: '32px', height: '32px', borderRadius: '50%',
                background: 'var(--accent)', color: 'var(--accent-ink)', fontSize: '13px', fontWeight: '700',
              },
            }, state.user.name[0].toUpperCase())
          : icon('settings', 21)),
    ),
    h('h1', { style: { fontSize: 'var(--step-3)', marginBottom: '4px' } },
      name ? `${greet}, ${name}.` : `${greet}.`),
    h('p.muted', { style: { marginBottom: 'var(--sp-4)' } }, 'What would you like to listen to?'),
    searchBar(),
  );
}

function searchBar() {
  return h(
    'button.search',
    {
      onclick: () => go('/search'),
      style: { width: '100%', textAlign: 'left', cursor: 'text' },
      'aria-label': 'Search your library',
    },
    icon('search', 19),
    h('span.muted', { style: { flex: '1' } }, 'Search documents, notes, highlights…'),
    h('span.kbd', { style: { opacity: '0.7' } }, '/'),
  );
}

const QUICK = [
  { icon: 'link', label: 'Website', to: '/import?tab=url' },
  { icon: 'doc', label: 'File', to: '/import?tab=file' },
  { icon: 'clip', label: 'Paste', to: '/import?tab=paste' },
  { icon: 'camera', label: 'Scan', to: '/import?tab=scan' },
];

function quickActions() {
  return h(
    'section.section',
    null,
    h(
      'div',
      { style: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--sp-3)' } },
      ...QUICK.map((q) =>
        h('button.qa', { onclick: () => go(q.to) },
          h('span.qa__glyph', null, icon(q.icon, 22)),
          h('span.qa__label', null, q.label))),
    ),
  );
}

function section(title, action, ...body) {
  return h(
    'section.section',
    null,
    h('div.section__head', null,
      h('h2.section__title', null, title),
      action && h('button.btn.btn--sm.btn--ghost', { onclick: action.fn }, action.label, icon('chevR', 15))),
    ...body,
  );
}

function grid(title, docs, action) {
  return section(
    title,
    action ? { label: 'See all', fn: action.fn } : null,
    h('div.grid', null, ...docs.map((d) => docCard(d, { onMenu: openDocMenu }))),
  );
}

/** Continue-reading card leads with time remaining, which is the actual decision input. */
function continueCard(doc) {
  const pct = Math.round((doc.progress || 0) * 100);
  const left = Math.max(0, Math.round(doc.words * (1 - (doc.progress || 0))));
  const secs = listenSeconds(left, state.settings.rate || 1);
  const mins = Math.max(1, Math.round(secs / 60));

  return h(
    'article.card.card--hover',
    {
      style: { padding: 'var(--sp-4)', cursor: 'pointer', display: 'grid', gap: 'var(--sp-3)' },
      tabIndex: 0,
      role: 'button',
      'aria-label': `Continue ${doc.title}, ${pct}% complete, about ${mins} minutes left`,
      onclick: () => go(`/read/${doc.id}`),
      onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), go(`/read/${doc.id}`)),
    },
    h('div.row', null,
      h('div', {
        style: {
          width: '44px', height: '44px', flex: 'none', borderRadius: 'var(--r-sm)', overflow: 'hidden',
          display: 'grid', placeItems: 'center',
          background: doc.thumb ? 'none' : 'linear-gradient(140deg, var(--accent-hi), var(--accent-lo))',
          color: 'var(--accent-ink)',
        },
      }, doc.thumb ? h('img', { src: doc.thumb, alt: '', style: { width: '100%', height: '100%', objectFit: 'cover' } }) : icon('book', 20)),
      h('div', { style: { minWidth: '0', flex: '1' } },
        h('div', {
          style: {
            fontWeight: '640', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
          },
        }, doc.title),
        h('div.small.muted', null, `${mins} min left · ${ago(doc.openedAt)}`)),
      h('span', {
        style: {
          display: 'grid', placeItems: 'center', width: '36px', height: '36px', flex: 'none',
          borderRadius: '50%', background: 'var(--accent)', color: 'var(--accent-ink)',
        },
      }, icon('play', 15)),
    ),
    h('div.bar', null, h('div.bar__fill', { style: { width: `${pct}%` } })),
  );
}

function collectionsRow(names, docs) {
  return section(
    'Collections',
    null,
    h('div.chips', null,
      ...names.map((n) => {
        const count = docs.filter((d) => (d.collections || []).includes(n)).length;
        return h('button.chip', { onclick: () => go(`/library?collection=${encodeURIComponent(n)}`) },
          icon('folder', 15), n, h('span.muted', null, count));
      })),
  );
}

/**
 * Recommendations.
 *
 * Deliberately local and explainable, not a black box: we surface the thing you
 * abandoned furthest in, the shortest unread item (easy win), and the oldest untouched
 * import. Each card says *why* it's there. No profiling, no server, no surprises.
 */
function recommend(docs) {
  const out = [];
  const seen = new Set();
  const take = (d, why) => {
    if (!d || seen.has(d.id)) return;
    seen.add(d.id);
    out.push({ doc: d, why });
  };

  take(
    docs.filter((d) => d.progress > 0.45 && d.progress < 0.9).sort((a, b) => b.progress - a.progress)[0],
    'You’re nearly through this one',
  );
  take(
    docs.filter((d) => !d.progress && d.words > 200 && d.words < 2200).sort((a, b) => a.words - b.words)[0],
    'A short read you haven’t started',
  );
  take(
    docs.filter((d) => !d.progress && Date.now() - d.createdAt > 6 * 86400000).sort((a, b) => a.createdAt - b.createdAt)[0],
    'Imported a while ago, still unread',
  );
  return out.slice(0, 3);
}

function recommendations(items) {
  return section(
    'Suggested for you',
    null,
    h('div.grid', null,
      ...items.map(({ doc, why }) =>
        docCard(doc, { onMenu: openDocMenu, subtitle: `${why} · ${readMinutes(doc.words)} min` }))),
  );
}

function onboarding() {
  return h(
    'section.section',
    null,
    h('div.card.card--pad', { style: { display: 'grid', gap: 'var(--sp-5)' } },
      h('div', { style: { display: 'grid', placeItems: 'center', gap: 'var(--sp-3)', textAlign: 'center' } },
        logo(56),
        h('h2', { style: { fontSize: 'var(--step-2)' } }, 'Listen to anything'),
        h('p.muted', { style: { maxWidth: '44ch' } },
          'Bring in a PDF, a web page, a photo of a book, or just paste some text. Lumen turns it into natural speech you can follow along with.')),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))', gap: 'var(--sp-3)' } },
        ...QUICK.map((q) =>
          h('button.qa', { onclick: () => go(q.to) },
            h('span.qa__glyph', null, icon(q.icon, 24)),
            h('span.qa__label', null, q.label)))),
      h('button.btn.btn--primary.btn--block', { onclick: () => go('/import') }, icon('add', 18), 'Add your first document'),
      h('p.small.muted.center', null,
        'Everything stays on this device unless you turn on cloud AI in Settings.')),
  );
}

/* ------------------------------ Document menu ------------------------------ */

export function openDocMenu(doc) {
  const items = docMenuItems(doc, {
    onChange: () => toast(doc.fav ? 'Removed from favourites' : 'Added to favourites', 'ok'),
    onExport: (d) => {
      s.close();
      openExport(d);
    },
    onDelete: async (d) => {
      s.close();
      const ok = await confirmDlg({
        title: 'Move to trash?',
        message: `"${d.title}" goes to Trash. You can restore it from Library → Trash.`,
        confirmLabel: 'Move to trash',
        danger: true,
      });
      if (!ok) return;
      await db.deleteDoc(d.id);
      invalidate();
      await refreshDocs();
      toast('Moved to trash', 'ok', {
        action: {
          label: 'Undo',
          fn: async () => {
            await db.patchDoc(d.id, { trashed: false });
            invalidate();
            await refreshDocs();
          },
        },
      });
    },
  });

  const s = sheet({
    title: doc.title,
    body: h('div.col', null,
      ...items.map((it) =>
        h('button.btn.btn--ghost', {
          style: { justifyContent: 'flex-start', width: '100%', color: it.danger ? 'var(--danger)' : undefined },
          onclick: () => {
            if (!it.danger && it.label !== 'Export…') s.close();
            it.fn();
          },
        }, icon(it.icon, 18), it.label))),
  });
  return s;
}
