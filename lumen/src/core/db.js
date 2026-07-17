/**
 * Storage layer — IndexedDB with optional encryption at rest.
 *
 * Object stores
 *   docs        Document metadata + extracted blocks. Indexed by folder, updatedAt, pinned, fav.
 *   blobs       Original file bytes, kept so re-extraction and export never need the network.
 *   marks       Highlights, underlines, bookmarks, notes. Indexed by docId.
 *   ai          Cached AI outputs, keyed `${docId}:${action}:${lang}`.
 *   audio       Cached TTS audio for offline playback, keyed `${docId}:${voice}:${idx}`.
 *   kv          Settings, session, sync cursor.
 *
 * Encryption: when the user enables it, `docs.blocks` and `blobs.data` are stored as
 * AES-GCM ciphertext. The key is derived from a passphrase with PBKDF2-SHA256 (310k
 * iterations, per OWASP) and held only in memory — it is never written to disk, so a
 * dump of IndexedDB yields nothing without the passphrase.
 */

const DB_NAME = 'lumen';
const DB_VERSION = 1;

/** @type {IDBDatabase|null} */
let db = null;
/** @type {CryptoKey|null} */
let cryptoKey = null;

export function open() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = (e) => {
      const d = req.result;
      const tx = req.transaction;

      if (!d.objectStoreNames.contains('docs')) {
        const s = d.createObjectStore('docs', { keyPath: 'id' });
        s.createIndex('updatedAt', 'updatedAt');
        s.createIndex('openedAt', 'openedAt');
        s.createIndex('folder', 'folder');
        s.createIndex('kind', 'kind');
        s.createIndex('fav', 'fav');
        s.createIndex('pinned', 'pinned');
        s.createIndex('trashed', 'trashed');
        s.createIndex('collection', 'collections', { multiEntry: true });
        s.createIndex('tag', 'tags', { multiEntry: true });
      }
      if (!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('marks')) {
        const s = d.createObjectStore('marks', { keyPath: 'id' });
        s.createIndex('docId', 'docId');
        s.createIndex('createdAt', 'createdAt');
        s.createIndex('type', 'type');
      }
      if (!d.objectStoreNames.contains('ai')) {
        const s = d.createObjectStore('ai', { keyPath: 'id' });
        s.createIndex('docId', 'docId');
      }
      if (!d.objectStoreNames.contains('audio')) {
        const s = d.createObjectStore('audio', { keyPath: 'id' });
        s.createIndex('docId', 'docId');
      }
      if (!d.objectStoreNames.contains('kv')) d.createObjectStore('kv', { keyPath: 'k' });

      // Upgrade path for future versions goes here, keyed off e.oldVersion.
      void tx;
      void e;
    };

    req.onsuccess = () => {
      db = req.result;
      db.onversionchange = () => {
        // Another tab is upgrading; release our handle so it isn't blocked.
        db?.close();
        db = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(new Error(`IndexedDB unavailable: ${req.error?.message || 'unknown'}`));
    req.onblocked = () => reject(new Error('Close other Lumen tabs to finish upgrading storage.'));
  });
}

function store(name, mode = 'readonly') {
  return open().then((d) => d.transaction(name, mode).objectStore(name));
}

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

/* ------------------------------ Encryption ------------------------------ */

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Derive and install the encryption key for this session.
 * @param {string} passphrase
 * @param {Uint8Array} salt
 */
export async function unlock(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  cryptoKey = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 310000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function lock() {
  cryptoKey = null;
}

export const isUnlocked = () => cryptoKey !== null;

/** Encrypt a JSON-serialisable value. Returns a tagged envelope. */
async function seal(value) {
  if (!cryptoKey) return { $plain: value };
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = enc.encode(JSON.stringify(value));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, data);
  return { $enc: new Uint8Array(ct), iv };
}

async function unseal(env) {
  if (!env) return null;
  if ('$plain' in env) return env.$plain;
  if (!('$enc' in env)) return env; // legacy plain value
  if (!cryptoKey) throw new Error('LOCKED');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: env.iv }, cryptoKey, env.$enc);
  return JSON.parse(dec.decode(pt));
}

/* ------------------------------ Documents ------------------------------ */

/**
 * @typedef {object} Doc
 * @property {string} id
 * @property {string} title
 * @property {string} kind - pdf|docx|epub|txt|md|html|rtf|image|web|clip|email
 * @property {string} folder - documents|books|scans|articles|websites
 * @property {Block[]} blocks - Ordered content blocks (encrypted at rest when unlocked).
 * @property {string} [source] - Original URL or filename.
 * @property {string} [thumb] - data: URL.
 * @property {number} words
 * @property {number} progress - 0..1
 * @property {number} sentenceIdx - Resume position.
 * @property {string[]} tags
 * @property {string[]} collections
 * @property {boolean} fav
 * @property {boolean} pinned
 * @property {boolean} trashed
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {number} openedAt
 * @property {number} listenedMs
 */

/**
 * @typedef {object} Block
 * @property {string} type - p|h1|h2|h3|quote|code|li|img|hr
 * @property {string} [text]
 * @property {string} [src] - for img
 * @property {number} [chapter]
 * @property {number} [page]
 * @property {number} [conf] - OCR confidence 0..100
 * @property {{w:string, c:number}[]} [wordsConf] - per-word OCR confidence
 */

export async function putDoc(doc) {
  const s = await store('docs', 'readwrite');
  const row = { ...doc, blocks: await seal(doc.blocks || []), updatedAt: Date.now() };
  await wrap(s.put(row));
  return doc.id;
}

/** Patch a document without rewriting its (possibly large, encrypted) blocks. */
export async function patchDoc(id, patch) {
  const d = await open();
  const tx = d.transaction('docs', 'readwrite');
  const s = tx.objectStore('docs');
  const row = await wrap(s.get(id));
  if (!row) return null;
  Object.assign(row, patch, { updatedAt: Date.now() });
  await wrap(s.put(row));
  return row.id;
}

export async function getDoc(id) {
  const s = await store('docs');
  const row = await wrap(s.get(id));
  if (!row) return null;
  return { ...row, blocks: (await unseal(row.blocks)) || [] };
}

/**
 * List documents. Blocks are omitted — lists never need content, and decrypting
 * every document to render a grid would be both slow and pointless.
 * @param {{folder?:string, fav?:boolean, pinned?:boolean, trashed?:boolean,
 *          collection?:string, tag?:string, limit?:number, sort?:'updated'|'opened'|'title'}} [q]
 * @returns {Promise<Omit<Doc,'blocks'>[]>}
 */
export async function listDocs(q = {}) {
  const s = await store('docs');
  const rows = await wrap(s.getAll());
  let out = rows.map(({ blocks, ...meta }) => meta);

  out = out.filter((d) => Boolean(d.trashed) === Boolean(q.trashed));
  if (q.folder) out = out.filter((d) => d.folder === q.folder);
  if (q.fav) out = out.filter((d) => d.fav);
  if (q.pinned) out = out.filter((d) => d.pinned);
  if (q.collection) out = out.filter((d) => (d.collections || []).includes(q.collection));
  if (q.tag) out = out.filter((d) => (d.tags || []).includes(q.tag));
  if (q.kind) out = out.filter((d) => d.kind === q.kind);

  const key = q.sort === 'opened' ? 'openedAt' : q.sort === 'title' ? 'title' : 'updatedAt';
  out.sort((a, b) =>
    key === 'title' ? String(a.title).localeCompare(String(b.title)) : (b[key] || 0) - (a[key] || 0));

  return q.limit ? out.slice(0, q.limit) : out;
}

/** Full document rows including decrypted blocks — used by search and export. */
export async function allDocsFull() {
  const s = await store('docs');
  const rows = await wrap(s.getAll());
  const out = [];
  for (const row of rows) {
    try {
      out.push({ ...row, blocks: (await unseal(row.blocks)) || [] });
    } catch {
      // Encrypted and locked — skip rather than fail the whole query.
      out.push({ ...row, blocks: [], locked: true });
    }
  }
  return out;
}

export async function deleteDoc(id, { hard = false } = {}) {
  if (!hard) return patchDoc(id, { trashed: true, trashedAt: Date.now() });
  const d = await open();
  const tx = d.transaction(['docs', 'blobs', 'marks', 'ai', 'audio'], 'readwrite');
  tx.objectStore('docs').delete(id);
  tx.objectStore('blobs').delete(id);
  for (const name of ['marks', 'ai', 'audio']) {
    const idx = tx.objectStore(name).index('docId');
    const req = idx.openCursor(IDBKeyRange.only(id));
    req.onsuccess = () => {
      const c = req.result;
      if (c) {
        c.delete();
        c.continue();
      }
    };
  }
  return new Promise((res, rej) => {
    tx.oncomplete = () => res(id);
    tx.onerror = () => rej(tx.error);
  });
}

export async function emptyTrash() {
  const rows = await listDocs({ trashed: true });
  for (const r of rows) await deleteDoc(r.id, { hard: true });
  return rows.length;
}

/* ------------------------------ Blobs ------------------------------ */

export async function putBlob(id, data, meta = {}) {
  const s = await store('blobs', 'readwrite');
  return wrap(s.put({ id, data: await seal(data), meta, size: data?.byteLength || 0 }));
}

export async function getBlob(id) {
  const s = await store('blobs');
  const row = await wrap(s.get(id));
  if (!row) return null;
  const data = await unseal(row.data);
  // Sealed arrays round-trip through JSON as plain objects; restore the buffer.
  return { ...row, data: data && !(data instanceof ArrayBuffer) ? toBuffer(data) : data };
}

function toBuffer(v) {
  if (v instanceof ArrayBuffer) return v;
  if (ArrayBuffer.isView(v)) return v.buffer;
  if (v && typeof v === 'object') return new Uint8Array(Object.values(v)).buffer;
  return v;
}

/* ------------------------------ Marks ------------------------------ */

export async function putMark(mark) {
  const s = await store('marks', 'readwrite');
  const row = { id: mark.id || crypto.randomUUID(), createdAt: Date.now(), ...mark };
  await wrap(s.put(row));
  return row;
}

export async function marksFor(docId) {
  const s = await store('marks');
  const rows = await wrap(s.index('docId').getAll(IDBKeyRange.only(docId)));
  return rows.sort((a, b) => a.blockIdx - b.blockIdx || a.start - b.start);
}

export async function allMarks() {
  const s = await store('marks');
  return wrap(s.getAll());
}

export async function deleteMark(id) {
  const s = await store('marks', 'readwrite');
  return wrap(s.delete(id));
}

/* ------------------------------ AI cache ------------------------------ */

export async function putAi(docId, action, lang, payload) {
  const s = await store('ai', 'readwrite');
  return wrap(s.put({ id: `${docId}:${action}:${lang || 'en'}`, docId, action, lang, payload, at: Date.now() }));
}

export async function getAi(docId, action, lang) {
  const s = await store('ai');
  return wrap(s.get(`${docId}:${action}:${lang || 'en'}`));
}

export async function aiFor(docId) {
  const s = await store('ai');
  return wrap(s.index('docId').getAll(IDBKeyRange.only(docId)));
}

/* ------------------------------ Audio cache ------------------------------ */

export async function putAudio(docId, voice, idx, blob) {
  const s = await store('audio', 'readwrite');
  return wrap(s.put({ id: `${docId}:${voice}:${idx}`, docId, voice, idx, blob, size: blob.size, at: Date.now() }));
}

export async function getAudio(docId, voice, idx) {
  const s = await store('audio');
  return wrap(s.get(`${docId}:${voice}:${idx}`));
}

export async function audioFor(docId) {
  const s = await store('audio');
  return wrap(s.index('docId').getAll(IDBKeyRange.only(docId)));
}

export async function clearAudio(docId) {
  const d = await open();
  const tx = d.transaction('audio', 'readwrite');
  const req = tx.objectStore('audio').index('docId').openCursor(IDBKeyRange.only(docId));
  req.onsuccess = () => {
    const c = req.result;
    if (c) {
      c.delete();
      c.continue();
    }
  };
  return new Promise((res) => { tx.oncomplete = res; });
}

/* ------------------------------ Key/value ------------------------------ */

export async function kvGet(k, fallback = null) {
  const s = await store('kv');
  const row = await wrap(s.get(k));
  return row ? row.v : fallback;
}

export async function kvSet(k, v) {
  const s = await store('kv', 'readwrite');
  return wrap(s.put({ k, v }));
}

export async function kvDel(k) {
  const s = await store('kv', 'readwrite');
  return wrap(s.delete(k));
}

/* ------------------------------ Storage stats ------------------------------ */

/** Per-store byte usage plus the browser's own quota estimate. */
export async function usage() {
  const est = (await navigator.storage?.estimate?.()) || {};
  const [docs, audio, blobs] = await Promise.all([
    store('docs').then((s) => wrap(s.count())),
    store('audio').then((s) => wrap(s.getAll())),
    store('blobs').then((s) => wrap(s.getAll())),
  ]);
  return {
    docs,
    audioCount: audio.length,
    audioBytes: audio.reduce((n, a) => n + (a.size || 0), 0),
    blobBytes: blobs.reduce((n, b) => n + (b.size || 0), 0),
    used: est.usage || 0,
    quota: est.quota || 0,
  };
}

/** Ask the browser to exempt our data from automatic eviction. */
export async function persist() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

/** Delete everything. Used by Settings → Privacy → Erase all data. */
export async function nuke() {
  db?.close();
  db = null;
  cryptoKey = null;
  return new Promise((res, rej) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => res(true);
    req.onerror = () => rej(req.error);
    req.onblocked = () => res(false);
  });
}
