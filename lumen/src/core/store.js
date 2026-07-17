/**
 * Application state.
 *
 * A single observable object with topic-scoped subscriptions. Views subscribe to the
 * slices they render, so playback ticking 20×/second never re-renders the library.
 */

import * as db from './db.js';

/** @type {Map<string, Set<Function>>} */
const subs = new Map();

export const DEFAULT_SETTINGS = {
  theme: 'system', // system|light|dark|amoled
  accentHue: 262,
  dynamicColor: true, // derive accent from the current document's thumbnail
  contrast: 'normal', // normal|high
  motion: 'auto', // auto|reduced
  uiScale: 1,

  paper: 'light', // light|dark|sepia|paper|amoled
  fontFamily: 'serif', // sans|serif|mono|dyslexia
  fontSize: 19,
  lineHeight: 1.75,
  pageWidth: 68,
  paraSpacing: 1,
  textAlign: 'left',
  autoScroll: true,
  focusMode: false,
  wordHighlight: true,

  voiceURI: '',
  rate: 1,
  pitch: 1,
  volume: 1,
  lang: 'en-US',
  skipSilence: false,
  highlightSentence: true,

  aiProvider: 'local', // local|anthropic
  aiKey: '',
  aiModel: 'claude-sonnet-5',
  aiConsent: false, // must be true before any content leaves the device
  translateTo: 'es',

  encrypt: false,
  analytics: false,
  notifications: false,
  wifiOnlyDownloads: true,
  proxy: '', // optional CORS proxy for the website reader
};

export const state = {
  ready: false,
  route: { name: 'home', params: {} },
  settings: { ...DEFAULT_SETTINGS },
  user: null, // {id, name, email, provider} — null means guest
  docs: [], // metadata only
  doc: null, // full document open in the reader
  marks: [],
  player: {
    docId: null,
    playing: false,
    paused: false,
    idx: 0, // sentence index
    total: 0,
    rate: 1,
    elapsedMs: 0,
    title: '',
    queue: [], // upcoming doc ids
  },
  online: navigator.onLine,
  busy: null, // {label, pct} while importing/OCRing
};

/**
 * Subscribe to a topic.
 * @param {string} topic - 'settings'|'docs'|'doc'|'player'|'route'|'marks'|'user'|'busy'|'online'|'*'
 * @param {(state:typeof state)=>void} fn
 * @returns {() => void} unsubscribe
 */
export function on(topic, fn) {
  if (!subs.has(topic)) subs.set(topic, new Set());
  subs.get(topic).add(fn);
  return () => subs.get(topic)?.delete(fn);
}

/** Notify subscribers of one or more topics. */
export function emit(...topics) {
  for (const t of [...topics, '*']) {
    for (const fn of subs.get(t) || []) {
      try {
        fn(state);
      } catch (err) {
        console.error(`[store] subscriber for "${t}" threw`, err);
      }
    }
  }
}

/** Shallow-merge into a slice and emit that topic. */
export function set(topic, patch) {
  if (topic === 'settings' || topic === 'player') Object.assign(state[topic], patch);
  else state[topic] = patch;
  emit(topic);
}

/* ------------------------------ Settings ------------------------------ */

export async function loadSettings() {
  const saved = await db.kvGet('settings', {});
  // Merge over defaults so a new setting in a later release lands with a sane value.
  state.settings = { ...DEFAULT_SETTINGS, ...saved };
  state.user = await db.kvGet('user', null);
  emit('settings', 'user');
  return state.settings;
}

let saveTimer = null;

/** Update settings; persistence is debounced so dragging a slider isn't 60 writes. */
export function setSetting(key, value) {
  state.settings[key] = value;
  emit('settings');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.kvSet('settings', state.settings).catch(console.error), 220);
}

export function setSettings(patch) {
  Object.assign(state.settings, patch);
  emit('settings');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => db.kvSet('settings', state.settings).catch(console.error), 220);
}

/* ------------------------------ Documents ------------------------------ */

export async function refreshDocs() {
  state.docs = await db.listDocs({ sort: 'updated' });
  emit('docs');
  return state.docs;
}

export async function openDoc(id) {
  const doc = await db.getDoc(id);
  if (!doc) return null;
  state.doc = doc;
  state.marks = await db.marksFor(id);
  emit('doc', 'marks');
  await db.patchDoc(id, { openedAt: Date.now() });
  refreshDocs();
  return doc;
}

/* ------------------------------ Session ------------------------------ */

export async function setUser(user) {
  state.user = user;
  await db.kvSet('user', user);
  emit('user');
}

export function busy(label, pct = null) {
  state.busy = label ? { label, pct } : null;
  emit('busy');
}

window.addEventListener('online', () => {
  state.online = true;
  emit('online');
});
window.addEventListener('offline', () => {
  state.online = false;
  emit('online');
});
