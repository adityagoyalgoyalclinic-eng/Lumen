/**
 * AI features.
 *
 * Two providers behind one interface:
 *
 *   'local'      Runs on-device. No network, no key, no data leaves the machine.
 *                Genuinely useful for the extractive tasks (summary, keywords, study
 *                notes, action items, timeline, hard words) and honest about the rest.
 *   'anthropic'  Full quality via the Claude API, for every action including the
 *                generative ones (explain simply, translate, Q&A, quiz).
 *
 * Consent is a hard gate, not a checkbox we read later: `assertConsent()` throws before
 * any request is built. The default provider is 'local', so a user who never opens
 * Settings never sends a byte anywhere. That's a deliberate product stance — people
 * import medical letters and legal documents into this app.
 *
 * Results are cached in IndexedDB per (doc, action, language) so reopening a summary
 * is instant and free.
 */

import { state } from '../core/store.js';
import * as db from '../core/db.js';
import { extractiveSummary, keywords, hardWords, sentences, countWords } from '../util/text.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

/** Catalogue of actions. `local` marks those with a real on-device implementation. */
export const ACTIONS = [
  { id: 'summary', label: 'Summary', icon: 'sparkle', local: true, desc: 'The gist in a few sentences' },
  { id: 'bullets', label: 'Bullet points', icon: 'list', local: true, desc: 'Key takeaways as a list' },
  { id: 'simplify', label: 'Explain simply', icon: 'info', local: false, desc: 'Plain language, no jargon' },
  { id: 'translate', label: 'Translate', icon: 'translate', local: false, desc: 'Into another language' },
  { id: 'ask', label: 'Ask a question', icon: 'quiz', local: false, desc: 'Answers grounded in this document' },
  { id: 'flashcards', label: 'Flashcards', icon: 'cards', local: false, desc: 'Question and answer pairs' },
  { id: 'quiz', label: 'Quiz', icon: 'quiz', local: false, desc: 'Test yourself' },
  { id: 'keywords', label: 'Keywords', icon: 'filter', local: true, desc: 'The terms that carry the text' },
  { id: 'definitions', label: 'Definitions', icon: 'book', local: true, desc: 'Terms this document defines' },
  { id: 'notes', label: 'Study notes', icon: 'note', local: true, desc: 'Structured revision notes' },
  { id: 'important', label: 'Key sections', icon: 'star', local: true, desc: 'The passages that matter most' },
  { id: 'todos', label: 'Action items', icon: 'check', local: true, desc: 'What needs doing' },
  { id: 'timeline', label: 'Timeline', icon: 'clock', local: true, desc: 'Events in order' },
  { id: 'hard', label: 'Difficult words', icon: 'font', local: true, desc: 'Explain the hard vocabulary' },
];

export const LANGS = [
  { code: 'es', label: 'Spanish' }, { code: 'fr', label: 'French' }, { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' }, { code: 'pt', label: 'Portuguese' }, { code: 'nl', label: 'Dutch' },
  { code: 'pl', label: 'Polish' }, { code: 'ru', label: 'Russian' }, { code: 'tr', label: 'Turkish' },
  { code: 'ar', label: 'Arabic' }, { code: 'hi', label: 'Hindi' }, { code: 'bn', label: 'Bengali' },
  { code: 'ja', label: 'Japanese' }, { code: 'ko', label: 'Korean' }, { code: 'zh', label: 'Chinese' },
  { code: 'en', label: 'English' },
];

/** Thrown when a cloud action is attempted without consent — the UI catches this. */
export class ConsentError extends Error {
  constructor() {
    super('Sending this document to an AI provider needs your permission first.');
    this.name = 'ConsentError';
  }
}

export class NeedsKeyError extends Error {
  constructor() {
    super('Add an API key in Settings → AI to use this feature.');
    this.name = 'NeedsKeyError';
  }
}

function assertConsent() {
  const { aiProvider, aiConsent, aiKey } = state.settings;
  if (aiProvider === 'local') return;
  if (!aiConsent) throw new ConsentError();
  if (!aiKey) throw new NeedsKeyError();
}

/** Is this action available right now, and if not, why? */
export function availability(actionId) {
  const a = ACTIONS.find((x) => x.id === actionId);
  const cloud = state.settings.aiProvider !== 'local';
  if (cloud && state.settings.aiConsent && state.settings.aiKey) return { ok: true, mode: 'cloud' };
  if (a?.local) return { ok: true, mode: 'local' };
  return { ok: false, mode: 'none', reason: 'Needs an AI provider — set one up in Settings.' };
}

/**
 * Run an AI action against a document.
 * @param {string} actionId
 * @param {Doc} doc
 * @param {{question?:string, lang?:string, force?:boolean, signal?:AbortSignal}} [opts]
 * @returns {Promise<{mode:'local'|'cloud', kind:string, data:any, cached?:boolean}>}
 */
export async function run(actionId, doc, opts = {}) {
  const lang = opts.lang || state.settings.translateTo;
  const cacheKey = actionId === 'ask' ? null : actionId; // questions are never cached
  const cacheLang = actionId === 'translate' ? lang : 'en';

  if (cacheKey && !opts.force) {
    const hit = await db.getAi(doc.id, cacheKey, cacheLang);
    if (hit) return { ...hit.payload, cached: true };
  }

  const text = docText(doc);
  if (!text.trim()) throw new Error('This document has no text to work with.');

  const avail = availability(actionId);
  if (!avail.ok) throw new Error(avail.reason);

  let result;
  if (avail.mode === 'cloud') {
    assertConsent();
    result = await cloud(actionId, text, doc, { ...opts, lang });
  } else {
    result = local(actionId, text, doc, { ...opts, lang });
  }

  if (cacheKey) await db.putAi(doc.id, cacheKey, cacheLang, result);
  return result;
}

/**
 * Flatten a document to plain text for analysis.
 *
 * Headings get a full stop appended when they lack terminal punctuation. Without it the
 * sentence splitter — which normalises whitespace — welds the heading onto the first
 * sentence beneath it ("The Catch The trouble is that…"), which then poisons every
 * extractive feature that ranks sentences.
 */
export const docText = (doc) =>
  (doc.blocks || [])
    .filter((b) => b.text && b.type !== 'code')
    .map((b) => {
      const t = b.text.trim();
      return /^h[1-6]$/.test(b.type) && !/[.!?:;]$/.test(t) ? `${t}.` : t;
    })
    .join('\n\n');

/**
 * Prose only — headings excluded.
 *
 * Summaries and key-passage extraction rank sentences, and a heading is a label, not a
 * sentence: it is short, keyword-dense, and sits at position zero, so every ranking
 * heuristic loves it and a summary that opens with the document's own title tells the
 * reader nothing. Keywords and study notes still use the full text, where headings are
 * genuine signal.
 */
export const docProse = (doc) =>
  (doc.blocks || [])
    .filter((b) => b.text && b.type !== 'code' && !/^h[1-6]$/.test(b.type))
    .map((b) => b.text.trim())
    .join('\n\n');

/* ============================ Local ============================ */

function local(action, text, doc, opts) {
  // Sentence-ranking actions read prose only; see docProse() for why.
  const prose = docProse(doc) || text;

  switch (action) {
    case 'summary': {
      const n = Math.min(7, Math.max(3, Math.round(countWords(prose) / 400)));
      return { mode: 'local', kind: 'prose', data: extractiveSummary(prose, n).join(' ') };
    }
    case 'bullets':
      return { mode: 'local', kind: 'list', data: extractiveSummary(prose, 7).map(trimBullet) };

    case 'keywords':
      return { mode: 'local', kind: 'chips', data: keywords(text, 18).map((k) => k.term) };

    case 'hard':
      return {
        mode: 'local',
        kind: 'pairs',
        data: hardWords(text, 12).map((w) => ({
          term: w.term,
          value: contextFor(text, w.term) || `Appears ${w.count} time${w.count > 1 ? 's' : ''} in this document.`,
        })),
      };

    case 'definitions':
      return { mode: 'local', kind: 'pairs', data: findDefinitions(text) };

    case 'important':
      return { mode: 'local', kind: 'list', data: extractiveSummary(prose, 6) };

    case 'todos':
      return { mode: 'local', kind: 'list', data: findTodos(text) };

    case 'timeline':
      return { mode: 'local', kind: 'timeline', data: findTimeline(text) };

    case 'notes':
      return { mode: 'local', kind: 'notes', data: buildNotes(text, prose, doc) };

    default:
      throw new Error(`"${action}" needs a cloud AI provider. Set one up in Settings → AI.`);
  }
  void opts;
}

const trimBullet = (s) => s.replace(/^\W+/, '').replace(/\s+/g, ' ').trim();

/** A sentence containing the term, as lightweight context. */
function contextFor(text, term) {
  const hit = sentences(text).find((s) => s.toLowerCase().includes(term.toLowerCase()));
  return hit && hit.length < 240 ? hit : null;
}

/**
 * Pronouns and determiners that open a sentence. Without excluding these, "These are
 * the stories we tell" is read as defining the term "These".
 */
const NON_TERMS = new Set([
  'this', 'that', 'these', 'those', 'it', 'they', 'there', 'here', 'he', 'she', 'we',
  'you', 'i', 'who', 'what', 'which', 'some', 'many', 'most', 'both', 'all', 'each',
  'one', 'two', 'others', 'people', 'things', 'everything', 'nothing', 'something',
]);

/**
 * Clause openers that follow the copula in ordinary prose rather than a definition.
 * "The trouble is that ordinary decisions..." is a sentence, not a definition of
 * "trouble"; a real definition continues with a noun phrase, not a subordinate clause.
 */
const CLAUSE_OPENERS = /^(?:that|what|why|how|when|where|whether|because|not|no|so|just|only|still|now|also|about to|going to|likely|unlikely|possible|impossible|clear|obvious|true|false|hard|easy|difficult|important|interesting)\b/i;

/**
 * Terms this document explicitly defines: "X is a …", "X means …", "X refers to …".
 *
 * Pattern-matching definitions out of prose is inherently noisy — English uses "is"
 * for far more than definition. This errs strongly toward precision: it would rather
 * return three real definitions than ten with two embarrassing false positives, since
 * a wrong "definition" is worse than a missing one. Anything subtler is a job for the
 * cloud model.
 */
function findDefinitions(text) {
  const out = [];
  const re = /^(?:The\s+|An?\s+)?([A-Za-z][\w'’-]*(?:\s+[\w'’-]+){0,3}?)\s+(?:is|are|means|refers to|is defined as|is called|denotes)\s+(?:an?\s+|the\s+)?(.{12,200}?)[.;]/;

  const lower = text.toLowerCase();
  const occurrences = (t) => lower.split(t.toLowerCase()).length - 1;

  for (const s of sentences(text)) {
    const m = re.exec(s.trim());
    if (!m) continue;

    const term = m[1].trim().replace(/^(?:The|An?)\s+/i, '');
    const value = m[2].trim();
    const first = term.toLowerCase().split(/\s+/)[0];

    if (!term || term.split(/\s+/).length > 4) continue;
    if (NON_TERMS.has(first) || STOP_OPENERS.has(first)) continue;
    // The definition body must be a noun phrase, not a subordinate clause.
    if (CLAUSE_OPENERS.test(value)) continue;
    // A real term recurs; a one-off phrase is almost always a false positive.
    if (occurrences(term) < 2) continue;
    if (out.some((o) => o.term.toLowerCase() === term.toLowerCase())) continue;

    out.push({ term, value });
    if (out.length >= 14) break;
  }
  return out;
}

/** Sentence-opening words that are never the subject of a definition. */
const STOP_OPENERS = new Set([
  'over', 'under', 'after', 'before', 'during', 'through', 'within', 'without',
  'above', 'below', 'across', 'around', 'between', 'beyond', 'since', 'until',
  'consider', 'imagine', 'suppose', 'given', 'here', 'there', 'then', 'thus',
  'today', 'yesterday', 'tomorrow', 'result', 'reason', 'point', 'trouble',
  'problem', 'question', 'answer', 'idea', 'thing', 'way', 'part', 'rest',
  'mathematics', 'finding', 'catch',
]);

/** Imperative / obligation sentences — the offline "action items". */
function findTodos(text) {
  const re = /\b(?:must|should|need(?:s)? to|have to|has to|required to|action item|to-?do|next step|please|ensure|make sure|remember to|don't forget|deadline|due by|submit|schedule|follow up|review|send|complete)\b/i;
  const out = [];
  for (const s of sentences(text)) {
    if (!re.test(s)) continue;
    const t = s.trim();
    if (t.length < 18 || t.length > 260) continue;
    out.push(t);
    if (out.length >= 12) break;
  }
  return out;
}

/** Sentences carrying a date or year, ordered as they appear. */
function findTimeline(text) {
  const DATE = /\b(?:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2},?\s*(?:\d{4})?|\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s*\d{0,4}|\b(?:1[5-9]|20)\d{2}\b|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b)/;
  const out = [];
  for (const s of sentences(text)) {
    const m = DATE.exec(s);
    if (!m) continue;
    const t = s.trim();
    if (t.length > 240) continue;
    out.push({ when: m[0], what: t });
    if (out.length >= 16) break;
  }
  return out;
}

/**
 * Study notes. The outline and keywords want headings (they are the document's own
 * structure); the overview and key points want prose only.
 */
function buildNotes(text, prose, doc) {
  const heads = (doc.blocks || []).filter((b) => /^h[1-3]$/.test(b.type)).map((b) => b.text);
  return {
    overview: extractiveSummary(prose, 3).join(' '),
    outline: heads.slice(0, 20),
    key: extractiveSummary(prose, 6).map(trimBullet),
    terms: keywords(text, 12).map((k) => k.term),
    stats: { words: countWords(prose), sentences: sentences(prose).length },
  };
}

/* ============================ Cloud (Claude) ============================ */

/**
 * Trim to a token budget. We send the head and tail of very long documents rather
 * than truncating: conclusions carry as much signal as introductions, and a summary
 * that stops at chapter three is worse than one built from both ends.
 */
function fit(text, maxChars = 160000) {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2) - 60;
  return `${text.slice(0, half)}\n\n[… middle of the document omitted for length …]\n\n${text.slice(-half)}`;
}

const PROMPTS = {
  summary: () => ({
    kind: 'prose',
    sys: 'You summarise documents for a listening app. Write flowing prose that sounds natural read aloud. No headings, no bullets, no markdown.',
    user: (t) => `Summarise this in 4-6 sentences. Capture the main argument and the most important specifics.\n\n<document>\n${t}\n</document>`,
  }),
  bullets: () => ({
    kind: 'list',
    sys: 'You extract key points. Reply with one point per line. No numbering, no bullet characters, no markdown.',
    user: (t) => `List the 5-8 most important takeaways, one per line.\n\n<document>\n${t}\n</document>`,
  }),
  simplify: () => ({
    kind: 'prose',
    sys: 'You explain complex material in plain language a curious 12-year-old could follow, without dumbing down the facts. Natural prose, no markdown.',
    user: (t) => `Explain what this document says in simple, everyday language.\n\n<document>\n${t}\n</document>`,
  }),
  translate: (o) => ({
    kind: 'prose',
    sys: `You are a professional translator. Translate faithfully into ${langName(o.lang)}, preserving tone and meaning. Output only the translation, no notes, no markdown.`,
    user: (t) => `Translate into ${langName(o.lang)}:\n\n<document>\n${t}\n</document>`,
  }),
  ask: (o) => ({
    kind: 'prose',
    sys: 'You answer questions strictly from the provided document. If the answer is not in it, say so plainly rather than guessing. Natural prose, no markdown.',
    user: (t) => `<document>\n${t}\n</document>\n\nQuestion: ${o.question}`,
  }),
  flashcards: () => ({
    kind: 'cards',
    sys: 'You create study flashcards. Reply ONLY with a JSON array of {"q","a"} objects. No prose, no code fence.',
    user: (t) => `Create 8-12 flashcards covering the key facts.\n\n<document>\n${t}\n</document>`,
  }),
  quiz: () => ({
    kind: 'quiz',
    sys: 'You write multiple-choice quizzes. Reply ONLY with a JSON array of {"q","options":[4 strings],"answer":<0-3>,"why"} objects. No prose, no code fence.',
    user: (t) => `Write a 6-question multiple-choice quiz. Make the wrong options plausible.\n\n<document>\n${t}\n</document>`,
  }),
  keywords: () => ({
    kind: 'chips',
    sys: 'Reply ONLY with a JSON array of strings. No prose, no code fence.',
    user: (t) => `Extract the 12-18 most significant terms.\n\n<document>\n${t}\n</document>`,
  }),
  definitions: () => ({
    kind: 'pairs',
    sys: 'Reply ONLY with a JSON array of {"term","value"} objects. No prose, no code fence.',
    user: (t) => `List the terms this document defines, with their definitions as given.\n\n<document>\n${t}\n</document>`,
  }),
  notes: () => ({
    kind: 'notes',
    sys: 'Reply ONLY with a JSON object {"overview":string,"outline":string[],"key":string[],"terms":string[]}. No code fence.',
    user: (t) => `Produce structured study notes.\n\n<document>\n${t}\n</document>`,
  }),
  important: () => ({
    kind: 'list',
    sys: 'You identify the passages that matter most. Quote them verbatim, one per line, no markdown.',
    user: (t) => `Quote the 5-7 most important passages verbatim, one per line.\n\n<document>\n${t}\n</document>`,
  }),
  todos: () => ({
    kind: 'list',
    sys: 'You extract action items. One per line, phrased as a clear task. No markdown. If there are none, reply exactly: NONE',
    user: (t) => `List every action item, task, or commitment.\n\n<document>\n${t}\n</document>`,
  }),
  timeline: () => ({
    kind: 'timeline',
    sys: 'Reply ONLY with a JSON array of {"when","what"} objects in chronological order. No code fence. If there are no dated events, reply []',
    user: (t) => `Extract the dated events.\n\n<document>\n${t}\n</document>`,
  }),
  hard: () => ({
    kind: 'pairs',
    sys: 'Reply ONLY with a JSON array of {"term","value"} objects where value is a one-sentence plain-English meaning as used here. No code fence.',
    user: (t) => `Find the 8-12 words a general reader would struggle with, and explain each.\n\n<document>\n${t}\n</document>`,
  }),
};

const langName = (c) => LANGS.find((l) => l.code === c)?.label || c;

async function cloud(action, text, doc, opts) {
  const make = PROMPTS[action];
  if (!make) throw new Error(`Unknown action "${action}".`);
  const spec = make(opts);

  const body = {
    model: state.settings.aiModel || 'claude-sonnet-5',
    max_tokens: action === 'translate' ? 8000 : 2400,
    system: spec.sys,
    messages: [{ role: 'user', content: spec.user(fit(text)) }],
  };

  const res = await fetch(API_URL, {
    method: 'POST',
    signal: opts.signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': state.settings.aiKey,
      'anthropic-version': '2023-06-01',
      // Required for browser-origin calls; without it the API rejects the request.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
  }).catch((err) => {
    if (err.name === 'AbortError') throw err;
    throw new Error('Could not reach the AI provider. Check your connection.');
  });

  if (!res.ok) throw await apiError(res);

  const json = await res.json();
  const out = (json.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
  if (!out) throw new Error('The AI returned an empty response.');

  return { mode: 'cloud', kind: spec.kind, data: shape(spec.kind, out) };
}

async function apiError(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = j?.error?.message || '';
  } catch { /* non-JSON error body */ }

  if (res.status === 401) return new Error('That API key was rejected. Check it in Settings → AI.');
  if (res.status === 429) return new Error('Rate limited by the AI provider. Wait a moment and retry.');
  if (res.status === 400 && /credit|balance/i.test(detail)) return new Error('Your AI account is out of credit.');
  if (res.status >= 500) return new Error('The AI provider is having trouble. Try again shortly.');
  return new Error(detail || `AI request failed (${res.status}).`);
}

/** Coerce a model response into the shape the UI expects. */
function shape(kind, raw) {
  switch (kind) {
    case 'prose':
      return raw;
    case 'list':
      if (/^NONE$/i.test(raw.trim())) return [];
      return raw.split('\n').map((l) => l.replace(/^[\s•\-*\d.)]+/, '').trim()).filter(Boolean);
    case 'chips':
    case 'cards':
    case 'quiz':
    case 'pairs':
    case 'timeline':
    case 'notes':
      return parseJson(raw, kind);
    default:
      return raw;
  }
}

/** Models occasionally wrap JSON in a fence or preamble; recover it rather than fail. */
function parseJson(raw, kind) {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    return JSON.parse(s);
  } catch { /* try harder */ }

  const open = kind === 'notes' ? '{' : '[';
  const close = kind === 'notes' ? '}' : ']';
  const a = s.indexOf(open);
  const b = s.lastIndexOf(close);
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch { /* fall through */ }
  }
  throw new Error("The AI's response wasn't in the expected format. Try again.");
}

/** Speakable text for any result — the "listen to the summary" button. */
export function speakable(result) {
  const { kind, data } = result;
  switch (kind) {
    case 'prose': return String(data);
    case 'list': return data.join('. ');
    case 'chips': return `Key terms: ${data.join(', ')}.`;
    case 'pairs': return data.map((p) => `${p.term}. ${p.value}`).join('. ');
    case 'timeline': return data.map((t) => `${t.when}. ${t.what}`).join('. ');
    case 'cards': return data.map((c) => `${c.q} ${c.a}`).join('. ');
    case 'quiz': return data.map((q, i) => `Question ${i + 1}. ${q.q}`).join('. ');
    case 'notes': return [data.overview, ...(data.key || [])].join('. ');
    default: return '';
  }
}
