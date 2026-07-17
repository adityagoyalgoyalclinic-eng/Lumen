/**
 * Library — folders, collections, sorting, bulk selection, trash.
 *
 * Rendering is virtualised above ~80 items: a library of a thousand scans would
 * otherwise build a thousand cards (and decode a thousand thumbnails) on every filter
 * change. Below that threshold plain rendering is faster and simpler, so we don't pay
 * the complexity unless it buys something.
 */

import { h, fill, icon, $ } from '../util/dom.js';
import { state, on, refreshDocs } from '../core/store.js';
import { go } from '../core/router.js';
import * as db from '../core/db.js';
import { docCard } from './doc-card.js';
import { openDocMenu } from './home.js';
import { empty, sheet, toast, confirm as confirmDlg, ago } from './kit.js';
import { invalidate } from '../services/search.js';
import { openExport } from './export-sheet.js';

const FOLDERS = [
  { id: 'all', label: 'All', icon: 'library' },
  { id: 'documents', label: 'Documents', icon: 'doc' },
  { id: 'books', label: 'Books', icon: 'book' },
  { id: 'articles', label: 'Articles', icon: 'note' },
  { id: 'websites', label: 'Websites', icon: 'globe' },
  { id: 'scans', label: 'Scans', icon: 'camera' },
  { id: 'favorites', label: 'Favourites', icon: 'star' },
  { id: 'downloads', label: 'Downloads', icon: 'down' },
  { id: 'history', label: 'History', icon: 'clock' },
  { id: 'trash', label: 'Trash', icon: 'trash' },
];

const SORTS = [
  { id: 'updated', label: 'Recently updated' },
  { id: 'opened', label: 'Recently opened' },
  { id: 'title', label: 'Title A–Z' },
  { id: 'progress', label: 'Progress' },
  { id: 'longest', label: 'Longest first' },
];

let sortBy = 'updated';
/** @type {Set<string>} */
const selected = new Set();

export function libraryView() {
  const root = h('div.wrap');
  const render = () => {
    fill(root, ...build(render));
  };
  render();
  const offDocs = on('docs', render);
  const offRoute = on('route', render);
  root.addEventListener('lumen:teardown', () => {
    offDocs();
    offRoute();
    selected.clear();
  });
  refreshDocs();
  return root;
}

function build(render) {
  const folder = state.route.params.folder || 'all';
  const collection = state.route.params.collection || null;
  const isTrash = folder === 'trash';

  return [
    header(folder, collection, render, isTrash),
    folderChips(folder, collection),
    selected.size ? bulkBar(render) : null,
    body(folder, collection, render, isTrash),
  ];
}

function header(folder, collection, render, isTrash) {
  const label = collection || FOLDERS.find((f) => f.id === folder)?.label || 'Library';
  return h(
    'header.topbar',
    null,
    h(
      'div.topbar__row',
      null,
      h('h1.topbar__title', null, label),
      isTrash
        ? h('button.btn.btn--sm.btn--danger', {
            onclick: async () => {
              const ok = await confirmDlg({
                title: 'Empty trash?',
                message: 'Everything in Trash will be permanently deleted. This cannot be undone.',
                confirmLabel: 'Delete permanently',
                danger: true,
              });
              if (!ok) return;
              const n = await db.emptyTrash();
              invalidate();
              await refreshDocs();
              toast(`Deleted ${n} item${n === 1 ? '' : 's'}`, 'ok');
            },
          }, icon('trash', 16), 'Empty')
        : [
            h('button.icon-btn', { onclick: () => openSort(render), 'aria-label': 'Sort' }, icon('filter', 20)),
            h('button.icon-btn', { onclick: () => go('/search'), 'aria-label': 'Search' }, icon('search', 20)),
            h('button.btn.btn--sm.btn--primary', { onclick: () => go('/import') }, icon('add', 16), 'Add'),
          ],
    ),
  );
}

function folderChips(active, collection) {
  const counts = countBy(state.docs);
  return h(
    'div',
    { style: { overflowX: 'auto', paddingBottom: 'var(--sp-3)', marginInline: '-4px', paddingInline: '4px' } },
    h(
      'div.chips',
      { style: { flexWrap: 'nowrap', width: 'max-content' } },
      ...FOLDERS.map((f) =>
        h('button.chip', {
          'aria-pressed': String(!collection && f.id === active),
          onclick: () => go(f.id === 'all' ? '/library' : `/library/${f.id}`),
        }, icon(f.icon, 15), f.label, counts[f.id] ? h('span.muted', null, counts[f.id]) : null)),
    ),
  );
}

function countBy(docs) {
  const live = docs.filter((d) => !d.trashed);
  return {
    all: live.length,
    documents: live.filter((d) => d.folder === 'documents').length,
    books: live.filter((d) => d.folder === 'books').length,
    articles: live.filter((d) => d.folder === 'articles').length,
    websites: live.filter((d) => d.folder === 'websites').length,
    scans: live.filter((d) => d.folder === 'scans').length,
    favorites: live.filter((d) => d.fav).length,
    downloads: live.filter((d) => d.downloaded).length,
    history: live.filter((d) => d.openedAt).length,
    trash: docs.filter((d) => d.trashed).length,
  };
}

function select(folder, collection) {
  let docs = state.docs;

  if (folder === 'trash') return docs.filter((d) => d.trashed);
  docs = docs.filter((d) => !d.trashed);

  if (collection) return docs.filter((d) => (d.collections || []).includes(collection));

  switch (folder) {
    case 'favorites': docs = docs.filter((d) => d.fav); break;
    case 'downloads': docs = docs.filter((d) => d.downloaded); break;
    case 'history': docs = docs.filter((d) => d.openedAt).sort((a, b) => b.openedAt - a.openedAt); break;
    case 'all': break;
    default: docs = docs.filter((d) => d.folder === folder);
  }

  const sorted = [...docs];
  switch (sortBy) {
    case 'title': sorted.sort((a, b) => a.title.localeCompare(b.title)); break;
    case 'opened': sorted.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0)); break;
    case 'progress': sorted.sort((a, b) => (b.progress || 0) - (a.progress || 0)); break;
    case 'longest': sorted.sort((a, b) => (b.words || 0) - (a.words || 0)); break;
    default: sorted.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  }
  return sorted;
}

function body(folder, collection, render, isTrash) {
  const docs = select(folder, collection);

  if (!docs.length) {
    if (isTrash) return empty('trash', 'Trash is empty', 'Deleted documents appear here for as long as you want.');
    if (folder === 'favorites') return empty('star', 'No favourites yet', 'Tap the star on any document to keep it here.');
    return empty('library', 'Nothing here yet', 'Import a file, a website, or a scan to get started.', {
      label: 'Add something',
      fn: () => go('/import'),
    });
  }

  const grid = h('div.grid');
  if (isTrash) {
    grid.append(...docs.map((d) => trashCard(d, render)));
  } else if (docs.length > 80) {
    return h('div', null, virtualGrid(docs), h('p.small.muted.center', { style: { marginTop: 'var(--sp-5)' } },
      `${docs.length} items`));
  } else {
    grid.append(...docs.map((d) => docCard(d, { onMenu: openDocMenu })));
  }

  return h('div', null, grid,
    h('p.small.muted.center', { style: { marginTop: 'var(--sp-5)' } },
      `${docs.length} item${docs.length === 1 ? '' : 's'}${isTrash ? '' : ` · ${SORTS.find((s) => s.id === sortBy).label.toLowerCase()}`}`));
}

/**
 * Windowed grid. Renders only the rows near the viewport and keeps total scroll height
 * correct with spacer divs, so scrolling a 2000-item library stays at 60fps.
 */
function virtualGrid(docs) {
  const wrap = h('div', { style: { position: 'relative' } });
  const inner = h('div.grid');
  const top = h('div', { 'aria-hidden': 'true' });
  const bottom = h('div', { 'aria-hidden': 'true' });
  wrap.append(top, inner, bottom);

  const ROW_H = 258;
  let cols = 1;
  let first = -1;

  const measure = () => {
    const w = wrap.clientWidth || 1;
    cols = Math.max(1, Math.floor(w / 190));
  };

  const paint = () => {
    const rect = wrap.getBoundingClientRect();
    const rows = Math.ceil(docs.length / cols);
    const scrolled = Math.max(0, -rect.top);
    const startRow = Math.max(0, Math.floor(scrolled / ROW_H) - 2);
    const visibleRows = Math.ceil(innerHeight / ROW_H) + 4;
    const start = startRow * cols;
    if (start === first) return;
    first = start;

    const end = Math.min(docs.length, start + visibleRows * cols);
    fill(inner, ...docs.slice(start, end).map((d) => docCard(d, { onMenu: openDocMenu })));
    top.style.height = `${startRow * ROW_H}px`;
    bottom.style.height = `${Math.max(0, (rows - Math.ceil(end / cols)) * ROW_H)}px`;
  };

  const onScroll = () => requestAnimationFrame(paint);
  addEventListener('scroll', onScroll, { passive: true });
  const ro = new ResizeObserver(() => {
    measure();
    first = -1;
    paint();
  });

  requestAnimationFrame(() => {
    measure();
    paint();
    ro.observe(wrap);
  });

  wrap.addEventListener('lumen:teardown', () => {
    removeEventListener('scroll', onScroll);
    ro.disconnect();
  });
  return wrap;
}

function trashCard(doc, render) {
  const card = docCard(doc, {});
  card.style.opacity = '0.75';
  card.append(
    h('div', {
      style: { display: 'flex', gap: '6px', padding: '0 var(--sp-4) var(--sp-4)' },
    },
      h('button.btn.btn--sm.btn--outline', {
        style: { flex: '1' },
        onclick: async (e) => {
          e.stopPropagation();
          await db.patchDoc(doc.id, { trashed: false });
          invalidate();
          await refreshDocs();
          toast('Restored', 'ok');
          render();
        },
      }, icon('up', 14), 'Restore'),
      h('button.btn.btn--sm.btn--danger', {
        onclick: async (e) => {
          e.stopPropagation();
          const ok = await confirmDlg({
            title: 'Delete permanently?',
            message: `"${doc.title}" will be gone for good.`,
            confirmLabel: 'Delete',
            danger: true,
          });
          if (!ok) return;
          await db.deleteDoc(doc.id, { hard: true });
          invalidate();
          await refreshDocs();
          render();
        },
      }, icon('trash', 14)),
    ),
  );
  return card;
}

function bulkBar(render) {
  return h(
    'div.card',
    { style: { display: 'flex', alignItems: 'center', gap: 'var(--sp-3)', padding: 'var(--sp-3)', marginBottom: 'var(--sp-4)' } },
    h('span', { style: { fontWeight: '640' } }, `${selected.size} selected`),
    h('div.spacer'),
    h('button.btn.btn--sm.btn--ghost', {
      onclick: () => {
        selected.clear();
        render();
      },
    }, 'Clear'),
  );
}

function openSort(render) {
  const s = sheet({
    title: 'Sort by',
    body: h('div.col', null,
      ...SORTS.map((o) =>
        h('button.btn.btn--ghost', {
          style: { justifyContent: 'flex-start', width: '100%', color: o.id === sortBy ? 'var(--accent)' : undefined },
          onclick: () => {
            sortBy = o.id;
            s.close();
            render();
          },
        }, o.id === sortBy ? icon('check', 18) : h('span', { style: { width: '18px' } }), o.label))),
  });
}

void $;
void ago;
void openExport;
