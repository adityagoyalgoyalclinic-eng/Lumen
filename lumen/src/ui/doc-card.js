/**
 * The document card. Used by Home, Library, and Search — one component so a document
 * looks and behaves identically wherever it appears.
 */

import { h, icon } from '../util/dom.js';
import { go } from '../core/router.js';
import { ago, KIND_ICON, KIND_LABEL } from './kit.js';
import { readMinutes } from '../util/text.js';
import * as db from '../core/db.js';
import { refreshDocs } from '../core/store.js';
import { invalidate } from '../services/search.js';

/**
 * @param {object} doc - Document metadata (blocks not required).
 * @param {{compact?:boolean, onMenu?:Function, subtitle?:string}} [opts]
 */
export function docCard(doc, opts = {}) {
  const pct = Math.round((doc.progress || 0) * 100);
  const open = () => go(`/read/${doc.id}`);

  const thumb = h(
    'div.doc__thumb',
    null,
    doc.thumb
      ? h('img', { src: doc.thumb, alt: '', loading: 'lazy', decoding: 'async' })
      : h('div.doc__glyph', null, icon(KIND_ICON[doc.kind] || 'doc', 34)),
    h('span.doc__kind', null, KIND_LABEL[doc.kind] || doc.kind),
    doc.pinned && h('span.doc__pin', { title: 'Pinned' }, icon('pin', 14)),
    doc.fav && !doc.pinned && h('span.doc__pin', { title: 'Favourite' }, icon('star', 14)),
  );

  const meta = [];
  if (opts.subtitle) meta.push(h('span', null, opts.subtitle));
  else {
    if (doc.words) meta.push(h('span', null, `${readMinutes(doc.words)} min`));
    if (doc.openedAt || doc.updatedAt) meta.push(h('span', null, ago(doc.openedAt || doc.updatedAt)));
  }

  const card = h(
    'article.card.card--hover.doc',
    {
      tabIndex: 0,
      role: 'button',
      // The full title is in the a11y label because the visible one is line-clamped.
      'aria-label': `${doc.title}. ${KIND_LABEL[doc.kind] || doc.kind}. ${pct ? `${pct}% complete.` : 'Not started.'}`,
      onclick: open,
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      },
      oncontextmenu: (e) => {
        if (!opts.onMenu) return;
        e.preventDefault();
        opts.onMenu(doc, card);
      },
    },
    thumb,
    h(
      'div.doc__body',
      null,
      h('h3.doc__title', { title: doc.title }, doc.title),
      meta.length > 0 && h('div.doc__meta', null, ...meta),
      pct > 0 && pct < 100
        ? h('div.bar', { style: { marginTop: '6px' } }, h('div.bar__fill', { style: { width: `${pct}%` } }))
        : pct >= 100
          ? h('div.doc__meta', null, h('span.badge.badge--ok', null, icon('check', 11), 'Finished'))
          : null,
    ),
  );

  if (opts.onMenu) {
    card.append(
      h(
        'button.icon-btn',
        {
          style: {
            position: 'absolute', bottom: '6px', right: '6px', width: '34px', height: '34px',
            background: 'var(--surface-solid)', boxShadow: 'var(--shadow-1)',
          },
          'aria-label': `Options for ${doc.title}`,
          onclick: (e) => {
            e.stopPropagation();
            opts.onMenu(doc, card);
          },
        },
        icon('more', 16),
      ),
    );
  }

  return card;
}

/** Compact row for search results and dense lists. */
export function docRow(doc, { snippet, where, onClick } = {}) {
  return h(
    'button.card.card--hover',
    {
      style: { display: 'flex', gap: 'var(--sp-4)', padding: 'var(--sp-3)', textAlign: 'left', width: '100%', alignItems: 'center' },
      onclick: onClick || (() => go(`/read/${doc.id}`)),
    },
    h(
      'div',
      {
        style: {
          width: '52px', height: '52px', flex: 'none', borderRadius: 'var(--r-sm)', overflow: 'hidden',
          display: 'grid', placeItems: 'center', background: 'var(--accent-wash)', color: 'var(--accent)',
        },
      },
      doc.thumb
        ? h('img', { src: doc.thumb, alt: '', style: { width: '100%', height: '100%', objectFit: 'cover' } })
        : icon(KIND_ICON[doc.kind] || 'doc', 22),
    ),
    h(
      'div',
      { style: { flex: '1', minWidth: '0' } },
      h('div', { style: { fontWeight: '640', marginBottom: '2px' } }, doc.title),
      snippet &&
        h('div.small.muted', {
          style: { display: '-webkit-box', WebkitLineClamp: '2', WebkitBoxOrient: 'vertical', overflow: 'hidden' },
        }, snippet),
      where && h('span.badge', { style: { marginTop: '4px' } }, where),
    ),
    icon('chevR', 18),
  );
}

/**
 * Build the context menu for a document. Returns menu item descriptors so the caller
 * decides how to present them (sheet on mobile, popover on desktop).
 */
export function docMenuItems(doc, { onChange, onExport, onDelete } = {}) {
  const toggle = async (key) => {
    await db.patchDoc(doc.id, { [key]: !doc[key] });
    invalidate();
    await refreshDocs();
    onChange?.();
  };

  return [
    { icon: 'play', label: 'Open', fn: () => go(`/read/${doc.id}`) },
    { icon: 'star', label: doc.fav ? 'Remove from favourites' : 'Add to favourites', fn: () => toggle('fav') },
    { icon: 'pin', label: doc.pinned ? 'Unpin' : 'Pin to home', fn: () => toggle('pinned') },
    { icon: 'down', label: 'Export…', fn: () => onExport?.(doc) },
    { icon: 'trash', label: 'Move to trash', danger: true, fn: () => onDelete?.(doc) },
  ];
}
