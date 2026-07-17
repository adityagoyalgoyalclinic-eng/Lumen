/**
 * Text analysis: segmentation, statistics, readability, keywords.
 *
 * Sentence segmentation is the backbone of the whole product — it defines what the
 * reader highlights, what TTS speaks as one utterance, and what "next sentence" seeks
 * to. We use Intl.Segmenter where available (correct for CJK, Thai, and locale-aware
 * abbreviation handling) and fall back to a regex tuned for common English pitfalls.
 */

const ABBR = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'mt', 'rev', 'hon', 'gen', 'col',
  'lt', 'sgt', 'capt', 'cmdr', 'vs', 'etc', 'eg', 'ie', 'al', 'fig', 'no', 'vol', 'op',
  'inc', 'ltd', 'co', 'corp', 'dept', 'univ', 'approx', 'apt', 'ave', 'blvd', 'rd',
  'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
  'a.m', 'p.m', 'u.s', 'u.k', 'e.g', 'i.e', 'ph.d', 'm.d', 'b.a', 'm.a',
]);

const hasSegmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function';

/**
 * Split text into sentences.
 * @param {string} text
 * @param {string} [locale='en']
 * @returns {string[]} Trimmed, non-empty sentences in document order.
 */
export function sentences(text, locale = 'en') {
  const src = String(text || '').replace(/\s+/g, ' ').trim();
  if (!src) return [];

  let raw;
  if (hasSegmenter) {
    try {
      const seg = new Intl.Segmenter(locale, { granularity: 'sentence' });
      raw = [...seg.segment(src)].map((s) => s.segment);
    } catch {
      raw = regexSplit(src);
    }
  } else {
    raw = regexSplit(src);
  }

  // Intl.Segmenter still breaks after "Dr." and after initials like "J. R. R." —
  // stitch those fragments back onto the following sentence.
  const out = [];
  for (const piece of raw) {
    const s = piece.trim();
    if (!s) continue;
    const prev = out[out.length - 1];
    if (prev && endsWithAbbrev(prev)) out[out.length - 1] = `${prev} ${s}`;
    else out.push(s);
  }

  // Very long sentences (bad OCR, minified text, missing punctuation) would stall TTS
  // and make highlighting useless. Break them on clause boundaries as a safety valve.
  const capped = [];
  for (const s of out) {
    if (s.length <= 420) capped.push(s);
    else capped.push(...softBreak(s, 420));
  }
  return capped;
}

function regexSplit(src) {
  return src.match(/[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g) || [src];
}

function endsWithAbbrev(s) {
  const m = s.match(/(?:^|\s)([A-Za-z][A-Za-z.]*)\.$/);
  if (!m) return false;
  const w = m[1].toLowerCase().replace(/\.$/, '');
  if (ABBR.has(w)) return true;
  // Single capital letter = initial ("J." in "J. R. R. Tolkien").
  return /^[A-Za-z]$/.test(m[1]);
}

function softBreak(s, max) {
  const parts = [];
  let buf = '';
  for (const clause of s.split(/(?<=[,;:—–)])\s+/)) {
    if (buf && (buf + ' ' + clause).length > max) {
      parts.push(buf);
      buf = clause;
    } else {
      buf = buf ? `${buf} ${clause}` : clause;
    }
  }
  if (buf) parts.push(buf);
  // Still oversized (no clause markers at all) — hard-slice on word boundaries.
  return parts.flatMap((p) => (p.length <= max ? [p] : chunkWords(p, max)));
}

function chunkWords(s, max) {
  const out = [];
  let buf = '';
  for (const w of s.split(' ')) {
    if (buf && (buf + ' ' + w).length > max) {
      out.push(buf);
      buf = w;
    } else buf = buf ? `${buf} ${w}` : w;
  }
  if (buf) out.push(buf);
  return out;
}

/** Split into words using Intl where available. */
export function words(text, locale = 'en') {
  const src = String(text || '');
  if (hasSegmenter) {
    try {
      const seg = new Intl.Segmenter(locale, { granularity: 'word' });
      return [...seg.segment(src)].filter((s) => s.isWordLike).map((s) => s.segment);
    } catch { /* fall through */ }
  }
  return src.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || [];
}

export const countWords = (text) => words(text).length;

/**
 * Estimated silent reading time.
 * @param {number} wordCount
 * @param {number} [wpm=225] - Adult average for non-technical prose.
 * @returns {number} minutes, minimum 1
 */
export const readMinutes = (wordCount, wpm = 225) => Math.max(1, Math.round(wordCount / wpm));

/**
 * Estimated listening time at a given playback rate.
 * Speech runs ~155 wpm at 1×, which is why listening takes longer than reading.
 */
export const listenSeconds = (wordCount, rate = 1) => Math.round((wordCount / (155 * rate)) * 60);

/** Count syllables in an English word — the heuristic behind Flesch scoring. */
export function syllables(word) {
  const w = String(word).toLowerCase().replace(/[^a-z]/g, '');
  if (!w) return 0;
  if (w.length <= 3) return 1;
  const trimmed = w
    .replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '')
    .replace(/^y/, '');
  const groups = trimmed.match(/[aeiouy]{1,2}/g);
  return Math.max(1, groups ? groups.length : 1);
}

/**
 * Readability via Flesch Reading Ease + Flesch–Kincaid grade level.
 * Only meaningful for English prose; callers show it as guidance, not gospel.
 * @returns {{score:number, grade:number, label:string, tone:'ok'|'warn'|'danger'}}
 */
export function readability(text) {
  const sents = sentences(text);
  const ws = words(text);
  if (!sents.length || !ws.length) {
    return { score: 0, grade: 0, label: 'Unknown', tone: 'ok' };
  }
  const syl = ws.reduce((n, w) => n + syllables(w), 0);
  const wps = ws.length / sents.length;
  const spw = syl / ws.length;
  const score = Math.max(0, Math.min(100, 206.835 - 1.015 * wps - 84.6 * spw));
  const grade = Math.max(1, Math.round((0.39 * wps + 11.8 * spw - 15.59) * 10) / 10);

  let label = 'Very difficult';
  let tone = 'danger';
  if (score >= 80) { label = 'Very easy'; tone = 'ok'; }
  else if (score >= 65) { label = 'Easy'; tone = 'ok'; }
  else if (score >= 50) { label = 'Moderate'; tone = 'ok'; }
  else if (score >= 35) { label = 'Difficult'; tone = 'warn'; }

  return { score: Math.round(score), grade, label, tone };
}

const STOP = new Set(`a about above after again against all am an and any are aren't as at be because been
before being below between both but by can cannot could couldn't did didn't do does doesn't doing don't down
during each few for from further had hadn't has hasn't have haven't having he he'd he'll he's her here here's
hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself let's me more
most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't
she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there
there's these they they'd they'll they're they've this those through to too under until up very was wasn't we
we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's
with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves also may might must shall
will just now new one two three said says say get got make made also many much use used using`.split(/\s+/));

/**
 * Extract keywords by term frequency, weighted toward multi-word phrases and
 * capitalised terms. Runs fully offline — this is the no-API-key fallback for the
 * "Extract Keywords" AI action, and it is genuinely useful on its own.
 * @returns {{term:string, count:number, weight:number}[]}
 */
export function keywords(text, limit = 14) {
  const ws = words(text);
  const freq = new Map();
  const bump = (term, by = 1) => freq.set(term, (freq.get(term) || 0) + by);

  for (let i = 0; i < ws.length; i++) {
    const w = ws[i];
    const lo = w.toLowerCase();
    if (lo.length < 3 || STOP.has(lo) || /^\d+$/.test(lo)) continue;
    // Capitalised mid-sentence usually means a proper noun — worth more.
    bump(lo, /^[A-Z]/.test(w) && i > 0 ? 1.6 : 1);

    const next = ws[i + 1];
    if (next) {
      const nlo = next.toLowerCase();
      if (nlo.length >= 3 && !STOP.has(nlo) && !/^\d+$/.test(nlo)) {
        bump(`${lo} ${nlo}`, 1.4); // bigrams carry more meaning than either half
      }
    }
  }

  const total = ws.length || 1;
  return [...freq.entries()]
    .filter(([t, c]) => c >= (t.includes(' ') ? 2.8 : 2))
    .map(([term, count]) => ({ term, count: Math.round(count), weight: count / total }))
    .sort((a, b) => b.count - a.count)
    .slice(0, limit);
}

/**
 * Extractive summary: rank sentences by keyword density, position, and length,
 * then return the top `n` in original document order so it still reads as prose.
 * This is the offline fallback for "Generate Summary".
 */
export function extractiveSummary(text, n = 5) {
  const sents = sentences(text);
  if (sents.length <= n) return sents;

  const kw = new Map(keywords(text, 40).map((k) => [k.term, k.count]));
  const scored = sents.map((s, i) => {
    const sw = words(s).map((w) => w.toLowerCase());
    if (sw.length < 5) return { s, i, score: -1 };
    let score = 0;
    for (const w of sw) score += kw.get(w) || 0;
    score /= Math.sqrt(sw.length); // normalise so long sentences don't just win
    // Opening and closing sentences of a document carry disproportionate signal.
    if (i < 3) score *= 1.35;
    if (i > sents.length - 3) score *= 1.1;
    return { s, i, score };
  });

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.s);
}

/**
 * Long words that are common enough to need no explanation.
 *
 * Length and syllable count alone are a poor proxy for difficulty: "decisions",
 * "important", and "everything" all clear a naive bar while being words a ten-year-old
 * knows. Without a frequency corpus (which would cost hundreds of kilobytes to ship),
 * an explicit list of the common long words is the honest trade — it removes the
 * embarrassing false positives at negligible cost.
 */
const COMMON_LONG = new Set(`decision decisions important different everything something anything
nothing themselves yourself ourselves understand understanding remember remembered together
american national international government president company companies business businesses
question questions problem problems example examples experience experiences interesting
information education educational family families children personal personally possible
possibly probably actually usually generally completely certainly especially particularly
available difficult already another because before between another however therefore
although through thought thoughts without within around during against himself herself
including followed following continue continued consider considered practical suggestion
mathematics ordinary environment deliberation`.split(/\s+/).filter(Boolean));

/**
 * Words a general reader may stumble on — powers "Explain Difficult Words" offline.
 * Requires length, syllable count, and absence from the common-word lists.
 */
export function hardWords(text, limit = 12) {
  const seen = new Map();
  for (const w of words(text)) {
    const lo = w.toLowerCase().replace(/[’']s$/, '');
    if (lo.length < 9 || STOP.has(lo) || COMMON_LONG.has(lo)) continue;
    // Strip a plural/past-tense suffix before checking the common list, so
    // "decisions" is caught by "decision".
    const stem = lo.replace(/(?:s|es|ed|ing|ly)$/, '');
    if (COMMON_LONG.has(stem)) continue;
    if (syllables(lo) < 4) continue; // 3 syllables catches far too much ordinary prose
    seen.set(lo, (seen.get(lo) || 0) + 1);
  }
  return [...seen.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .slice(0, limit)
    .map(([term, count]) => ({ term, count }));
}

/** Case/diacritic-insensitive normalisation for search indexing. */
export const norm = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

/** Escape for building safe RegExps from user input. */
export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Escape text for safe interpolation into HTML. */
export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** A short snippet centred on the first match of `q`, for search results. */
export function snippet(text, q, len = 150) {
  const t = String(text || '');
  const i = norm(t).indexOf(norm(q));
  if (i < 0) return t.slice(0, len) + (t.length > len ? '…' : '');
  const start = Math.max(0, i - Math.floor(len / 3));
  const end = Math.min(t.length, start + len);
  return (start > 0 ? '…' : '') + t.slice(start, end).trim() + (end < t.length ? '…' : '');
}
