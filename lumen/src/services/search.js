/**
 * Global search across documents, notes, highlights, and OCR text.
 *
 * An inverted index built in memory and rebuilt when documents change. At the scale
 * this app operates on (hundreds of documents, not millions) a real index is overkill,
 * but a naive substring scan over every block on every keystroke is visibly laggy past
 * ~50 documents. The index keeps keystroke latency flat.
 *
 * Ranking blends term frequency, field weight (title beats body), whole-word bonus, and
 * recency, so "the report I read yesterday" surfaces above a 2019 archive.
 */

import * as db from '../core/db.js';
import { norm, snippet, escapeRe } from '../util/text.js';

/** @type {{docs: Map, terms: Map, built: number}|null} */
let index = null;
let building = null;

const FIELD_WEIGHT = { title: 8, heading: 3, body: 1, note: 4, highlight: 3, tag: 5, source: 2 };

/** Build (or rebuild) the index. Safe to call repeatedly; concurrent calls share work. */
export async function build() {
  if (building) return building;
  building = (async () => {
    const [docs, marks] = await Promise.all([db.allDocsFull(), db.allMarks()]);
    const terms = new Map(); // term -> Map(docId -> weight)
    const meta = new Map();

    const add = (docId, term, weight) => {
      const t = norm(term);
      if (t.length < 2) return;
      if (!terms.has(t)) terms.set(t, new Map());
      const m = terms.get(t);
      m.set(docId, (m.get(docId) || 0) + weight);
    };

    const marksByDoc = new Map();
    for (const m of marks) {
      if (!marksByDoc.has(m.docId)) marksByDoc.set(m.docId, []);
      marksByDoc.get(m.docId).push(m);
    }

    for (const d of docs) {
      if (d.trashed) continue;
      const docMarks = marksByDoc.get(d.id) || [];
      const body = (d.blocks || []).filter((b) => b.text).map((b) => b.text).join('\n');

      meta.set(d.id, {
        id: d.id,
        title: d.title,
        kind: d.kind,
        folder: d.folder,
        thumb: d.thumb,
        updatedAt: d.updatedAt,
        openedAt: d.openedAt,
        words: d.words,
        progress: d.progress,
        locked: Boolean(d.locked),
        body,
        ocr: Boolean(d.meta?.ocr),
        notes: docMarks.filter((m) => m.note).map((m) => m.note),
        highlights: docMarks.filter((m) => m.text).map((m) => m.text),
        source: d.source || '',
        tags: d.tags || [],
      });

      for (const w of tokens(d.title)) add(d.id, w, FIELD_WEIGHT.title);
      for (const t of d.tags || []) for (const w of tokens(t)) add(d.id, w, FIELD_WEIGHT.tag);
      for (const w of tokens(d.source || '')) add(d.id, w, FIELD_WEIGHT.source);

      for (const b of d.blocks || []) {
        if (!b.text) continue;
        const weight = /^h[1-3]$/.test(b.type) ? FIELD_WEIGHT.heading : FIELD_WEIGHT.body;
        for (const w of tokens(b.text)) add(d.id, w, weight);
      }
      for (const m of docMarks) {
        for (const w of tokens(m.note || '')) add(d.id, w, FIELD_WEIGHT.note);
        for (const w of tokens(m.text || '')) add(d.id, w, FIELD_WEIGHT.highlight);
      }
    }

    index = { docs: meta, terms, built: Date.now() };
    return index;
  })();

  try {
    return await building;
  } finally {
    building = null;
  }
}

export const invalidate = () => { index = null; };

const tokens = (s) => norm(s).match(/[\p{L}\p{N}][\p{L}\p{N}'-]*/gu) || [];

/**
 * Search.
 * @param {string} query
 * @param {{scope?:string, limit?:number}} [opts] scope: all|documents|books|articles|
 *   websites|scans|notes|highlights|favorites
 * @returns {Promise<{id,title,kind,score,snippet,where,thumb}[]>}
 */
export async function search(query, opts = {}) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  if (!index) await build();

  const { limit = 40, scope = 'all' } = opts;
  const qTokens = tokens(q);
  if (!qTokens.length) return [];

  const scores = new Map();
  for (const t of qTokens) {
    // Exact term.
    for (const [docId, w] of index.terms.get(t) || []) {
      scores.set(docId, (scores.get(docId) || 0) + w * 2);
    }
    // Prefix matches, so results appear while still typing. Weighted lower, and
    // shorter completions score higher ("read" → "reader" beats "readability").
    if (t.length >= 3) {
      for (const [term, docsMap] of index.terms) {
        if (term === t || !term.startsWith(t)) continue;
        const decay = t.length / term.length;
        for (const [docId, w] of docsMap) {
          scores.set(docId, (scores.get(docId) || 0) + w * 0.5 * decay);
        }
      }
    }
  }

  const now = Date.now();
  const phrase = qTokens.length > 1 ? norm(q) : null;

  let out = [];
  for (const [docId, base] of scores) {
    const d = index.docs.get(docId);
    if (!d) continue;
    if (!inScope(d, scope)) continue;

    let score = base;

    // Require every token for multi-word queries — otherwise "annual report" returns
    // everything containing "report", which is not what anyone means.
    const hay = norm(`${d.title} ${d.body} ${d.notes.join(' ')} ${d.highlights.join(' ')} ${d.tags.join(' ')}`);
    if (qTokens.length > 1 && !qTokens.every((t) => hay.includes(t))) continue;

    if (phrase && hay.includes(phrase)) score *= 3; // exact phrase is a strong signal
    if (norm(d.title).includes(norm(q))) score *= 2.2;
    if (norm(d.title) === norm(q)) score *= 2;

    // Recency: gentle decay over ~90 days, never enough to bury a strong match.
    const age = (now - (d.openedAt || d.updatedAt || now)) / 86400000;
    score *= 1 + Math.max(0, 0.35 - age / 260);

    out.push({
      id: d.id,
      title: d.title,
      kind: d.kind,
      folder: d.folder,
      thumb: d.thumb,
      progress: d.progress,
      words: d.words,
      score,
      ...locate(d, q),
    });
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

function inScope(d, scope) {
  switch (scope) {
    case 'all': return true;
    case 'notes': return d.notes.length > 0;
    case 'highlights': return d.highlights.length > 0;
    case 'ocr': return d.ocr;
    case 'favorites': return d.fav;
    default: return d.folder === scope;
  }
}

/** Decide which field to quote in the result row. */
function locate(d, q) {
  const nq = norm(q);
  const note = d.notes.find((n) => norm(n).includes(nq));
  if (note) return { where: 'Note', snippet: snippet(note, q) };

  const hl = d.highlights.find((x) => norm(x).includes(nq));
  if (hl) return { where: 'Highlight', snippet: snippet(hl, q) };

  if (norm(d.body).includes(nq)) {
    return { where: d.ocr ? 'Scanned text' : 'Text', snippet: snippet(d.body, q) };
  }
  if (norm(d.title).includes(nq)) return { where: 'Title', snippet: snippet(d.body, q, 110) };
  if (d.tags.some((t) => norm(t).includes(nq))) return { where: 'Tag', snippet: d.tags.join(', ') };
  return { where: 'Match', snippet: snippet(d.body, q, 110) };
}

/** Find every occurrence within one document — the reader's in-document search. */
export function findInDoc(doc, query) {
  const q = String(query || '').trim();
  if (q.length < 2) return [];
  const re = new RegExp(escapeRe(q), 'gi');
  const hits = [];
  (doc.blocks || []).forEach((b, blockIdx) => {
    if (!b.text) return;
    let m;
    re.lastIndex = 0;
    while ((m = re.exec(b.text))) {
      hits.push({ blockIdx, start: m.index, end: m.index + m[0].length, snippet: snippet(b.text, q) });
      if (hits.length > 400) return; // pathological query guard
    }
  });
  return hits;
}

/** Suggestions for the empty search box: recent titles and common tags. */
export async function suggestions(limit = 6) {
  if (!index) await build();
  return [...index.docs.values()]
    .sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0))
    .slice(0, limit)
    .map((d) => ({ id: d.id, title: d.title, kind: d.kind }));
}
