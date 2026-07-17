/**
 * Universal import.
 *
 * Every entry point (file picker, drag & drop, URL, paste, clipboard, camera, share
 * target) funnels into `commit()`, so a document created by dropping a PDF is
 * indistinguishable from one created by the Android share sheet.
 */

import { h, fill, icon, $ } from '../util/dom.js';
import { go } from '../core/router.js';
import { state, refreshDocs, busy } from '../core/store.js';
import * as db from '../core/db.js';
import { validateFile, sniffKind, kindForExt, fmtBytes } from '../util/sanitize.js';
import { extractFile, fromPaste, blockWords } from '../services/extract.js';
import { fetchArticle } from '../services/reader-web.js';
import { ocrBatch, OCR_LANGS, disposeOcr } from '../services/ocr.js';
import { toast, sheet, empty } from './kit.js';
import { invalidate } from '../services/search.js';
import { readability } from '../util/text.js';

const TABS = [
  { id: 'file', label: 'File', icon: 'doc' },
  { id: 'url', label: 'Website', icon: 'link' },
  { id: 'paste', label: 'Paste', icon: 'clip' },
  { id: 'scan', label: 'Scan', icon: 'camera' },
];

const ACCEPT = '.pdf,.docx,.epub,.txt,.md,.markdown,.html,.htm,.rtf,.eml,.png,.jpg,.jpeg,.webp,.gif,.bmp,.tif,.tiff,.avif';

export function importView() {
  let tab = state.route.params.tab || 'file';
  const panel = h('div');

  const chips = h('div.chips', { role: 'tablist', style: { marginBottom: 'var(--sp-5)' } },
    ...TABS.map((t) =>
      h('button.chip', {
        role: 'tab',
        'aria-selected': String(t.id === tab),
        'aria-pressed': String(t.id === tab),
        onclick: () => {
          tab = t.id;
          [...chips.children].forEach((c, i) => {
            const on = TABS[i].id === tab;
            c.setAttribute('aria-selected', String(on));
            c.setAttribute('aria-pressed', String(on));
          });
          paint();
        },
      }, icon(t.icon, 15), t.label)));

  const paint = () => {
    fill(panel,
      tab === 'file' ? filePanel()
        : tab === 'url' ? urlPanel()
          : tab === 'paste' ? pastePanel()
            : scanPanel());
  };
  paint();

  const root = h('div.wrap',
    null,
    h('header.topbar', null,
      h('div.topbar__row', null,
        h('button.icon-btn', { onclick: () => go('/'), 'aria-label': 'Back' }, icon('chevL', 20)),
        h('h1.topbar__title', null, 'Add to Lumen'))),
    chips,
    panel,
  );

  root.addEventListener('lumen:teardown', () => disposeOcr());
  return root;
}

/* ============================ File ============================ */

function filePanel() {
  const input = h('input', {
    type: 'file',
    multiple: true,
    accept: ACCEPT,
    style: { display: 'none' },
    onchange: (e) => handleFiles([...e.target.files]),
  });

  const dz = h('div.dz', {
    tabIndex: 0,
    role: 'button',
    'aria-label': 'Choose files to import',
    onclick: () => input.click(),
    onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.click()),
    ondragover: (e) => {
      e.preventDefault();
      dz.classList.add('is-over');
    },
    ondragleave: () => dz.classList.remove('is-over'),
    ondrop: (e) => {
      e.preventDefault();
      dz.classList.remove('is-over');
      handleFiles([...e.dataTransfer.files]);
    },
  },
    h('div.empty__glyph', null, icon('down', 30)),
    h('h3', null, 'Drop files here'),
    h('p.small.muted', null, 'or tap to browse'),
    h('div.chips', { style: { justifyContent: 'center', marginTop: 'var(--sp-3)' } },
      ...['PDF', 'DOCX', 'EPUB', 'TXT', 'MD', 'HTML', 'RTF', 'EML', 'Images'].map((x) =>
        h('span.badge', null, x))),
    input,
  );

  return h('div.col', null, dz, h('p.small.muted.center', null,
    'Files are read on this device. Nothing is uploaded.'));
}

/**
 * Import files. Each is validated, sniffed for its real type, extracted, and stored.
 * One bad file never aborts the batch — it reports and the rest continue.
 */
export async function handleFiles(files) {
  if (!files.length) return;
  const images = [];
  let ok = 0;

  for (const file of files) {
    const check = validateFile(file);
    if (!check.ok) {
      toast(`${file.name}: ${check.reason}`, 'err');
      continue;
    }

    // The extension is a hint; the bytes are the truth.
    const sniffed = await sniffKind(file);
    if (sniffed === 'executable') {
      toast(`${file.name} is a program, not a document. Skipped.`, 'err');
      continue;
    }
    if (sniffed === 'pdf' && check.kind !== 'pdf') {
      toast(`${file.name} is really a PDF — reading it as one.`);
    }
    const kind = sniffed === 'pdf' ? 'pdf' : check.kind;

    // Batch images into one multi-page scan rather than N one-page documents.
    if (kind === 'image') {
      images.push(file);
      continue;
    }

    try {
      busy(`Reading ${file.name}`, 0);
      const res = await extractFile(file, kind, (pct, label) => busy(label || `Reading ${file.name}`, pct));
      await commit({
        ...res,
        kind,
        source: file.name,
        folder: folderFor(kind),
        blob: await file.arrayBuffer(),
        blobMeta: { name: file.name, type: file.type, size: file.size },
      });
      ok++;
    } catch (err) {
      console.error(err);
      toast(`${file.name}: ${err.message}`, 'err');
    } finally {
      busy(null);
    }
  }

  if (images.length) await scanFiles(images);
  if (ok) toast(`Added ${ok} document${ok === 1 ? '' : 's'}`, 'ok');
}

const folderFor = (kind) =>
  kind === 'epub' ? 'books'
    : kind === 'image' ? 'scans'
      : kind === 'web' ? 'websites'
        : kind === 'html' ? 'articles'
          : 'documents';

/* ============================ URL ============================ */

function urlPanel() {
  const input = h('input.input', {
    type: 'url',
    placeholder: 'https://example.com/article',
    inputmode: 'url',
    autocapitalize: 'off',
    spellcheck: false,
    'aria-label': 'Website address',
  });

  const status = h('p.small.muted');
  const btn = h('button.btn.btn--primary.btn--block', { type: 'submit' }, icon('link', 18), 'Read this page');

  const form = h('form.col', {
    onsubmit: async (e) => {
      e.preventDefault();
      const url = input.value.trim();
      if (!url) return;

      btn.disabled = true;
      fill(btn, h('span.spin'), 'Fetching…');
      status.textContent = '';
      status.style.color = '';

      try {
        busy('Fetching the page', null);
        const res = await fetchArticle(url, { proxy: state.settings.proxy });
        const id = await commit({
          ...res,
          kind: 'web',
          folder: 'websites',
          source: res.meta?.url || url,
        });
        toast('Article ready', 'ok');
        go(`/read/${id}`);
      } catch (err) {
        status.textContent = err.message;
        status.style.color = 'var(--danger)';
      } finally {
        busy(null);
        btn.disabled = false;
        fill(btn, icon('link', 18), 'Read this page');
      }
    },
  },
    h('label.field', null, h('span.field__label', null, 'Website address'), input),
    btn,
    status,
    h('div.card.card--pad', { style: { display: 'grid', gap: 'var(--sp-2)' } },
      h('div.row', null, icon('shield', 17), h('strong.small', null, 'What Lumen does with a link')),
      h('ul.small.muted', { style: { paddingLeft: '1.2em', display: 'grid', gap: '4px' } },
        h('li', null, 'Fetches the page and keeps only the article — no ads, nav, sidebars, or comments.'),
        h('li', null, 'Strips tracking parameters from the URL.'),
        h('li', null, 'Never sends your cookies, so it only sees what a logged-out visitor sees.'),
        h('li', null, 'Some sites block other apps from reading them; if that happens, paste the text instead.'))),
  );

  // Offer whatever URL is already on the clipboard — the common case for this tab.
  navigator.clipboard?.readText?.().then((t) => {
    if (/^https?:\/\/\S+$/i.test((t || '').trim()) && !input.value) {
      status.append(
        h('button.btn.btn--sm.btn--ghost', {
          onclick: () => {
            input.value = t.trim();
            status.textContent = '';
          },
        }, icon('clip', 14), 'Paste link from clipboard'),
      );
    }
  }).catch(() => { /* clipboard read denied — no prompt, just skip the affordance */ });

  requestAnimationFrame(() => input.focus());
  return form;
}

/* ============================ Paste ============================ */

function pastePanel() {
  const ta = h('textarea.textarea', {
    placeholder: 'Paste anything — an article, an email, notes, Markdown, or a link.',
    style: { minHeight: '220px' },
    'aria-label': 'Text to import',
    oninput: () => {
      const n = ta.value.trim().split(/\s+/).filter(Boolean).length;
      stat.textContent = n ? `${n} word${n === 1 ? '' : 's'} · about ${Math.max(1, Math.round(n / 225))} min to read` : '';
      btn.disabled = !ta.value.trim();
    },
  });

  const stat = h('p.small.muted');
  const btn = h('button.btn.btn--primary.btn--block', { disabled: true, onclick: submit }, icon('add', 18), 'Add to library');

  async function submit() {
    const text = ta.value.trim();
    if (!text) return;
    try {
      busy('Reading', null);
      const parsed = fromPaste(text);

      // A bare URL in the paste box means "read this page", not "save this string".
      if (parsed.isUrl) {
        const res = await fetchArticle(parsed.url, { proxy: state.settings.proxy });
        const id = await commit({ ...res, kind: 'web', folder: 'websites', source: parsed.url });
        go(`/read/${id}`);
        return;
      }

      const id = await commit({ ...parsed, kind: 'clip', folder: 'documents', source: 'Pasted text' });
      toast('Added', 'ok');
      go(`/read/${id}`);
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      busy(null);
    }
  }

  const fromClip = h('button.btn.btn--outline.btn--block', {
    onclick: async () => {
      try {
        const t = await navigator.clipboard.readText();
        if (!t?.trim()) return toast('Clipboard is empty', 'err');
        ta.value = t;
        ta.dispatchEvent(new Event('input'));
        ta.focus();
      } catch {
        toast('Your browser blocked clipboard access. Paste with Ctrl+V instead.', 'err');
      }
    },
  }, icon('clip', 18), 'Read from clipboard');

  return h('div.col', null, fromClip, h('label.field', null, ta), stat, btn);
}

/* ============================ Scan / OCR ============================ */

function scanPanel() {
  let lang = 'eng';

  const camera = h('input', {
    type: 'file',
    accept: 'image/*',
    capture: 'environment',
    style: { display: 'none' },
    onchange: (e) => e.target.files.length && scanFiles([...e.target.files]),
  });
  const picker = h('input', {
    type: 'file',
    accept: 'image/*',
    multiple: true,
    style: { display: 'none' },
    onchange: (e) => e.target.files.length && scanFiles([...e.target.files], lang),
  });

  const langSel = h('select.select', { onchange: (e) => { lang = e.target.value; } },
    ...OCR_LANGS.map((l) => h('option', { value: l.code, selected: l.code === lang }, l.label)));

  return h('div.col', null,
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' } },
      h('button.qa', { style: { padding: 'var(--sp-5)' }, onclick: () => camera.click() },
        h('span.qa__glyph', null, icon('camera', 26)), h('span.qa__label', null, 'Take a photo')),
      h('button.qa', { style: { padding: 'var(--sp-5)' }, onclick: () => picker.click() },
        h('span.qa__glyph', null, icon('image', 26)), h('span.qa__label', null, 'Choose images'))),
    h('label.field', null, h('span.field__label', null, 'Language of the text'), langSel),
    h('div.card.card--pad', { style: { display: 'grid', gap: 'var(--sp-2)' } },
      h('div.row', null, icon('shield', 17), h('strong.small', null, 'Scanning is private')),
      h('p.small.muted', null,
        'Text recognition runs entirely on this device — your photos never leave it. The first scan downloads a one-time engine (about 12 MB); after that it works offline.'),
      h('p.small.muted', null,
        'For best results: flatten the page, fill the frame, and avoid shadows across the text.')),
    camera, picker,
  );
}

/** OCR one or more images, then open the review editor. */
export async function scanFiles(files, lang = 'eng') {
  try {
    busy('Preparing', 0);
    const res = await ocrBatch(files, (pct, label) => busy(label, pct), { lang });
    busy(null);
    openOcrReview(res, files);
  } catch (err) {
    busy(null);
    toast(err.message, 'err');
  }
}

/**
 * OCR review.
 *
 * OCR is never perfect, so the honest move is to show the confidence and let people fix
 * it before it becomes a document they'll listen to. Words below 75% confidence are
 * shaded; below 60% more strongly. The text is editable in place.
 */
function openOcrReview(res, files) {
  const low = res.meta.lowConfidence || 0;
  const conf = res.meta.confidence || 0;
  const tone = conf >= 88 ? 'ok' : conf >= 72 ? 'warn' : 'danger';

  const editor = h('div', {
    contentEditable: 'true',
    role: 'textbox',
    'aria-multiline': 'true',
    'aria-label': 'Recognised text — edit to correct mistakes',
    spellcheck: true,
    style: {
      minHeight: '240px', maxHeight: '46vh', overflowY: 'auto', padding: 'var(--sp-4)',
      borderRadius: 'var(--r-md)', border: '1px solid var(--line-2)', background: 'var(--surface-solid)',
      lineHeight: '1.7', fontSize: '15px',
    },
  });

  // Render with per-word confidence shading; the editor stays plain text on save.
  for (const b of res.blocks) {
    const p = h('p', { style: { marginBottom: '0.9em', fontWeight: b.type?.startsWith('h') ? '650' : '400' } });
    if (b.wordsConf?.length) {
      b.wordsConf.forEach((w, i) => {
        const cls = w.c < 60 ? 'ocr-w ocr-w--low' : w.c < 75 ? 'ocr-w ocr-w--mid' : 'ocr-w';
        p.append(h(`span.${cls.split(' ').join('.')}`, { title: `${w.c}% confident` }, w.w));
        if (i < b.wordsConf.length - 1) p.append(' ');
      });
    } else p.textContent = b.text;
    editor.append(p);
  }

  const titleInput = h('input.input', { value: res.title, 'aria-label': 'Title' });

  const save = h('button.btn.btn--primary.btn--block', {
    onclick: async () => {
      // Read the (possibly edited) text back out of the editor.
      const blocks = [...editor.children]
        .map((p) => p.textContent.replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .map((text, i) => ({ type: i === 0 && text.length < 66 ? 'h2' : 'p', text }));

      if (!blocks.length) return toast('There’s no text to save.', 'err');

      const id = await commit({
        title: titleInput.value.trim() || res.title,
        blocks,
        thumb: res.thumb,
        kind: 'image',
        folder: 'scans',
        source: files.length > 1 ? `${files.length} scanned pages` : files[0]?.name || 'Scan',
        meta: res.meta,
        blob: files.length === 1 ? await files[0].arrayBuffer() : null,
        blobMeta: files.length === 1 ? { name: files[0].name, type: files[0].type, size: files[0].size } : null,
      });
      s.close();
      toast('Scan saved', 'ok');
      go(`/read/${id}`);
    },
  }, icon('check', 18), 'Save to library');

  const s = sheet({
    title: 'Check the scan',
    body: h('div.col', null,
      h('div.row', null,
        h(`span.badge.badge--${tone}`, null, `${conf}% confident`),
        low > 0 && h('span.badge.badge--warn', null, `${low} uncertain word${low === 1 ? '' : 's'}`),
        h('div.spacer'),
        h('span.small.muted', null, `${res.blocks.length} paragraph${res.blocks.length === 1 ? '' : 's'}`)),
      low > 0 &&
        h('p.small.muted', null,
          'Shaded words are ones the scanner wasn’t sure about. Tap the text to fix anything before saving.'),
      h('label.field', null, h('span.field__label', null, 'Title'), titleInput),
      editor,
      save),
  });
}

/* ============================ Commit ============================ */

/**
 * Persist an extracted document.
 * @returns {Promise<string>} the new document id
 */
export async function commit({ title, blocks, thumb, kind, folder, source, meta, blob, blobMeta }) {
  if (!blocks?.length) throw new Error('Nothing readable was found in that.');

  const id = crypto.randomUUID();
  const words = blockWords(blocks);
  const text = blocks.filter((b) => b.text).map((b) => b.text).join(' ');

  const doc = {
    id,
    title: (title || 'Untitled').slice(0, 200).trim() || 'Untitled',
    kind,
    folder: folder || 'documents',
    blocks,
    thumb: thumb || null,
    source: source || '',
    words,
    meta: { ...meta, readability: meta?.readability || readability(text) },
    progress: 0,
    sentenceIdx: 0,
    tags: [],
    collections: [],
    fav: false,
    pinned: false,
    trashed: false,
    downloaded: false,
    listenedMs: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    openedAt: 0,
  };

  await db.putDoc(doc);
  if (blob) {
    // Keep the original so export and re-extraction never need the source again.
    await db.putBlob(id, blob, blobMeta).catch((err) => {
      // Quota is the likely cause; the document itself is already safe.
      console.warn('[import] could not keep original file', err);
    });
  }

  invalidate();
  await refreshDocs();
  return id;
}

/* ============================ Global drop + share target ============================ */

/** Accept files dropped anywhere in the app, not just on the import screen. */
export function bindGlobalDrop() {
  let depth = 0;
  const veil = h('div', {
    style: {
      position: 'fixed', inset: '0', zIndex: '95', display: 'none', placeItems: 'center',
      background: 'var(--accent-wash)', backdropFilter: 'blur(10px)',
      border: '3px dashed var(--accent)', pointerEvents: 'none',
    },
  }, h('div.card.card--pad', { style: { textAlign: 'center' } },
    h('div.empty__glyph', { style: { margin: '0 auto var(--sp-3)' } }, icon('down', 30)),
    h('h3', null, 'Drop to add'),
    h('p.small.muted', null, 'PDF, DOCX, EPUB, images, and more')));
  document.body.append(veil);

  const show = (on) => { veil.style.display = on ? 'grid' : 'none'; };

  addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    depth++;
    show(true);
  });
  addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) show(false);
  });
  addEventListener('dragover', (e) => e.preventDefault());
  addEventListener('drop', async (e) => {
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    depth = 0;
    show(false);
    go('/import');
    await handleFiles([...e.dataTransfer.files]);
  });
}

/** Ctrl/Cmd+V anywhere imports the clipboard. */
export function bindGlobalPaste() {
  addEventListener('paste', async (e) => {
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /input|textarea/i.test(t.tagName))) return;
    if (state.route.name === 'reader') return;

    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      go('/import');
      return handleFiles(files);
    }
    const text = e.clipboardData?.getData('text')?.trim();
    if (!text || text.length < 12) return;

    e.preventDefault();
    try {
      const parsed = fromPaste(text);
      if (parsed.isUrl) {
        go('/import?tab=url');
        const el = $('input[type="url"]');
        if (el) el.value = parsed.url;
        return;
      }
      const id = await commit({ ...parsed, kind: 'clip', folder: 'documents', source: 'Pasted text' });
      toast('Pasted text added', 'ok', { action: { label: 'Open', fn: () => go(`/read/${id}`) } });
    } catch (err) {
      toast(err.message, 'err');
    }
  });
}

/**
 * Handle the PWA share target. The service worker forwards shared content here as
 * query params, which is how "Share → Lumen" works from Android.
 */
export async function handleShareTarget() {
  const p = new URLSearchParams(location.search);
  // The manifest's share_target maps the OS payload onto these three params.
  if (!p.has('url') && !p.has('text') && !p.has('title')) return false;

  const url = p.get('url');
  const text = p.get('text');
  const title = p.get('title') || 'Shared';

  // Android often puts a shared link in `text` rather than `url`.
  if (!url && !text) return false;

  // Clean the URL so a refresh doesn't re-import.
  history.replaceState(null, '', location.pathname + location.hash);

  try {
    if (url) {
      busy('Fetching the shared link', null);
      const res = await fetchArticle(url, { proxy: state.settings.proxy });
      const id = await commit({ ...res, kind: 'web', folder: 'websites', source: url });
      go(`/read/${id}`);
      return true;
    }
    if (text) {
      const parsed = fromPaste(text, title);
      if (parsed.isUrl) {
        const res = await fetchArticle(parsed.url, { proxy: state.settings.proxy });
        const id = await commit({ ...res, kind: 'web', folder: 'websites', source: parsed.url });
        go(`/read/${id}`);
        return true;
      }
      const id = await commit({ ...parsed, kind: 'clip', folder: 'documents', source: 'Shared text' });
      go(`/read/${id}`);
      return true;
    }
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    busy(null);
  }
  return false;
}

void empty;
void kindForExt;
void fmtBytes;
