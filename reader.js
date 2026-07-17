/**
 * Reader.
 *
 * The document is rendered once into blocks of sentence `<span>`s. Every sentence gets
 * a global index that the player, the progress bar, and resume all share, so
 * highlighting, seeking, and "continue where you left off" agree by construction
 * rather than by bookkeeping.
 *
 * Long documents render lazily: blocks past the first screenful are mounted by an
 * IntersectionObserver, so opening a 600-page book is instant.
 */

import { h, fill, icon, $, $$ } from '../util/dom.js';
import { state, on, setSetting, openDoc } from '../core/store.js';
import { go, back } from '../core/router.js';
import * as db from '../core/db.js';
import { sentences, readMinutes, listenSeconds, countWords } from '../util/text.js';
import { sheet, toast, ago, confirm as confirmDlg, ask } from './kit.js';
import { openAiPanel } from './ai-panel.js';
import { openExport } from './export-sheet.js';
import { player } from './player.js';
import { invalidate } from '../services/search.js';
import { accentFromImage } from './kit.js';

/**
 * Flattened sentence map for the open document.
 * @type {{text:string, blockIdx:number, start:number, end:number}[]}
 */
let smap = [];
/** blockIdx -> first sentence index, for paragraph skipping. */
let blockStarts = [];
let chapterStarts = [];
let immersiveTimer = null;

export const sentenceMap = () => smap;
export const blockStartIndices = () => blockStarts;
export const chapterStartIndices = () => chapterStarts;

export function readerView() {
  const root = h('div.reader', { 'data-paper': state.settings.paper });
  const page = h('article.reader__page', { id: 'reader-page' });
  const bar = h('div.reader__bar');
  root.append(bar, page);

  const id = state.route.params.id;

  (async () => {
    const doc = await openDoc(id);
    if (!doc) {
      fill(root, h('div.wrap', null,
        h('div.empty', null,
          h('div.empty__glyph', null, icon('warn', 28)),
          h('h3', null, 'That document is gone'),
          h('button.btn.btn--primary', { onclick: () => go('/library') }, 'Back to library'))));
      return;
    }

    buildMap(doc);
    fill(bar, ...barContent(doc, root));
    renderDoc(doc, page);
    applyType(root);
    await paintMarks(doc);

    // Dynamic colour: tint the whole app from the cover art.
    if (state.settings.dynamicColor && doc.thumb) {
      const hue = await accentFromImage(doc.thumb);
      if (hue != null) document.documentElement.style.setProperty('--h', String(hue));
    }

    player.attach(doc, root);

    // Resume where they left off, without yanking the view if they're at the top.
    if (doc.sentenceIdx > 0) {
      const el = $(`[data-si="${doc.sentenceIdx}"]`, page);
      el?.scrollIntoView({ block: 'center' });
      toast(`Resumed at ${Math.round((doc.progress || 0) * 100)}%`, 'info', {
        action: { label: 'Start over', fn: () => player.seek(0) },
      });
    }
  })();

  const offSettings = on('settings', () => {
    root.dataset.paper = state.settings.paper;
    applyType(root);
  });

  bindImmersive(root);
  bindSelection(root);

  root.addEventListener('lumen:teardown', () => {
    offSettings();
    clearTimeout(immersiveTimer);
    player.detach();
    // Restore the user's chosen accent after a dynamically-tinted document.
    document.documentElement.style.setProperty('--h', String(state.settings.accentHue));
  });

  return root;
}

/* ------------------------------ Sentence map ------------------------------ */

function buildMap(doc) {
  smap = [];
  blockStarts = [];
  chapterStarts = [];
  let lastChapter = -1;

  (doc.blocks || []).forEach((b, blockIdx) => {
    if (b.chapter != null && b.chapter !== lastChapter) {
      lastChapter = b.chapter;
      chapterStarts.push(smap.length);
    }
    if (!b.text || b.type === 'img' || b.type === 'hr') return;
    // Code blocks are indexed so highlighting lines up, but the player skips them —
    // nobody wants a voice reading out a JSON payload character by character.
    if (b.type === 'code') return;

    blockStarts.push(smap.length);
    let cursor = 0;
    for (const s of sentences(b.text)) {
      const start = b.text.indexOf(s, cursor);
      const at = start < 0 ? cursor : start;
      smap.push({ text: s, blockIdx, start: at, end: at + s.length });
      cursor = at + s.length;
    }
  });
}

/* ------------------------------ Rendering ------------------------------ */

function renderDoc(doc, page) {
  page.replaceChildren();
  let si = 0;

  const nodes = (doc.blocks || []).map((b, blockIdx) => {
    if (b.type === 'hr') return h('hr');
    if (b.type === 'img') {
      return b.src
        ? h('figure', null,
            h('img', { src: b.src, alt: b.text || '', loading: 'lazy', decoding: 'async' }),
            b.text && h('figcaption.small.muted.center', null, b.text))
        : null;
    }
    if (!b.text) return null;
    if (b.type === 'code') return h('pre', null, h('code', null, b.text));

    const tag = { h1: 'h1', h2: 'h2', h3: 'h3', quote: 'blockquote', li: 'li' }[b.type] || 'p';
    const el = h(`${tag}.blk`, { dataset: { bi: String(blockIdx) } });

    const parts = sentences(b.text);
    if (!parts.length) {
      el.textContent = b.text;
      return el;
    }
    parts.forEach((s, i) => {
      const span = h('span.sn', {
        dataset: { si: String(si) },
        onclick: () => player.seek(Number(span.dataset.si)),
      }, s);
      el.append(span);
      if (i < parts.length - 1) el.append(' ');
      si++;
    });
    return el;
  }).filter(Boolean);

  // Mount the first screenful immediately; stream the rest in as it approaches.
  const EAGER = 24;
  page.append(...nodes.slice(0, EAGER));

  if (nodes.length > EAGER) {
    const rest = nodes.slice(EAGER);
    const sentinel = h('div', { style: { height: '1px' } });
    page.append(sentinel);

    let at = 0;
    const io = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      const chunk = rest.slice(at, at + 40);
      at += 40;
      sentinel.before(...chunk);
      if (at >= rest.length) {
        io.disconnect();
        sentinel.remove();
      }
    }, { rootMargin: '1200px 0px' });
    io.observe(sentinel);
    page.addEventListener('lumen:teardown', () => io.disconnect());
  }
}

function applyType(root) {
  const s = state.settings;
  const fonts = { sans: 'var(--font-ui)', serif: 'var(--font-serif)', mono: 'var(--font-mono)', dyslexia: 'var(--font-dys)' };
  root.style.setProperty('--rd-font', fonts[s.fontFamily] || fonts.serif);
  root.style.setProperty('--rd-size', `${s.fontSize}px`);
  root.style.setProperty('--rd-line', String(s.lineHeight));
  root.style.setProperty('--rd-width', `${s.pageWidth}ch`);
  root.style.setProperty('--rd-para', `${s.paraSpacing}em`);
  root.style.setProperty('--rd-align', s.textAlign);
  root.classList.toggle('is-focus', s.focusMode);
}

/* ------------------------------ Top bar ------------------------------ */

function barContent(doc, root) {
  return [
    h('button.icon-btn', { onclick: () => back(), 'aria-label': 'Back' }, icon('chevL', 20)),
    h('span.reader__bar-title', { title: doc.title }, doc.title),
    h('button.icon-btn', {
      onclick: () => openInfo(doc),
      'aria-label': 'Document details',
    }, icon('info', 19)),
    h('button.icon-btn', {
      'aria-pressed': String(Boolean(doc.fav)),
      'aria-label': doc.fav ? 'Remove from favourites' : 'Add to favourites',
      onclick: async (e) => {
        const next = !doc.fav;
        doc.fav = next;
        await db.patchDoc(doc.id, { fav: next });
        e.currentTarget.setAttribute('aria-pressed', String(next));
        e.currentTarget.setAttribute('aria-label', next ? 'Remove from favourites' : 'Add to favourites');
        toast(next ? 'Added to favourites' : 'Removed from favourites', 'ok');
      },
    }, icon('star', 19)),
    h('button.icon-btn', { onclick: () => openTypography(root), 'aria-label': 'Text and theme' }, icon('font', 19)),
    h('button.icon-btn', {
      onclick: () => openAiPanel(doc),
      'aria-label': 'AI tools',
      style: { color: 'var(--accent)' },
    }, icon('sparkle', 19)),
    h('button.icon-btn', { onclick: () => openMore(doc, root), 'aria-label': 'More' }, icon('more', 19)),
  ];
}

/* ------------------------------ Immersive mode ------------------------------ */

/** Hide the bar while scrolling down; bring it back on scroll up or tap. */
function bindImmersive(root) {
  let lastY = 0;
  const onScroll = () => {
    const y = scrollY;
    if (y > lastY + 40 && y > 120) root.classList.add('is-immersive');
    else if (y < lastY - 24) root.classList.remove('is-immersive');
    lastY = y;
  };
  addEventListener('scroll', onScroll, { passive: true });
  root.addEventListener('lumen:teardown', () => removeEventListener('scroll', onScroll));
}

/* ------------------------------ Selection & annotation ------------------------------ */

/**
 * Selection toolbar. Anchors to a block + character offsets rather than DOM nodes, so
 * marks survive re-render, font changes, and reload.
 */
function bindSelection(root) {
  let bar = null;

  const kill = () => {
    bar?.remove();
    bar = null;
  };

  const onUp = () => {
    setTimeout(() => {
      const sel = getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) return kill();

      const range = sel.getRangeAt(0);
      const blk = range.startContainer.parentElement?.closest('.blk');
      if (!blk || !root.contains(blk)) return kill();

      const anchor = resolveRange(blk, range);
      if (!anchor) return kill();

      kill();
      const rect = range.getBoundingClientRect();
      bar = h('div.selbar',
        null,
        act('hl', 'Highlight'),
        act('ul', 'Underline'),
        act('note', 'Note'),
        h('button.icon-btn', {
          style: { width: '38px', height: '38px' },
          'aria-label': 'Read from here',
          title: 'Read from here',
          onclick: () => {
            const span = range.startContainer.parentElement?.closest('.sn');
            if (span) player.seek(Number(span.dataset.si));
            kill();
            sel.removeAllRanges();
          },
        }, icon('play', 15)),
        h('button.icon-btn', {
          style: { width: '38px', height: '38px' },
          'aria-label': 'Copy',
          title: 'Copy',
          onclick: async () => {
            await navigator.clipboard.writeText(sel.toString()).catch(() => {});
            toast('Copied', 'ok');
            kill();
            sel.removeAllRanges();
          },
        }, icon('clip', 15)),
      );

      document.body.append(bar);
      const bw = bar.offsetWidth;
      bar.style.left = `${Math.max(10, Math.min(innerWidth - bw - 10, rect.left + rect.width / 2 - bw / 2))}px`;
      bar.style.top = `${Math.max(10, rect.top + scrollY - 52)}px`;

      function act(type, label) {
        const glyph = { hl: 'hl', ul: 'ul', note: 'note' }[type];
        return h('button.icon-btn', {
          style: { width: '38px', height: '38px' },
          'aria-label': label,
          title: label,
          onclick: async () => {
            const text = sel.toString().trim();
            let note = null;
            kill();
            if (type === 'note') {
              note = await ask({ title: 'Add a note', label: `On "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`, multiline: true, placeholder: 'Your thoughts…' });
              if (!note) return;
            }
            const mark = await db.putMark({
              docId: state.doc.id,
              type,
              blockIdx: anchor.blockIdx,
              start: anchor.start,
              end: anchor.end,
              text,
              note,
            });
            state.marks.push(mark);
            invalidate();
            await paintMarks(state.doc);
            sel.removeAllRanges();
            toast(type === 'note' ? 'Note added' : type === 'hl' ? 'Highlighted' : 'Underlined', 'ok');
          },
        }, icon(glyph, 15));
      }
    }, 10);
  };

  document.addEventListener('selectionchange', () => {
    const sel = getSelection();
    if (!sel || sel.isCollapsed) kill();
  });
  root.addEventListener('mouseup', onUp);
  root.addEventListener('touchend', onUp);
  root.addEventListener('lumen:teardown', kill);
}

/** Convert a DOM Range into block-relative character offsets. */
function resolveRange(blk, range) {
  const full = blk.textContent;
  const pre = document.createRange();
  pre.selectNodeContents(blk);
  pre.setEnd(range.startContainer, range.startOffset);
  const start = pre.toString().length;
  const end = start + range.toString().length;
  if (end <= start) return null;
  return { blockIdx: Number(blk.dataset.bi), start, end, full };
}

/**
 * Paint saved marks.
 *
 * Re-derives every mark from character offsets on each call. That's O(marks) and
 * cheap, and it means marks can never drift out of sync with the text — the
 * alternative (patching the DOM incrementally) is where annotation bugs live.
 */
async function paintMarks(doc) {
  // Clear existing marks by unwrapping them.
  for (const el of $$('.mk')) {
    const parent = el.parentNode;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    el.remove();
    parent.normalize();
  }

  const marks = state.marks.filter((m) => m.type !== 'bookmark');
  for (const m of marks) {
    const blk = $(`.blk[data-bi="${m.blockIdx}"]`);
    if (!blk) continue; // block not mounted yet (lazy render) — it'll paint on re-open
    try {
      const range = offsetsToRange(blk, m.start, m.end);
      if (!range) continue;
      const wrap = h(`mark.mk.mk--${m.type}`, {
        dataset: { mid: m.id },
        title: m.note || undefined,
        onclick: (e) => {
          e.stopPropagation();
          openMark(m, doc);
        },
      });
      range.surroundContents(wrap);
    } catch {
      // surroundContents throws if the range crosses element boundaries (a highlight
      // spanning two sentence spans). Fall back to per-span wrapping.
      wrapAcross(blk, m);
    }
  }
}

function offsetsToRange(blk, start, end) {
  const walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  let pos = 0;
  let set = false;
  let node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    if (!set && pos + len >= start) {
      range.setStart(node, start - pos);
      set = true;
    }
    if (set && pos + len >= end) {
      range.setEnd(node, end - pos);
      return range;
    }
    pos += len;
  }
  return set ? range : null;
}

/** Highlight that spans multiple sentence spans — wrap each intersecting text node. */
function wrapAcross(blk, m) {
  const walker = document.createTreeWalker(blk, NodeFilter.SHOW_TEXT);
  let pos = 0;
  const jobs = [];
  let node;
  while ((node = walker.nextNode())) {
    const len = node.nodeValue.length;
    const a = Math.max(start(), pos);
    const b = Math.min(m.end, pos + len);
    if (a < b) jobs.push({ node, from: a - pos, to: b - pos });
    pos += len;
  }
  function start() { return m.start; }

  for (const j of jobs) {
    const r = document.createRange();
    r.setStart(j.node, j.from);
    r.setEnd(j.node, j.to);
    const wrap = h(`mark.mk.mk--${m.type}`, {
      dataset: { mid: m.id },
      title: m.note || undefined,
      onclick: (e) => {
        e.stopPropagation();
        openMark(m, state.doc);
      },
    });
    try { r.surroundContents(wrap); } catch { /* skip this fragment */ }
  }
}

function openMark(mark, doc) {
  const s = sheet({
    title: mark.type === 'note' ? 'Note' : mark.type === 'hl' ? 'Highlight' : 'Underline',
    body: h('div.col', null,
      h('blockquote', {
        style: { paddingLeft: 'var(--sp-4)', borderLeft: '3px solid var(--accent)', color: 'var(--ink-2)', fontStyle: 'italic' },
      }, mark.text),
      mark.note && h('div.card.card--pad', null, h('p', null, mark.note)),
      h('p.small.muted', null, ago(mark.createdAt)),
      h('div.row', null,
        h('button.btn.btn--outline', {
          style: { flex: '1' },
          onclick: async () => {
            const note = await ask({
              title: mark.note ? 'Edit note' : 'Add a note',
              value: mark.note || '',
              multiline: true,
            });
            if (note == null) return;
            await db.putMark({ ...mark, note });
            const i = state.marks.findIndex((x) => x.id === mark.id);
            if (i >= 0) state.marks[i] = { ...mark, note };
            invalidate();
            await paintMarks(doc);
            s.close();
            toast('Note saved', 'ok');
          },
        }, icon('note', 16), mark.note ? 'Edit note' : 'Add note'),
        h('button.btn.btn--danger', {
          onclick: async () => {
            await db.deleteMark(mark.id);
            state.marks = state.marks.filter((x) => x.id !== mark.id);
            invalidate();
            await paintMarks(doc);
            s.close();
            toast('Removed', 'ok');
          },
        }, icon('trash', 16), 'Remove'))),
  });
}

/* ------------------------------ Typography sheet ------------------------------ */

function openTypography(root) {
  const s = state.settings;

  const row = (label, control) =>
    h('div.setting', null, h('div.setting__text', null, h('div.setting__name', null, label)), control);

  const stepper = (key, min, max, step, fmt) => {
    const val = h('span', { style: { minWidth: '48px', textAlign: 'center', fontWeight: '640', fontVariantNumeric: 'tabular-nums' } },
      fmt(s[key]));
    const bump = (d) => {
      const next = Math.round(Math.min(max, Math.max(min, s[key] + d)) * 100) / 100;
      setSetting(key, next);
      val.textContent = fmt(next);
      applyType(root);
    };
    return h('div.row', null,
      h('button.icon-btn', { onclick: () => bump(-step), 'aria-label': `Decrease ${key}` }, h('span', { style: { fontSize: '20px' } }, '−')),
      val,
      h('button.icon-btn', { onclick: () => bump(step), 'aria-label': `Increase ${key}` }, h('span', { style: { fontSize: '18px' } }, '+')));
  };

  const pick = (key, options, after) =>
    h('div.chips', null,
      ...options.map((o) =>
        h('button.chip', {
          'aria-pressed': String(s[key] === o.id),
          onclick: (e) => {
            setSetting(key, o.id);
            [...e.currentTarget.parentElement.children].forEach((c, i) =>
              c.setAttribute('aria-pressed', String(options[i].id === o.id)));
            after?.();
          },
        }, o.label)));

  sheet({
    title: 'Text & theme',
    body: h('div.col', null,
      h('span.field__label', null, 'Reading theme'),
      pick('paper', [
        { id: 'light', label: 'Light' },
        { id: 'sepia', label: 'Sepia' },
        { id: 'paper', label: 'Paper' },
        { id: 'dark', label: 'Dark' },
        { id: 'amoled', label: 'AMOLED' },
      ], () => { root.dataset.paper = state.settings.paper; }),

      h('span.field__label', { style: { marginTop: 'var(--sp-3)' } }, 'Typeface'),
      pick('fontFamily', [
        { id: 'serif', label: 'Serif' },
        { id: 'sans', label: 'Sans' },
        { id: 'mono', label: 'Mono' },
        { id: 'dyslexia', label: 'Dyslexia-friendly' },
      ], () => applyType(root)),

      h('div', { style: { marginTop: 'var(--sp-3)' } },
        row('Text size', stepper('fontSize', 13, 34, 1, (v) => `${v}px`)),
        row('Line spacing', stepper('lineHeight', 1.2, 2.6, 0.05, (v) => v.toFixed(2))),
        row('Paragraph spacing', stepper('paraSpacing', 0.4, 3, 0.1, (v) => `${v.toFixed(1)}em`)),
        row('Page width', stepper('pageWidth', 40, 110, 2, (v) => `${v}ch`))),

      h('span.field__label', { style: { marginTop: 'var(--sp-3)' } }, 'Alignment'),
      pick('textAlign', [{ id: 'left', label: 'Left' }, { id: 'justify', label: 'Justified' }], () => applyType(root)),

      toggleRow('Focus mode', 'Dim everything except the sentence being read', 'focusMode', () => applyType(root)),
      toggleRow('Auto-scroll', 'Keep the current sentence in view', 'autoScroll'),
      toggleRow('Word highlighting', 'Follow along word by word where supported', 'wordHighlight'),
    ),
  });
}

export function toggleRow(name, desc, key, after) {
  const sw = h('button.switch', {
    role: 'switch',
    'aria-checked': String(Boolean(state.settings[key])),
    'aria-label': name,
    onclick: () => {
      const next = !state.settings[key];
      setSetting(key, next);
      sw.setAttribute('aria-checked', String(next));
      after?.(next);
    },
  });
  return h('div.setting', null,
    h('div.setting__text', null,
      h('div.setting__name', null, name),
      desc && h('div.small.muted', null, desc)),
    sw);
}

/* ------------------------------ Info & more ------------------------------ */

function openInfo(doc) {
  const text = (doc.blocks || []).filter((b) => b.text).map((b) => b.text).join(' ');
  const r = doc.meta?.readability || { label: '—', grade: 0, tone: 'ok', score: 0 };
  const secs = listenSeconds(doc.words, state.settings.rate || 1);

  const stat = (label, value, tone) =>
    h('div.card.card--pad', { style: { padding: 'var(--sp-4)' } },
      h('div', { style: { fontSize: 'var(--step-2)', fontWeight: '700', color: tone ? `var(--${tone})` : 'var(--ink)' } }, value),
      h('div.small.muted', null, label));

  sheet({
    title: 'Details',
    body: h('div.col', null,
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--sp-3)' } },
        stat('Words', doc.words.toLocaleString()),
        stat('Reading time', `${readMinutes(doc.words)} min`),
        stat('Listening time', `${Math.max(1, Math.round(secs / 60))} min`),
        stat('Difficulty', r.label, r.tone)),
      h('div.card.card--pad', { style: { display: 'grid', gap: 'var(--sp-2)' } },
        kv('Reading ease', `${r.score}/100 · grade ${r.grade}`),
        kv('Sentences', String(smap.length)),
        kv('Paragraphs', String((doc.blocks || []).filter((b) => b.type === 'p').length)),
        doc.meta?.pages && kv('Pages', String(doc.meta.pages)),
        doc.meta?.author && kv('Author', doc.meta.author),
        doc.meta?.site && kv('Site', doc.meta.site),
        doc.meta?.ocr && kv('Scan confidence', `${doc.meta.confidence}%`),
        kv('Added', new Date(doc.createdAt).toLocaleString()),
        doc.source && kv('Source', doc.source)),
      doc.source?.startsWith('http') &&
        h('a.btn.btn--outline.btn--block', { href: doc.source, target: '_blank', rel: 'noopener noreferrer' },
          icon('globe', 16), 'Open original page'),
      h('p.small.muted', null,
        `Difficulty uses the Flesch reading-ease score, which is a guide for English prose rather than a verdict.`)),
  });
  void text;
  void countWords;
}

const kv = (k, v) =>
  h('div.row', { style: { alignItems: 'baseline' } },
    h('span.small.muted', { style: { flex: 'none', minWidth: '120px' } }, k),
    h('span.small', { style: { flex: '1', wordBreak: 'break-word' } }, v));

function openMore(doc, root) {
  const items = [
    { icon: 'note', label: `Notes & highlights (${state.marks.length})`, fn: () => openNotes(doc) },
    { icon: 'search', label: 'Find in document', fn: () => openFind(doc) },
    ...(chapterStarts.length > 1 ? [{ icon: 'list', label: 'Chapters', fn: () => openChapters(doc) }] : []),
    { icon: 'down', label: 'Export…', fn: () => openExport(doc) },
    { icon: 'folder', label: 'Move to collection…', fn: () => openCollection(doc) },
    { icon: 'expand', label: 'Full screen', fn: () => toggleFullscreen(root) },
    { icon: 'trash', label: 'Move to trash', danger: true, fn: async () => {
      const ok = await confirmDlg({ title: 'Move to trash?', message: `"${doc.title}" goes to Trash.`, confirmLabel: 'Move to trash', danger: true });
      if (!ok) return;
      await db.deleteDoc(doc.id);
      invalidate();
      toast('Moved to trash', 'ok');
      go('/library');
    } },
  ];

  const s = sheet({
    title: 'Options',
    body: h('div.col', null,
      ...items.map((it) =>
        h('button.btn.btn--ghost', {
          style: { justifyContent: 'flex-start', width: '100%', color: it.danger ? 'var(--danger)' : undefined },
          onclick: () => {
            s.close();
            it.fn();
          },
        }, icon(it.icon, 18), it.label))),
  });
}

function toggleFullscreen(root) {
  if (document.fullscreenElement) document.exitFullscreen();
  else root.requestFullscreen?.().catch(() => toast('Full screen is not available here.', 'err'));
}

function openNotes(doc) {
  const marks = state.marks;
  sheet({
    title: `Notes & highlights`,
    body: marks.length
      ? h('div.col', null,
          h('div.row', null,
            h('span.small.muted', { style: { flex: '1' } }, `${marks.length} annotation${marks.length === 1 ? '' : 's'}`),
            h('button.btn.btn--sm.btn--outline', {
              onclick: async () => {
                const { exportNotes } = await import('../services/export.js');
                await exportNotes(doc);
                toast('Notes exported', 'ok');
              },
            }, icon('down', 14), 'Export')),
          ...marks.map((m) =>
            h('button.card.card--pad', {
              style: { textAlign: 'left', padding: 'var(--sp-4)', display: 'grid', gap: '6px' },
              onclick: () => {
                const el = $(`.blk[data-bi="${m.blockIdx}"]`);
                el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              },
            },
              h('div.row', null,
                h('span.badge', null, m.type === 'hl' ? 'Highlight' : m.type === 'ul' ? 'Underline' : 'Note'),
                h('span.small.muted', null, ago(m.createdAt))),
              h('div.small', { style: { color: 'var(--ink-2)', fontStyle: 'italic' } }, `"${m.text}"`),
              m.note && h('div.small', { style: { color: 'var(--accent)' } }, m.note))))
      : h('div.empty', null,
          h('div.empty__glyph', null, icon('note', 26)),
          h('h3', null, 'No notes yet'),
          h('p.small', null, 'Select any text to highlight it or add a note.')),
  });
}

function openFind(doc) {
  const input = h('input.input', { type: 'search', placeholder: 'Find in this document…', 'aria-label': 'Find' });
  const out = h('div.col');

  const run = async () => {
    const q = input.value.trim();
    if (q.length < 2) return fill(out, h('p.small.muted', null, 'Type at least two characters.'));
    const { findInDoc } = await import('../services/search.js');
    const hits = findInDoc(doc, q);
    if (!hits.length) return fill(out, h('p.small.muted', null, `No matches for "${q}".`));
    fill(out,
      h('p.small.muted', null, `${hits.length} match${hits.length === 1 ? '' : 'es'}`),
      ...hits.slice(0, 60).map((hit) =>
        h('button.btn.btn--ghost', {
          style: { justifyContent: 'flex-start', textAlign: 'left', width: '100%', height: 'auto', padding: 'var(--sp-3)' },
          onclick: () => {
            const el = $(`.blk[data-bi="${hit.blockIdx}"]`);
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el?.animate([{ background: 'var(--accent-wash)' }, { background: 'transparent' }], { duration: 1400 });
            s.close();
          },
        }, h('span.small', null, hit.snippet))));
  };

  let t;
  input.addEventListener('input', () => {
    clearTimeout(t);
    t = setTimeout(run, 140);
  });

  const s = sheet({ title: 'Find in document', body: h('div.col', null, input, out) });
}

function openChapters(doc) {
  const chapters = doc.meta?.chapters || [];
  const s = sheet({
    title: 'Chapters',
    body: h('div.col', null,
      ...chapters.map((c, i) =>
        h('button.btn.btn--ghost', {
          style: { justifyContent: 'flex-start', width: '100%' },
          onclick: () => {
            player.seek(chapterStarts[i] ?? 0);
            s.close();
          },
        }, h('span.muted', { style: { minWidth: '28px' } }, i + 1), c.title))),
  });
}

async function openCollection(doc) {
  const all = [...new Set(state.docs.flatMap((d) => d.collections || []))];
  const s = sheet({
    title: 'Collections',
    body: h('div.col', null,
      ...all.map((name) => {
        const on = (doc.collections || []).includes(name);
        return h('button.btn.btn--ghost', {
          style: { justifyContent: 'flex-start', width: '100%' },
          onclick: async () => {
            const next = on
              ? doc.collections.filter((c) => c !== name)
              : [...(doc.collections || []), name];
            doc.collections = next;
            await db.patchDoc(doc.id, { collections: next });
            invalidate();
            toast(on ? `Removed from ${name}` : `Added to ${name}`, 'ok');
            s.close();
          },
        }, icon(on ? 'check' : 'folder', 17), name);
      }),
      h('button.btn.btn--outline.btn--block', {
        onclick: async () => {
          const name = await ask({ title: 'New collection', label: 'Name', placeholder: 'e.g. Research' });
          if (!name) return;
          const next = [...(doc.collections || []), name];
          doc.collections = next;
          await db.patchDoc(doc.id, { collections: next });
          invalidate();
          toast(`Added to ${name}`, 'ok');
          s.close();
        },
      }, icon('add', 16), 'New collection')),
  });
}
